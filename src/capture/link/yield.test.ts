import { describe, expect, it } from "vitest";
import { parseYield } from "./yield";

describe("parseYield", () => {
  it.each([
    ["4", 4], ["4 porciones", 4], ["Rinde 6", 6], ["Para 4 personas", 4], ["Serves 8", 8], ["6 servings", 6],
    ["Porciones: 12", 12], ["Rinde: 4 raciones", 4],
  ])("reads %s as %i portions", (text, portions) => {
    expect(parseYield(text)).toEqual({ portions });
  });

  it("does not invent portions", () => {
    expect(parseYield(undefined)).toEqual({});
    expect(parseYield("  ")).toEqual({});
    expect(parseYield("4-6 porciones").portions).toBeUndefined();
    expect(parseYield("4-6 porciones").note).toContain("rango");
    expect(parseYield("24 galletas")).toMatchObject({ note: expect.stringContaining("24 galletas") });
    expect(parseYield("24 galletas").portions).toBeUndefined();
    expect(parseYield("Una charola").portions).toBeUndefined();
    expect(parseYield("Makes 12").portions).toBeUndefined();
    expect(parseYield("Makes 12")).toMatchObject({ note: expect.stringContaining("Makes 12") });
    expect(parseYield("Yield: 8").portions).toBeUndefined();
    expect(parseYield("0").portions).toBeUndefined();
  });
});
