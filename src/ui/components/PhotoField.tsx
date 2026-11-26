import { ActionIcon } from "./ActionIcon";
import {
  createSignal,
  createUniqueId,
  Match,
  onSettled,
  Show,
  Switch,
} from "solid-js";
import type { PhotoInput } from "../../contracts";
import { acceptedPhotoTypes, PhotoError, prepareLocalPhoto } from "../photo";
import { PhotoImage } from "./PhotoImage";

/** `keep` leaves the stored photo untouched, `remove` deletes it, and `replace` stores a new one. */
export type PhotoChoice =
  | { kind: "keep" }
  | { kind: "remove" }
  | { kind: "replace"; input: PhotoInput; previewUrl: string };

type Props = {
  existingPhotoId: string | undefined;
  choice: PhotoChoice;
  onChange: (choice: PhotoChoice) => void;
};

function releasePreview(choice: PhotoChoice): void {
  if (choice.kind === "replace") URL.revokeObjectURL(choice.previewUrl);
}

export function PhotoField(props: Props) {
  const fieldId = createUniqueId();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  let input: HTMLInputElement | undefined;

  onSettled(() => () => releasePreview(props.choice));

  const previewUrl = () =>
    props.choice.kind === "replace" ? props.choice.previewUrl : undefined;
  const hasPhoto = () =>
    props.choice.kind === "replace" ||
    (props.choice.kind === "keep" && props.existingPhotoId !== undefined);

  async function choose(file: File | undefined) {
    if (!file) return;
    setError("");
    setBusy(true);
    try {
      const prepared = await prepareLocalPhoto(file);
      releasePreview(props.choice);
      props.onChange({
        kind: "replace",
        input: prepared,
        previewUrl: URL.createObjectURL(prepared.blob),
      });
    } catch (failure) {
      console.error("Could not prepare the chosen photo.", failure);
      setError(
        failure instanceof PhotoError
          ? failure.userMessage
          : "No pudimos procesar la foto. Prueba con otra.",
      );
    } finally {
      setBusy(false);
    }
  }

  function remove() {
    setError("");
    releasePreview(props.choice);
    props.onChange(
      props.existingPhotoId !== undefined
        ? { kind: "remove" }
        : { kind: "keep" },
    );
  }

  return (
    <div class="field" role="group" aria-labelledby={`${fieldId}-label`}>
      <span class="label" id={`${fieldId}-label`}>
        Foto <span class="muted">(opcional)</span>
      </span>
      <div class="photo-field">
        <div class="photo-preview">
          <Switch fallback={<span class="photo-empty">Sin foto</span>}>
            <Match when={previewUrl()}>
              {(url) => <img src={url()} alt="Vista previa de la foto nueva" />}
            </Match>
            <Match
              when={
                props.choice.kind === "keep" &&
                props.existingPhotoId !== undefined
              }
            >
              <PhotoImage
                photoId={props.existingPhotoId}
                alt="Foto actual de la receta"
                fallback={
                  <span class="photo-empty">No se pudo cargar la foto</span>
                }
              />
            </Match>
          </Switch>
        </div>
        <div class="photo-actions">
          <button
            type="button"
            class="btn"
            disabled={busy()}
            onClick={() => input?.click()}
            title={hasPhoto() ? "Reemplazar foto" : "Elegir foto"}
          >
            <ActionIcon name="image" />
            <span class="sr-only">
              {hasPhoto() ? "Reemplazar foto" : "Elegir foto"}
            </span>
          </button>
          <Show when={hasPhoto()}>
            <button
              type="button"
              class="btn btn-quiet"
              disabled={busy()}
              onClick={remove}
              title="Quitar foto"
            >
              <ActionIcon name="delete" />
              <span class="sr-only">Quitar foto</span>
            </button>
          </Show>
          <input
            ref={(element) => (input = element)}
            hidden
            type="file"
            accept={acceptedPhotoTypes}
            tabindex={-1}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              void choose(file);
            }}
          />
          <p class="hint">
            La foto se reduce y se guarda solo en este dispositivo.
          </p>
        </div>
      </div>
      <div role="status">
        <Show when={busy()}>
          <p class="hint">Procesando la foto…</p>
        </Show>
      </div>
      <div role="alert">
        <Show when={error()}>
          <p class="field-error">{error()}</p>
        </Show>
      </div>
    </div>
  );
}
