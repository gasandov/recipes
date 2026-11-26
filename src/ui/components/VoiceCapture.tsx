import { ActionIcon } from "./ActionIcon";
import {
  createSignal,
  createUniqueId,
  Match,
  onSettled,
  Show,
  Switch,
} from "solid-js";
import type { CaptureActionProps } from "../../capture/contract";
import { fetchSupabaseFunction } from "../../data/supabase-client";
import {
  browserEnvironment,
  failureMessages,
  resolveCloudConfig,
  unsupportedMessage,
  VoiceController,
} from "../../capture/voice";
import type { VoiceState } from "../../capture/voice";

/**
 * Dictation entry point for drafting a recipe. Recognition stays on the device when the browser can prove it;
 * cloud transcription is offered only when configured and only after the user approves each recording.
 * Audio and transcripts stay in memory and are discarded after the draft is handed over.
 */
export function VoiceCapture(props: CaptureActionProps) {
  const headingId = createUniqueId();
  const textId = createUniqueId();
  const [state, setState] = createSignal<VoiceState>({ phase: "checking" });
  const [typed, setTyped] = createSignal("");

  const controller = new VoiceController({
    env: { ...browserEnvironment(), fetch: fetchSupabaseFunction },
    cloud: resolveCloudConfig(import.meta.env),
    onDraft: (draft) => {
      setTyped("");
      props.onDraft(draft);
    },
    onState: setState,
    exposeTranscript: import.meta.env.DEV,
  });

  onSettled(() => {
    void controller.check();
    return () => controller.dispose();
  });

  const idle = () => {
    const current = state();
    return current.phase === "idle" ? current : undefined;
  };
  const recording = () => {
    const current = state();
    return current.phase === "recording" ? current : undefined;
  };
  const approval = () => {
    const current = state();
    return current.phase === "approve-cloud" ? current : undefined;
  };
  const failed = () => {
    const current = state();
    return current.phase === "failed" ? current : undefined;
  };
  const busy = () => {
    const phase = state().phase;
    return (
      phase === "recording" ||
      phase === "approve-cloud" ||
      phase === "processing"
    );
  };

  return (
    <section class="panel" aria-labelledby={headingId}>
      <h2 id={headingId}>Dictar una receta</h2>
      <p class="hint">
        Di el nombre, las porciones, los ingredientes con sus cantidades y los
        pasos. Después revisarás el borrador en el editor y decidirás si lo
        guardas.
      </p>

      <div role="status">
        <Switch>
          <Match when={state().phase === "checking"}>
            <p class="hint">Comprobando el dictado en este dispositivo…</p>
          </Match>
          <Match when={state().phase === "installing"}>
            <p class="hint">Descargando el paquete de voz…</p>
          </Match>
          <Match when={state().phase === "processing"}>
            <p class="hint">Creando el borrador…</p>
          </Match>
          <Match when={recording()}>
            {(current) => (
              <>
                <p>
                  <strong>
                    {current().mode === "local" ? "Escuchando…" : "Grabando…"}
                  </strong>{" "}
                  {current().mode === "local"
                    ? "Habla con naturalidad. El reconocimiento ocurre en este dispositivo."
                    : "El audio se queda en este dispositivo hasta que decidas enviarlo."}
                </p>
                <Show when={import.meta.env.DEV && current().liveTranscript}>
                  <p class="hint">
                    Solo desarrollo: {current().liveTranscript}
                  </p>
                </Show>
              </>
            )}
          </Match>
        </Switch>
      </div>

      <Show when={recording()}>
        <div class="actions">
          <button
            type="button"
            class="btn btn-primary"
            onClick={() => controller.stop()}
            title="Detener y crear borrador"
          >
            <ActionIcon name="stop" />
            <span class="sr-only">Detener y crear borrador</span>
          </button>
          <button
            type="button"
            class="btn btn-quiet"
            onClick={() => controller.cancel()}
            title="Cancelar"
          >
            <ActionIcon name="close" />
            <span class="sr-only">Cancelar</span>
          </button>
        </div>
      </Show>

      <Show when={approval()}>
        {(current) => (
          <div>
            <p>
              <Show when={current().limitReached}>
                La grabación llegó al límite de tiempo.{" "}
              </Show>
              Tu grabación está lista y aún no salió de este dispositivo. Si la
              envías, se transcribirá en {current().providerLabel}.
            </p>
            <Show when={current().retentionNote}>
              <p class="hint">{current().retentionNote}</p>
            </Show>
            <p class="hint">
              Solo se envía esta grabación, una vez. Después se descarta aquí.
            </p>
            <div class="actions">
              <button
                type="button"
                class="btn btn-primary"
                onClick={() => void controller.sendToCloud()}
                title="Enviar y transcribir"
              >
                <ActionIcon name="send" />
                <span class="sr-only">Enviar y transcribir</span>
              </button>
              <button
                type="button"
                class="btn btn-quiet"
                onClick={() => controller.cancel()}
                title="Descartar grabación"
              >
                <ActionIcon name="delete" />
                <span class="sr-only">Descartar grabación</span>
              </button>
            </div>
          </div>
        )}
      </Show>

      <Show when={failed()}>
        {(current) => (
          <div class="error-box" role="alert">
            <p>
              <span aria-hidden="true">⚠ </span>
              {failureMessages[current().failure]}
              <Show when={current().hasCaptured}>
                {" "}
                Conservamos lo que alcanzamos a captar.
              </Show>
            </p>
            <div class="actions">
              <Show when={current().hasCaptured}>
                <button
                  type="button"
                  class="btn btn-primary"
                  onClick={() => controller.useCaptured()}
                  title="Usar lo capturado"
                >
                  <ActionIcon name="microphone" />
                  <span class="sr-only">Usar lo capturado</span>
                </button>
              </Show>
              <button
                type="button"
                class="btn"
                onClick={() => controller.cancel()}
                title="Intentar de nuevo"
              >
                <ActionIcon name="retry" />
                <span class="sr-only">Intentar de nuevo</span>
              </button>
              <button
                type="button"
                class="btn btn-quiet"
                onClick={() => controller.continueManually()}
                title="Continuar en el editor sin voz"
              >
                <ActionIcon name="edit" />
                <span class="sr-only">Continuar en el editor sin voz</span>
              </button>
            </div>
          </div>
        )}
      </Show>

      <Show when={idle()}>
        {(current) => (
          <div>
            <Switch>
              <Match when={current().local.kind === "ready"}>
                <p class="hint">
                  Tu voz se procesa dentro de este dispositivo; el audio no se
                  envía a ningún servidor.
                </p>
                <div class="actions">
                  <button
                    type="button"
                    class="btn btn-primary"
                    onClick={() => controller.startLocal()}
                    title="Empezar a dictar"
                  >
                    <ActionIcon name="microphone" />
                    <span class="sr-only">Empezar a dictar</span>
                  </button>
                </div>
              </Match>
              <Match when={current().local.kind === "downloadable"}>
                <p class="hint">
                  Para dictar sin enviar tu voz a internet, este dispositivo
                  necesita descargar el paquete de voz en español de México. Se
                  descarga una vez y puede tardar un poco.
                </p>
                <div class="actions">
                  <button
                    type="button"
                    class="btn btn-primary"
                    onClick={() => void controller.installLocalPack()}
                    title="Descargar paquete de voz"
                  >
                    <ActionIcon name="download" />
                    <span class="sr-only">Descargar paquete de voz</span>
                  </button>
                </div>
              </Match>
              <Match when={current().local.kind === "downloading"}>
                <p class="hint">
                  El paquete de voz se está descargando. Vuelve a comprobar en
                  unos momentos.
                </p>
                <div class="actions">
                  <button
                    type="button"
                    class="btn"
                    onClick={() => void controller.check()}
                    title="Comprobar de nuevo"
                  >
                    <ActionIcon name="retry" />
                    <span class="sr-only">Comprobar de nuevo</span>
                  </button>
                </div>
              </Match>
              <Match
                when={
                  current().local.kind === "unsupported"
                    ? current().local
                    : undefined
                }
              >
                {(support) => (
                  <p class="hint">
                    {unsupportedMessage(
                      support() as Parameters<typeof unsupportedMessage>[0],
                    )}
                  </p>
                )}
              </Match>
            </Switch>

            <Show
              when={
                current().cloud &&
                current().canRecordForCloud &&
                current().local.kind !== "ready"
              }
            >
              <div class="approx-note">
                <p>
                  Si quieres, puedes grabar y decidir después si envías esa
                  grabación a {current().cloud?.providerLabel} para
                  transcribirla. No se envía nada sin tu aprobación.
                </p>
                <div class="actions">
                  <button
                    type="button"
                    class="btn"
                    onClick={() => void controller.startCloudRecording()}
                    title="Grabar con transcripción en la nube"
                  >
                    <ActionIcon name="microphone" />
                    <span class="sr-only">
                      Grabar con transcripción en la nube
                    </span>
                  </button>
                </div>
              </div>
            </Show>
          </div>
        )}
      </Show>

      <Show when={!busy()}>
        <details class="library-help">
          <summary title="Prefiero escribir o pegar el dictado">
            <ActionIcon name="expand" />
            <span class="sr-only">Prefiero escribir o pegar el dictado</span>
          </summary>
          <div class="field">
            <label class="label" for={textId}>
              Texto de la receta
            </label>
            <textarea
              id={textId}
              class="control"
              rows="6"
              value={typed()}
              onInput={(event) => setTyped(event.currentTarget.value)}
            />
            <p class="hint">
              El texto se usa solo para crear el borrador y no se guarda.
            </p>
          </div>
          <div class="actions">
            <button
              type="button"
              class="btn"
              onClick={() => controller.submitText(typed())}
              title="Crear borrador"
            >
              <ActionIcon name="add" />
              <span class="sr-only">Crear borrador</span>
            </button>
          </div>
        </details>
        <Show when={!failed()}>
          <div class="actions">
            <button
              type="button"
              class="btn btn-quiet"
              onClick={() => controller.continueManually()}
              title="Continuar en el editor sin voz"
            >
              <ActionIcon name="edit" />
              <span class="sr-only">Continuar en el editor sin voz</span>
            </button>
          </div>
        </Show>
      </Show>
    </section>
  );
}
