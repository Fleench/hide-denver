"use strict";

self.onmessage = async (event) => {
  if (event.data?.type !== "process") return;
  try {
    const { cacheKey, urls } = event.data;
    const [lines, stops, busRoutes, busStops, railLines, railStations] = await Promise.all([
      fetchJson(urls.lines),
      fetchJson(urls.stops),
      fetchJson(urls.busRoutes),
      fetchJson(urls.busStops),
      fetchJson(urls.railLines),
      fetchJson(urls.railStations),
    ]);
    self.postMessage({
      type: "processed",
      payload: processTransitData(cacheKey, lines, stops, busRoutes, busStops, railLines, railStations),
    });
  } catch (error) {
    self.postMessage({ type: "error", message: error.message || String(error) });
  }
};

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Could not load ${url}.`);
  return response.json();
}

function processTransitData(cacheKey, linesGeojson, stopsGeojson, busRoutesGeojson, busStopsGeojson, railLinesGeojson, railStationsGeojson) {
  const routeMetadata = buildRouteMetadata([busRoutesGeojson, railLinesGeojson]);
  const stopMetadata = buildStopMetadata([busStopsGeojson, railStationsGeojson]);
  const serviceLineStops = buildServiceLineStops([busRoutesGeojson, railLinesGeojson], { busStops: busStopsGeojson, railStations: railStationsGeojson });
  const namedStops = buildNamedFilteredStops(stopsGeojson, stopMetadata);
  const lineFeatures = geometryCollectionToFeatures(linesGeojson, { layer: "line" }).map(feature => ({
    ...feature,
    properties: { ...feature.properties, ...(routeMetadata.get(geometrySignature(feature.geometry)) || {}) },
  }));
  assignTransitLineColors(lineFeatures);
  addFeatureBounds(lineFeatures);

  const stopFeatures = geometryCollectionToFeatures(stopsGeojson, { layer: "stop" });
  addFeatureBounds(stopFeatures);

  return {
    cacheKey,
    createdAt: new Date().toISOString(),
    namedStops,
    serviceLines: buildServiceLines(lineFeatures, serviceLineStops),
    featureCollection: {
      type: "FeatureCollection",
      features: [...lineFeatures, ...stopFeatures],
    },
  };
}

function buildRouteMetadata(routeGeojsons) {
  const metadata = new Map();
  for (const source of routeGeojsons) {
    for (const feature of collectFeatures(source)) {
      if (!isLineGeometry(feature.geometry)) continue;
      const route = String(feature.properties?.ROUTE || "").trim();
      const name = String(feature.properties?.NAME || "").trim();
      metadata.set(geometrySignature(feature.geometry), {
        route,
        name,
        type: String(feature.properties?.TYPE || "UNKNOWN").trim() || "UNKNOWN",
        service: String(feature.properties?.SERVICE || "").trim(),
        label: formatLineLabel(route, name),
      });
    }
  }
  return metadata;
}

function assignTransitLineColors(lineFeatures) {
  const groups = new Map();
  for (const feature of lineFeatures) {
    const routeType = String(feature.properties?.type || "UNKNOWN").trim().toUpperCase() || "UNKNOWN";
    if (!groups.has(routeType)) groups.set(routeType, []);
    groups.get(routeType).push(feature);
  }
  for (const [routeType, features] of groups) {
    const palette = routeTypeColors[routeType] || routeTypeColors.UNKNOWN;
    const byRoute = new Map();
    for (const feature of features) {
      const key = `${feature.properties?.route}|${feature.properties?.name}`;
      if (!byRoute.has(key)) byRoute.set(key, palette[byRoute.size % palette.length]);
      feature.properties.color = byRoute.get(key);
    }
  }
}

const routeTypeColors = {
  LOC: ["#e11d48", "#0ea5e9", "#f59e0b"],
  REG: ["#2563eb", "#dc2626", "#65a30d"],
  CNR: ["#7c3aed", "#0891b2", "#ea580c"],
  SKY: ["#0284c7", "#be123c", "#16a34a"],
  LRT: ["#16a34a", "#9333ea", "#f97316"],
  OFF: ["#06b6d4", "#f43f5e", "#84cc16"],
  UNKNOWN: ["#ff8a1c", "#00f0ff", "#f6d047"],
};

function buildStopMetadata(stopGeojsons) {
  const metadata = new Map();
  for (const source of stopGeojsons) {
    for (const feature of collectFeatures(source)) {
      if (feature.geometry?.type !== "Point") continue;
      const [lng, lat] = feature.geometry.coordinates;
      const name = String(feature.properties?.STOPNAME || feature.properties?.NAME || "").trim();
      if (name) metadata.set(coordinateSignature(lng, lat), { name, lat, lng });
    }
  }
  return metadata;
}

function buildNamedFilteredStops(stopsGeojson, stopMetadata) {
  const stops = [];
  const metadataStops = [...stopMetadata.values()];
  for (const geometry of collectGeometries(stopsGeojson)) {
    if (geometry.type !== "Point") continue;
    const [lng, lat] = geometry.coordinates;
    const exact = stopMetadata.get(coordinateSignature(lng, lat));
    if (exact) {
      stops.push(exact);
      continue;
    }
    const nearest = findNearestMetadataStop(lat, lng, metadataStops);
    if (nearest) stops.push(nearest);
  }
  return stops;
}

function findNearestMetadataStop(lat, lng, metadataStops) {
  if (!metadataStops.length) return null;
  let best = null;
  let dist = Infinity;
  for (const stop of metadataStops) {
    const nextDist = distanceMiles(lat, lng, stop.lat, stop.lng);
    if (nextDist < dist) {
      dist = nextDist;
      best = stop;
    }
  }
  return dist > 0.03 ? null : best;
}

function buildServiceLines(lineFeatures, serviceLineStops) {
  const lines = new Map();
  for (const feature of lineFeatures) {
    if (!feature.properties?.label) continue;
    const key = `${feature.properties.route}|${feature.properties.name}`;
    if (!lines.has(key)) {
      lines.set(key, {
        route: feature.properties.route || "",
        name: feature.properties.name || "",
        key,
        label: feature.properties.label,
        color: feature.properties.color || "#ff8a1c",
        group: getRouteGroup(feature),
        stops: serviceLineStops.get(key) || [],
      });
    }
  }
  return [...lines.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
}

function buildServiceLineStops(routeGeojsons, stopSources) {
  const stopsByLine = new Map();
  for (const source of routeGeojsons) {
    for (const feature of collectFeatures(source)) {
      if (!isLineGeometry(feature.geometry)) continue;
      const route = String(feature.properties?.ROUTE || "").trim();
      const name = String(feature.properties?.NAME || "").trim();
      if (!route && !name) continue;
      stopsByLine.set(`${route}|${name}`, getStopsForRoute(getRouteTokens(route, name), stopSources));
    }
  }
  return stopsByLine;
}

function getRouteTokens(route, name) {
  const tokens = new Set();
  for (const value of [route, name]) {
    String(value || "")
      .split(/[-,/ ]+/)
      .map(token => token.trim())
      .filter(Boolean)
      .forEach(token => tokens.add(token.replace(/Line$/i, "")));
  }
  if (route) tokens.add(route.replace(/-Line$/i, ""));
  return [...tokens].filter(Boolean);
}

function getStopsForRoute(routeTokens, stopSources) {
  const tokens = new Set(routeTokens);
  const stopsByName = new Map();
  for (const stop of collectFeatures(stopSources.busStops)) {
    const routes = String(stop.properties?.ROUTES || "").split(",").map(route => route.trim()).filter(Boolean);
    if (!routes.some(route => tokens.has(route))) continue;
    const name = String(stop.properties?.STOPNAME || "").trim();
    if (name) stopsByName.set(`bus:${name}`, name);
  }
  for (const station of collectFeatures(stopSources.railStations)) {
    const railTokens = String(station.properties?.RAIL_LINE || "").split(/[-,/ ]+/).map(route => route.trim()).filter(Boolean);
    if (!railTokens.some(route => tokens.has(route))) continue;
    const name = String(station.properties?.NAME || "").trim();
    if (name) stopsByName.set(`rail:${name}`, name);
  }
  return [...stopsByName.values()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function addFeatureBounds(features) {
  for (const feature of features) {
    feature.properties = feature.properties || {};
    feature.properties.bbox = getGeometryBounds(feature.geometry);
  }
}

function getGeometryBounds(geometry) {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [lng, lat] of getAllCoordinates(geometry)) {
    if (lng < west) west = lng;
    if (lng > east) east = lng;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  return Number.isFinite(west) ? [west, south, east, north] : null;
}

function geometryCollectionToFeatures(geojson, properties = {}) {
  if (geojson.type === "FeatureCollection") return geojson.features.map(feature => ({ ...feature, properties: { ...properties, ...(feature.properties || {}) } }));
  if (geojson.type === "Feature") return [{ ...geojson, properties: { ...properties, ...(geojson.properties || {}) } }];
  if (geojson.type === "GeometryCollection") return geojson.geometries.map(geometry => ({ type: "Feature", properties, geometry }));
  return [{ type: "Feature", properties, geometry: geojson }];
}

function collectFeatures(geojson) {
  if (!geojson) return [];
  if (geojson.type === "FeatureCollection") return geojson.features;
  if (geojson.type === "Feature") return [geojson];
  if (geojson.type === "GeometryCollection") return geojson.geometries.map(geometry => ({ type: "Feature", properties: {}, geometry }));
  return [{ type: "Feature", properties: {}, geometry: geojson }];
}

function collectGeometries(geojson) {
  if (!geojson) return [];
  if (geojson.type === "FeatureCollection") return geojson.features.flatMap(collectGeometries);
  if (geojson.type === "Feature") return collectGeometries(geojson.geometry);
  if (geojson.type === "GeometryCollection") return geojson.geometries.flatMap(collectGeometries);
  return [geojson];
}

function getAllCoordinates(geometry) {
  if (!geometry) return [];
  if (geometry.type === "Point") return [geometry.coordinates];
  if (geometry.type === "MultiPoint" || geometry.type === "LineString") return geometry.coordinates;
  if (geometry.type === "MultiLineString" || geometry.type === "Polygon") return geometry.coordinates.flat();
  if (geometry.type === "MultiPolygon") return geometry.coordinates.flat(2);
  if (geometry.type === "GeometryCollection") return geometry.geometries.flatMap(getAllCoordinates);
  return [];
}

function isLineGeometry(geometry) {
  return geometry && ["LineString", "MultiLineString"].includes(geometry.type);
}

function geometrySignature(geometry) {
  return JSON.stringify(geometry.coordinates);
}

function coordinateSignature(lng, lat) {
  return `${Number(lng).toFixed(6)},${Number(lat).toFixed(6)}`;
}

function formatLineLabel(route, name) {
  return route && name && route !== name ? `${route} - ${name}` : (route || name || "");
}

function getRouteGroup(feature) {
  const type = String(feature.properties?.type || "UNKNOWN").trim().toUpperCase();
  const service = String(feature.properties?.service || "").toUpperCase();
  return type === "LRT" || type === "OFF" || service.includes("RAIL") ? "Rail" : "Bus";
}

function distanceMiles(lat1, lng1, lat2, lng2) {
  const radiusMiles = 3958.7613;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  return radiusMiles * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRadians(degrees) {
  return degrees * Math.PI / 180;
}
