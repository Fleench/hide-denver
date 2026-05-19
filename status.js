"use strict";

const statusCards = document.querySelector("#statusCards");
const statusBackButton = document.querySelector("#statusBackButton");

statusBackButton?.addEventListener("click", () => {
  window.location.href = "index.html";
});

if (statusCards) {
  loadStatus();
} else {
  console.error("Status container was not found.");
}

async function loadStatus() {
  try {
    const [map, lines, stops, busRoutes, railRoutes, busStops, railStations] =
      await Promise.all([
        fetchJson("assets/Map.json"),
        fetchJson("assets/Lines.json"),
        fetchJson("assets/Stops.json"),
        fetchJson("assets/BusRoutes.geojson"),
        fetchJson("assets/LightrailLines_Offset.geojson"),
        fetchJson("assets/BusStops_Active.geojson"),
        fetchJson("assets/LightrailStations.geojson"),
      ]);

    const serviceLines = getMatchedServiceLines(lines, [busRoutes, railRoutes], {
      busStops,
      railStations,
    });
    const stopCount = countPointGeometries(stops);
    const areaSquareMiles = calculateAreaSquareMiles(map);

    statusCards.replaceChildren(
      renderStatusCard(
        serviceLines.length,
        "Service Lines in Use",
        "Matched against Lines.json from the original route files.",
      ),
      renderStatusCard(stopCount, "Stops", "Loaded from Stops.json."),
      renderStatusCard(
        areaSquareMiles.toLocaleString(undefined, {
          maximumFractionDigits: 2,
          minimumFractionDigits: 2,
        }),
        "Play Area mi²",
        "Calculated from Map.json.",
      ),
      renderLineListCard(serviceLines),
    );
  } catch (error) {
    statusCards.replaceChildren(
      renderStatusCard("!", "Status Unavailable", error.message || String(error)),
    );
  }
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Could not load ${url}.`);
  }
  return response.json();
}

function countPointGeometries(geojson) {
  let count = 0;
  for (const geometry of collectGeometries(geojson)) {
    if (geometry.type === "Point") count += 1;
    if (geometry.type === "MultiPoint") count += geometry.coordinates.length;
  }
  return count;
}

function getMatchedServiceLines(linesGeojson, sourceGeojsons, stopSources) {
  const sourceByGeometry = new Map();
  for (const source of sourceGeojsons) {
    for (const feature of collectFeatures(source)) {
      if (!isLineGeometry(feature.geometry)) continue;
      sourceByGeometry.set(geometrySignature(feature.geometry), feature.properties || {});
    }
  }

  const serviceLines = new Map();
  for (const geometry of collectGeometries(linesGeojson)) {
    if (!isLineGeometry(geometry)) continue;
    const properties = sourceByGeometry.get(geometrySignature(geometry));
    if (!properties) continue;

    const route = String(properties.ROUTE || "").trim();
    const name = String(properties.NAME || "").trim();
    const key = `${route}|${name}`;
    if (!route && !name) continue;

    serviceLines.set(key, {
      route,
      name,
      label: formatLineLabel(route, name),
      stops: getStopsForRoute(getRouteTokens(route, name), stopSources),
    });
  }

  return [...serviceLines.values()].sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { numeric: true }),
  );
}

function collectFeatures(geojson) {
  if (!geojson) return [];

  if (geojson.type === "FeatureCollection") return geojson.features;
  if (geojson.type === "Feature") return [geojson];
  if (geojson.type === "GeometryCollection") {
    return geojson.geometries.map((geometry) => ({
      type: "Feature",
      properties: {},
      geometry,
    }));
  }

  return [
    {
      type: "Feature",
      properties: {},
      geometry: geojson,
    },
  ];
}

function isLineGeometry(geometry) {
  return geometry && ["LineString", "MultiLineString"].includes(geometry.type);
}

function geometrySignature(geometry) {
  return JSON.stringify(geometry.coordinates);
}

function formatLineLabel(route, name) {
  if (route && name && route !== name) return `${route} - ${name}`;
  return route || name;
}

function getRouteTokens(route, name) {
  const tokens = new Set();
  for (const value of [route, name]) {
    String(value || "")
      .split(/[-,/ ]+/)
      .map((token) => token.trim())
      .filter(Boolean)
      .forEach((token) => tokens.add(token.replace(/Line$/i, "")));
  }
  if (route) tokens.add(route.replace(/-Line$/i, ""));
  return [...tokens].filter(Boolean);
}

function getStopsForRoute(routeTokens, stopSources) {
  const tokens = new Set(routeTokens);
  const stopsByName = new Map();

  for (const stop of collectFeatures(stopSources.busStops)) {
    const routes = String(stop.properties?.ROUTES || "")
      .split(",")
      .map((route) => route.trim())
      .filter(Boolean);
    if (!routes.some((route) => tokens.has(route))) continue;
    const name = String(stop.properties?.STOPNAME || "").trim();
    if (name) stopsByName.set(`bus:${name}`, name);
  }

  for (const station of collectFeatures(stopSources.railStations)) {
    const railTokens = String(station.properties?.RAIL_LINE || "")
      .split(/[-,/ ]+/)
      .map((route) => route.trim())
      .filter(Boolean);
    if (!railTokens.some((route) => tokens.has(route))) continue;
    const name = String(station.properties?.NAME || "").trim();
    if (name) stopsByName.set(`rail:${name}`, name);
  }

  return [...stopsByName.values()].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
}

function calculateAreaSquareMiles(mapGeojson) {
  const squareMeters = collectFeatures(mapGeojson)
    .filter((feature) => ["Polygon", "MultiPolygon"].includes(feature.geometry?.type))
    .reduce((total, feature) => total + turf.area(feature), 0);

  return squareMeters / 2589988.110336;
}

function collectGeometries(geojson) {
  if (!geojson) return [];

  if (geojson.type === "FeatureCollection") {
    return geojson.features.flatMap(collectGeometries);
  }

  if (geojson.type === "Feature") {
    return collectGeometries(geojson.geometry);
  }

  if (geojson.type === "GeometryCollection") {
    return geojson.geometries.flatMap(collectGeometries);
  }

  return [geojson];
}

function renderStatusCard(value, title, description) {
  const article = document.createElement("article");
  article.className = "status-card";

  const number = document.createElement("span");
  number.className = "status-number";
  number.textContent = typeof value === "number" ? value.toLocaleString() : value;

  const heading = document.createElement("h2");
  heading.textContent = title;

  const body = document.createElement("p");
  body.textContent = description;

  article.append(number, heading, body);
  return article;
}

function renderLineListCard(serviceLines) {
  const article = document.createElement("article");
  article.className = "status-card status-card-wide";

  const heading = document.createElement("h2");
  heading.textContent = "Lines in Use";

  const list = document.createElement("ul");
  list.className = "status-line-list";

  for (const line of serviceLines) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.className = "status-line-button";
    button.type = "button";
    button.textContent = line.label;
    button.addEventListener("click", () => renderSelectedLine(article, line));
    item.appendChild(button);
    list.appendChild(item);
  }

  article.append(heading, list);
  return article;
}

function renderSelectedLine(container, line) {
  container.querySelector(".status-selected-line")?.remove();

  const section = document.createElement("section");
  section.className = "status-selected-line";

  const heading = document.createElement("h3");
  heading.textContent = line.label;

  const summary = document.createElement("p");
  summary.textContent = `${line.stops.length.toLocaleString()} stops/stations`;

  const list = document.createElement("ol");
  list.className = "status-stop-list";
  const names = line.stops.length ? line.stops : ["No matching stops found."];
  for (const stop of names) {
    const item = document.createElement("li");
    item.textContent = stop;
    list.appendChild(item);
  }

  section.append(heading, summary, list);
  container.appendChild(section);
}
