// Static server for the production build used by the browser tests.
//
// Usage: node e2e/support/server.mjs <buildDir> <port> [<port> ...]
//
// It mimics the headers recommended for the real deployment: `no-cache` for the HTML shell and
// service worker, immutable caching for hashed assets, and the manifest media type. Each port
// serves the same build and keeps its own "release" state, so the update test can pretend a new
// version shipped without rebuilding: `POST /__e2e/release?version=b` makes that port serve a
// different `sw.js` revision and an HTML marker. Binds to 127.0.0.1 only.
import { Buffer } from "node:buffer";
import console from "node:console";
import { createServer } from "node:http";
import { access, readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers";
import { URL } from "node:url";

const [buildDirArg, ...portArgs] = process.argv.slice(2);
if (!buildDirArg || portArgs.length === 0) {
  console.error("Usage: node server.mjs <buildDir> <port> [<port> ...]");
  process.exit(1);
}
const root = resolve(buildDirArg);

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

async function waitForBuild() {
  // The build runs in a sibling process. Do not listen until it has produced the shell.
  for (let attempt = 0; attempt < 600; attempt++) {
    try {
      await access(join(root, "sw.js"));
      await access(join(root, "index.html"));
      return;
    } catch {
      await new Promise((done) => setTimeout(done, 200));
    }
  }
  throw new Error(`No production build appeared in ${root}.`);
}

function start(port) {
  let version = "a";

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/__e2e/release" && request.method === "POST") {
      version = url.searchParams.get("version") ?? "a";
      response.writeHead(204).end();
      return;
    }

    const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const file = normalize(join(root, relative));
    if (file !== root && !file.startsWith(root + sep)) {
      response.writeHead(403).end();
      return;
    }

    try {
      let body = await readFile(file);
      const name = relative;
      const headers = { "content-type": types[extname(file)] ?? "application/octet-stream" };

      if (name === "index.html" || name === "sw.js") headers["cache-control"] = "no-cache";
      else if (name.startsWith("assets/")) headers["cache-control"] = "public, max-age=31536000, immutable";
      else headers["cache-control"] = "no-cache";

      if (version !== "a") {
        if (name === "sw.js") {
          // A new release changes the precache revision, and therefore the worker bytes.
          body = Buffer.from(body.toString("utf8").replace(/"revision":"[^"]*"/, `"revision":"release-${version}"`));
        }
        if (name === "index.html") {
          body = Buffer.from(body.toString("utf8").replace("</head>", `<meta name="e2e-release" content="${version}"></head>`));
        }
      }
      response.writeHead(200, headers).end(request.method === "HEAD" ? undefined : body);
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
    }
  });

  return new Promise((done) => server.listen(port, "127.0.0.1", done));
}

await waitForBuild();
await Promise.all(portArgs.map((port) => start(Number(port))));
console.log(`Serving ${root} on ${portArgs.join(", ")}`);
