import { ActionIcon } from "../components/ActionIcon";
import {
  createEffect,
  createSignal,
  createUniqueId,
  For,
  onSettled,
  Show,
} from "solid-js";
import { accountSync } from "../../sync";
import type {
  AccountStatus,
  AccountSyncController,
  ChoiceSide,
  ConflictView,
} from "../../sync";
import {
  collectionLabels,
  describeRecord,
  noticeText,
} from "../../sync/describe";
import { Modal } from "../components/Modal";
import { paths } from "../router";

const number = new Intl.NumberFormat("es-MX");
const date = new Intl.DateTimeFormat("es-MX", {
  dateStyle: "medium",
  timeStyle: "short",
});

type Names = ReadonlyMap<string, string>;
type SignOutDialog = "confirm" | "pending" | "failed";

function countText(count: number, one: string, many: string): string {
  return `${number.format(count)} ${count === 1 ? one : many}`;
}

function statusLine(status: AccountStatus): string {
  switch (status.phase) {
    case "syncing":
      return "Sincronizando…";
    case "offline":
      return "Sin conexión. Tus cambios se guardan aquí y se enviarán al reconectar.";
    case "error":
      return status.errorCode === "auth"
        ? "No pudimos confirmar tu sesión. Se reintentará en un momento."
        : "No pudimos sincronizar. Se reintentará en un momento.";
    case "idle":
      return status.lastSyncedAt
        ? `Sincronizado el ${date.format(status.lastSyncedAt)}.`
        : "Todo está sincronizado.";
    default:
      return "";
  }
}

/** Download of the personal ZIP, as on the backups page. */
async function downloadBackup(
  controller: AccountSyncController,
): Promise<void> {
  const bytes = await controller.exportBackup();
  const url = URL.createObjectURL(
    new Blob([bytes as BlobPart], { type: "application/zip" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `recetario-${new Intl.DateTimeFormat("en-CA", { dateStyle: "short" }).format(new Date())}.zip`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function RecordLines(props: {
  conflict: ConflictView;
  side: "local" | "remote";
  names: Names;
}) {
  const lines = () =>
    describeRecord(
      props.conflict.collection,
      props.conflict[props.side],
      props.names,
    );
  return (
    <Show
      when={lines().length > 1}
      fallback={<span>{lines()[0] ?? "Sin contenido"}</span>}
    >
      <details>
        <summary title={lines()[0]}>
          <ActionIcon name="expand" />
          <span class="sr-only">{lines()[0]}</span>
        </summary>
        <ul>
          <For each={lines().slice(1)}>{(item) => <li>{item}</li>}</For>
        </ul>
      </details>
    </Show>
  );
}

/** One record, both versions side by side. The caller owns the choice. */
function ChoiceFieldset(props: {
  conflict: ConflictView;
  names: Names;
  value?: ChoiceSide;
  disabled: boolean;
  remoteLabel: string;
  localLabel: string;
  onChoose: (side: ChoiceSide) => void;
}) {
  const id = createUniqueId();
  const remoteDeleted = () => props.conflict.remote === undefined;
  const localDeleted = () => props.conflict.local === undefined;
  return (
    <fieldset disabled={props.disabled}>
      <legend>{collectionLabels[props.conflict.collection]}</legend>
      <div>
        <label>
          <input
            type="radio"
            name={id}
            checked={props.value === "local"}
            onChange={() => props.onChoose("local")}
          />
          {props.localLabel}
        </label>
        <Show
          when={localDeleted()}
          fallback={
            <RecordLines
              conflict={props.conflict}
              side="local"
              names={props.names}
            />
          }
        >
          <p>Esta versión no existe en este dispositivo.</p>
        </Show>
      </div>
      <div>
        <label>
          <input
            type="radio"
            name={id}
            checked={props.value === "remote"}
            onChange={() => props.onChoose("remote")}
          />
          {props.remoteLabel}
          <Show when={props.conflict.remoteUpdatedAt}>
            {(when) => <> · {date.format(new Date(when()))}</>}
          </Show>
        </label>
        <Show
          when={remoteDeleted()}
          fallback={
            <RecordLines
              conflict={props.conflict}
              side="remote"
              names={props.names}
            />
          }
        >
          <p>Esta versión no existe en tu cuenta.</p>
        </Show>
      </div>
    </fieldset>
  );
}

/**
 * Account, sign-in and sync status. It talks to the shared `accountSync` controller, which `startAccountSync`
 * keeps running while the person navigates. Mount this view on the `#/cuenta` route.
 */
export function AccountSync(props: { controller?: AccountSyncController }) {
  const controller = () => props.controller ?? accountSync;
  const id = createUniqueId();
  const [status, setStatus] = createSignal<AccountStatus>(
    controller().getStatus(),
  );
  const [conflicts, setConflicts] = createSignal<{
    views: ConflictView[];
    names: Names;
  }>({ views: [], names: new Map() });
  const [reviewChoices, setReviewChoices] = createSignal(
    new Map<string, ChoiceSide>(),
  );
  const [dialog, setDialog] = createSignal<SignOutDialog>();
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal("");
  const [failure, setFailure] = createSignal("");

  onSettled(() => {
    const current = controller();
    setStatus(current.getStatus());
    const stop = current.subscribe(() => setStatus(current.getStatus()));
    void current.refresh();
    return stop;
  });

  // Reload the open conflicts whenever sync finishes a round or the count changes.
  createEffect(
    () =>
      `${status().pending.conflicts}:${status().lastSyncedAt ?? 0}:${status().phase}`,
    () => {
      if (status().pending.conflicts === 0)
        setConflicts({ views: [], names: new Map() });
      else
        void controller()
          .conflicts()
          .then(setConflicts)
          .catch(() => {});
    },
  );

  async function guarded(task: () => Promise<void>, error: string) {
    if (busy()) return;
    setBusy(true);
    setFailure("");
    setMessage("");
    try {
      await task();
    } catch (cause) {
      console.error(error, cause);
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }

  async function signOut(discardUnsynced: boolean) {
    setBusy(true);
    setFailure("");
    try {
      const result = await controller().signOut({ discardUnsynced });
      if (result.ok) {
        setDialog(undefined);
        setMessage(
          "Cerraste sesión. Se quitaron de este dispositivo las recetas y el menú de tu cuenta.",
        );
      } else {
        setDialog(result.reason === "pending" ? "pending" : "failed");
      }
    } finally {
      setBusy(false);
    }
  }

  const user = () => status().user;
  const pendingTotal = () =>
    status().pending.changes + status().pending.conflicts;
  const signedIn = () => user() !== undefined;
  const choose = (key: string, side: ChoiceSide) =>
    setReviewChoices(new Map(reviewChoices()).set(key, side));

  return (
    <>
      <header class="page-head">
        <h1 tabindex="-1">Cuenta</h1>
      </header>

      <div role="status">
        <Show when={message()}>{(text) => <p>{text()}</p>}</Show>
        <Show when={statusLine(status())}>{(text) => <p>{text()}</p>}</Show>
      </div>
      <div role="alert">
        <Show when={failure()}>
          {(text) => <p class="error-box">{text()}</p>}
        </Show>
      </div>

      <Show when={status().phase === "unavailable"}>
        <section class="panel">
          <h2>Sincronización no disponible</h2>
          <p>
            Esta instalación no está conectada a un servicio de cuentas. Tus
            recetas y tu menú se guardan solo en este dispositivo.
          </p>
          <p>Puedes guardar una copia con un respaldo.</p>
        </section>
      </Show>

      <Show
        when={
          !signedIn() &&
          !["unavailable", "session-ended", "offline"].includes(status().phase)
        }
      >
        <section class="panel" aria-labelledby={`${id}-in`}>
          <h2 id={`${id}-in`}>Usa tu recetario en todos tus dispositivos</h2>
          <p>
            Inicia sesión con Google para guardar tus recetas, fotos,
            categorías, ingredientes, menú y lista de compras en una cuenta
            privada. Solo pedimos tu identidad (nombre y correo). Nadie más
            puede ver tu recetario.
          </p>
          <p>
            Tus recetas se combinarán con las de tu cuenta. Si hay cambios
            distintos en la misma receta, podrás elegir qué versión conservar.
          </p>
          <button
            type="button"
            class="btn btn-primary"
            disabled={busy() || status().phase === "starting"}
            onClick={() =>
              void guarded(
                () => controller().signInWithGoogle(),
                "No pudimos abrir el inicio de sesión. Inténtalo de nuevo.",
              )
            }
            title="Continuar con Google"
          >
            <ActionIcon name="login" />
            <span class="sr-only">Continuar con Google</span>
          </button>
        </section>
      </Show>

      <Show when={status().phase === "session-ended"}>
        <section class="panel">
          <h2>Tu sesión terminó</h2>
          <p>
            Este dispositivo todavía tiene los datos de tu cuenta
            <Show when={pendingTotal() > 0}>
              {" "}
              y {countText(pendingTotal(), "cambio", "cambios")} sin sincronizar
            </Show>
            . Inicia sesión de nuevo para continuar donde te quedaste.
          </p>
          <div class="actions">
            <button
              type="button"
              class="btn btn-primary"
              disabled={busy()}
              onClick={() =>
                void guarded(
                  () => controller().signInWithGoogle(),
                  "No pudimos abrir el inicio de sesión. Inténtalo de nuevo.",
                )
              }
              title="Continuar con Google"
            >
              <ActionIcon name="login" />
              <span class="sr-only">Continuar con Google</span>
            </button>
            <button
              type="button"
              class="btn"
              disabled={busy()}
              onClick={() => setDialog("confirm")}
              title="Quitar los datos de este dispositivo"
            >
              <ActionIcon name="delete" />
              <span class="sr-only">Quitar los datos de este dispositivo</span>
            </button>
          </div>
        </section>
      </Show>

      <Show when={status().phase === "foreign"}>
        <section class="panel">
          <h2>Este dispositivo tiene datos de otra cuenta</h2>
          <p>
            Para proteger tu privacidad no los combinamos con{" "}
            {user()?.email ?? "esta cuenta"}. Descarga un respaldo si quieres
            conservarlos y luego quítalos de este dispositivo para continuar.
          </p>
          <div class="actions">
            <button
              type="button"
              class="btn"
              disabled={busy()}
              onClick={() =>
                void guarded(
                  () => downloadBackup(controller()),
                  "No pudimos crear el respaldo. Inténtalo de nuevo.",
                )
              }
              title="Descargar respaldo"
            >
              <ActionIcon name="download" />
              <span class="sr-only">Descargar respaldo</span>
            </button>
            <button
              type="button"
              class="btn btn-danger"
              disabled={busy()}
              onClick={() =>
                void guarded(async () => {
                  if (!(await controller().discardLocalData()))
                    throw new Error("clear failed");
                }, "No pudimos quitar los datos de este dispositivo.")
              }
              title="Quitar datos de este dispositivo"
            >
              <ActionIcon name="delete" />
              <span class="sr-only">Quitar datos de este dispositivo</span>
            </button>
          </div>
        </section>
      </Show>

      <Show when={status().review} keyed>
        {(review) => (
          <section class="panel" aria-labelledby={`${id}-review`}>
            <h2 id={`${id}-review`}>Combinar este dispositivo con tu cuenta</h2>
            <p>
              Este dispositivo tiene{" "}
              {countText(review.localCount, "registro", "registros")} y tu
              cuenta tiene{" "}
              {countText(review.accountCount, "registro", "registros")}. Los
              registros iguales se reutilizan y los distintos se combinan. Elige
              qué versión conservar en los{" "}
              {number.format(review.conflicts.length)} que cambian en ambos
              lados.
            </p>
            <div class="actions">
              <button
                type="button"
                class="btn"
                disabled={busy()}
                onClick={() =>
                  setReviewChoices(
                    new Map(
                      review.conflicts.map(({ key }) => [
                        key,
                        "local" as const,
                      ]),
                    ),
                  )
                }
                title="Conservar todo de este dispositivo"
              >
                <ActionIcon name="confirm" />
                <span class="sr-only">Conservar todo de este dispositivo</span>
              </button>
              <button
                type="button"
                class="btn"
                disabled={busy()}
                onClick={() =>
                  setReviewChoices(
                    new Map(
                      review.conflicts.map(({ key }) => [
                        key,
                        "remote" as const,
                      ]),
                    ),
                  )
                }
                title="Usar todo de mi cuenta"
              >
                <ActionIcon name="account" />
                <span class="sr-only">Usar todo de mi cuenta</span>
              </button>
            </div>
            <ul class="planning-list">
              <For each={review.conflicts} keyed={(conflict) => conflict.key}>
                {(conflict) => (
                  <li class="panel">
                    <ChoiceFieldset
                      conflict={conflict()}
                      names={review.names}
                      value={reviewChoices().get(conflict().key)}
                      disabled={busy()}
                      localLabel="Conservar la de este dispositivo"
                      remoteLabel="Usar la de mi cuenta"
                      onChoose={(side) => choose(conflict().key, side)}
                    />
                  </li>
                )}
              </For>
            </ul>
            <div class="actions actions-end">
              <button
                type="button"
                class="btn btn-primary"
                disabled={
                  busy() ||
                  review.conflicts.some(({ key }) => !reviewChoices().has(key))
                }
                onClick={() =>
                  void guarded(async () => {
                    await controller().completeReview(reviewChoices());
                    setReviewChoices(new Map());
                  }, "No pudimos combinar tus datos. Tu recetario sigue intacto.")
                }
                title="Combinar y sincronizar"
              >
                <ActionIcon name="sync" />
                <span class="sr-only">Combinar y sincronizar</span>
              </button>
            </div>
          </section>
        )}
      </Show>

      <Show when={signedIn()}>
        <section class="panel" aria-labelledby={`${id}-account`}>
          <h2 id={`${id}-account`}>Tu cuenta</h2>
          <p>
            <Show when={user()?.avatarUrl}>
              {(src) => (
                <img
                  src={src()}
                  alt=""
                  width="40"
                  height="40"
                  referrerpolicy="no-referrer"
                />
              )}
            </Show>
            <strong>{user()?.name ?? user()?.email}</strong>
            <Show when={user()?.name && user()?.email}> · {user()?.email}</Show>
          </p>
          <p>
            <Show
              when={pendingTotal() > 0}
              fallback="Todo lo de este dispositivo está en tu cuenta."
            >
              {countText(status().pending.changes, "cambio", "cambios")} sin
              sincronizar
              <Show when={status().pending.conflicts > 0}>
                {" "}
                ·{" "}
                {countText(
                  status().pending.conflicts,
                  "conflicto",
                  "conflictos",
                )}{" "}
                por resolver
              </Show>
              .
            </Show>
          </p>
          <Show when={status().rejected > 0}>
            <p class="error-box">
              El servicio rechazó{" "}
              {countText(status().rejected, "cambio", "cambios")}. Se conservan
              en este dispositivo; descarga un respaldo si quieres guardarlos.
            </p>
          </Show>
          <div class="actions">
            <button
              type="button"
              class="btn btn-primary"
              disabled={busy() || status().phase === "syncing"}
              onClick={() =>
                void guarded(
                  () => controller().syncNow(),
                  "No pudimos sincronizar. Inténtalo de nuevo.",
                )
              }
              title="Sincronizar ahora"
            >
              <ActionIcon name="sync" />
              <span class="sr-only">Sincronizar ahora</span>
            </button>
            <button
              type="button"
              class="btn"
              disabled={busy()}
              onClick={() => setDialog("confirm")}
              title="Cerrar sesión en este dispositivo"
            >
              <ActionIcon name="logout" />
              <span class="sr-only">Cerrar sesión en este dispositivo</span>
            </button>
          </div>
        </section>
      </Show>

      <Show when={conflicts().views.length > 0}>
        <section class="panel" aria-labelledby={`${id}-conflicts`}>
          <h2 id={`${id}-conflicts`}>Editado en dos dispositivos</h2>
          <p>
            Cambiaste estos registros aquí y en otro dispositivo. Elige qué
            versión conservar; la otra se descarta.
          </p>
          <ul class="planning-list">
            <For each={conflicts().views} keyed={(conflict) => conflict.key}>
              {(conflict) => (
                <li class="panel">
                  <ChoiceFieldset
                    conflict={conflict()}
                    names={conflicts().names}
                    disabled={busy()}
                    localLabel="Conservar la de este dispositivo"
                    remoteLabel="Usar la de otro dispositivo"
                    onChoose={(side) =>
                      void guarded(
                        () =>
                          controller().resolveConflict(conflict().key, side),
                        "No pudimos guardar tu elección. Inténtalo de nuevo.",
                      )
                    }
                  />
                </li>
              )}
            </For>
          </ul>
        </section>
      </Show>

      <Show when={status().notices.length > 0}>
        <section class="panel" aria-labelledby={`${id}-notices`}>
          <h2 id={`${id}-notices`}>Cambios por sincronización</h2>
          <ul>
            <For each={status().notices}>
              {(notice) => <li>{noticeText(notice)}</li>}
            </For>
          </ul>
          <button
            type="button"
            class="btn"
            onClick={() => controller().dismissNotices()}
            title="Entendido"
          >
            <ActionIcon name="confirm" />
            <span class="sr-only">Entendido</span>
          </button>
        </section>
      </Show>

      <section class="panel">
        <h2>Respaldos</h2>
        <p>Guarda o restaura una copia de tu recetario en un archivo ZIP.</p>
        <a class="btn" href={paths.backups} title="Abrir respaldos">
          <ActionIcon name="download" />
          <span class="sr-only">Abrir respaldos</span>
        </a>
      </section>

      <Show when={dialog() === "confirm"}>
        <Modal
          title="¿Cerrar sesión en este dispositivo?"
          onClose={() => setDialog(undefined)}
        >
          <p>
            Se quitarán de este dispositivo tus recetas, fotos, menú y lista de
            compras. Seguirán en tu cuenta y en tus otros dispositivos. Si
            tienes cambios sin sincronizar, primero intentaremos enviarlos.
          </p>
          <div class="actions actions-end">
            <button
              type="button"
              class="btn"
              autofocus
              onClick={() => setDialog(undefined)}
              title="Cancelar"
            >
              <ActionIcon name="close" />
              <span class="sr-only">Cancelar</span>
            </button>
            <button
              type="button"
              class="btn btn-danger"
              disabled={busy()}
              onClick={() => void signOut(false)}
              title="Cerrar sesión"
            >
              <ActionIcon name="logout" />
              <span class="sr-only">Cerrar sesión</span>
            </button>
          </div>
        </Modal>
      </Show>

      <Show when={dialog() === "pending"}>
        <Modal
          title="Tienes cambios sin sincronizar"
          onClose={() => setDialog(undefined)}
        >
          <p>
            {countText(status().pending.changes, "cambio", "cambios")} solo{" "}
            {status().pending.changes === 1 ? "existe" : "existen"} en este
            dispositivo
            <Show when={status().pending.conflicts > 0}>
              {" "}
              y{" "}
              {countText(
                status().pending.conflicts,
                "conflicto",
                "conflictos",
              )}{" "}
              {status().pending.conflicts === 1 ? "espera" : "esperan"} tu
              elección
            </Show>
            . Si cierras sesión ahora, se perderían. Sincroniza cuando tengas
            conexión, descarga un respaldo o descártalos de forma explícita.
          </p>
          <div class="actions actions-end">
            <button
              type="button"
              class="btn"
              onClick={() => setDialog(undefined)}
              title="Seguir usando la app"
            >
              <ActionIcon name="confirm" />
              <span class="sr-only">Seguir usando la app</span>
            </button>
            <button
              type="button"
              class="btn"
              disabled={busy()}
              onClick={() =>
                void guarded(
                  () => downloadBackup(controller()),
                  "No pudimos crear el respaldo. Inténtalo de nuevo.",
                )
              }
              title="Descargar respaldo"
            >
              <ActionIcon name="download" />
              <span class="sr-only">Descargar respaldo</span>
            </button>
            <button
              type="button"
              class="btn"
              disabled={busy()}
              onClick={() => void signOut(false)}
              title="Reintentar sincronización"
            >
              <ActionIcon name="sync" />
              <span class="sr-only">Reintentar sincronización</span>
            </button>
            <button
              type="button"
              class="btn btn-danger"
              disabled={busy()}
              onClick={() => void signOut(true)}
              title="Descartar cambios y cerrar sesión"
            >
              <ActionIcon name="logout" />
              <span class="sr-only">Descartar cambios y cerrar sesión</span>
            </button>
          </div>
        </Modal>
      </Show>

      <Show when={dialog() === "failed"}>
        <Modal
          title="No pudimos cerrar sesión"
          onClose={() => setDialog(undefined)}
        >
          <p>
            No pudimos quitar los datos de este dispositivo. Inténtalo de nuevo
            antes de usar otra cuenta.
          </p>
          <div class="actions actions-end">
            <button
              type="button"
              class="btn"
              autofocus
              onClick={() => setDialog(undefined)}
              title="Cerrar"
            >
              <ActionIcon name="close" />
              <span class="sr-only">Cerrar</span>
            </button>
            <button
              type="button"
              class="btn btn-primary"
              disabled={busy()}
              onClick={() => void signOut(false)}
              title="Reintentar"
            >
              <ActionIcon name="retry" />
              <span class="sr-only">Reintentar</span>
            </button>
          </div>
        </Modal>
      </Show>
    </>
  );
}
