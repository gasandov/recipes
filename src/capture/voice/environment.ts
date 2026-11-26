/**
 * Minimal structural types for the browser APIs used by voice capture. They are declared here, not taken from
 * lib.dom, because `SpeechRecognition.available()` and `processLocally` are not in every TypeScript DOM library, and
 * so tests can supply fakes without a DOM.
 */
export const dictationLanguage = "es-MX";

export type SpeechAlternativeLike = { transcript: string };
export type SpeechResultLike = { isFinal: boolean; length: number; [index: number]: SpeechAlternativeLike };
export type SpeechResultsLike = { length: number; [index: number]: SpeechResultLike };

export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  processLocally?: boolean;
  onresult: ((event: { results: SpeechResultsLike }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export type LocalPackStatus = "available" | "downloadable" | "downloading" | "unavailable";

export interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionLike;
  prototype: object;
  available?: (options: { langs: string[]; processLocally: boolean }) => Promise<string>;
  install?: (options: { langs: string[]; processLocally: boolean }) => Promise<boolean>;
}

export interface MediaTrackLike {
  stop(): void;
}
export interface MediaStreamLike {
  getTracks(): MediaTrackLike[];
}

export interface MediaRecorderLike {
  state: string;
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: (() => void) | null;
  start(timesliceMs?: number): void;
  stop(): void;
}

export interface MediaRecorderConstructor {
  new (stream: MediaStreamLike, options?: { mimeType?: string }): MediaRecorderLike;
  isTypeSupported?(mimeType: string): boolean;
}

/** Everything voice capture reads from the browser, so each part can be replaced in tests. */
export interface VoiceEnvironment {
  isSecureContext?: boolean;
  /** Only the unprefixed constructor counts: `webkitSpeechRecognition` cannot be verified as local. */
  SpeechRecognition?: SpeechRecognitionConstructor;
  getUserMedia?: (constraints: { audio: true }) => Promise<MediaStreamLike>;
  MediaRecorder?: MediaRecorderConstructor;
  fetch?: typeof fetch;
}

export function browserEnvironment(): VoiceEnvironment {
  const scope = globalThis as unknown as {
    isSecureContext?: boolean;
    SpeechRecognition?: SpeechRecognitionConstructor;
    MediaRecorder?: MediaRecorderConstructor;
    fetch?: typeof fetch;
    navigator?: { mediaDevices?: { getUserMedia?: (constraints: { audio: true }) => Promise<MediaStreamLike> } };
  };
  const devices = scope.navigator?.mediaDevices;
  return {
    isSecureContext: scope.isSecureContext,
    SpeechRecognition: scope.SpeechRecognition,
    MediaRecorder: scope.MediaRecorder,
    getUserMedia: devices?.getUserMedia ? (constraints) => devices.getUserMedia!(constraints) : undefined,
    fetch: scope.fetch ? scope.fetch.bind(globalThis) : undefined,
  };
}

export type LocalSupport =
  | { kind: "ready" }
  | { kind: "downloadable" }
  | { kind: "downloading" }
  | {
    kind: "unsupported";
    reason: "insecure-context" | "no-microphone-api" | "no-local-recognition" | "language-unavailable" | "check-failed";
  };

/**
 * Local recognition is trusted only when the browser can confirm it for es-MX. A browser without
 * `SpeechRecognition.available`, or without the `processLocally` flag, may send audio to a remote service,
 * so it is reported as unsupported instead of being used as a fallback.
 */
export async function checkLocalSupport(env: VoiceEnvironment): Promise<LocalSupport> {
  if (env.isSecureContext === false) return { kind: "unsupported", reason: "insecure-context" };
  if (!env.getUserMedia) return { kind: "unsupported", reason: "no-microphone-api" };

  const Recognition = env.SpeechRecognition;
  if (!Recognition || typeof Recognition.available !== "function" || !("processLocally" in Recognition.prototype)) {
    return { kind: "unsupported", reason: "no-local-recognition" };
  }

  try {
    const status = await Recognition.available({ langs: [dictationLanguage], processLocally: true });
    if (status === "available") return { kind: "ready" };
    if (status === "downloadable") return typeof Recognition.install === "function"
      ? { kind: "downloadable" }
      : { kind: "unsupported", reason: "language-unavailable" };
    if (status === "downloading") return { kind: "downloading" };
    return { kind: "unsupported", reason: "language-unavailable" };
  } catch {
    return { kind: "unsupported", reason: "check-failed" };
  }
}

/** Downloads the es-MX on-device pack. It must run from a user gesture and sends no audio. */
export async function installLocalPack(env: VoiceEnvironment): Promise<LocalSupport> {
  const Recognition = env.SpeechRecognition;
  if (!Recognition || typeof Recognition.install !== "function") {
    return { kind: "unsupported", reason: "no-local-recognition" };
  }
  try {
    const installed = await Recognition.install({ langs: [dictationLanguage], processLocally: true });
    if (!installed) return { kind: "unsupported", reason: "language-unavailable" };
  } catch {
    return { kind: "unsupported", reason: "language-unavailable" };
  }
  return checkLocalSupport(env);
}

export function canRecordAudio(env: VoiceEnvironment): boolean {
  return env.isSecureContext !== false && Boolean(env.getUserMedia) && typeof env.MediaRecorder === "function";
}
