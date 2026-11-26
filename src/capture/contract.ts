import type { Amount } from "../contracts";

export type CapturedIngredient = {
  name: string;
  amount: Amount;
  originalText?: string;
};

/** Source-derived values before review and four-portion normalization. */
export type CapturedRecipe = {
  name?: string;
  portions?: number;
  ingredients: CapturedIngredient[];
  steps: string[];
  sourceUrl?: string;
  notices?: string[];
};

export type CaptureActionProps = {
  onDraft: (draft: CapturedRecipe) => void;
  initialUrl?: string;
};
