import { ActionIcon } from "../components/ActionIcon";
import { createSignal, flush, Show } from "solid-js";
import type { CapturedRecipe } from "../../capture/contract";
import { takeSharedRecipeUrl } from "../../capture/share";
import { LinkCapture } from "../components/LinkCapture";
import { VoiceCapture } from "../components/VoiceCapture";
import { paths } from "../router";
import { focusSelector } from "../use-app";
import { RecipeForm } from "./RecipeForm";

export function CaptureRecipe() {
  const initialUrl = takeSharedRecipeUrl();
  const [draft, setDraft] = createSignal<CapturedRecipe>();

  function review(captured: CapturedRecipe) {
    setDraft(captured);
    flush();
    focusSelector(".recipe-form h1");
    window.scrollTo(0, 0);
  }

  return (
    <Show
      when={draft()}
      keyed
      fallback={
        <>
          <div class="page-head">
            <h1 tabindex="-1">Dictar o importar receta</h1>
            <a class="btn" href={paths.newRecipe} title="Escribir receta">
              <ActionIcon name="edit" />
              <span class="sr-only">Escribir receta</span>
            </a>
          </div>
          <VoiceCapture onDraft={review} />
          <LinkCapture onDraft={review} initialUrl={initialUrl} />
        </>
      }
    >
      {(captured) => <RecipeForm recipe={undefined} captured={captured} />}
    </Show>
  );
}
