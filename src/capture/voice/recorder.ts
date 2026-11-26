import type { MediaRecorderLike, MediaStreamLike, VoiceEnvironment } from "./environment";

export type RecorderFailure = "denied" | "no-microphone" | "failed";

export type Recording = {
  audio: Blob;
  /** The recording stopped by itself at the configured limit. */
  limitReached: boolean;
};

export interface RecorderSession {
  /** Resolves when recording ends for any reason, including the size or duration limit. */
  finished: Promise<Recording | undefined>;
  /** Stops and resolves with the audio, or `undefined` when nothing was captured. */
  stop(): Promise<Recording | undefined>;
  /** Stops and discards the audio. */
  cancel(): void;
}

export type RecorderStart = { ok: true; session: RecorderSession } | { ok: false; failure: RecorderFailure };

const preferredTypes = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"];

function mapMicrophoneError(error: unknown): RecorderFailure {
  const name = typeof error === "object" && error !== null && "name" in error ? String(error.name) : "";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") {
    return "no-microphone";
  }
  return "failed";
}

/** Records the microphone into memory. Nothing is sent or stored; the audio lives in the returned Blob only. */
export async function startRecording(
  env: VoiceEnvironment,
  limits: { maxDurationMs: number; maxBytes: number },
): Promise<RecorderStart> {
  if (!env.getUserMedia || !env.MediaRecorder) return { ok: false, failure: "failed" };

  let stream: MediaStreamLike;
  try {
    stream = await env.getUserMedia({ audio: true });
  } catch (error) {
    return { ok: false, failure: mapMicrophoneError(error) };
  }

  const releaseMicrophone = () => stream.getTracks().forEach((track) => track.stop());
  let recorder: MediaRecorderLike;
  try {
    const Recorder = env.MediaRecorder;
    const mimeType = preferredTypes.find((type) => Recorder.isTypeSupported?.(type));
    recorder = new Recorder(stream, mimeType ? { mimeType } : undefined);
  } catch {
    releaseMicrophone();
    return { ok: false, failure: "failed" };
  }

  let chunks: Blob[] = [];
  let bytes = 0;
  let limitReached = false;
  let discard = false;
  let settle: ((recording: Recording | undefined) => void) | undefined;
  const stopped = new Promise<Recording | undefined>((resolve) => (settle = resolve));
  const timer = setTimeout(() => {
    limitReached = true;
    requestStop();
  }, limits.maxDurationMs);

  function requestStop(): void {
    clearTimeout(timer);
    if (recorder.state === "inactive") return;
    try {
      recorder.stop();
    } catch {
      settle?.(undefined);
    }
  }

  recorder.ondataavailable = (event) => {
    if (event.data.size === 0) return;
    chunks.push(event.data);
    bytes += event.data.size;
    if (bytes >= limits.maxBytes) {
      limitReached = true;
      requestStop();
    }
  };
  recorder.onerror = () => {
    clearTimeout(timer);
    releaseMicrophone();
    chunks = [];
    settle?.(undefined);
  };
  recorder.onstop = () => {
    clearTimeout(timer);
    releaseMicrophone();
    const type = recorder.mimeType || chunks[0]?.type || "";
    const audio = discard || chunks.length === 0 ? undefined : new Blob(chunks, { type });
    chunks = [];
    settle?.(audio ? { audio, limitReached } : undefined);
  };

  try {
    recorder.start(1000);
  } catch {
    clearTimeout(timer);
    releaseMicrophone();
    return { ok: false, failure: "failed" };
  }

  return {
    ok: true,
    session: {
      finished: stopped,
      stop() {
        requestStop();
        return stopped;
      },
      cancel() {
        discard = true;
        chunks = [];
        requestStop();
        if (recorder.state === "inactive") releaseMicrophone();
      },
    },
  };
}
