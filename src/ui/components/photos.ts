import { repository } from "../../data/repository";

// Photo IDs are never reused by the repository, so a cached object URL cannot go stale.
const urls = new Map<string, Promise<string | undefined>>();

export function loadPhotoUrl(id: string): Promise<string | undefined> {
  let url = urls.get(id);
  if (!url) {
    url = repository
      .getPhoto(id)
      .then((photo) => (photo ? URL.createObjectURL(photo.blob) : undefined))
      .catch((error: unknown) => {
        console.error("Could not read a stored photo.", error);
        urls.delete(id);
        return undefined;
      });
    urls.set(id, url);
  }
  return url;
}
