import assert from "node:assert/strict";
import { createTranscriptionHandler, groqTranscriber } from "./handler.ts";

const origin = "http://localhost:5173";

function upload(headers: HeadersInit = {}, type = "audio/webm") {
  return new Request("http://localhost/transcribe-recipe", {
    method: "POST",
    headers: { "Content-Type": type, Origin: origin, ...headers },
    body: new Uint8Array([1, 2, 3]),
  });
}

Deno.test("accepts allowed users and returns the transcript with no caching", async () => {
  const handler = createTranscriptionHandler({
    allowedOrigins: [origin],
    authenticate: async (token) => token === "valid" ? { id: "user" } : undefined,
    transcribe: async (file) => {
      assert.equal(file.name, "recipe.webm");
      return "  Dos tazas de agua.  ";
    },
  });
  assert.equal((await handler(upload())).status, 401);
  assert.equal((await handler(upload({ Origin: "https://unknown.example", Authorization: "Bearer valid" }))).status, 403);
  const result = await handler(upload({ Origin: origin, Authorization: "Bearer valid" }));
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await result.json(), { transcript: "Dos tazas de agua." });
});

Deno.test("rejects unknown media and supports an unconfigured provider", async () => {
  const config = { allowedOrigins: [origin], authenticate: async () => ({ id: "user" }) };
  const headers = { Authorization: "Bearer valid" };
  assert.equal((await createTranscriptionHandler(config)(upload(headers))).status, 503);
  const handler = createTranscriptionHandler({ ...config, transcribe: async () => "unused" });
  assert.equal((await handler(upload(headers, "text/html"))).status, 415);
  assert.equal((await handler(upload({ ...headers, "Content-Length": String(9 * 1024 * 1024) }))).status, 413);
});

Deno.test("Groq adapter sends Spanish audio only to the configured provider endpoint", async () => {
  const fetchFixture: typeof fetch = async (url, options) => {
    assert.equal(url, "https://api.groq.com/openai/v1/audio/transcriptions");
    const form = options?.body;
    assert.ok(form instanceof FormData);
    assert.equal(form.get("language"), "es");
    assert.equal(form.get("model"), "whisper-large-v3-turbo");
    assert.ok(form.get("file") instanceof File);
    return Response.json({ text: "Una cucharada de canela." });
  };
  const service = groqTranscriber("fixture", fetchFixture);
  assert.equal(await service(new File(["audio"], "recording.webm")), "Una cucharada de canela.");
});
