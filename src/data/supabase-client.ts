import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

export const supabase = url && publishableKey
  ? createClient(url, publishableKey, {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,
      flowType: "pkce",
    },
  })
  : undefined;

export async function fetchSupabaseFunction(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (!supabase || !url || !publishableKey) return new Response(null, { status: 401 });
  const target = new URL(input instanceof Request ? input.url : input, url);
  if (target.origin !== new URL(url).origin || !target.pathname.startsWith("/functions/v1/")) {
    return new Response(null, { status: 403 });
  }

  const { data } = await supabase.auth.getSession();
  if (!data.session) return new Response(null, { status: 401 });
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${data.session.access_token}`);
  headers.set("apikey", publishableKey);
  return fetch(target, { ...init, headers, credentials: "omit", redirect: "error" });
}
