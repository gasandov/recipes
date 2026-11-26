export type VerifiedUser = { id: string };
export type VerifyUser = (accessToken: string) => Promise<VerifiedUser | undefined>;

/**
 * Confirms a Supabase Auth session by asking the Auth server about the bearer token.
 *
 * `verify_jwt` at the gateway only proves the token is signed by this project, and the public anon key
 * satisfies it. Asking `/auth/v1/user` fails for the anon key (it has no user) and for revoked or
 * expired sessions. Anonymous sign-in users are refused, so a throwaway session cannot use the importer.
 */
export function createSupabaseUserVerifier(options: {
  supabaseUrl: string;
  apiKey: string;
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}): VerifyUser {
  const endpoint = `${options.supabaseUrl.replace(/\/+$/, "")}/auth/v1/user`;
  return async (accessToken) => {
    if (!accessToken || accessToken.length > 4096) return undefined;
    try {
      const response = await options.fetch(endpoint, {
        method: "GET",
        headers: { apikey: options.apiKey, authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return undefined;
      }
      const user = (await response.json()) as { id?: unknown; is_anonymous?: unknown };
      if (typeof user.id !== "string" || user.id === "" || user.is_anonymous === true) return undefined;
      return { id: user.id };
    } catch {
      return undefined;
    }
  };
}

export function bearerToken(header: string | null): string | undefined {
  const match = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/.exec(header ?? "");
  return match?.[1];
}
