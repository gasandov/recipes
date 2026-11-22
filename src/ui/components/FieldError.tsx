import { Show } from "solid-js";

type Props = { id: string; message: string | undefined };

export function FieldError(props: Props) {
  return (
    <Show when={props.message}>
      <p id={props.id} class="field-error">
        <span aria-hidden="true">⚠ </span>
        {props.message}
      </p>
    </Show>
  );
}
