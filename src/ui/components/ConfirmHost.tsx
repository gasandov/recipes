import { ActionIcon } from "./ActionIcon";
import { Show } from "solid-js";
import { useApp } from "../use-app";
import { Modal } from "./Modal";

export function ConfirmHost() {
  const app = useApp();
  return (
    <Show when={app.pendingConfirm()} keyed>
      {(request) => (
        <Modal title={request.title} onClose={() => app.settleConfirm(false)}>
          <p>{request.message}</p>
          <div class="actions actions-end">
            <button
              type="button"
              class="btn"
              onClick={() => app.settleConfirm(false)}
              title="Cancelar"
            >
              <ActionIcon name="close" />
              <span class="sr-only">Cancelar</span>
            </button>
            <button
              type="button"
              class={["btn", request.danger ? "btn-danger" : "btn-primary"]}
              onClick={() => app.settleConfirm(true)}
              title={request.confirmLabel}
            >
              <ActionIcon name="confirm" />
              <span class="sr-only">{request.confirmLabel}</span>
            </button>
          </div>
        </Modal>
      )}
    </Show>
  );
}
