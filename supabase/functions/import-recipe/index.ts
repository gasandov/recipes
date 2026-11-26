// Supabase Edge Function entry point. All logic lives in handler.ts so it can be tested without Deno.
//
// Configuration (set with `supabase secrets set`, never in the app bundle):
//   IMPORT_ALLOWED_ORIGINS        comma-separated browser origins, e.g. https://gasandov.github.io
//   IMPORT_ALLOWED_HOSTS          comma-separated trusted recipe hosts
//   IMPORT_ALLOW_MISSING_ORIGIN   "true" only for local smoke tests without a browser
// Supabase provides SUPABASE_URL and SUPABASE_ANON_KEY automatically.
import { createSupabaseUserVerifier } from "../_shared/auth.ts";
import { createHandler } from "./handler.ts";
import { parseHostList } from "./guard.ts";

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Response | Promise<Response>): unknown;
  resolveDns?: (name: string, type: "A" | "AAAA") => Promise<string[]>;
};

const env = (name: string) => Deno.env.get(name);

async function resolveDns(hostname: string): Promise<string[]> {
  const resolve = Deno.resolveDns;
  if (typeof resolve !== "function") throw new Error("DNS resolution is not available in this runtime.");
  const answers = await Promise.all(
    (["A", "AAAA"] as const).map((type) =>
      // Only "no such record" means an empty answer. Permission or support errors are configuration
      // problems and must not look like an unreachable page.
      resolve(hostname, type).catch((error: unknown) => {
        if (error instanceof Error && error.name === "NotFound") return [] as string[];
        throw error;
      }),
    ),
  );
  return answers.flat();
}

/** Key sent as `apikey` to the Auth server: the legacy anon key, else the default publishable key. */
function apiKey(): string {
  const legacy = env("SUPABASE_ANON_KEY");
  if (legacy) return legacy;
  try {
    const keys = JSON.parse(env("SUPABASE_PUBLISHABLE_KEYS") ?? "{}") as Record<string, unknown>;
    if (typeof keys.default === "string") return keys.default;
  } catch {
    // Fall through to the explicit override.
  }
  return env("IMPORT_SUPABASE_API_KEY") ?? "";
}

const handler = createHandler(
  {
    allowedOrigins: parseHostList(env("IMPORT_ALLOWED_ORIGINS")).map((origin) => origin.replace(/\/+$/, "")),
    allowMissingOrigin: env("IMPORT_ALLOW_MISSING_ORIGIN") === "true",
    policy: {
      allowedHosts: parseHostList(env("IMPORT_ALLOWED_HOSTS")),
      allowAnyPublicHost: false,
    },
  },
  {
    fetch: (input, init) => fetch(input, init),
    resolveDns: typeof Deno.resolveDns === "function" ? resolveDns : undefined,
    verifyUser: createSupabaseUserVerifier({
      supabaseUrl: env("SUPABASE_URL") ?? "",
      apiKey: apiKey(),
      fetch: (input, init) => fetch(input, init),
    }),
  },
);

Deno.serve(handler);
