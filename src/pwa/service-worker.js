// The build inserts the asset list and its content revision above this script.
const { revision, assets } = self.precache;
const scope = self.registration.scope;
const cachePrefix = `recetario:${scope}:`;
const cacheName = cachePrefix + revision;
const assetUrls = new Set(assets.map((asset) => new URL(asset, scope).href));
const indexUrl = new URL("index.html", scope).href;

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    await cache.addAll([...assetUrls].map((url) => new Request(url, { cache: "reload" })));
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith(cachePrefix) && name !== cacheName)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || !request.url.startsWith(scope)) return;

  const key = request.mode === "navigate" ? indexUrl : request.url;
  if (!assetUrls.has(key)) return;

  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    return (await cache.match(key)) ?? fetch(request);
  })());
});
