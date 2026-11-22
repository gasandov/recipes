import { useContext } from "solid-js";
import { AppContext } from "./state";
import type { AppState } from "./state";

export function useApp(): AppState {
  return useContext(AppContext);
}

/** Moves focus to the first element matching the selector, after pending updates are applied. */
export function focusSelector(selector: string): void {
  const element = document.querySelector<HTMLElement>(selector);
  element?.focus();
}
