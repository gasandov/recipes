import { createSupabaseUserVerifier } from "../_shared/auth.ts";
import { createTranscriptionHandler, groqTranscriber } from "./handler.ts";

const backendUrl = Deno.env.get("SUPABASE_URL");
const publishableKey = Deno.env.get("SUPABASE_ANON_KEY");
const apiKey = Deno.env.get("GROQ_API_KEY");
const origins = (Deno.env.get("RECIPE_FUNCTION_ALLOWED_ORIGINS") ?? "http://localhost:5173,http://127.0.0.1:5173")
  .split(",").map((origin) => origin.trim()).filter(Boolean);

Deno.serve(createTranscriptionHandler({
  allowedOrigins: origins,
  authenticate: backendUrl && publishableKey
    ? createSupabaseUserVerifier({ supabaseUrl: backendUrl, apiKey: publishableKey, fetch })
    : async () => undefined,
  transcribe: apiKey ? groqTranscriber(apiKey) : undefined,
}));
