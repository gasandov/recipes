// Regenerates recipe-es.png from recipe-es.expected.json: black Arial text on white, drawn by Chromium.
// Usage: node src/capture/media/fixtures/make-fixture.mjs   (needs the Playwright Chromium from `npm run test:e2e:install`)
// The PNG is committed, so tests do not need to run this. Rendering depends on the machine's Arial; if the text
// changes, update recipe-es.expected.json to match.
/* global document */
import { Buffer } from "node:buffer";
import { readFile, writeFile } from "node:fs/promises";
import { URL } from "node:url";
import { chromium } from "@playwright/test";

const dir = new URL("./", import.meta.url);
const { lines } = JSON.parse(await readFile(new URL("recipe-es.expected.json", dir), "utf8"));

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 620 } });
  await page.setContent('<body style="margin:0"><canvas id="c" width="900" height="620"></canvas></body>');
  const dataUrl = await page.evaluate((text) => {
    const canvas = document.getElementById("c");
    const context = canvas.getContext("2d");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, 900, 620);
    context.fillStyle = "#111";
    context.font = "bold 34px Arial";
    text.forEach((line, index) => context.fillText(line, 40, 60 + index * 58));
    return canvas.toDataURL("image/png");
  }, lines);
  await writeFile(new URL("recipe-es.png", dir), Buffer.from(dataUrl.split(",")[1], "base64"));
} finally {
  await browser.close();
}
