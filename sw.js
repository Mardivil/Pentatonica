// The page's service worker: what makes Chrome offer to install the game, and what lets it start
// without a connection once it has been played.
//
// Two kinds of file, cached two ways:
//
// - Files whose content changes under the same name with each release (index.html, the scripts,
//   the manifest, the interface strings) come from the network first, so a published update is
//   seen at once, and from the cache only when there is no network.
// - Files that never change under their name come from the cache first: the .wasm files, named
//   after a hash of their content, the note samples and the icons. Samples are cached as they are
//   played, so only the instruments someone has heard are kept.
//
// A new pentatonica.js names the .wasm files it loads, and every other cached .wasm file is then
// deleted, so the cache holds one release rather than all of them.

const CACHE = "pentatonica";
const WASM = /[0-9a-f]{20}\.wasm/g;

// Everything the game needs to start, fetched as soon as the worker is installed. The page's
// first visit loads these before the worker can see its requests, so without this the first
// offline start would find no interface strings. One strings file per language: keep the list in
// step with shared/src/commonMain/composeResources/values*.
const LANGUAGES = ["", "-de", "-es", "-fr", "-pt", "-uk"];
const SHELL = [
    "./",
    "audio.js",
    "pentatonica.js",
    "manifest.webmanifest",
    "icon-192.png",
    "icon-512.png",
    "apple-touch-icon.png",
    ...LANGUAGES.map(suffix => "composeResources/pentatonica.app/values" + suffix + "/strings.commonMain.cvr"),
];

self.addEventListener("install", event => event.waitUntil(precache().then(() => self.skipWaiting())));

async function precache() {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL);
    const script = await (await cache.match("pentatonica.js")).text();
    await cache.addAll([...new Set(script.match(WASM) || [])]);
}

self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", event => {
    const request = event.request;
    if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
    event.respondWith(unchanging(request.url) ? cacheFirst(request) : networkFirst(request));
});

function unchanging(url) {
    const path = new URL(url).pathname;
    return path.endsWith(".wasm") || path.includes("/notes/") || path.endsWith(".png");
}

async function cacheFirst(request) {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
}

async function networkFirst(request) {
    const cache = await caches.open(CACHE);
    try {
        const response = await fetch(request);
        if (response.ok) {
            cache.put(request, response.clone());
            if (new URL(request.url).pathname.endsWith("/pentatonica.js")) {
                dropOtherWasm(cache, await response.clone().text());
            }
        }
        return response;
    } catch (offline) {
        const cached = await cache.match(request);
        if (cached) return cached;
        throw offline;
    }
}

async function dropOtherWasm(cache, script) {
    const current = new Set(script.match(WASM) || []);
    if (current.size === 0) return;
    for (const request of await cache.keys()) {
        const name = new URL(request.url).pathname.split("/").pop();
        if (name.endsWith(".wasm") && !current.has(name)) await cache.delete(request);
    }
}
