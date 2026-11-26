import { describe, expect, it } from "vitest";
import { formatMeasuredAmount } from "../../domain";
import { parseIngredientLine } from "./ingredient-line";

function read(line: string) {
  const { ingredient, flag } = parseIngredientLine(line);
  const amount = ingredient.amount;
  const shown = amount.kind === "measured" ? `${formatMeasuredAmount(amount)} ${amount.unit}` : amount.kind === "qualitative" ? amount.text : "pending";
  return { name: ingredient.name, shown, flag, originalText: ingredient.originalText };
}

describe("parseIngredientLine", () => {
  it.each([
    ["500 g de pechuga de pollo", "pechuga de pollo", "500 gram"],
    ["1 1/2 tazas de salsa verde", "salsa verde", "1 1/2 cup"],
    ["1½ cups all-purpose flour", "all-purpose flour", "1 1/2 cup"],
    ["½ cucharadita de sal", "sal", "1/2 teaspoon"],
    ["2 cdas. de aceite", "aceite", "2 tablespoon"],
    ["0,5 kg de jitomate", "jitomate", "1/2 kilogram"],
    ["2-3 dientes de ajo", "dientes de ajo", "2–3 piece"],
    ["2 a 3 limones", "limones", "2–3 piece"],
    ["3 huevos", "huevos", "3 piece"],
    ["Una pizca de sal", "sal", "1 pinch"],
    ["media taza de azúcar", "azúcar", "1/2 cup"],
    ["un manojo de cilantro", "cilantro", "1 bunch"],
    ["250 ml leche", "leche", "250 milliliter"],
    ["1 litro de caldo", "caldo", "1 liter"],
    ["8 fl oz milk", "milk", "8 fluidOunceUs"],
    ["2 oz butter", "butter", "2 ounce"],
    ["• 4 tomates", "tomates", "4 piece"],
  ])("reads %s", (line, name, shown) => {
    expect(read(line)).toMatchObject({ name, shown, flag: undefined });
  });

  it("keeps the exact amount of an exact fraction", () => {
    const { ingredient } = parseIngredientLine("1/3 taza de aceite");
    expect(ingredient.amount).toEqual({ kind: "measured", unit: "cup", min: { numerator: "1", denominator: "3" } });
  });

  it("marks taste-based amounts as qualitative and preserves the name", () => {
    expect(read("Sal al gusto")).toMatchObject({ name: "Sal", shown: "al gusto" });
    expect(read("Sal y pimienta al gusto")).toMatchObject({ name: "Sal y pimienta", shown: "al gusto" });
    expect(read("salt to taste")).toMatchObject({ name: "salt", shown: "al gusto" });
  });

  it("leaves unknown amounts pending instead of guessing", () => {
    expect(read("Aguacate")).toMatchObject({ name: "Aguacate", shown: "pending", flag: "unparsed" });
    expect(read("1 lb de carne molida")).toMatchObject({ name: "1 lb de carne molida", shown: "pending", flag: "unsupported-unit" });
    expect(read("3-2 tazas de agua")).toMatchObject({ shown: "pending", flag: "unparsed" });
    expect(read("2 tazas")).toMatchObject({ shown: "pending", flag: "unparsed" });
    expect(read("")).toMatchObject({ shown: "pending", flag: "unparsed" });
  });

  it("always keeps the original text", () => {
    expect(read("  2 tazas de harina ").originalText).toBe("2 tazas de harina");
  });
});
