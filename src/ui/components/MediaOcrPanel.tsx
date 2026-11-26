import { ActionIcon } from "./ActionIcon";
import { createSignal, createUniqueId, For, onCleanup, Show } from "solid-js";
import type { CapturedRecipe } from "../../capture/contract";
import { draftFromPastedText } from "../../capture/link";
import type { MediaReference } from "../../../supabase/functions/import-recipe/protocol.ts";
import {
  combineWithCaption,
  defaultOcrEngine,
  draftFromMediaText,
  mediaLimits,
  readMediaText,
} from "../../capture/media";
import type { MediaInput, MediaProgress, OcrEngine } from "../../capture/media";

export type MediaOcrPanelProps = {
  /** Media the public page lists. Only images are read; nothing is downloaded until the user asks. */
  media?: readonly MediaReference[];
  sourceUrl?: string;
  /** Text the user already pasted, such as a caption. The reading is merged with it and disagreements become notices. */
  captionText?: () => string;
  onDraft: (draft: CapturedRecipe) => void;
  /** Overrides for tests. */
  createEngine?: () => OcrEngine;
  fetch?: typeof fetch;
};

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

function progressText(progress: MediaProgress): string {
  const of =
    progress.total > 1 ? ` ${progress.index} de ${progress.total}` : "";
  if (progress.phase === "downloading") return `Descargando la imagen${of}…`;
  if (progress.phase === "preparing") return `Preparando la imagen${of}…`;
  return `Leyendo el texto de la imagen${of}. La primera vez tarda más porque se prepara el lector.`;
}

/**
 * Reads recipe text from images on the user's device. A file chosen from the device always works; images a public
 * page lists are fetched straight from their host only after the user presses the button, and only when that host
 * allows it. Nothing is uploaded to any service and image bytes are never stored.
 */
export function MediaOcrPanel(props: MediaOcrPanelProps) {
  const ids = createUniqueId();
  const [busy, setBusy] = createSignal(false);
  const [status, setStatus] = createSignal("");
  const [error, setError] = createSignal("");
  let controller: AbortController | undefined;
  let engine: OcrEngine | undefined;

  const images = () =>
    (props.media ?? [])
      .filter((item) => item.kind === "image")
      .slice(0, mediaLimits.maxImages);
  const hosts = () =>
    [...new Set(images().map((item) => hostOf(item.url)))].join(", ");

  async function run(inputs: MediaInput[]) {
    if (busy() || inputs.length === 0) return;
    controller = new AbortController();
    setError("");
    setStatus("");
    setBusy(true);
    engine ??= (props.createEngine ?? defaultOcrEngine)();

    try {
      const result = await readMediaText(inputs, {
        engine,
        fetch: props.fetch,
        signal: controller.signal,
        onProgress: (progress) => setStatus(progressText(progress)),
      });
      if (result.status === "failed") {
        if (result.failure !== "aborted") setError(result.message);
        return;
      }

      const { draft, usable } = draftFromMediaText(
        result.text,
        props.sourceUrl,
        result.confidence,
      );
      if (!usable) {
        setError(
          "Se leyó texto, pero no encontramos títulos como “Ingredientes” y “Preparación”. " +
            "Prueba con una captura donde se vean esos títulos.",
        );
        return;
      }
      let merged = draft;
      const caption = props.captionText?.().trim();
      if (caption) {
        const pasted = draftFromPastedText(caption, props.sourceUrl);
        if (pasted.usable) merged = combineWithCaption(pasted.draft, draft);
      }
      if (result.skipped.length > 0) {
        merged = {
          ...merged,
          notices: [
            ...(merged.notices ?? []),
            `${result.skipped.length} imagen(es) no se pudieron leer.`,
          ],
        };
      }
      props.onDraft(merged);
    } finally {
      // Frees the worker's memory. The model stays in the browser's cache, so the next read starts faster.
      const finished = engine;
      engine = undefined;
      void finished?.dispose();
      controller = undefined;
      setStatus("");
      setBusy(false);
    }
  }

  function chooseFiles(event: Event & { currentTarget: HTMLInputElement }) {
    const input = event.currentTarget;
    const files = [...(input.files ?? [])];
    input.value = "";
    if (files.length > mediaLimits.maxImages) {
      setError(`Elige hasta ${mediaLimits.maxImages} imágenes a la vez.`);
      return;
    }
    void run(files.map((file) => ({ origin: "user-file", file })));
  }

  onCleanup(() => {
    controller?.abort();
    void engine?.dispose();
  });

  return (
    <section
      aria-labelledby={`${ids}-title`}
      aria-busy={busy() ? "true" : undefined}
    >
      <h3 id={`${ids}-title`}>Leer texto de una imagen</h3>
      <p class="hint">
        Si la receta está en una imagen o en una captura de pantalla, Recetario
        la lee en tu dispositivo. La imagen no se sube a ningún servicio ni se
        guarda. La primera vez se descargan unos {mediaLimits.approxDownloadMb}{" "}
        MB del lector, desde este mismo sitio.
      </p>

      <div class="field">
        <label for={`${ids}-file`}>Elegir captura o imagen</label>
        <span class="file-picker">
          <input
            id={`${ids}-file`}
            class="control"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/avif"
            multiple
            disabled={busy()}
            aria-describedby={`${ids}-file-hint`}
            onChange={chooseFiles}
          />
          <ActionIcon name="upload" />
        </span>
        <p class="hint" id={`${ids}-file-hint`}>
          Hasta {mediaLimits.maxImages} imágenes de máximo 8 MB. En Instagram y
          Facebook toma una captura de la receta y elígela aquí.
        </p>
      </div>

      <Show when={images().length > 0}>
        <div class="field">
          <p>
            La página muestra{" "}
            {images().length === 1 ? "1 imagen" : `${images().length} imágenes`}
            .
          </p>
          <p class="hint">
            Si la lees, tu navegador la descarga directamente de {hosts()}, y
            ese sitio puede ver tu dirección IP. Solo funciona si el sitio
            permite que otras apps la lean; si no, elige una captura.
          </p>
          <ul class="hint">
            <For each={images()}>{(item) => <li>{hostOf(item.url)}</li>}</For>
          </ul>
          <div class="actions">
            <button
              type="button"
              class="btn"
              disabled={busy()}
              onClick={() =>
                void run(
                  images().map((item) => ({ origin: "page", url: item.url })),
                )
              }
              title={
                "Leer" +
                " " +
                String(images().length === 1 ? "la imagen" : "las imágenes") +
                " " +
                "de la página"
              }
            >
              <ActionIcon name="image" />
              <span class="sr-only">
                Leer {images().length === 1 ? "la imagen" : "las imágenes"} de
                la página
              </span>
            </button>
          </div>
        </div>
      </Show>

      <Show when={busy()}>
        <div class="actions">
          <button
            type="button"
            class="btn"
            onClick={() => controller?.abort()}
            title="Cancelar"
          >
            <ActionIcon name="close" />
            <span class="sr-only">Cancelar</span>
          </button>
        </div>
      </Show>

      <p role="status" class="hint">
        {busy() ? status() || "Preparando…" : ""}
      </p>
      <div role="alert">
        <Show when={error()}>
          <p class="field-error">
            <span aria-hidden="true">⚠ </span>
            {error()}
          </p>
          <p class="hint">
            Siempre puedes abrir el editor con el enlace guardado y escribir la
            receta.
          </p>
        </Show>
      </div>
    </section>
  );
}
