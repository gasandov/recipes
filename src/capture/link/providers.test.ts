import { describe, expect, it } from "vitest";
import type { CapturedRecipe } from "../contract";
import { facebookAdapter, instagramAdapter, mergeCapturedSources, unavailableOcr, unavailableSpeech } from "./providers";

const cup = (n: string, d: string) => ({ kind: "measured" as const, unit: "cup" as const, min: { numerator: n, denominator: d } });
const caption: CapturedRecipe = {
  name: "Pozole", portions: 4,
  ingredients: [{ name: "Maíz", amount: cup("2", "1") }, { name: "Sal", amount: { kind: "unspecified" } }],
  steps: ["Cuece el maíz."], notices: ["Texto pegado."],
};
const speech: CapturedRecipe = {
  name: "pozole rojo", portions: 6,
  ingredients: [{ name: "maiz", amount: cup("3", "1") }, { name: "Sal", amount: cup("1", "4") }, { name: "Chile", amount: { kind: "unspecified" } }],
  steps: ["Cuece el maíz.", "Agrega el chile."],
};

describe("social adapters", () => {
  it("claim no caption or media access and cite their sources", () => {
    for (const adapter of [instagramAdapter, facebookAdapter]) {
      expect(adapter.access).toMatchObject({ captions: "unsupported", media: "unsupported", verifiedOn: "2026-11-22" });
      expect(adapter.access.sources.length).toBeGreaterThan(0);
      expect(adapter.readPublicCaption).toBeUndefined();
    }
    expect(instagramAdapter.matches(new URL("https://www.instagram.com/reel/x"))).toBe(true);
    expect(instagramAdapter.matches(new URL("https://www.facebook.com/x"))).toBe(false);
    expect(facebookAdapter.matches(new URL("https://fb.watch/x"))).toBe(true);
  });
});

describe("media extractors", () => {
  it("report unavailable and never pretend to read media", async () => {
    for (const extractor of [unavailableOcr, unavailableSpeech]) {
      expect(extractor.availability.status).toBe("unavailable");
      const result = await extractor.extract({ kind: "video", url: "https://cdn.example/v.mp4", origin: "page-structured-data" }, {});
      expect(result.status).toBe("unsupported");
    }
  });
});

describe("mergeCapturedSources", () => {
  it("keeps the first source and flags every disagreement for review", () => {
    const merged = mergeCapturedSources([{ label: "descripción", draft: caption }, { label: "audio", draft: speech }]);
    expect(merged.portions).toBe(4);
    expect(merged.ingredients.find((line) => line.name === "Maíz")?.amount).toEqual(cup("2", "1"));
    expect(merged.ingredients.map((line) => line.name)).toEqual(["Maíz", "Sal", "Chile"]);
    const notices = (merged.notices ?? []).join("\n");
    expect(notices).toContain("nombre difiere");
    expect(notices).toContain("porciones difieren: 4 (descripción) y 6 (audio)");
    expect(notices).toContain('cantidad de "Maíz" difiere');
    expect(notices).toContain('"Chile" solo aparece en audio');
    expect(notices).toContain("número de pasos difiere");
    // A pending amount may be filled from another source, but it is flagged for confirmation.
    expect(merged.ingredients.find((line) => line.name === "Sal")?.amount).toEqual(cup("1", "4"));
    expect(notices).toContain('cantidad de "Sal"');
  });

  it("does not mutate its inputs", () => {
    const before = structuredClone(caption);
    mergeCapturedSources([{ label: "a", draft: caption }, { label: "b", draft: speech }]);
    expect(caption).toEqual(before);
  });

  it("handles no sources", () => {
    expect(mergeCapturedSources([])).toEqual({ ingredients: [], steps: [] });
  });
});
