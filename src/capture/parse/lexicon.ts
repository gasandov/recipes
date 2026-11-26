import type { UnitId } from "../../contracts";

/** Accent-free spoken words. Regular verbs are expanded into the forms people use while dictating. */
const regularVerbs = [
  "agregar", "picar", "cocinar", "licuar", "mezclar", "sazonar", "hornear", "precalentar", "dejar", "tapar", "bajar",
  "batir", "tostar", "asar", "pelar", "lavar", "desinfectar", "escurrir", "colar", "moler", "amasar", "estirar",
  "rellenar", "dorar", "saltear", "integrar", "incorporar", "retirar", "reservar", "untar", "enrollar", "banar",
  "decorar", "acompanar", "cortar", "rebanar", "rallar", "acitronar", "anadir", "remojar", "desvenar", "aplastar",
  "machacar", "triturar", "ablandar", "marinar", "adobar", "sellar", "cubrir", "voltear", "servir", "meter", "sacar",
  "echar", "probar", "rectificar", "apagar", "prender", "encender", "enfriar", "refrigerar", "congelar",
  "descongelar", "hidratar", "desgranar", "cernir", "tamizar", "forrar", "engrasar", "enharinar", "extender",
  "ensamblar", "armar", "emplatar", "adornar", "espolvorear", "rociar", "exprimir", "dividir", "separar", "unir",
  "juntar", "esperar", "reposar", "cerrar", "abrir", "partir", "deshuesar", "deshebrar", "sumergir", "mojar",
  "remover", "escaldar", "gratinar", "licuar", "colocar", "verter", "vaciar", "tallar", "freir", "hervir",
  "sofreir", "poner", "mover", "cocer", "revolver", "calentar", "pasar",
];

const irregularForms = [
  "frie", "freimos", "fria", "hierve", "hervimos", "sofrie", "sofreimos", "pon", "pone", "ponemos", "sirve",
  "servimos", "tuesta", "tostamos", "calienta", "calentamos", "cierra", "cuela", "colamos", "muele", "molemos",
  "revuelve", "revolvemos", "mueve", "movemos", "cuece", "cocemos", "anade", "anadimos",
];

const firstPlural = new Set<string>();
const verbForms = new Set<string>(irregularForms);

for (const infinitive of regularVerbs) {
  verbForms.add(infinitive);
  const stem = infinitive.slice(0, -2);
  if (infinitive.endsWith("ar")) {
    verbForms.add(`${stem}a`);
    firstPlural.add(`${stem}amos`);
  } else if (infinitive.endsWith("er")) {
    verbForms.add(`${stem}e`);
    firstPlural.add(`${stem}emos`);
  } else {
    verbForms.add(`${stem}e`);
    firstPlural.add(`${stem}imos`);
  }
}
for (const form of ["freimos", "hervimos", "sofreimos", "ponemos", "servimos", "tostamos", "calentamos", "colamos",
  "molemos", "revolvemos", "movemos", "cocemos", "anadimos"]) firstPlural.add(form);
for (const form of firstPlural) verbForms.add(form);

/** Forms that start a step when they open a clause. */
export const stepVerbs: ReadonlySet<string> = verbForms;
/** Unambiguous first-person-plural forms, safe to cut an ingredient phrase. */
export const firstPersonPlural: ReadonlySet<string> = firstPlural;

/** Ordering words that open a new step. */
export const connectors: ReadonlySet<string> = new Set([
  "luego", "despues", "primero", "segundo", "tercero", "enseguida", "posteriormente", "finalmente", "entonces",
]);

export const fillers: ReadonlySet<string> = new Set(["eh", "ehh", "em", "emm", "mm", "mmm", "mmmm", "ah", "ajam"]);

export type UnitMatch = { unit: UnitId; words: number };

const simpleUnits: Record<string, UnitId> = {
  gramo: "gram", gramos: "gram", gr: "gram", grs: "gram", g: "gram", gramito: "gram", gramitos: "gram",
  kilo: "kilogram", kilos: "kilogram", kg: "kilogram", kgs: "kilogram", kilogramo: "kilogram", kilogramos: "kilogram",
  mililitro: "milliliter", mililitros: "milliliter", ml: "milliliter", mls: "milliliter",
  litro: "liter", litros: "liter", l: "liter", lt: "liter", lts: "liter",
  taza: "cup", tazas: "cup",
  cucharada: "tablespoon", cucharadas: "tablespoon", cda: "tablespoon", cdas: "tablespoon",
  cuchara: "tablespoon", cucharas: "tablespoon",
  cucharadita: "teaspoon", cucharaditas: "teaspoon", cdta: "teaspoon", cdtas: "teaspoon", cdita: "teaspoon",
  cditas: "teaspoon",
  onza: "ounce", onzas: "ounce", oz: "ounce",
  pieza: "piece", piezas: "piece", pza: "piece", pzas: "piece", unidad: "piece", unidades: "piece",
  diente: "piece", dientes: "piece", rama: "piece", ramas: "piece", ramita: "piece", ramitas: "piece",
  hoja: "piece", hojas: "piece", rebanada: "piece", rebanadas: "piece", rodaja: "piece", rodajas: "piece",
  gajo: "piece", gajos: "piece", tallo: "piece", tallos: "piece",
  pizca: "pinch", pizcas: "pinch",
  manojo: "bunch", manojos: "bunch", manojito: "bunch", ramo: "bunch", ramos: "bunch", ramito: "bunch",
  ramitos: "bunch",
};

const unitModifiers = new Set(["sopera", "soperas", "rasa", "rasas", "colmada", "colmadas", "copeteada", "copeteadas",
  "grande", "grandes"]);

export function unitAt(keys: readonly (string | undefined)[], index: number): UnitMatch | undefined {
  const key = keys[index];
  if (key === undefined) return undefined;
  const next = keys[index + 1];

  if (key === "fl" && keys[index + 1] === "oz") return { unit: "fluidOunceUs", words: 2 };
  if ((key === "onza" || key === "onzas") && next !== undefined && /^(liquida|liquidas|fluida|fluidas)$/u.test(next)) {
    return { unit: "fluidOunceUs", words: 2 };
  }
  if (/^cuchar(?:a|as|ada|adas)$/u.test(key) && next !== undefined && /^cafeter(?:a|as)$/u.test(next)) {
    return { unit: "teaspoon", words: 2 };
  }
  const unit = simpleUnits[key];
  if (unit === undefined) return undefined;
  let words = 1;
  while (unitModifiers.has(keys[index + words] ?? "")) words++;
  return { unit, words };
}

export const countNouns: ReadonlySet<string> = new Set([
  "diente", "dientes", "rama", "ramas", "ramita", "ramitas", "hoja", "hojas", "rebanada", "rebanadas", "rodaja",
  "rodajas", "gajo", "gajos", "tallo", "tallos",
]);

export function isUnitWord(key: string | undefined): boolean {
  return key !== undefined && key in simpleUnits;
}

export type Qualitative = { text: string; words: number };

const leadQualifiers: ReadonlyArray<[string[], string]> = [
  [["un", "buen", "chorro"], "un buen chorro"],
  [["un", "chorrito"], "un chorrito"], [["chorrito"], "un chorrito"],
  [["un", "chorro"], "un chorro"], [["chorro"], "un chorro"],
  [["un", "poquito"], "un poquito"], [["poquito"], "un poquito"], [["poquita"], "un poquito"],
  [["un", "poco"], "un poco"], [["poco"], "un poco"],
  [["un", "punado"], "un puñado"], [["punado"], "un puñado"], [["un", "punito"], "un puñado"],
  [["unas", "gotas"], "unas gotas"], [["unas", "gotitas"], "unas gotas"], [["gotas"], "unas gotas"],
  [["cantidad", "suficiente"], "cantidad suficiente"], [["suficiente"], "cantidad suficiente"],
  [["lo", "necesario"], "lo necesario"], [["un", "toque"], "un toque"], [["unos", "cuantos"], "unos cuantos"], [["unas", "cuantas"], "unas cuantas"],
];

/** A vague amount before the ingredient, such as `un poco de`. */
export function leadingQualitative(keys: readonly (string | undefined)[], index: number): Qualitative | undefined {
  for (const [words, text] of leadQualifiers) {
    if (words.every((word, offset) => keys[index + offset] === word)) return { text, words: words.length };
  }
  return undefined;
}

const trailQualifiers: ReadonlyArray<[string[], string]> = [
  [["al", "gusto"], "al gusto"], [["a", "gusto"], "al gusto"],
  [["lo", "que", "se", "necesite"], "lo necesario"], [["lo", "que", "necesites"], "lo necesario"],
  [["lo", "que", "necesite"], "lo necesario"], [["lo", "necesario"], "lo necesario"],
  [["cantidad", "suficiente"], "cantidad suficiente"], [["c", "s"], "cantidad suficiente"],
  [["opcional"], "opcional"],
];

/** A vague amount after the ingredient, such as `al gusto`. */
export function trailingQualitative(keys: readonly (string | undefined)[], index: number): Qualitative | undefined {
  for (const [words, text] of trailQualifiers) {
    if (words.every((word, offset) => keys[index + offset] === word)) return { text, words: words.length };
  }
  return undefined;
}

export const portionNouns: ReadonlySet<string> = new Set([
  "porcion", "porciones", "racion", "raciones", "persona", "personas", "comensal", "comensales", "invitado",
  "invitados",
]);

/** Seasonings people list at the end with `al gusto`; used to separate them from a measured ingredient before them. */
export const seasoningWords: ReadonlySet<string> = new Set([
  "sal", "pimienta", "azucar", "comino", "oregano", "aceite", "limon", "cilantro", "perejil", "pimenton", "canela",
  "negra", "blanca", "molida", "fina", "gruesa", "mar", "polvo", "en", "de", "y", "e",
]);
