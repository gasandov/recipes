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
            <button type="button" class="btn" onClick={() => app.settleConfirm(false)}>
              Cancelar
            </button>
            <button
              type="button"
              class={["btn", request.danger ? "btn-danger" : "btn-primary"]}
              onClick={() => app.settleConfirm(true)}
            >
              {request.confirmLabel}
            </button>
          </div>
        </Modal>
      )}
    </Show>
  );
}
