import { createSignal } from "solid-js";
import { useApp } from "../use-app";

export function AddToMenuButton(props: { recipeId: string; recipeName: string; primary?: boolean }) {
  const app = useApp();
  const [adding, setAdding] = createSignal(false);

  async function add() {
    if (adding()) return;
    const { recipeId, recipeName } = props;
    setAdding(true);
    const saved = await app.addMenuBatch(recipeId);
    setAdding(false);
    if (saved) {
      app.notify("success", `Se agregó «${recipeName}» al menú.`);
    } else {
      app.notify("error", "No se pudo agregar la receta al menú. Inténtalo de nuevo.");
    }
  }

  return (
    <button
      type="button"
      class={["btn", props.primary ? "btn-primary" : "btn-small"]}
      aria-label={`Agregar al menú: ${props.recipeName}`}
      aria-disabled={adding() ? "true" : undefined}
      onClick={() => void add()}
    >
      Agregar al menú
    </button>
  );
}
