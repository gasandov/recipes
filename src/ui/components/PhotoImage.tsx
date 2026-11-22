import { createMemo, Loading, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { loadPhotoUrl } from "./photos";

type Props = {
  photoId: string | undefined;
  alt: string;
  fallback: JSX.Element;
};

/** Shows a stored photo, or the fallback when the recipe has none or it cannot be read. */
export function PhotoImage(props: Props) {
  const url = createMemo(() => (props.photoId ? loadPhotoUrl(props.photoId) : undefined));
  return (
    <Loading fallback={<div class="photo-pending" aria-hidden="true" />}>
      <Show when={url()} fallback={props.fallback}>
        {(source) => <img src={source()} alt={props.alt} decoding="async" />}
      </Show>
    </Loading>
  );
}
