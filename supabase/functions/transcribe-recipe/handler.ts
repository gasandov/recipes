import { bearerToken } from "../_shared/auth.ts";
import type { VerifyUser } from "../_shared/auth.ts";
import { createUserRateLimiter } from "../_shared/rate-limit.ts";
import { readRequestBody } from "../_shared/request-body.ts";

const maxUploadBytes = 8 * 1024 * 1024;
const audioTypes: Record<string, string> = {
  "audio/webm": "webm",
  "video/webm": "webm",
  "audio/mp4": "m4a",
  "video/mp4": "mp4",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mpeg": "mp3",
};

type Options = {
  allowedOrigins: readonly string[];
  authenticate: VerifyUser;
  transcribe?: (file: File) => Promise<string>;
};

class QuotaError extends Error {}

export function createTranscriptionHandler({ authenticate, transcribe, allowedOrigins }: Options) {
  const allowRate = createUserRateLimiter(5);
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get("origin");
    if (!origin || !allowedOrigins.includes(origin)) return new Response(null, { status: 403 });
    const headers = {
      "Cache-Control": "no-store",
      "Vary": "Origin",
      ...(origin ? {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Headers": "authorization, apikey, content-type, accept-language, x-client-info",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      } : {}),
    };
    const reply = (status: number, code: string) => Response.json({ code }, { status, headers });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "POST") return reply(405, "method_not_allowed");

    const token = bearerToken(request.headers.get("authorization"));
    if (!token) return reply(401, "login_required");
    let user;
    try {
      user = await authenticate(token);
    } catch {
      return reply(503, "auth_unavailable");
    }
    if (!user) return reply(401, "login_required");
    if (!transcribe) return reply(503, "transcription_unavailable");
    if (!allowRate(user.id)) return reply(429, "transcription_quota_exhausted");

    const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
    const extension = Object.hasOwn(audioTypes, contentType) ? audioTypes[contentType] : undefined;
    if (!extension) return reply(415, "unsupported_audio");

    let bytes: Uint8Array<ArrayBuffer> | undefined;
    try {
      bytes = await readRequestBody(request, maxUploadBytes);
    } catch {
      return reply(400, "invalid_audio");
    }
    if (!bytes) return reply(413, "audio_too_large");
    if (!bytes.byteLength) return reply(400, "invalid_audio");

    try {
      const transcript = (await transcribe(new File([bytes], `recipe.${extension}`, { type: contentType }))).trim();
      if (!transcript) return reply(422, "empty_transcript");
      return Response.json({ transcript }, { headers });
    } catch (error) {
      if (error instanceof QuotaError) return reply(429, "transcription_quota_exhausted");
      return reply(502, "transcription_failed");
    }
  };
}

export function groqTranscriber(apiKey: string, request: typeof fetch = fetch) {
  return async (file: File): Promise<string> => {
    const form = new FormData();
    form.set("file", file);
    form.set("model", "whisper-large-v3-turbo");
    form.set("language", "es");
    form.set("response_format", "json");
    const response = await request("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    if (response.status === 429) throw new QuotaError("Speech provider quota exhausted.");
    if (!response.ok) throw new Error("Speech provider rejected the request.");
    const result: unknown = await response.json();
    if (typeof result !== "object" || result === null || !("text" in result) || typeof result.text !== "string") {
      throw new Error("Speech provider returned an invalid transcript.");
    }
    return result.text;
  };
}
