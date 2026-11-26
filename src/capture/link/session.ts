import { supabase } from "../../data/supabase-client";

/**
 * Default configuration for the importer, read from build-time public settings.
 * `VITE_RECIPE_IMPORT_URL` overrides the endpoint, which otherwise is the `import-recipe` function of
 * the configured Supabase project. Neither value is a secret.
 */
export function defaultImportEndpoint(): string | undefined {
  const explicit = import.meta.env.VITE_RECIPE_IMPORT_URL as string | undefined;
  if (explicit) return explicit;
  const project = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  return project ? `${project.replace(/\/+$/, "")}/functions/v1/import-recipe` : undefined;
}

/** The signed-in user's access token, or `undefined` when nobody is signed in or sync is not configured. */
export async function defaultAccessToken(): Promise<string | undefined> {
  if (!supabase) return undefined;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token;
}
