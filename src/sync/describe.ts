import type { Amount, Density, Recipe } from "../contracts";
import { formatMeasuredAmount } from "../domain";
import { categoryKindLabels, classificationLabels, tagLabels, unitLabel } from "../ui/text";
import type { Collection, RecordData, RepairNote, SyncNotice } from "./types";

/** Spanish names for the kinds of record a person can be asked about. */
export const collectionLabels: Readonly<Record<Collection, string>> = {
  recipes: "Receta",
  categories: "Categoría",
  ingredients: "Ingrediente personal",
  ingredient_overrides: "Ajuste de ingrediente compartido",
  shared_ingredients: "Ingrediente compartido",
  menu: "Lote del menú",
  photos: "Foto",
  shopping_items: "Artículo de la lista de compras",
  shopping_balances: "Cantidad de la lista de compras",
  shopping_checked: "Línea marcada en la lista de compras",
};

const count = new Intl.NumberFormat("es-MX");

function amountText(amount: Amount): string {
  if (amount.kind === "unspecified") return "";
  if (amount.kind === "qualitative") return amount.text;
  return `${formatMeasuredAmount(amount)} ${unitLabel(amount.unit, amount.max ?? amount.min)}`;
}

function line(name: string, amount: Amount | undefined): string {
  const quantity = amount ? amountText(amount) : "";
  return quantity ? `${name} · ${quantity}` : name;
}

function density(value: Density): string {
  return `${value.gramsPerMilliliter.numerator}/${value.gramsPerMilliliter.denominator} g/ml · ${value.source}`;
}

/** Lines that let a person compare two versions of one record. The first line names the record. */
export function describeRecord(collection: Collection, data: RecordData | undefined, names: ReadonlyMap<string, string>): string[] {
  if (!data) return [];
  const nameOf = (id: string) => names.get(id) ?? "Ingrediente";
  switch (collection) {
    case "recipes": {
      const recipe = data as unknown as Recipe;
      return [
        recipe.name,
        ...recipe.ingredients.map((entry) => line(nameOf(entry.ingredientId), entry.amount)),
        ...recipe.steps.map((step, index) => `${index + 1}. ${step}`),
        ...recipe.categoryIds.map((id) => names.get(id) ?? "Categoría"),
        ...recipe.tags.map((tag) => tagLabels[tag]),
        ...(recipe.sourceUrl ? [recipe.sourceUrl] : []),
        ...(recipe.photoId ? ["Incluye foto"] : []),
      ];
    }
    case "menu": {
      const entry = data as unknown as { name: string; portions: number; ingredients: { ingredientId: string; name: string; amount: Amount }[] };
      return [entry.name, `${count.format(entry.portions)} porciones`, ...entry.ingredients.map((item) => line(item.name, item.amount))];
    }
    case "categories": {
      const category = data as unknown as { name: string; kind: keyof typeof categoryKindLabels };
      return [category.name, categoryKindLabels[category.kind] ?? ""].filter(Boolean);
    }
    case "ingredients":
    case "ingredient_overrides": {
      const item = data as unknown as {
        id: string; name?: string; hidden?: boolean; parentId?: string | null; classification?: keyof typeof classificationLabels | null;
        density?: Density | null;
      };
      if (item.hidden) return [nameOf(item.id), "Ocultar este ingrediente"];
      return [
        item.name ?? nameOf(item.id),
        ...(item.parentId === undefined ? [] : [item.parentId ? `Variante de ${nameOf(item.parentId)}` : "Sin ingrediente principal"]),
        ...(item.classification === undefined ? [] : [item.classification ? classificationLabels[item.classification] : "Sin clasificación"]),
        ...(item.density === undefined ? [] : [item.density ? density(item.density) : "Sin equivalencia"]),
      ];
    }
    case "photos": {
      const photo = data as unknown as { width: number; height: number };
      return [`${photo.width} × ${photo.height} px`];
    }
    case "shopping_items": {
      const item = data as unknown as { name: string; amount: Amount };
      return [line(item.name, item.amount)];
    }
    case "shopping_balances": {
      const row = data as unknown as { unit: Parameters<typeof unitLabel>[0]; bought?: Parameters<typeof formatMeasuredAmount>[0]["min"]; onHand?: Parameters<typeof formatMeasuredAmount>[0]["min"] };
      const text = (value: typeof row.bought) => value ? `${formatMeasuredAmount({ kind: "measured", unit: row.unit, min: value })} ${unitLabel(row.unit, value)}` : undefined;
      return [text(row.bought) ? `Comprado: ${text(row.bought)}` : "", text(row.onHand) ? `En casa: ${text(row.onHand)}` : ""].filter(Boolean);
    }
    case "shopping_checked": {
      const row = data as unknown as { note: string | null };
      return [row.note ? `Marcado como comprado · ${row.note}` : "Marcado como comprado"];
    }
    case "shared_ingredients":
      return [String(data.name ?? nameOf(data.id))];
  }
}

function repairText(note: RepairNote): string {
  switch (note.code) {
    case "ingredientLineRemoved":
      return `«${note.subject}» tenía un ingrediente que se eliminó en otro dispositivo. Quitamos esa línea de la receta.`;
    case "categoryRemoved":
      return `«${note.subject}» estaba en una categoría que se eliminó en otro dispositivo. Quitamos esa categoría de la receta.`;
    case "photoDetached":
      return `«${note.subject}» ya no tiene foto porque se cambió o se eliminó en otro dispositivo.`;
    case "parentCleared":
      return `«${note.subject}» ya no depende de otro ingrediente porque ese ingrediente cambió en otro dispositivo.`;
    case "overrideDropped":
      return "Quitamos un ajuste de un ingrediente compartido que ya no existe en el catálogo de esta versión.";
  }
}

/** The explanation shown after sync changed something the person did not do on this device. */
export function noticeText(notice: SyncNotice): string {
  if (notice.code === "repaired") return repairText(notice.note);
  return `«${notice.name}» se eliminó en otro dispositivo, así que también se quitó de este. La eliminación tiene prioridad sobre tus cambios sin sincronizar.`;
}
