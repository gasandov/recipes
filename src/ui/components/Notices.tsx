import { ActionIcon } from "./ActionIcon";
import { For } from "solid-js";
import { useApp } from "../use-app";

/** Live regions stay mounted so screen readers announce the messages added later. */
export function Notices() {
  const app = useApp();
  return (
    <div class="notices">
      <div role="status">
        <For each={app.notices().filter((notice) => notice.kind === "success")}>
          {(notice) => <p class="notice notice-success">{notice.text}</p>}
        </For>
      </div>
      <div role="alert">
        <For each={app.notices().filter((notice) => notice.kind === "error")}>
          {(notice) => (
            <p class="notice notice-error">
              <span>{notice.text}</span>
              <button
                type="button"
                class="link-button"
                onClick={() => app.dismissNotice(notice.id)}
                title="Cerrar"
              >
                <ActionIcon name="close" />
                <span class="sr-only">Cerrar</span>
              </button>
            </p>
          )}
        </For>
      </div>
    </div>
  );
}
