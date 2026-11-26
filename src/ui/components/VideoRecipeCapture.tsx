import { ActionIcon } from "./ActionIcon";
import { createSignal, createUniqueId, onCleanup, Show } from "solid-js";
import type { CapturedRecipe } from "../../capture/contract";
import { draftFromPastedText } from "../../capture/link";
import { mergeCapturedSources } from "../../capture/link/providers";
import {
  defaultOcrEngine,
  draftFromMediaText,
  readMediaText,
} from "../../capture/media";
import {
  assertRecipeVideo,
  downloadRecipeVideo,
  extractRecipeVideoAudio,
  readRecipeVideoFrames,
  videoLimits,
} from "../../capture/media/video";
import { parseRecipeTranscript } from "../../capture/parse";
import {
  failureMessages,
  resolveCloudConfig,
  transcribeInCloud,
} from "../../capture/voice";
import { fetchSupabaseFunction } from "../../data/supabase-client";

type Mode = "visual" | "audio";

type Props = {
  sourceUrl?: string;
  pageVideo?: string;
  captionText: () => string;
  onDraft: (draft: CapturedRecipe) => void;
};

export function VideoRecipeCapture(props: Props) {
  const fileId = createUniqueId();
  const cloud = resolveCloudConfig(import.meta.env);
  const [video, setVideo] = createSignal<Blob>();
  const [usePageVideo, setUsePageVideo] = createSignal(false);
  const [visual, setVisual] = createSignal<CapturedRecipe>();
  const [audio, setAudio] = createSignal<CapturedRecipe>();
  const [busy, setBusy] = createSignal<Mode>();
  const [consent, setConsent] = createSignal(false);
  const [error, setError] = createSignal("");
  let active: AbortController | undefined;

  function clearDrafts() {
    setVisual(undefined);
    setAudio(undefined);
    setError("");
    setConsent(false);
  }

  function choose(file: File) {
    clearDrafts();
    setUsePageVideo(false);
    try {
      assertRecipeVideo(file);
      setVideo(file);
    } catch {
      setVideo(undefined);
      setError("Elige un video MP4 o WebM de hasta 24 MB.");
    }
  }

  async function run(mode: Mode) {
    if (busy()) return;
    const controller = new AbortController();
    const { signal } = controller;
    active = controller;
    setBusy(mode);
    setConsent(false);
    setError("");
    const sourceUrl = props.sourceUrl;
    try {
      const pageVideo = usePageVideo() ? props.pageVideo : undefined;
      const clip =
        video() ??
        (pageVideo ? await downloadRecipeVideo(pageVideo, signal) : undefined);
      if (!clip) return;
      signal.throwIfAborted();
      setVideo(clip);
      if (mode === "audio") {
        const sound = await extractRecipeVideoAudio(clip, signal);
        const result = await transcribeInCloud(
          cloud,
          sound,
          { fetch: fetchSupabaseFunction },
          signal,
        );
        if (signal.aborted) return;
        if (!result.ok) {
          setError(failureMessages[`cloud-${result.failure}`]);
          return;
        }
        if (!result.transcript.trim()) {
          setError("El servicio no detectó voz en este video.");
          return;
        }
        const draft = parseRecipeTranscript(result.transcript);
        setAudio({ ...draft, sourceUrl });
        return;
      }

      const frames = await readRecipeVideoFrames(clip, signal);
      const engine = defaultOcrEngine();
      try {
        const result = await readMediaText(
          frames.map((file) => ({ origin: "user-file", file })),
          { engine, signal },
        );
        if (signal.aborted) return;
        if (result.status === "failed") {
          setError(result.message);
          return;
        }
        // Persistent captions usually appear in several frames. Keep the first appearance of each line.
        const uniqueLines = [...new Set(result.text.split("\n"))].join("\n");
        const { draft, usable } = draftFromMediaText(
          uniqueLines,
          sourceUrl,
          result.confidence,
        );
        if (usable) setVisual(draft);
        else
          setError(
            "Leímos texto, pero faltan encabezados de ingredientes o preparación. Prueba con una captura más clara.",
          );
      } finally {
        await engine.dispose();
      }
    } catch {
      if (!signal.aborted)
        setError(
          mode === "audio"
            ? "No pudimos extraer el audio. Elige un MP4 o WebM con audio de hasta dos minutos."
            : "No pudimos abrir el video. Elige un MP4 o WebM de hasta dos minutos, o usa una captura de pantalla.",
        );
    } finally {
      active = undefined;
      setBusy(undefined);
    }
  }

  function review() {
    const imageDraft = visual();
    const voiceDraft = audio();
    const pasted = draftFromPastedText(props.captionText(), props.sourceUrl);
    const drafts = [
      ...(pasted.usable
        ? [{ label: "la descripción pegada", draft: pasted.draft }]
        : []),
      ...(imageDraft
        ? [{ label: "el texto del video", draft: imageDraft }]
        : []),
      ...(voiceDraft
        ? [{ label: "el audio transcrito", draft: voiceDraft }]
        : []),
    ];
    setVideo(undefined);
    clearDrafts();
    props.onDraft(mergeCapturedSources(drafts));
  }

  onCleanup(() => active?.abort());

  return (
    <details class="library-help">
      <summary title="Leer una receta de un video corto">
        <ActionIcon name="expand" />
        <span class="sr-only">Leer una receta de un video corto</span>
      </summary>
      <p class="hint">
        Puedes leer el texto que aparece en pantalla en videos MP4 o WebM de
        hasta dos minutos y {videoLimits.bytes / 1024 / 1024} MB. Los fotogramas
        se procesan en este dispositivo.
      </p>
      <div class="field">
        <label for={fileId}>Elegir video de la receta</label>
        <span class="file-picker">
          <input
            id={fileId}
            class="control"
            type="file"
            accept="video/mp4,video/webm"
            disabled={!!busy()}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) choose(file);
            }}
          />
          <ActionIcon name="upload" />
        </span>
        <Show when={video() instanceof File && !usePageVideo()}>
          <p class="hint">Video elegido · {(video() as File).name}</p>
        </Show>
      </div>
      <Show when={props.pageVideo}>
        <button
          type="button"
          class="btn"
          disabled={!!busy()}
          onClick={() => {
            clearDrafts();
            setVideo(undefined);
            setUsePageVideo(true);
          }}
          title="Usar video de la página"
        >
          <ActionIcon name="video" />
          <span class="sr-only">Usar video de la página</span>
        </button>
        <Show when={usePageVideo()}>
          <p class="hint">
            Tu navegador descargará el archivo del sitio de origen, si el sitio
            permite acceder al video.
          </p>
        </Show>
      </Show>
      <Show when={video() || (usePageVideo() && props.pageVideo)}>
        <div class="actions">
          <button
            type="button"
            class="btn"
            disabled={!!busy()}
            onClick={() => void run("visual")}
            title="Leer texto del video"
          >
            <ActionIcon name="video" />
            <span class="sr-only">Leer texto del video</span>
          </button>
          <Show when={cloud}>
            <button
              type="button"
              class="btn"
              disabled={!!busy()}
              onClick={() => setConsent(true)}
              title="Transcribir audio del video"
            >
              <ActionIcon name="microphone" />
              <span class="sr-only">Transcribir audio del video</span>
            </button>
          </Show>
        </div>
      </Show>
      <Show when={cloud && consent()}>
        <p>
          Si aceptas, el audio de este video se envía a {cloud?.providerLabel}{" "}
          para transcribirlo. La imagen se queda en tu dispositivo.
        </p>
        <Show when={cloud?.retentionNote}>
          <p class="hint">{cloud?.retentionNote}</p>
        </Show>
        <div class="actions">
          <button
            type="button"
            class="btn btn-primary"
            onClick={() => void run("audio")}
            title="Enviar audio y transcribir"
          >
            <ActionIcon name="send" />
            <span class="sr-only">Enviar audio y transcribir</span>
          </button>
          <button
            type="button"
            class="btn"
            onClick={() => setConsent(false)}
            title="Cancelar envío"
          >
            <ActionIcon name="close" />
            <span class="sr-only">Cancelar envío</span>
          </button>
        </div>
      </Show>
      <div role="status">
        <Show when={busy()}>
          <p>
            {busy() === "visual"
              ? "Leyendo el texto del video…"
              : "Procesando el audio del video…"}
          </p>
          <button
            type="button"
            class="btn"
            onClick={() => active?.abort()}
            title="Cancelar lectura"
          >
            <ActionIcon name="close" />
            <span class="sr-only">Cancelar lectura</span>
          </button>
        </Show>
        <Show when={visual()}>
          <p>Ya leímos el texto del video.</p>
        </Show>
        <Show when={audio()}>
          <p>Ya transcribimos el audio.</p>
        </Show>
      </div>
      <div role="alert">
        <Show when={error()}>
          <p class="field-error">{error()}</p>
        </Show>
      </div>
      <Show when={visual() || audio()}>
        <button
          type="button"
          class="btn btn-primary"
          disabled={!!busy()}
          onClick={review}
          title="Revisar borrador del video"
        >
          <ActionIcon name="video" />
          <span class="sr-only">Revisar borrador del video</span>
        </button>
      </Show>
    </details>
  );
}
