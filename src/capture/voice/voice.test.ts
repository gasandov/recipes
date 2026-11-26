import { afterEach, describe, expect, it, vi } from "vitest";
import type { CapturedRecipe } from "../contract";
import { resolveCloudConfig, transcribeInCloud } from "./cloud";
import type { CloudTranscriptionConfig } from "./cloud";
import { VoiceController } from "./controller";
import type { VoiceState } from "./controller";
import { checkLocalSupport, installLocalPack } from "./environment";
import type {
  MediaRecorderLike, SpeechRecognitionConstructor, SpeechRecognitionLike, SpeechResultsLike, VoiceEnvironment,
} from "./environment";
import { startLocalDictation } from "./local";
import { startRecording } from "./recorder";

// --- Fakes -------------------------------------------------------------------------------------------------------

function results(...parts: [string, boolean][]): SpeechResultsLike {
  return Object.assign(
    parts.map(([transcript, isFinal]) => Object.assign([{ transcript }], { isFinal, length: 1 })),
    { length: parts.length },
  ) as unknown as SpeechResultsLike;
}

class FakeRecognition implements SpeechRecognitionLike {
  static instances: FakeRecognition[] = [];
  static status = "available";
  static installResult = true;
  static acceptsProcessLocally = true;
  static availableCalls: unknown[] = [];

  lang = "";
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  onresult: SpeechRecognitionLike["onresult"] = null;
  onerror: SpeechRecognitionLike["onerror"] = null;
  onend: SpeechRecognitionLike["onend"] = null;
  started = 0;
  stopped = 0;
  aborted = 0;
  #processLocally: boolean | undefined;

  constructor() {
    FakeRecognition.instances.push(this);
  }
  get processLocally(): boolean | undefined {
    return this.#processLocally;
  }
  set processLocally(value: boolean | undefined) {
    if (FakeRecognition.acceptsProcessLocally) this.#processLocally = value;
  }
  start() {
    this.started++;
  }
  stop() {
    this.stopped++;
  }
  abort() {
    this.aborted++;
  }
  static async available(options: unknown) {
    FakeRecognition.availableCalls.push(options);
    return FakeRecognition.status;
  }
  static async install() {
    if (FakeRecognition.installResult) FakeRecognition.status = "available";
    return FakeRecognition.installResult;
  }
  static reset() {
    FakeRecognition.instances = [];
    FakeRecognition.status = "available";
    FakeRecognition.installResult = true;
    FakeRecognition.acceptsProcessLocally = true;
    FakeRecognition.availableCalls = [];
  }
}

const Recognition = FakeRecognition as unknown as SpeechRecognitionConstructor;
const lastRecognition = () => FakeRecognition.instances[FakeRecognition.instances.length - 1];

class FakeRecorder implements MediaRecorderLike {
  static instances: FakeRecorder[] = [];
  state = "inactive";
  mimeType = "audio/webm;codecs=opus";
  ondataavailable: MediaRecorderLike["ondataavailable"] = null;
  onstop: MediaRecorderLike["onstop"] = null;
  onerror: MediaRecorderLike["onerror"] = null;
  constructor() {
    FakeRecorder.instances.push(this);
  }
  static isTypeSupported(type: string) {
    return type === "audio/webm;codecs=opus";
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    queueMicrotask(() => this.onstop?.());
  }
  push(bytes: number) {
    this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)], { type: this.mimeType }) });
  }
}

function microphone() {
  const track = { stop: vi.fn() };
  return { track, getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) };
}

function environment(overrides: Partial<VoiceEnvironment> = {}): VoiceEnvironment {
  return {
    isSecureContext: true,
    SpeechRecognition: Recognition,
    getUserMedia: microphone().getUserMedia,
    MediaRecorder: FakeRecorder as unknown as VoiceEnvironment["MediaRecorder"],
    ...overrides,
  };
}

afterEach(() => {
  FakeRecognition.reset();
  FakeRecorder.instances = [];
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// --- Local support --------------------------------------------------------------------------------------------------

describe("checking for verified on-device recognition", () => {
  it("asks about the es-MX pack with local processing required", async () => {
    await expect(checkLocalSupport(environment())).resolves.toEqual({ kind: "ready" });
    expect(FakeRecognition.availableCalls).toEqual([{ langs: ["es-MX"], processLocally: true }]);
  });

  it.each([
    ["downloadable", { kind: "downloadable" }],
    ["downloading", { kind: "downloading" }],
    ["unavailable", { kind: "unsupported", reason: "language-unavailable" }],
  ])("reports the pack status %s", async (status, expected) => {
    FakeRecognition.status = status;
    await expect(checkLocalSupport(environment())).resolves.toEqual(expected);
  });

  it("treats a browser without the local-recognition API as unsupported, never as a fallback", async () => {
    // Safari: only `webkitSpeechRecognition` exists, which is deliberately ignored.
    await expect(checkLocalSupport(environment({ SpeechRecognition: undefined })))
      .resolves.toEqual({ kind: "unsupported", reason: "no-local-recognition" });

    class NoLocalFlag {
      static available = async () => "available";
    }
    await expect(checkLocalSupport(environment({ SpeechRecognition: NoLocalFlag as unknown as SpeechRecognitionConstructor })))
      .resolves.toEqual({ kind: "unsupported", reason: "no-local-recognition" });

    class NoAvailable {
      processLocally = false;
    }
    await expect(checkLocalSupport(environment({ SpeechRecognition: NoAvailable as unknown as SpeechRecognitionConstructor })))
      .resolves.toEqual({ kind: "unsupported", reason: "no-local-recognition" });
  });

  it("reports insecure contexts, missing microphone APIs, and failed checks", async () => {
    await expect(checkLocalSupport(environment({ isSecureContext: false })))
      .resolves.toEqual({ kind: "unsupported", reason: "insecure-context" });
    await expect(checkLocalSupport(environment({ getUserMedia: undefined })))
      .resolves.toEqual({ kind: "unsupported", reason: "no-microphone-api" });
    vi.spyOn(FakeRecognition, "available").mockRejectedValueOnce(new Error("boom"));
    await expect(checkLocalSupport(environment())).resolves.toEqual({ kind: "unsupported", reason: "check-failed" });
  });

  it("installs the pack on request and re-checks it", async () => {
    FakeRecognition.status = "downloadable";
    await expect(installLocalPack(environment())).resolves.toEqual({ kind: "ready" });
    FakeRecognition.status = "downloadable";
    FakeRecognition.installResult = false;
    await expect(installLocalPack(environment()))
      .resolves.toEqual({ kind: "unsupported", reason: "language-unavailable" });
  });
});

// --- Local dictation --------------------------------------------------------------------------------------------

describe("on-device dictation", () => {
  it("starts only with es-MX and processLocally accepted, and delivers the transcript on stop", () => {
    const onFinish = vi.fn();
    const started = startLocalDictation(environment(), { onFinish });
    expect(started.ok).toBe(true);
    const recognition = lastRecognition();
    expect(recognition).toMatchObject({ lang: "es-MX", continuous: true, interimResults: true, started: 1 });
    expect(recognition.processLocally).toBe(true);

    recognition.onresult?.({ results: results(["receta de pozole", true], ["rinde ocho porcio", false]) });
    if (started.ok) started.session.stop();
    recognition.onend?.();
    expect(onFinish).toHaveBeenCalledExactlyOnceWith({ transcript: "receta de pozole rinde ocho porcio" });
  });

  it("refuses to start when the browser does not accept processLocally", () => {
    FakeRecognition.acceptsProcessLocally = false;
    const started = startLocalDictation(environment(), { onFinish: vi.fn() });
    expect(started).toEqual({ ok: false, failure: "failed" });
    expect(lastRecognition().started).toBe(0);
  });

  it.each([
    ["not-allowed", "denied"],
    ["service-not-allowed", "denied"],
    ["audio-capture", "no-microphone"],
    ["language-not-supported", "language-unavailable"],
    ["network", "failed"],
  ])("maps the %s error to %s and keeps what was captured", (code, failure) => {
    const onFinish = vi.fn();
    startLocalDictation(environment(), { onFinish });
    const recognition = lastRecognition();
    recognition.onresult?.({ results: results(["dos tazas de harina", true]) });
    recognition.onerror?.({ error: code });
    expect(onFinish).toHaveBeenCalledExactlyOnceWith({ transcript: "dos tazas de harina", failure });
    expect(FakeRecognition.instances).toHaveLength(1);
  });

  it("continues across browser-ended sessions and keeps earlier text", () => {
    const onFinish = vi.fn();
    const started = startLocalDictation(environment(), { onFinish });
    lastRecognition().onresult?.({ results: results(["tres huevos", true]) });
    lastRecognition().onend?.();
    expect(FakeRecognition.instances).toHaveLength(2);
    expect(lastRecognition().started).toBe(1);
    lastRecognition().onresult?.({ results: results(["una pizca de sal", true]) });
    if (started.ok) started.session.stop();
    lastRecognition().onend?.();
    expect(onFinish).toHaveBeenCalledExactlyOnceWith({ transcript: "tres huevos una pizca de sal" });
  });

  it("reports an interruption after repeated silent restarts", () => {
    const onFinish = vi.fn();
    startLocalDictation(environment(), { onFinish });
    lastRecognition().onresult?.({ results: results(["medio kilo de frijol", true]) });
    for (let i = 0; i < 5 && !onFinish.mock.calls.length; i++) lastRecognition().onend?.();
    expect(onFinish).toHaveBeenCalledExactlyOnceWith({ transcript: "medio kilo de frijol", failure: "interrupted" });
  });

  it("ends a stop that the browser never confirms", () => {
    vi.useFakeTimers();
    const onFinish = vi.fn();
    const started = startLocalDictation(environment(), { onFinish });
    lastRecognition().onresult?.({ results: results(["sal al gusto", true]) });
    if (started.ok) started.session.stop();
    vi.advanceTimersByTime(4000);
    expect(onFinish).toHaveBeenCalledExactlyOnceWith({ transcript: "sal al gusto" });
  });

  it("discards everything on cancel", () => {
    const onFinish = vi.fn();
    const started = startLocalDictation(environment(), { onFinish });
    lastRecognition().onresult?.({ results: results(["algo privado", true]) });
    if (started.ok) started.session.cancel();
    expect(lastRecognition().aborted).toBe(1);
    expect(onFinish).not.toHaveBeenCalled();
  });
});

// --- Cloud ---------------------------------------------------------------------------------------------------------

describe("cloud configuration", () => {
  it("is inactive without a valid public endpoint", () => {
    expect(resolveCloudConfig({})).toBeUndefined();
    for (const url of ["", "ftp://x.example/a", "http://stt.example/a", "//evil.example/a", "https://user:pw@stt.example/a",
      "https://stt.example/a?apikey=1", "not a url"]) {
      expect(resolveCloudConfig({ VITE_CLOUD_TRANSCRIPTION_URL: url })).toBeUndefined();
    }
  });

  it("accepts https, same-origin paths, and local development URLs", () => {
    for (const url of ["https://stt.example/transcribe", "/api/transcribe", "http://localhost:8787/transcribe"]) {
      expect(resolveCloudConfig({ VITE_CLOUD_TRANSCRIPTION_URL: url })?.endpoint).toBeTruthy();
    }
    expect(resolveCloudConfig({
      VITE_CLOUD_TRANSCRIPTION_URL: "https://stt.example/transcribe",
      VITE_CLOUD_TRANSCRIPTION_PROVIDER: "Servicio de prueba",
      VITE_CLOUD_TRANSCRIPTION_RETENTION: "No guarda el audio.",
      VITE_CLOUD_TRANSCRIPTION_MAX_SECONDS: "60",
      VITE_CLOUD_TRANSCRIPTION_MAX_MB: "4",
    })).toMatchObject({
      providerLabel: "Servicio de prueba",
      retentionNote: "No guarda el audio.",
      maxDurationMs: 60_000,
      maxBytes: 4 * 1024 * 1024,
    });
  });
});

describe("cloud transcription request", () => {
  const config = resolveCloudConfig({ VITE_CLOUD_TRANSCRIPTION_URL: "https://stt.example/transcribe" }) as CloudTranscriptionConfig;
  const audio = new Blob([new Uint8Array(10)], { type: "audio/webm;codecs=opus" });

  it("does nothing without configuration", async () => {
    const fetchSpy = vi.fn();
    await expect(transcribeInCloud(undefined, audio, { fetch: fetchSpy as unknown as typeof fetch }))
      .resolves.toEqual({ ok: false, failure: "inactive" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts only the audio, with no credentials or keys, and returns the transcript", async () => {
    const fetchSpy = vi.fn(async () => Response.json({ transcript: "dos tazas de harina" }));
    await expect(transcribeInCloud(config, audio, { fetch: fetchSpy as unknown as typeof fetch }))
      .resolves.toEqual({ ok: true, transcript: "dos tazas de harina" });
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://stt.example/transcribe");
    expect(init).toMatchObject({ method: "POST", body: audio, credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" });
    expect(init.headers).toEqual({
      "Content-Type": "audio/webm;codecs=opus", Accept: "application/json", "Accept-Language": "es-MX",
    });
  });

  it.each([
    [413, "too-large"], [415, "unsupported-audio"], [429, "quota"], [503, "unavailable"], [400, "rejected"],
  ])("maps HTTP %i to %s", async (status, failure) => {
    const fetchSpy = vi.fn(async () => new Response("", { status }));
    await expect(transcribeInCloud(config, audio, { fetch: fetchSpy as unknown as typeof fetch }))
      .resolves.toEqual({ ok: false, failure });
  });

  it("rejects an oversized recording before sending, and reports network and malformed answers", async () => {
    const fetchSpy = vi.fn(async () => Response.json({ text: "x" }));
    const big = { ...config, maxBytes: 5 };
    await expect(transcribeInCloud(big, audio, { fetch: fetchSpy as unknown as typeof fetch }))
      .resolves.toEqual({ ok: false, failure: "too-large" });
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(transcribeInCloud(config, audio, { fetch: fetchSpy as unknown as typeof fetch }))
      .resolves.toEqual({ ok: false, failure: "bad-response" });
    const offline = vi.fn(async () => { throw new TypeError("offline"); });
    await expect(transcribeInCloud(config, audio, { fetch: offline as unknown as typeof fetch }))
      .resolves.toEqual({ ok: false, failure: "network" });
  });
});

// --- Recorder --------------------------------------------------------------------------------------------------------

describe("microphone recording for the cloud path", () => {
  const limits = { maxDurationMs: 60_000, maxBytes: 1_000 };

  it.each([
    ["NotAllowedError", "denied"], ["SecurityError", "denied"], ["NotFoundError", "no-microphone"],
    ["NotReadableError", "failed"],
  ])("maps %s to %s", async (name, failure) => {
    const getUserMedia = vi.fn(async () => { throw Object.assign(new Error("x"), { name }); });
    await expect(startRecording(environment({ getUserMedia }), limits)).resolves.toEqual({ ok: false, failure });
  });

  it("records into memory and releases the microphone on stop", async () => {
    const mic = microphone();
    const started = await startRecording(environment({ getUserMedia: mic.getUserMedia }), limits);
    if (!started.ok) throw new Error("expected recording");
    FakeRecorder.instances[0].push(100);
    const recording = await started.session.stop();
    expect(recording?.audio.size).toBe(100);
    expect(recording?.audio.type).toBe("audio/webm;codecs=opus");
    expect(mic.track.stop).toHaveBeenCalled();
  });

  it("stops by itself at the size limit and drops the audio on cancel", async () => {
    const mic = microphone();
    const started = await startRecording(environment({ getUserMedia: mic.getUserMedia }), limits);
    if (!started.ok) throw new Error("expected recording");
    FakeRecorder.instances[0].push(2_000);
    await expect(started.session.finished).resolves.toMatchObject({ limitReached: true });

    const second = await startRecording(environment({ getUserMedia: mic.getUserMedia }), limits);
    if (!second.ok) throw new Error("expected recording");
    FakeRecorder.instances[1].push(10);
    second.session.cancel();
    await expect(second.session.finished).resolves.toBeUndefined();
  });
});

// --- Workflow --------------------------------------------------------------------------------------------------------

const cloudConfig = resolveCloudConfig({
  VITE_CLOUD_TRANSCRIPTION_URL: "https://stt.example/transcribe",
  VITE_CLOUD_TRANSCRIPTION_PROVIDER: "Servicio de prueba",
}) as CloudTranscriptionConfig;

function workflow(env: VoiceEnvironment, cloud?: CloudTranscriptionConfig) {
  const states: VoiceState[] = [];
  const drafts: CapturedRecipe[] = [];
  const controller = new VoiceController({
    env, cloud, onDraft: (draft) => drafts.push(draft), onState: (state) => states.push(state),
  });
  return { controller, states, drafts };
}

describe("dictation workflow", () => {
  it("turns an on-device dictation into a draft and then forgets the text", async () => {
    const { controller, states, drafts } = workflow(environment());
    await controller.check();
    controller.startLocal();
    lastRecognition().onresult?.({
      results: results(["receta de guacamole para cuatro personas ingredientes tres aguacates primero aplasta los aguacates", true]),
    });
    controller.stop();
    lastRecognition().onend?.();

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ name: "Guacamole", portions: 4 });
    expect(drafts[0].steps).toEqual(["Aplasta los aguacates."]);
    expect(states.at(-1)).toMatchObject({ phase: "idle" });
    controller.useCaptured();
    expect(states.at(-1)).toMatchObject({ phase: "failed", failure: "empty" });
  });

  it("exposes the live transcript only when asked", async () => {
    const seen: VoiceState[] = [];
    const controller = new VoiceController({
      env: environment(), onDraft: vi.fn(), onState: (state) => seen.push(state), exposeTranscript: true,
    });
    await controller.check();
    controller.startLocal();
    lastRecognition().onresult?.({ results: results(["hola", false]) });
    expect(seen.at(-1)).toMatchObject({ phase: "recording", liveTranscript: "hola" });

    const hidden = workflow(environment());
    await hidden.controller.check();
    hidden.controller.startLocal();
    lastRecognition().onresult?.({ results: results(["hola", false]) });
    expect(JSON.stringify(hidden.states)).not.toContain("hola");
  });

  it("offers what was captured after the microphone is denied mid-dictation", async () => {
    const { controller, states, drafts } = workflow(environment());
    await controller.check();
    controller.startLocal();
    lastRecognition().onresult?.({ results: results(["dos huevos y una taza de leche", true]) });
    lastRecognition().onerror?.({ error: "not-allowed" });
    expect(states.at(-1)).toEqual({ phase: "failed", failure: "denied", hasCaptured: true });
    controller.useCaptured();
    expect(drafts[0].ingredients.map((item) => item.name)).toEqual(["Huevos", "Leche"]);
  });

  it("does not use the microphone or start recognition when local support is unverified", async () => {
    const env = environment({ SpeechRecognition: undefined });
    const { controller, states } = workflow(env);
    await controller.check();
    expect(states.at(-1)).toMatchObject({
      phase: "idle", local: { kind: "unsupported", reason: "no-local-recognition" }, canRecordForCloud: false,
    });
    controller.startLocal();
    expect(FakeRecognition.instances).toHaveLength(0);
    expect(env.getUserMedia).not.toHaveBeenCalled();
  });

  it("downloads the pack only when asked, then allows dictation", async () => {
    FakeRecognition.status = "downloadable";
    const { controller, states } = workflow(environment());
    await controller.check();
    expect(states.at(-1)).toMatchObject({ phase: "idle", local: { kind: "downloadable" } });
    controller.startLocal();
    expect(FakeRecognition.instances).toHaveLength(0);
    await controller.installLocalPack();
    expect(states.at(-1)).toMatchObject({ phase: "idle", local: { kind: "ready" } });
  });

  it("lets the user continue by typing or without voice", async () => {
    const { controller, drafts } = workflow(environment({ SpeechRecognition: undefined }));
    await controller.check();
    controller.submitText("Receta de caldo. Ingredientes: dos litros de agua.");
    expect(drafts[0].ingredients[0].amount).toMatchObject({ kind: "measured", unit: "liter" });
    controller.continueManually();
    expect(drafts[1]).toEqual({ ingredients: [], steps: [] });
  });

  it("records for the cloud without sending anything until the user approves that recording", async () => {
    const fetchSpy = vi.fn(async () => Response.json({ transcript: "tacos de canasta para seis personas" }));
    const mic = microphone();
    const env = environment({
      SpeechRecognition: undefined, getUserMedia: mic.getUserMedia, fetch: fetchSpy as unknown as typeof fetch,
    });
    const { controller, states, drafts } = workflow(env, cloudConfig);
    await controller.check();
    expect(states.at(-1)).toMatchObject({ phase: "idle", canRecordForCloud: true });

    await controller.startCloudRecording();
    FakeRecorder.instances[0].push(500);
    controller.stop();
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ phase: "approve-cloud", providerLabel: "Servicio de prueba" }));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mic.track.stop).toHaveBeenCalled();

    await controller.sendToCloud();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(drafts[0]).toMatchObject({ name: "Tacos de canasta", portions: 6 });
  });

  it("discards a cloud recording the user declines, and never sends it", async () => {
    const fetchSpy = vi.fn();
    const env = environment({ SpeechRecognition: undefined, fetch: fetchSpy as unknown as typeof fetch });
    const { controller, states } = workflow(env, cloudConfig);
    await controller.check();
    await controller.startCloudRecording();
    FakeRecorder.instances[0].push(500);
    controller.stop();
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ phase: "approve-cloud" }));
    controller.cancel();
    await controller.sendToCloud();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(states.at(-1)).toMatchObject({ phase: "idle" });
  });

  it("keeps cloud inactive without configuration and reports cloud failures", async () => {
    const env = environment({ SpeechRecognition: undefined });
    const inactive = workflow(env);
    await inactive.controller.check();
    expect(inactive.states.at(-1)).toMatchObject({ phase: "idle", canRecordForCloud: false });
    expect(inactive.states.at(-1)).not.toHaveProperty("cloud");
    await inactive.controller.startCloudRecording();
    expect(inactive.states.at(-1)).toMatchObject({ phase: "failed", failure: "unavailable" });

    const quota = vi.fn(async () => new Response("", { status: 429 }));
    const { controller, states } = workflow({ ...env, fetch: quota as unknown as typeof fetch }, cloudConfig);
    await controller.check();
    await controller.startCloudRecording();
    FakeRecorder.instances[0].push(10);
    controller.stop();
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ phase: "approve-cloud" }));
    await controller.sendToCloud();
    expect(states.at(-1)).toMatchObject({ phase: "failed", failure: "cloud-quota", hasCaptured: false });
  });

  it("never logs while handling dictation", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level));
    const { controller } = workflow(environment());
    await controller.check();
    controller.startLocal();
    lastRecognition().onresult?.({ results: results(["receta secreta de mole", true]) });
    lastRecognition().onerror?.({ error: "network" });
    controller.useCaptured();
    controller.dispose();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
