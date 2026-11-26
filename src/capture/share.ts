import { normalizeSourceUrl } from "../domain";

const urlParameter = "recipe-share-url";
const textParameter = "recipe-share-text";
let pendingSourceUrl: string | undefined;

export function receiveSharedRecipe(location: URL): { location: URL; sourceUrl?: string } | undefined {
  const url = location.searchParams.get(urlParameter);
  const text = location.searchParams.get(textParameter);
  if (url === null && text === null) return undefined;

  let sourceUrl: string | undefined;
  for (const candidate of [url, text?.match(/https?:\/\/[^\s<>"']+/i)?.[0]]) {
    if (!candidate) continue;
    try {
      sourceUrl = normalizeSourceUrl(candidate);
      if (sourceUrl) break;
    } catch {
      // Keep the import entry point available when shared text has no valid URL.
    }
  }
  const destination = new URL(location);
  destination.searchParams.delete(urlParameter);
  destination.searchParams.delete(textParameter);
  destination.hash = "/recetas/capturar";
  return { location: destination, sourceUrl };
}

export function prepareIncomingRecipeShare(): void {
  const incoming = receiveSharedRecipe(new URL(window.location.href));
  if (!incoming) return;
  pendingSourceUrl = incoming.sourceUrl;
  window.history.replaceState(window.history.state, "", incoming.location);
}

export function takeSharedRecipeUrl(): string | undefined {
  const url = pendingSourceUrl;
  pendingSourceUrl = undefined;
  return url;
}
