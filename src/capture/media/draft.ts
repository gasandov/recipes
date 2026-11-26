import type { CapturedRecipe } from "../contract";
import { draftFromPastedText } from "../link/map";
import { mergeCapturedSources } from "../link/providers";

export type MediaDraft = {
  draft: CapturedRecipe;
  /** False when the text had no ingredient or step headings, so nothing could be placed in the editor. */
  usable: boolean;
};

/** Below this mean confidence the reading is likely to contain wrong digits or words. */
export const lowConfidence = 0.8;

const ocrNotice =
  "Los datos vienen de texto leído en una imagen (reconocimiento automático). Puede haber errores en cantidades y palabras: revísalas contra la imagen.";

/** Builds an editable draft from OCR text. Missing quantities stay pending exactly like any other source. */
export function draftFromMediaText(text: string, sourceUrl: string | undefined, confidence?: number): MediaDraft {
  const { draft, usable } = draftFromPastedText(text, sourceUrl);
  const notices = [...(draft.notices ?? [])];
  notices[0] = ocrNotice;
  if (confidence !== undefined && confidence < lowConfidence) {
    notices.push("La lectura de la imagen tuvo poca seguridad. Si puedes, vuelve a intentarlo con una captura más nítida.");
  }
  return { draft: { ...draft, notices }, usable };
}

/** Combines image text with a caption the user already pasted. Disagreements become notices; nothing is silently chosen. */
export function combineWithCaption(caption: CapturedRecipe, image: CapturedRecipe): CapturedRecipe {
  return mergeCapturedSources([
    { label: "la descripción pegada", draft: caption },
    { label: "la imagen", draft: image },
  ]);
}
