import { describe, expect, it, vi } from "vitest";
import type { Amount, UnitId } from "../../contracts";
import { parseMeasuredAmount } from "../../domain";
import type { CapturedRecipe } from "../contract";
import { parseRecipeTranscript } from "./index";

function measured(text: string, unit: UnitId): Amount {
  return parseMeasuredAmount(text, unit);
}

function lines(recipe: CapturedRecipe): [string, Amount][] {
  return recipe.ingredients.map((item) => [item.name, item.amount]);
}

describe("punctuated dictation with headings", () => {
  const recipe = parseRecipeTranscript(
    "Receta de enchiladas verdes para cuatro personas. Ingredientes: seis tomates verdes, dos chiles serranos, "
    + "media cebolla, un diente de ajo, 250 gramos de pollo deshebrado, una taza y media de crema, sal al gusto. "
    + "Preparación: primero hervimos los tomates con los chiles. Luego los licuamos con la cebolla y el ajo. "
    + "Después pasamos las tortillas por aceite y las rellenamos con el pollo.",
  );

  it("extracts the name, stated portions, and ingredient lines with exact amounts", () => {
    expect(recipe.name).toBe("Enchiladas verdes");
    expect(recipe.portions).toBe(4);
    expect(lines(recipe)).toEqual([
      ["Tomates verdes", measured("6", "piece")],
      ["Chiles serranos", measured("2", "piece")],
      ["Cebolla", measured("1/2", "piece")],
      ["Ajo", measured("1", "piece")],
      ["Pollo", measured("250", "gram")],
      ["Crema", measured("1 1/2", "cup")],
      ["Sal", { kind: "qualitative", text: "al gusto" }],
    ]);
  });

  it("keeps the preparation steps in spoken order without ordering words", () => {
    expect(recipe.steps).toEqual([
      "Hervimos los tomates con los chiles.",
      "Los licuamos con la cebolla y el ajo.",
      "Pasamos las tortillas por aceite y las rellenamos con el pollo.",
    ]);
  });

  it("keeps the spoken phrase for review and raises no notice for a complete recipe", () => {
    expect(recipe.ingredients[5].originalText).toBe("una taza y media de crema");
    expect(recipe.notices).toBeUndefined();
  });
});

describe("run-on dictation as speech recognition often returns it", () => {
  it("splits ingredients at each new quantity and steps at ordering words", () => {
    const recipe = parseRecipeTranscript(
      "vamos a preparar un pozole rojo que rinde ocho porciones necesitamos kilo y medio de maíz pozolero "
      + "medio kilo de carne de puerco un cuarto de kilo de chile guajillo tres dientes de ajo sal y pimienta al gusto "
      + "primero cocemos el maíz con el ajo después licuamos los chiles y los agregamos al caldo finalmente servimos "
      + "con lechuga y rábano",
    );
    expect(recipe.name).toBe("Pozole rojo");
    expect(recipe.portions).toBe(8);
    expect(lines(recipe)).toEqual([
      ["Maíz pozolero", measured("1.5", "kilogram")],
      ["Carne de puerco", measured("1/2", "kilogram")],
      ["Chile guajillo", measured("1/4", "kilogram")],
      ["Ajo", measured("3", "piece")],
      ["Sal", { kind: "qualitative", text: "al gusto" }],
      ["Pimienta", { kind: "qualitative", text: "al gusto" }],
    ]);
    expect(recipe.steps).toEqual([
      "Cocemos el maíz con el ajo.",
      "Licuamos los chiles y los agregamos al caldo.",
      "Servimos con lechuga y rábano.",
    ]);
  });

  it("moves from ingredients to steps without any heading when a clause starts with a cooking verb", () => {
    const recipe = parseRecipeTranscript(
      "hoy hacemos un pastel de zanahoria lleva 2 tazas de harina 1 1/2 cucharaditas de polvo para hornear "
      + "de 2 a 3 zanahorias ralladas tres cuartos de taza de aceite cuatro huevos y una pizca de sal "
      + "mezclamos todo y horneamos a 180 grados por 40 minutos",
    );
    expect(recipe.name).toBe("Pastel de zanahoria");
    expect(lines(recipe)).toEqual([
      ["Harina", measured("2", "cup")],
      ["Polvo para hornear", measured("1 1/2", "teaspoon")],
      ["Zanahorias", measured("2-3", "piece")],
      ["Aceite", measured("3/4", "cup")],
      ["Huevos", measured("4", "piece")],
      ["Sal", measured("1", "pinch")],
    ]);
    expect(recipe.steps).toEqual(["Mezclamos todo y horneamos a 180 grados por 40 minutos."]);
  });

  it("numbers steps and ignores `paso N` labels", () => {
    const recipe = parseRecipeTranscript(
      "Salsa roja para seis personas. Ingredientes: cinco jitomates, dos chiles de árbol. "
      + "Paso 1: asa los jitomates. Paso dos licúalos con el ajo. Paso 3, fríe la salsa por diez minutos.",
    );
    expect(recipe.steps).toEqual(["Asa los jitomates.", "Licúalos con el ajo.", "Fríe la salsa por diez minutos."]);
  });
});

describe("quantities", () => {
  function first(text: string) {
    return parseRecipeTranscript(`Ingredientes: ${text}.`).ingredients[0];
  }

  it.each([
    ["una taza y media de leche", "Leche", measured("3/2", "cup")],
    ["taza y media de leche", "Leche", measured("3/2", "cup")],
    ["dos y medio litros de caldo", "Caldo", measured("5/2", "liter")],
    ["dos kilos y medio de papa", "Papa", measured("5/2", "kilogram")],
    ["tres cuartos de taza de aceite", "Aceite", measured("3/4", "cup")],
    ["3 cuartos de taza de aceite", "Aceite", measured("3/4", "cup")],
    ["1 tercio de taza de leche", "Leche", measured("1/3", "cup")],
    ["1/4 de cebolla", "Cebolla", measured("1/4", "piece")],
    ["1 1/2 tazas de azúcar", "Azúcar", measured("3/2", "cup")],
    ["1½ tazas de azúcar", "Azúcar", measured("3/2", "cup")],
    ["2,5 kg de jitomate", "Jitomate", measured("5/2", "kilogram")],
    ["doscientos cincuenta gramos de queso", "Queso", measured("250", "gram")],
    ["250g de queso", "Queso", measured("250", "gram")],
    ["veintiún dientes de ajo", "Ajo", measured("21", "piece")],
    ["dos cucharadas soperas de aceite", "Aceite", measured("2", "tablespoon")],
    ["una cucharada cafetera de comino", "Comino", measured("1", "teaspoon")],
    ["2 cdtas de sal", "Sal", measured("2", "teaspoon")],
    ["una onza líquida de ron", "Ron", measured("1", "fluidOunceUs")],
    ["un manojo de cilantro", "Cilantro", measured("1", "bunch")],
    ["pizca de sal", "Sal", measured("1", "pinch")],
  ] as const)("reads %j", (spoken, name, amount) => {
    const item = first(spoken);
    expect(item.name).toBe(name);
    expect(item.amount).toEqual(amount);
  });

  it.each([
    ["de 2 a 3 jitomates", "2-3", "piece"],
    ["dos o tres jitomates", "2-3", "piece"],
    ["entre 3 y 4 chiles de árbol", "3-4", "piece"],
    ["2-3 cucharadas de aceite", "2-3", "tablespoon"],
    ["media a una taza de crema", "1/2-1", "cup"],
    ["de 100 a 150 gramos de queso", "100-150", "gram"],
  ] as const)("reads the range %j", (spoken, range, unit) => {
    expect(first(spoken).amount).toEqual(measured(range, unit));
  });

  it("asks for review when `o` makes a range ambiguous", () => {
    const recipe = parseRecipeTranscript("Ingredientes: dos o tres jitomates.");
    expect(recipe.notices?.join("\n")).toContain("se registró como un rango (2–3)");
  });

  it("keeps a reversed range pending instead of guessing", () => {
    const recipe = parseRecipeTranscript("Ingredientes: de 4 a 2 tazas de leche.");
    expect(recipe.ingredients[0].amount).toEqual({ kind: "unspecified" });
    expect(recipe.notices?.join("\n")).toContain("estaba invertido");
  });

  it("separates one-egg-or-two-chiles style lists into two ingredients", () => {
    const recipe = parseRecipeTranscript("Ingredientes: 1 cebolla o 2 chiles.");
    expect(lines(recipe)).toEqual([
      ["Cebolla", measured("1", "piece")],
      ["Chiles", measured("2", "piece")],
    ]);
  });

  it("treats vague amounts as qualitative text and flags a conflicting `al gusto`", () => {
    const recipe = parseRecipeTranscript(
      "Ingredientes: un chorrito de aceite, un poco de sal, cilantro picado al gusto, cantidad suficiente de agua, "
      + "2 chiles al gusto.",
    );
    expect(lines(recipe)).toEqual([
      ["Aceite", { kind: "qualitative", text: "un chorrito" }],
      ["Sal", { kind: "qualitative", text: "un poco" }],
      ["Cilantro", { kind: "qualitative", text: "al gusto" }],
      ["Agua", { kind: "qualitative", text: "cantidad suficiente" }],
      ["Chiles", measured("2", "piece")],
    ]);
    expect(recipe.ingredients[2].originalText).toBe("cilantro picado al gusto");
    expect(recipe.notices?.join("\n")).toContain("«Chiles» tiene cantidad y «al gusto»");
  });

  it("marks ingredients with no amount as unspecified and lists them for review", () => {
    const recipe = parseRecipeTranscript("Ingredientes: harina, dos huevos, queso fresco desmoronado.");
    expect(recipe.ingredients[0]).toMatchObject({ name: "Harina", amount: { kind: "unspecified" } });
    expect(recipe.notices?.join("\n")).toContain("Sin cantidad: Harina, Queso fresco desmoronado.");
  });

  it("splits a short conjunction of seasonings and leaves long names whole", () => {
    const recipe = parseRecipeTranscript("Ingredientes: sal y pimienta al gusto, salsa de chile y tomate.");
    expect(lines(recipe)).toEqual([
      ["Sal", { kind: "qualitative", text: "al gusto" }],
      ["Pimienta", { kind: "qualitative", text: "al gusto" }],
      ["Salsa de chile y tomate", { kind: "unspecified" }],
    ]);
  });
});

describe("what the draft leaves for review", () => {
  it("reports missing portions as undefined rather than defaulting to four", () => {
    const recipe = parseRecipeTranscript("Tacos de canasta. Ingredientes: dos tortillas. Calienta las tortillas.");
    expect(recipe.portions).toBeUndefined();
    expect(recipe.notices?.join("\n")).toContain("No mencionaste cuántas porciones");
  });

  it.each([
    ["rinde seis porciones", 6],
    ["para 12 personas", 12],
    ["alcanza para ocho comensales", 8],
    ["salen veinte raciones", 20],
  ])("reads the yield %j", (phrase, portions) => {
    const recipe = parseRecipeTranscript(`Receta de arroz ${phrase}. Ingredientes: dos tazas de arroz.`);
    expect(recipe.portions).toBe(portions);
    expect(recipe.ingredients).toHaveLength(1);
  });

  it("does not turn a portion of an ingredient into the recipe yield", () => {
    const recipe = parseRecipeTranscript("Ingredientes: una porción de queso, dos tazas de leche.");
    expect(recipe.portions).toBeUndefined();
    expect(recipe.ingredients).toHaveLength(2);
  });

  it.each([["de 4 a 6 porciones"], ["dos porciones y media"]])("keeps %j pending", (phrase) => {
    const recipe = parseRecipeTranscript(`Pozole rinde ${phrase}. Ingredientes: dos tazas de maíz.`);
    expect(recipe.portions).toBeUndefined();
    expect(recipe.notices?.join("\n")).toContain("no es una cantidad exacta de porciones");
  });

  it("proposes a title from the first words only when it says so", () => {
    const recipe = parseRecipeTranscript("guacamole tres aguacates, un jitomate. aplasta los aguacates y mezcla");
    expect(recipe.name).toBe("Guacamole");
    expect(recipe.notices?.join("\n")).toContain("Tomamos «Guacamole» como nombre");
    expect(recipe.steps).toEqual(["Aplasta los aguacates y mezcla."]);
  });

  it("leaves the name unset and says so when none was dictated", () => {
    const recipe = parseRecipeTranscript("Ingredientes: dos huevos. Fríe los huevos.");
    expect(recipe.name).toBeUndefined();
    expect(recipe.notices?.[0]).toContain("No detectamos el nombre");
  });

  it("returns an empty draft with notices for silence or unrelated speech", () => {
    for (const text of ["", "   ", "eh mmm"]) {
      const recipe = parseRecipeTranscript(text);
      expect(recipe.ingredients).toEqual([]);
      expect(recipe.steps).toEqual([]);
      expect(recipe.notices?.join("\n")).toContain("No detectamos ingredientes");
    }
  });

  it("does not guess the meaning of a quantity without an ingredient", () => {
    const recipe = parseRecipeTranscript("Ingredientes: dos tazas, tres huevos.");
    expect(lines(recipe)).toEqual([["Huevos", measured("3", "piece")]]);
    expect(recipe.notices?.join("\n")).toContain("Una cantidad no tenía ingrediente");
  });

  it("does not log or leak the transcript", () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level));
    parseRecipeTranscript("Receta de mole. Ingredientes: dos chiles. Muele los chiles.");
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });
});
