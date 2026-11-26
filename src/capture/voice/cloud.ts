/**
 * Optional cloud transcription, used only when the user approves it for one recording.
 *
 * The app never holds a provider key. `VITE_CLOUD_TRANSCRIPTION_URL` names a small endpoint owned by the app owner
 * (for example an edge function) that keeps the provider credentials, checks quotas, and forwards the audio. Without
 * that variable the option does not exist.
 *
 * Request contract (see README.md in this folder):
 *
 *     POST {endpoint}
 *     Content-Type: the recorder's MIME type, such as `audio/webm;codecs=opus` or `audio/mp4`
 *     Accept: application/json
 *     Accept-Language: es-MX
 *     body: the raw audio bytes, at most `maxBytes`
 *
 *     200 { "transcript": string }
 *     413 too large · 415 unsupported audio · 429 quota exhausted · 5xx unavailable
 *
 * Authentication belongs to the app's function transport. The endpoint discards the audio and transcript after use.
 */
import { dictationLanguage } from "./environment";
import type { VoiceEnvironment } from "./environment";

export type CloudTranscriptionConfig = {
  endpoint: string;
  /** Name shown in the consent text, such as the provider or the app owner's service. */
  providerLabel: string;
  /** Optional plain-language retention statement shown before the user approves. */
  retentionNote?: string;
  maxBytes: number;
  maxDurationMs: number;
  timeoutMs: number;
};

export type CloudTranscriptionRequest = {
  method: "POST";
  url: string;
  headers: { "Content-Type": string; Accept: "application/json"; "Accept-Language": typeof dictationLanguage };
  body: Blob;
};

export type CloudTranscriptionResponse = { transcript: string };

export type CloudFailure =
  | "inactive"
  | "login-required"
  | "too-large"
  | "unsupported-audio"
  | "quota"
  | "unavailable"
  | "rejected"
  | "timeout"
  | "network"
  | "bad-response";

export type CloudResult = { ok: true; transcript: string } | { ok: false; failure: CloudFailure };

const defaultMaxSeconds = 180;
const defaultMaxMegabytes = 8;
const defaultTimeoutMs = 60_000;

function validEndpoint(value: string): string | undefined {
  const text = value.trim();
  if (!text) return undefined;
  if (text.startsWith("/") && !text.startsWith("//")) return text;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.username || url.password || url.search.toLowerCase().includes("key")) return undefined;
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol === "https:" || (url.protocol === "http:" && local)) return url.href;
  return undefined;
}

function positive(value: unknown, fallback: number): number {
  const parsed = typeof value === "string" ? Number(value) : typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Reads the public build-time settings. Returns `undefined` (inactive) when no valid endpoint is configured. */
export function resolveCloudConfig(source: Record<string, unknown>): CloudTranscriptionConfig | undefined {
  const raw = source.VITE_CLOUD_TRANSCRIPTION_URL;
  const endpoint = typeof raw === "string" ? validEndpoint(raw) : undefined;
  if (!endpoint) return undefined;
  const label = source.VITE_CLOUD_TRANSCRIPTION_PROVIDER;
  const retention = source.VITE_CLOUD_TRANSCRIPTION_RETENTION;
  return {
    endpoint,
    providerLabel: typeof label === "string" && label.trim() ? label.trim() : "el servicio de transcripción configurado",
    ...(typeof retention === "string" && retention.trim() ? { retentionNote: retention.trim() } : {}),
    maxBytes: Math.floor(positive(source.VITE_CLOUD_TRANSCRIPTION_MAX_MB, defaultMaxMegabytes) * 1024 * 1024),
    maxDurationMs: Math.floor(positive(source.VITE_CLOUD_TRANSCRIPTION_MAX_SECONDS, defaultMaxSeconds) * 1000),
    timeoutMs: defaultTimeoutMs,
  };
}

export function buildCloudRequest(config: CloudTranscriptionConfig, audio: Blob): CloudTranscriptionRequest {
  return {
    method: "POST",
    url: config.endpoint,
    headers: {
      "Content-Type": audio.type || "application/octet-stream",
      Accept: "application/json",
      "Accept-Language": dictationLanguage,
    },
    body: audio,
  };
}

function statusFailure(status: number): CloudFailure {
  if (status === 413) return "too-large";
  if (status === 415) return "unsupported-audio";
  if (status === 429) return "quota";
  if (status === 401) return "login-required";
  if (status >= 500) return "unavailable";
  return "rejected";
}

/** Sends one approved recording. The caller discards the audio afterward; nothing here keeps it. */
export async function transcribeInCloud(
  config: CloudTranscriptionConfig | undefined,
  audio: Blob,
  env: Pick<VoiceEnvironment, "fetch">,
  signal?: AbortSignal,
): Promise<CloudResult> {
  if (!config || !env.fetch) return { ok: false, failure: "inactive" };
  if (audio.size > config.maxBytes) return { ok: false, failure: "too-large" };

  const request = buildCloudRequest(config, audio);
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), config.timeoutMs);
  const cancel = () => timeout.abort();
  signal?.addEventListener("abort", cancel);
  try {
    const response = await env.fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: timeout.signal,
    });
    if (!response.ok) return { ok: false, failure: statusFailure(response.status) };
    const body = (await response.json()) as Partial<CloudTranscriptionResponse> | null;
    if (typeof body?.transcript !== "string") return { ok: false, failure: "bad-response" };
    return { ok: true, transcript: body.transcript };
  } catch {
    return { ok: false, failure: signal?.aborted || timeout.signal.aborted ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}
