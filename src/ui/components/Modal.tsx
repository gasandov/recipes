import { createUniqueId, onSettled } from "solid-js";
import type { JSX } from "@solidjs/web";

type Props = {
  title: string;
  onClose: () => void;
  children: JSX.Element;
};

/** A modal dialog built on the native element, which traps focus and restores it on close. */
export function Modal(props: Props) {
  let dialog: HTMLDialogElement | undefined;
  const titleId = createUniqueId();

  onSettled(() => {
    dialog?.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  });

  return (
    <dialog
      ref={(element) => (dialog = element)}
      class="modal"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        props.onClose();
      }}
      onClick={(event) => {
        if (event.target === dialog) props.onClose();
      }}
    >
      <div class="modal-body">
        <h2 id={titleId}>{props.title}</h2>
        {props.children}
      </div>
    </dialog>
  );
}
