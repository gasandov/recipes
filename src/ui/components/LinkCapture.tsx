import { ActionIcon } from "./ActionIcon";
import { createSignal, createUniqueId, flush, Show } from "solid-js";
import type { CaptureActionProps } from "../../capture/contract";
import {
  draftFromPastedText,
  importRecipeFromLink,
  parseLinkInput,
} from "../../capture/link";
import type { LinkImportOptions, LinkImportOutcome } from "../../capture/link";
import {
  defaultAccessToken,
  defaultImportEndpoint,
} from "../../capture/link/session";
import type { OcrEngine } from "../../capture/media";
import { fetchSupabaseFunction } from "../../data/supabase-client";
import { focusSelector } from "../use-app";
import { MediaOcrPanel } from "./MediaOcrPanel";
import { VideoRecipeCapture } from "./VideoRecipeCapture";

type Failure = Extract<LinkImportOutcome, { status: "failed" }>;

export type LinkCaptureProps = CaptureActionProps & {
  /** A link received from the share sheet. It fills the field but is not imported until the user asks. */
  initialUrl?: string;
  /** Overrides for tests or a different deployment. */
  endpoint?: string;
  getAccessToken?: LinkImportOptions["getAccessToken"];
  /** Used only for the import function. Defaults to the Supabase-aware fetch that limits the session token to the project's functions. */
  fetch?: typeof fetch;
  /** Used only to download public images the user asked to read. Never carries the session token. */
  mediaFetch?: typeof fetch;
  /** Replaces the local OCR engine in tests. */
  createOcrEngine?: () => OcrEngine;
};

const pasteHelp =
  "Pega el texto con títulos como “Ingredientes” y “Preparación”. Si no encontramos ingredientes ni pasos, abre el editor con el enlace.";

/** Imports a recipe from a pasted or shared link and hands the editable draft to the review editor. */
export function LinkCapture(props: LinkCaptureProps) {
  const ids = createUniqueId();
  const [url, setUrl] = createSignal(props.initialUrl ?? "");
  const [busy, setBusy] = createSignal(false);
  const [failure, setFailure] = createSignal<Failure>();
  const [pasting, setPasting] = createSignal(false);
  const [pasted, setPasted] = createSignal("");
  const [pasteError, setPasteError] = createSignal("");
  let controller: AbortController | undefined;

  const sourceUrl = () => {
    const link = parseLinkInput(url());
    return (
      failure()?.fallback.sourceUrl ?? (link.ok ? link.sourceUrl : undefined)
    );
  };

  async function run(event: SubmitEvent) {
    event.preventDefault();
    if (busy()) return;
    controller = new AbortController();
    setFailure(undefined);
    setPasting(false);
    setPasteError("");
    setBusy(true);

    try {
      const outcome = await importRecipeFromLink(url(), {
        endpoint: props.endpoint ?? defaultImportEndpoint(),
        getAccessToken: props.getAccessToken ?? defaultAccessToken,
        fetch: props.fetch ?? fetchSupabaseFunction,
        signal: controller.signal,
      });
      if (outcome.status === "draft") {
        props.onDraft(outcome.draft);
        return;
      }
      setFailure(outcome);
      flush();
      focusSelector(`#${CSS.escape(`${ids}-failure`)}`);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError"))
        throw error;
    } finally {
      setBusy(false);
    }
  }

  function cancel() {
    controller?.abort();
  }

  function usePastedText() {
    const current = failure();
    const { draft, usable } = draftFromPastedText(
      pasted(),
      current?.fallback.sourceUrl,
    );
    if (!usable) {
      setPasteError(
        "No encontramos ingredientes ni pasos en ese texto. Revisa que tenga títulos como “Ingredientes” y “Preparación”.",
      );
      return;
    }
    props.onDraft(draft);
  }

  return (
    <section class="panel" aria-labelledby={`${ids}-title`}>
      <h2 id={`${ids}-title`}>Importar desde un enlace</h2>
      <p class="hint">
        Pega el enlace de una página con receta. Revisarás todo en el editor
        antes de guardar y el enlace original se conserva.
      </p>

      <form
        onSubmit={(event) => void run(event)}
        novalidate
        aria-busy={busy() ? "true" : undefined}
      >
        <div class="field">
          <label for={`${ids}-url`}>Enlace de la receta</label>
          <input
            id={`${ids}-url`}
            class="control"
            type="text"
            inputmode="url"
            autocomplete="off"
            autocapitalize="off"
            spellcheck={false}
            placeholder="https://"
            value={url()}
            aria-describedby={`${ids}-hint`}
            onInput={(event) => setUrl(event.currentTarget.value)}
          />
          <p class="hint" id={`${ids}-hint`}>
            Funciona con páginas públicas. Instagram y Facebook no permiten leer
            sus publicaciones desde otras apps; para esos enlaces puedes pegar
            la descripción.
          </p>
        </div>
        <div class="actions">
          <button
            type="submit"
            class="btn btn-primary"
            disabled={busy() || url().trim() === ""}
            title={busy() ? "Leyendo la página…" : "Importar receta"}
          >
            <ActionIcon name="link" />
            <span class="sr-only">
              {busy() ? "Leyendo la página…" : "Importar receta"}
            </span>
          </button>
          <Show when={busy()}>
            <button type="button" class="btn" onClick={cancel} title="Cancelar">
              <ActionIcon name="close" />
              <span class="sr-only">Cancelar</span>
            </button>
          </Show>
        </div>
      </form>

      <p role="status" class="hint">
        {busy() ? "Leyendo la página. Puede tardar unos segundos." : ""}
      </p>

      <div role="alert">
        <Show when={failure()} keyed>
          {(current) => (
            <div class="error-box" id={`${ids}-failure`} tabindex="-1">
              <p>{current.message}</p>
              <div class="actions">
                <button
                  type="button"
                  class="btn btn-primary"
                  onClick={() => props.onDraft(current.fallback)}
                  title="Abrir editor con el enlace"
                >
                  <ActionIcon name="edit" />
                  <span class="sr-only">Abrir editor con el enlace</span>
                </button>
                <Show when={current.canPasteText && !pasting()}>
                  <button
                    type="button"
                    class="btn"
                    onClick={() => setPasting(true)}
                    title="Pegar texto de la receta"
                  >
                    <ActionIcon name="paste" />
                    <span class="sr-only">Pegar texto de la receta</span>
                  </button>
                </Show>
              </div>
            </div>
          )}
        </Show>
      </div>

      <Show when={failure() && pasting()}>
        <div class="field">
          <label for={`${ids}-paste`}>Texto de la receta o descripción</label>
          <textarea
            id={`${ids}-paste`}
            class="control"
            rows="8"
            aria-describedby={`${ids}-paste-hint`}
            aria-invalid={pasteError() ? "true" : undefined}
            value={pasted()}
            onInput={(event) => {
              setPasted(event.currentTarget.value);
              setPasteError("");
            }}
          />
          <p class="hint" id={`${ids}-paste-hint`}>
            {pasteHelp}
          </p>
          <Show when={pasteError()}>
            <p class="field-error" role="alert">
              <span aria-hidden="true">⚠ </span>
              {pasteError()}
            </p>
          </Show>
          <div class="actions">
            <button
              type="button"
              class="btn btn-primary"
              disabled={pasted().trim() === ""}
              onClick={usePastedText}
              title="Usar este texto"
            >
              <ActionIcon name="edit" />
              <span class="sr-only">Usar este texto</span>
            </button>
          </div>
        </div>
      </Show>

      <MediaOcrPanel
        media={failure()?.media}
        sourceUrl={sourceUrl()}
        captionText={pasted}
        onDraft={props.onDraft}
        createEngine={props.createOcrEngine}
        fetch={props.mediaFetch}
      />
      <VideoRecipeCapture
        pageVideo={failure()?.media.find((item) => item.kind === "video")?.url}
        sourceUrl={sourceUrl()}
        captionText={pasted}
        onDraft={props.onDraft}
      />
    </section>
  );
}
