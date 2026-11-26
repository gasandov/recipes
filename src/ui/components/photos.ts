import { createSignal } from "solid-js";
import { repository } from "../../data/repository";

// A library restore can replace the bytes of a photo while keeping its ID.
const urls = new Map<string, Promise<string | undefined>>();
const [revision, setRevision] = createSignal(0);

export function invalidatePhotoUrls(): void {
  const invalidated = [...urls.values()];
  urls.clear();
  setRevision((current) => current + 1);
  for (const pending of invalidated) {
    void pending.then((url) => {
      if (url) URL.revokeObjectURL(url);
    });
  }
}

export function loadPhotoUrl(id: string): Promise<string | undefined> {
  revision();
  let url = urls.get(id);
  if (!url) {
    url = repository
      .getPhoto(id)
      .then((photo) => (photo ? URL.createObjectURL(photo.blob) : undefined))
      .catch((error: unknown) => {
        console.error("Could not read a stored photo.", error);
        if (urls.get(id) === url) urls.delete(id);
        return undefined;
      });
    urls.set(id, url);
  }
  return url;
}
