import { dictationLanguage } from "./environment";
import type { SpeechRecognitionLike, VoiceEnvironment } from "./environment";
import { TranscriptBuffer } from "./transcript";

export type DictationFailure =
  | "denied"
  | "no-microphone"
  | "language-unavailable"
  | "interrupted"
  | "failed";

export type DictationResult = {
  /** Everything recognized so far, also when `failure` is set. Held in memory by the caller only. */
  transcript: string;
  failure?: DictationFailure;
};

export interface DictationSession {
  /** Ends the dictation and delivers the transcript through `onFinish`. */
  stop(): void;
  /** Ends the dictation and discards everything without calling `onFinish`. */
  cancel(): void;
}

export type LocalStart = { ok: true; session: DictationSession } | { ok: false; failure: DictationFailure };

export type LocalOptions = {
  /** Receives the running transcript. Used only for development displays. */
  onText?: (text: string) => void;
  onFinish: (result: DictationResult) => void;
};

const maxRestarts = 30;
const maxSilentRestarts = 3;
const stopGraceMs = 4000;

function mapError(code: string): DictationFailure | "ignore" {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "denied";
    case "audio-capture":
      return "no-microphone";
    case "language-not-supported":
      return "language-unavailable";
    case "no-speech":
    case "aborted":
      return "ignore";
    // `network` means the browser tried to reach a remote service. It is never retried.
    default:
      return "failed";
  }
}

/**
 * Starts recognition that must run on the device. The recognizer is only started when `processLocally` is accepted;
 * otherwise nothing is started, because a recognizer without it may send audio to the browser vendor.
 */
export function startLocalDictation(env: VoiceEnvironment, options: LocalOptions): LocalStart {
  const Recognition = env.SpeechRecognition;
  if (!Recognition) return { ok: false, failure: "failed" };

  const buffer = new TranscriptBuffer();
  let recognition: SpeechRecognitionLike | undefined;
  let stopping = false;
  let finished = false;
  let failure: DictationFailure | undefined;
  let restarts = 0;
  let silentRestarts = 0;
  let sawText = false;

  function release(instance: SpeechRecognitionLike | undefined): void {
    if (!instance) return;
    instance.onresult = null;
    instance.onerror = null;
    instance.onend = null;
  }

  function finish(): void {
    if (finished) return;
    finished = true;
    buffer.commit();
    const result: DictationResult = { transcript: buffer.text(), ...(failure ? { failure } : {}) };
    release(recognition);
    recognition = undefined;
    buffer.clear();
    options.onFinish(result);
  }

  function create(): SpeechRecognitionLike | undefined {
    const instance = new Recognition!();
    instance.lang = dictationLanguage;
    instance.continuous = true;
    instance.interimResults = true;
    instance.maxAlternatives = 1;
    instance.processLocally = true;
    if (instance.processLocally !== true) return undefined;

    instance.onresult = (event) => {
      buffer.update(event.results);
      const text = buffer.text();
      if (text) sawText = true;
      options.onText?.(text);
    };
    instance.onerror = (event) => {
      const mapped = mapError(event.error);
      if (mapped === "ignore") return;
      failure ??= mapped;
      if (mapped === "failed" || mapped === "denied" || mapped === "no-microphone" || mapped === "language-unavailable") {
        try {
          instance.abort();
        } catch {
          // The recognizer is already stopped.
        }
        finish();
      }
    };
    instance.onend = () => {
      if (finished) return;
      if (stopping || failure) {
        finish();
        return;
      }
      // Browsers end long or silent sessions on their own. Continue with what was captured.
      buffer.commit();
      silentRestarts = sawText ? 0 : silentRestarts + 1;
      sawText = false;
      restarts++;
      if (restarts > maxRestarts || silentRestarts >= maxSilentRestarts) {
        failure = "interrupted";
        finish();
        return;
      }
      release(instance);
      recognition = create();
      try {
        recognition?.start();
      } catch {
        failure = "interrupted";
        finish();
        return;
      }
      if (!recognition) {
        failure = "failed";
        finish();
      }
    };
    return instance;
  }

  recognition = create();
  if (!recognition) return { ok: false, failure: "failed" };
  try {
    recognition.start();
  } catch {
    release(recognition);
    return { ok: false, failure: "failed" };
  }

  return {
    ok: true,
    session: {
      stop() {
        if (finished || stopping) return;
        stopping = true;
        try {
          recognition?.stop();
        } catch {
          finish();
          return;
        }
        // Some browsers never report the end of a stopped session; do not wait forever.
        setTimeout(finish, stopGraceMs);
      },
      cancel() {
        if (finished) return;
        finished = true;
        const active = recognition;
        release(active);
        recognition = undefined;
        try {
          active?.abort();
        } catch {
          // Nothing to stop.
        }
        buffer.clear();
      },
    },
  };
}
