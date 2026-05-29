"use strict";

const CACHE_VERSION = "mission-area-v18";
const APP_SHELL_CACHE = `${CACHE_VERSION}-app-shell`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

const APP_SHELL_URLS = [
  "./",
  "index.html",
  "rules.html",
  "status.html",
  "styles.css",
  "app.js",
  "transit-worker.js",
  "rules.js",
  "status.js",
  "pwa.js",
  "rules.md",
  "manifest.webmanifest",
  "assets/Map.json",
  "assets/Lines.json",
  "assets/Stops.json",
  "assets/BusRoutes.geojson",
  "assets/BusStops_Active.geojson",
  "assets/LightrailLines_Offset.geojson",
  "assets/LightrailStations.geojson",
  "assets/game_zone.geojson",
  "hide-denver-printable-play-area.geojson",
  "icons/icon.svg",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
  "https://cdn.jsdelivr.net/npm/@turf/turf@6.5.0/turf.min.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(APP_SHELL_CACHE)
      .then((cache) =>
        Promise.allSettled(
          APP_SHELL_URLS.map((url) =>
            fetch(url)
              .then((response) => {
                if (!response || response.status >= 400) return null;
                return cache.put(url, response);
              })
              .catch(() => null),
          ),
        ),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => ![APP_SHELL_CACHE, RUNTIME_CACHE].includes(key))
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, "index.html"));
    return;
  }

  if (url.hostname.endsWith("basemaps.cartocdn.com")) {
    event.respondWith(cacheFirst(request, RUNTIME_CACHE));
    return;
  }

  event.respondWith(cacheFirst(request, APP_SHELL_CACHE));
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response && response.status < 400) {
    cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(request, fallbackUrl) {
  const cache = await caches.open(APP_SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response && response.status < 400) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    return (await cache.match(request)) || cache.match(fallbackUrl);
  }
}
