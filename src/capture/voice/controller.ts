import type { CaptureActionProps, CapturedRecipe } from "../contract";
import { parseRecipeTranscript } from "../parse";
import { transcribeInCloud } from "./cloud";
import type { CloudFailure, CloudTranscriptionConfig } from "./cloud";
import { canRecordAudio, checkLocalSupport, installLocalPack } from "./environment";
import type { LocalSupport, VoiceEnvironment } from "./environment";
import { startLocalDictation } from "./local";
import type { DictationFailure, DictationSession } from "./local";
import { startRecording } from "./recorder";
import type { RecorderSession } from "./recorder";

export type VoiceFailure =
  | DictationFailure
  | "empty"
  | "unavailable"
  | `cloud-${CloudFailure}`;

export type VoiceState =
  | { phase: "checking" }
  | {
    phase: "idle";
    local: LocalSupport;
    canRecordForCloud: boolean;
    cloud?: Pick<CloudTranscriptionConfig, "providerLabel" | "retentionNote" | "maxDurationMs">;
  }
  | { phase: "installing" }
  | { phase: "recording"; mode: "local" | "cloud"; liveTranscript?: string }
  | { phase: "approve-cloud"; providerLabel: string; retentionNote?: string; limitReached: boolean }
  | { phase: "processing" }
  | { phase: "failed"; failure: VoiceFailure; hasCaptured: boolean };

export type VoiceControllerOptions = {
  env: VoiceEnvironment;
  /** `undefined` leaves cloud transcription inactive. */
  cloud?: CloudTranscriptionConfig;
  onDraft: CaptureActionProps["onDraft"];
  onState: (state: VoiceState) => void;
  /** Development only: publish the running transcript in `recording` states. */
  exposeTranscript?: boolean;
  parse?: (text: string) => CapturedRecipe;
};

/**
 * The dictation workflow without any UI framework. Audio and transcripts exist only in this object's memory:
 * they are dropped after a draft is produced, on cancel, and on dispose. Nothing here logs or stores them.
 */
export class VoiceController {
  readonly #options: VoiceControllerOptions;
  #state: VoiceState = { phase: "checking" };
  #local: LocalSupport = { kind: "unsupported", reason: "check-failed" };
  #dictation: DictationSession | undefined;
  #recorder: RecorderSession | undefined;
  #audio: Blob | undefined;
  #captured = "";
  #cloudAbort: AbortController | undefined;
  #generation = 0;
  #disposed = false;

  constructor(options: VoiceControllerOptions) {
    this.#options = options;
  }

  get state(): VoiceState {
    return this.#state;
  }

  #set(state: VoiceState): void {
    if (this.#disposed) return;
    this.#state = state;
    this.#options.onState(state);
  }

  #idle(): void {
    const cloud = this.#options.cloud;
    this.#set({
      phase: "idle",
      local: this.#local,
      canRecordForCloud: cloud !== undefined && canRecordAudio(this.#options.env),
      ...(cloud ? { cloud: { providerLabel: cloud.providerLabel, retentionNote: cloud.retentionNote, maxDurationMs: cloud.maxDurationMs } } : {}),
    });
  }

  #discard(): void {
    this.#generation++;
    this.#dictation?.cancel();
    this.#dictation = undefined;
    this.#recorder?.cancel();
    this.#recorder = undefined;
    this.#cloudAbort?.abort();
    this.#cloudAbort = undefined;
    this.#audio = undefined;
    this.#captured = "";
  }

  async check(): Promise<void> {
    this.#set({ phase: "checking" });
    this.#local = await checkLocalSupport(this.#options.env);
    if (!this.#disposed && this.#state.phase === "checking") this.#idle();
  }

  async installLocalPack(): Promise<void> {
    const generation = ++this.#generation;
    this.#set({ phase: "installing" });
    const support = await installLocalPack(this.#options.env);
    if (generation !== this.#generation || this.#disposed || this.#state.phase !== "installing") return;
    this.#local = support;
    this.#idle();
  }

  startLocal(): void {
    if (this.#local.kind !== "ready") return;
    this.#discard();
    const generation = this.#generation;
    const expose = this.#options.exposeTranscript === true;
    const started = startLocalDictation(this.#options.env, {
      onText: (text) => {
        if (expose && generation === this.#generation) this.#set({ phase: "recording", mode: "local", liveTranscript: text });
      },
      onFinish: (result) => {
        if (generation !== this.#generation) return;
        this.#dictation = undefined;
        this.#captured = result.transcript;
        if (result.failure) this.#fail(result.failure);
        else this.#complete();
      },
    });
    if (!started.ok) {
      this.#fail(started.failure);
      return;
    }
    this.#dictation = started.session;
    this.#set({ phase: "recording", mode: "local" });
  }

  /** Records into memory only. Nothing leaves the device until `sendToCloud` is called after the user approves. */
  async startCloudRecording(): Promise<void> {
    const cloud = this.#options.cloud;
    if (!cloud || !canRecordAudio(this.#options.env)) {
      this.#fail("unavailable");
      return;
    }
    this.#discard();
    const generation = this.#generation;
    const started = await startRecording(this.#options.env, cloud);
    if (generation !== this.#generation || this.#disposed) {
      if (started.ok) started.session.cancel();
      return;
    }
    if (!started.ok) {
      this.#fail(started.failure);
      return;
    }
    this.#recorder = started.session;
    this.#set({ phase: "recording", mode: "cloud" });
    void started.session.finished.then((recording) => {
      if (generation !== this.#generation || this.#recorder !== started.session) return;
      this.#recorder = undefined;
      if (!recording) {
        this.#fail("failed");
        return;
      }
      this.#audio = recording.audio;
      this.#set({
        phase: "approve-cloud",
        providerLabel: cloud.providerLabel,
        retentionNote: cloud.retentionNote,
        limitReached: recording.limitReached,
      });
    });
  }

  stop(): void {
    if (this.#dictation) {
      this.#set({ phase: "processing" });
      this.#dictation.stop();
    } else if (this.#recorder) {
      void this.#recorder.stop();
    }
  }

  /** Sends the recording held in memory, only after the user approved this recording. */
  async sendToCloud(): Promise<void> {
    const audio = this.#audio;
    if (!audio || this.#state.phase !== "approve-cloud") return;
    const generation = this.#generation;
    this.#cloudAbort = new AbortController();
    this.#set({ phase: "processing" });
    const result = await transcribeInCloud(this.#options.cloud, audio, this.#options.env, this.#cloudAbort.signal);
    if (generation !== this.#generation) return;
    this.#audio = undefined;
    this.#cloudAbort = undefined;
    if (!result.ok) {
      this.#fail(`cloud-${result.failure}`);
      return;
    }
    this.#captured = result.transcript;
    this.#complete();
  }

  /** Drops the recording or the captured text and returns to the start. */
  cancel(): void {
    this.#discard();
    this.#idle();
  }

  /** Builds a draft from the text captured before an interruption. */
  useCaptured(): void {
    if (this.#captured.trim()) this.#complete();
    else this.#fail("empty");
  }

  /** Builds a draft from text the user typed or pasted. */
  submitText(text: string): void {
    this.#discard();
    this.#captured = text;
    if (text.trim()) this.#complete();
    else this.#fail("empty");
  }

  /** Opens the editor with an empty draft, for when voice is unavailable. */
  continueManually(): void {
    this.#discard();
    this.#options.onDraft({ ingredients: [], steps: [] });
  }

  dispose(): void {
    this.#discard();
    this.#disposed = true;
  }

  #fail(failure: VoiceFailure): void {
    if (failure === "language-unavailable") this.#local = { kind: "unsupported", reason: "language-unavailable" };
    const hasCaptured = this.#captured.trim().length > 0;
    this.#audio = undefined;
    this.#set({ phase: "failed", failure, hasCaptured });
  }

  #complete(): void {
    const text = this.#captured;
    this.#captured = "";
    this.#audio = undefined;
    if (!text.trim()) {
      this.#fail("empty");
      return;
    }
    this.#set({ phase: "processing" });
    let draft: CapturedRecipe;
    try {
      draft = (this.#options.parse ?? parseRecipeTranscript)(text);
    } catch {
      // Keep the text so the user can retry or continue; never report what was said.
      this.#captured = text;
      this.#fail("failed");
      return;
    }
    this.#options.onDraft(draft);
    this.#idle();
  }
}
