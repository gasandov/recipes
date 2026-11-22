import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import solid from "@solidjs/vite-plugin";
import { defineConfig } from "vite";
import type { Plugin } from "vite";

function appShell(): Plugin {
  return {
    name: "recetario-app-shell",
    apply: "build",
    enforce: "post",
    generateBundle: {
      order: "post",
      async handler(_outputOptions, bundle) {
        const publicAssets = [
          "manifest.webmanifest",
          "icons/icon-192.png",
          "icons/icon-512.png",
          "icons/icon-maskable.png",
          "icons/apple-touch-icon.png",
        ];
        const worker = await readFile(new URL("./src/pwa/service-worker.js", import.meta.url), "utf8");
        const hash = createHash("sha256").update(worker);
        const assets: string[] = [];

        for (const [name, file] of Object.entries(bundle).sort(([a], [b]) => a.localeCompare(b))) {
          if (name.endsWith(".map")) continue;
          assets.push(name);
          hash.update(name).update(file.type === "chunk" ? file.code : file.source);
        }
        for (const name of publicAssets) {
          assets.push(name);
          hash.update(name).update(await readFile(new URL(`./public/${name}`, import.meta.url)));
        }

        const revision = hash.digest("hex").slice(0, 16);
        this.emitFile({
          type: "asset",
          fileName: "sw.js",
          source: `self.precache = ${JSON.stringify({ revision, assets })};\n${worker}`,
        });
      },
    },
  };
}

export default defineConfig({ base: "./", plugins: [solid(), appShell()] });
