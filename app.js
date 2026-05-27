"use strict";

const MAP_URL = "assets/Map.json";
const LINES_URL = "assets/Lines.json";
const STOPS_URL = "assets/Stops.json";
const BUS_ROUTES_URL = "assets/BusRoutes.geojson";
const BUS_STOPS_URL = "assets/BusStops_Active.geojson";
const RAIL_LINES_URL = "assets/LightrailLines_Offset.geojson";
const RAIL_STATIONS_URL = "assets/LightrailStations.geojson";
const SHRINK_RADIUS_MILES = 0.25;
const STORED_PIN_KEY = "hideDenver.activePin";
const TRANSIT_VISIBLE_KEY = "hideDenver.linesStopsVisible";
const LINE_NAMES_VISIBLE_KEY = "hideDenver.lineNamesVisible";
const TRANSIT_CACHE_DB = "hideDenverTransitCache";
const TRANSIT_CACHE_STORE = "processedTransit";
const TRANSIT_CACHE_KEY = "transit-v4";
const TRANSIT_WORKER_URL = "transit-worker.js";
const REMOTE_RULES_URL = "https://denver.flench.me/rules.md";
const REMOTE_RULES_PROXY_URL = "remote-rules.md";
const RULES_CACHE_TEXT_KEY = "hideDenver.rulesMarkdown";
const RULES_CACHE_VERSION_KEY = "hideDenver.rulesVersion";
const WARNING_DISABLED_KEY = "hideDenver.warningDisabled";
const COPY_COORDINATES_KEY = "hideDenver.copyCoordinatesOnTap";
const OFFLINE_MODE_KEY = "hideDenver.offlineMode";
const NO_UI_MODE_KEY = "hideDenver.noUiMode";
const ROUTE_TYPE_COLORS = {
  LOC: ["#e11d48", "#0ea5e9", "#f59e0b"],
  REG: ["#2563eb", "#dc2626", "#65a30d"],
  CNR: ["#7c3aed", "#0891b2", "#ea580c"],
  SKY: ["#0284c7", "#be123c", "#16a34a"],
  LRT: ["#16a34a", "#9333ea", "#f97316"],
  OFF: ["#06b6d4", "#f43f5e", "#84cc16"],
  UNKNOWN: ["#ff8a1c", "#00f0ff", "#f6d047"],
};

const elements = {
  map: document.querySelector("#map"),
  zoneOverlay: document.querySelector("#zoneOverlay"),
  centerButton: document.querySelector("#centerButton"),
  zoomInButton: document.querySelector("#zoomInButton"),
  zoomOutButton: document.querySelector("#zoomOutButton"),
  bottomPanel: document.querySelector("#bottomPanel"),
  bottomPanelToggles: document.querySelector(".bottom-panel-toggles"),
  statusToggleButton: document.querySelector("#statusToggleButton"),
  statusContent: document.querySelector("#statusContent"),
  statusCards: document.querySelector("#statusCards"),
  rulesToggleButton: document.querySelector("#rulesToggleButton"),
  rulesRefreshButton: document.querySelector("#rulesRefreshButton"),
  rulesContent: document.querySelector("#rulesContent"),
  rulesCards: document.querySelector("#rulesCards"),
  devContent: document.querySelector("#devContent"),
  warningDisableToggle: document.querySelector("#warningDisableToggle"),
  copyCoordinatesToggle: document.querySelector("#copyCoordinatesToggle"),
  offlineModeToggle: document.querySelector("#offlineModeToggle"),
  noUiModeToggle: document.querySelector("#noUiModeToggle"),
  visibleRoutesSummary: document.querySelector("#visibleRoutesSummary"),
  visibleRoutesList: document.querySelector("#visibleRoutesList"),
  statusClock: document.querySelector("#statusClock"),
  statusBattery: document.querySelector("#statusBattery"),
  batteryLevel: document.querySelector("#batteryLevel"),
  transitToggleButton: document.querySelector("#transitToggleButton"),
  lineNamesToggleButton: document.querySelector("#lineNamesToggleButton"),
  resetButton: document.querySelector("#resetButton"),
  statusPanel: document.querySelector("#statusPanel"),
};

let map;
let originalZoneFeature;
let activeZoneFeature;
let originalBoundaryLayer;
let activeBoundaryLayer;
let transitFeatureCollection = null;
let transitServiceLines = [];
let transitStopBuckets = null;
let overlayLayers = null;
let selectedTransitLineKey = null;
let suppressTransitSelectionReset = false;
let transitVisible = safeGetStorageItem(TRANSIT_VISIBLE_KEY) !== "false";
let lineNamesVisible = safeGetStorageItem(LINE_NAMES_VISIBLE_KEY) === "true";
let autoFollowEnabled = false;
let activeTabId = null;
let isFullscreen = false;
let namedStops = [];
let droppedPinLatLng = null;
let radiusFeature = null;
let playerMarker;
let pinMarker;
let radiusLayer;
let watchId = null;
let lastPlayerPosition = null;
let overlayUpdateFrame = null;
let touchMapInteractionActive = false;
let activeTouchPointers = 0;
const activeTouchPointerIds = new Set();
let longPressTimer = null;
let longPressPoint = null;
let longPressStartClient = null;
let paneSwipeStart = null;
let paneSwipeHandled = false;
let warningDisabled = safeGetStorageItem(WARNING_DISABLED_KEY) === "true";
let copyCoordinatesOnTap = safeGetStorageItem(COPY_COORDINATES_KEY) === "true";
let offlineMode = safeGetStorageItem(OFFLINE_MODE_KEY) === "true";
let noUiMode = safeGetStorageItem(NO_UI_MODE_KEY) === "true";
let warningActive = false;
const devChordPointers = new Set();
let suppressTabClickCount = 0;
let lastDevChordClick = null;
let tileErrorShown = false;
let noUiExitClickCount = 0;
let noUiExitClickTimer = null;
const launchTabId = getLaunchTabId();

document.body.classList.toggle("no-ui-mode", noUiMode);

bootstrap();

async function bootstrap() {
  try {
    bindConnectivityEvents();
    showStatus("Loading mission area...", { persistent: true });
    const zoneFeature = await loadPrimaryPolygon();
    originalZoneFeature = zoneFeature;
    activeZoneFeature = originalZoneFeature;

    createMap();
    renderMissionLayers();
    bindControls();
    bindLongPress();
    bindPaneSwipes();
    startStatusUpdater();
    fitToActiveZone();
    loadMissionStatus();
    loadMissionRules({ checkRemote: true });

    const restoredPin = restoreStoredPin();
    startForegroundTracking();
    if (!restoredPin) {
      showStatus("Long-press the map to shrink the mission area to a 1/4-mile radius.");
    }
    loadTransitOverlays();
    if (launchTabId) setTabState(launchTabId, false);
  } catch (error) {
    showStatus(error.message || String(error), { persistent: true, error: true });
  }
}

function getLaunchTabId() {
  try {
    const params = new URLSearchParams(window.location.search);
    const tab = String(params.get("tab") || window.location.hash.replace(/^#/, "") || "").toLowerCase();
    if (tab === "status" || tab === "rules" || tab === "dev") return tab;
  } catch (error) {}
  return null;
}

async function loadTransitOverlays() {
  try {
    showStatus("Loading transit lines and stops...", { persistent: true });
    const linesStopsFeatureCollection = await loadLinesAndStops();
    renderLinesAndStops(linesStopsFeatureCollection);
    showStatus("Transit loaded.");
  } catch (error) {
    console.error("Transit overlays unavailable.", error);
    namedStops = [];
    transitServiceLines = [];
    transitStopBuckets = null;
    renderLinesAndStops({ type: "FeatureCollection", features: [] });
    showStatus("Transit overlays unavailable. Map and geofence still work.", {
      persistent: true,
      error: true,
    });
  }
}

function startStatusUpdater() {
  updateStatusText();
  setInterval(updateStatusText, 10000);
}

async function updateStatusText() {
  const now = new Date();
  const timeStr = now.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  if (elements.statusClock) elements.statusClock.textContent = timeStr;

  try {
    if ("getBattery" in navigator) {
      const battery = await navigator.getBattery();
      const level = Math.round(battery.level * 100);
      if (elements.batteryLevel) elements.batteryLevel.textContent = `${level}%`;

      const useChargingIcon = battery.charging;
      const iconHref = useChargingIcon ? "#icon-battery-charging" : "#icon-battery";
      elements.statusBattery?.querySelector("use")?.setAttribute("href", iconHref);
    }
  } catch (e) {
    // Battery API might fail or be blocked
  }
}

function safeGetStorageItem(key) {
  try {
    return window.localStorage.getItem(key);
  } catch (error) {
    return null;
  }
}

function safeSetStorageItem(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch (error) {}
}

function safeRemoveStorageItem(key) {
  try {
    window.localStorage.removeItem(key);
  } catch (error) {}
}

function openTransitCacheDb() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("IndexedDB is not available."));
      return;
    }
    const request = indexedDB.open(TRANSIT_CACHE_DB, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(TRANSIT_CACHE_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open transit cache."));
  });
}

async function readCachedTransit() {
  try {
    const db = await openTransitCacheDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(TRANSIT_CACHE_STORE, "readonly");
      const request = tx.objectStore(TRANSIT_CACHE_STORE).get(TRANSIT_CACHE_KEY);
      request.onsuccess = () => {
        const value = request.result;
        resolve(value?.cacheKey === TRANSIT_CACHE_KEY ? value : null);
      };
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => db.close();
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  } catch (error) {
    console.warn("Transit cache read failed.", error);
    return null;
  }
}

async function writeCachedTransit(processedTransit) {
  try {
    const db = await openTransitCacheDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(TRANSIT_CACHE_STORE, "readwrite");
      tx.objectStore(TRANSIT_CACHE_STORE).put(processedTransit, TRANSIT_CACHE_KEY);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  } catch (error) {
    console.warn("Transit cache write failed.", error);
  }
}

async function loadPrimaryPolygon() {
  const response = await fetch(MAP_URL, { cache: "no-store" });
  if (!response.ok) throw new Error(`Could not load ${MAP_URL}.`);
  const geojson = await response.json();
  const polygons = collectPolygonFeatures(geojson);
  if (!polygons.length) throw new Error("No Polygon geometry was found.");
  polygons.sort((a, b) => turf.area(b) - turf.area(a));
  return turf.cleanCoords(polygons[0]);
}

function collectPolygonFeatures(geojson) {
  if (!geojson) return [];
  if (geojson.type === "FeatureCollection") return geojson.features.flatMap(collectPolygonFeatures);
  if (geojson.type === "Feature") return collectPolygonFeatures(geojson.geometry).map(f => ({ ...f, properties: geojson.properties || {} }));
  if (geojson.type === "GeometryCollection") return geojson.geometries.flatMap(collectPolygonFeatures);
  if (geojson.type === "Polygon" || geojson.type === "MultiPolygon") return [{ type: "Feature", properties: {}, geometry: geojson }];
  return [];
}

async function loadLinesAndStops() {
  const cachedTransit = await readCachedTransit();
  if (cachedTransit) {
    applyProcessedTransit(cachedTransit);
    return cachedTransit.featureCollection;
  }

  const processedTransit = await loadProcessedTransitWithWorker().catch((error) => {
    console.warn("Transit worker unavailable; processing on main thread.", error);
    return loadProcessedTransitOnMainThread();
  });
  applyProcessedTransit(processedTransit);
  await writeCachedTransit(processedTransit);
  return processedTransit.featureCollection;
}

async function loadProcessedTransitWithWorker() {
  if (!("Worker" in window)) throw new Error("Workers are not supported.");
  return new Promise((resolve, reject) => {
    const worker = new Worker(TRANSIT_WORKER_URL);
    const timeoutId = window.setTimeout(() => {
      worker.terminate();
      reject(new Error("Transit worker timed out."));
    }, 30000);

    worker.onmessage = (event) => {
      window.clearTimeout(timeoutId);
      worker.terminate();
      if (event.data?.type === "processed") resolve(event.data.payload);
      else reject(new Error(event.data?.message || "Transit worker failed."));
    };
    worker.onerror = (event) => {
      window.clearTimeout(timeoutId);
      worker.terminate();
      reject(new Error(event.message || "Transit worker failed."));
    };
    worker.postMessage({
      type: "process",
      cacheKey: TRANSIT_CACHE_KEY,
      urls: {
        lines: LINES_URL,
        stops: STOPS_URL,
        busRoutes: BUS_ROUTES_URL,
        busStops: BUS_STOPS_URL,
        railLines: RAIL_LINES_URL,
        railStations: RAIL_STATIONS_URL,
      },
    });
  });
}

async function loadProcessedTransitOnMainThread() {
  const [linesResponse, stopsResponse, busRoutesResponse, busStopsResponse, railLinesResponse, railStationsResponse] = await Promise.all([
    fetch(LINES_URL, { cache: "no-store" }),
    fetch(STOPS_URL, { cache: "no-store" }),
    fetch(BUS_ROUTES_URL, { cache: "no-store" }),
    fetch(BUS_STOPS_URL, { cache: "no-store" }),
    fetch(RAIL_LINES_URL, { cache: "no-store" }),
    fetch(RAIL_STATIONS_URL, { cache: "no-store" }),
  ]);

  if (!linesResponse.ok || !stopsResponse.ok || !busRoutesResponse.ok || !busStopsResponse.ok || !railLinesResponse.ok || !railStationsResponse.ok) {
    throw new Error("Could not load transit files.");
  }

  const [linesGeojson, stopsGeojson, busRoutesGeojson, busStopsGeojson, railLinesGeojson, railStationsGeojson] = await Promise.all([
    linesResponse.json(), stopsResponse.json(), busRoutesResponse.json(), busStopsResponse.json(), railLinesResponse.json(), railStationsResponse.json()
  ]);

  return processTransitData(linesGeojson, stopsGeojson, busRoutesGeojson, busStopsGeojson, railLinesGeojson, railStationsGeojson);
}

function processTransitData(linesGeojson, stopsGeojson, busRoutesGeojson, busStopsGeojson, railLinesGeojson, railStationsGeojson) {
  const routeMetadata = buildRouteMetadata([busRoutesGeojson, railLinesGeojson]);
  const stopMetadata = buildStopMetadata([busStopsGeojson, railStationsGeojson]);
  const serviceLineStops = buildServiceLineStops([busRoutesGeojson, railLinesGeojson], { busStops: busStopsGeojson, railStations: railStationsGeojson });
  const filteredStops = buildNamedFilteredStops(stopsGeojson, stopMetadata);
  const lineFeatures = geometryCollectionToFeatures(linesGeojson, { layer: "line" }).map(feature => ({
    ...feature,
    properties: { ...feature.properties, ...(routeMetadata.get(geometrySignature(feature.geometry)) || {}) },
  }));
  assignTransitLineColors(lineFeatures);
  addFeatureBounds(lineFeatures);

  const stopFeatures = geometryCollectionToFeatures(stopsGeojson, { layer: "stop" });
  addFeatureBounds(stopFeatures);
  const serviceLines = buildServiceLines(lineFeatures, serviceLineStops);

  return {
    cacheKey: TRANSIT_CACHE_KEY,
    createdAt: new Date().toISOString(),
    namedStops: filteredStops,
    serviceLines,
    featureCollection: {
      type: "FeatureCollection",
      features: [...lineFeatures, ...stopFeatures],
    },
  };
}

function applyProcessedTransit(processedTransit) {
  namedStops = processedTransit.namedStops || [];
  transitServiceLines = processedTransit.serviceLines || [];
  transitStopBuckets = buildStopBuckets(namedStops);
}

function buildRouteMetadata(routeGeojsons) {
  const metadata = new Map();
  for (const source of routeGeojsons) {
    for (const feature of collectFeatures(source)) {
      if (!isLineGeometry(feature.geometry)) continue;
      const route = String(feature.properties?.ROUTE || "").trim();
      const name = String(feature.properties?.NAME || "").trim();
      metadata.set(geometrySignature(feature.geometry), {
        route, name, type: String(feature.properties?.TYPE || "UNKNOWN").trim() || "UNKNOWN",
        service: String(feature.properties?.SERVICE || "").trim(),
        label: formatLineLabel(route, name),
      });
    }
  }
  return metadata;
}

function buildServiceLines(lineFeatures, serviceLineStops) {
  const lines = new Map();
  for (const f of lineFeatures) {
    if (!f.properties?.label) continue;
    const key = `${f.properties.route}|${f.properties.name}`;
    if (!lines.has(key)) {
      lines.set(key, {
        route: f.properties.route || "",
        name: f.properties.name || "",
        key,
        label: f.properties.label,
        color: f.properties.color || "#ff8a1c",
        group: getRouteGroup(f),
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
    const routes = String(stop.properties?.ROUTES || "")
      .split(",")
      .map(route => route.trim())
      .filter(Boolean);
    if (!routes.some(route => tokens.has(route))) continue;
    const name = String(stop.properties?.STOPNAME || "").trim();
    if (name) stopsByName.set(`bus:${name}`, name);
  }

  for (const station of collectFeatures(stopSources.railStations)) {
    const railTokens = String(station.properties?.RAIL_LINE || "")
      .split(/[-,/ ]+/)
      .map(route => route.trim())
      .filter(Boolean);
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
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const [lng, lat] of getAllCoordinates(geometry)) {
    if (lng < west) west = lng;
    if (lng > east) east = lng;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  return Number.isFinite(west) ? [west, south, east, north] : null;
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

function assignTransitLineColors(lineFeatures) {
  const lineGroups = groupByRouteType(lineFeatures);
  for (const [routeType, features] of lineGroups) {
    const palette = ROUTE_TYPE_COLORS[routeType] || ROUTE_TYPE_COLORS.UNKNOWN;
    const conflicts = buildLineConflictGraph(features);
    const orderedFeatures = [...features].sort((a, b) => conflicts.get(b).size - conflicts.get(a).size);
    for (const feature of orderedFeatures) {
      const neighborColors = new Set([...conflicts.get(feature)].map(n => n.properties?.color).filter(Boolean));
      feature.properties.color = palette.find(c => !neighborColors.has(c)) || chooseLeastConflictingColor(palette, conflicts.get(feature));
    }
  }
}

function groupByRouteType(lineFeatures) {
  const groups = new Map();
  for (const feature of lineFeatures) {
    const routeType = String(feature.properties?.type || "UNKNOWN").trim().toUpperCase() || "UNKNOWN";
    if (!groups.has(routeType)) groups.set(routeType, []);
    groups.get(routeType).push(feature);
  }
  return groups;
}

function buildLineConflictGraph(features) {
  const conflicts = new Map(features.map(f => [f, new Set()]));
  const segmentSignatures = new Map(features.map(f => [f, getLineSegmentSignatures(f.geometry)]));
  for (let i = 0; i < features.length; i++) {
    for (let j = i + 1; j < features.length; j++) {
      if (linesHavePointIntersection(features[i], features[j]) && !lineSegmentSetsOverlap(segmentSignatures.get(features[i]), segmentSignatures.get(features[j]))) {
        conflicts.get(features[i]).add(features[j]);
        conflicts.get(features[j]).add(features[i]);
      }
    }
  }
  return conflicts;
}

function linesHavePointIntersection(f1, f2) {
  try { return turf.lineIntersect(f1, f2).features.length > 0; } catch (e) { return false; }
}

function getLineSegmentSignatures(geometry) {
  const signatures = new Set();
  for (const line of getLineCoordinateSequences(geometry)) {
    for (let i = 1; i < line.length; i++) {
      const s = coordinateColorSignature(line[i - 1]), e = coordinateColorSignature(line[i]);
      signatures.add(s < e ? `${s}|${e}` : `${e}|${s}`);
    }
  }
  return signatures;
}

function coordinateColorSignature([lng, lat]) { return `${Number(lng).toFixed(5)},${Number(lat).toFixed(5)}`; }
function lineSegmentSetsOverlap(s1, s2) { for (const s of s1) { if (s2.has(s)) return true; } return false; }
function chooseLeastConflictingColor(palette, neighbors) {
  return palette.map(c => ({ color: c, conflicts: [...neighbors].filter(n => n.properties?.color === c).length }))
    .sort((a, b) => a.conflicts - b.conflicts)[0].color;
}

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
    if (exact) { stops.push(exact); continue; }
    const nearest = findNearestMetadataStop(lat, lng, metadataStops);
    if (nearest) stops.push(nearest);
  }
  return stops;
}

function findNearestMetadataStop(lat, lng, metadataStops) {
  if (!metadataStops.length) return null;
  const p = turf.point([lng, lat]);
  let best = null, dist = Infinity;
  for (const s of metadataStops) {
    const d = turf.distance(p, turf.point([s.lng, s.lat]), { units: "miles" });
    if (d < dist) { dist = d; best = s; }
  }
  return dist > 0.03 ? null : best;
}

function geometryCollectionToFeatures(geojson, properties = {}) {
  if (geojson.type === "FeatureCollection") return geojson.features.map(f => ({ ...f, properties: { ...properties, ...(f.properties || {}) } }));
  if (geojson.type === "Feature") return [{ ...geojson, properties: { ...properties, ...(geojson.properties || {}) } }];
  if (geojson.type === "GeometryCollection") return geojson.geometries.map(g => ({ type: "Feature", properties, geometry: g }));
  return [{ type: "Feature", properties, geometry: geojson }];
}

function createMap() {
  const center = turf.center(originalZoneFeature).geometry.coordinates;
  map = L.map(elements.map, {
    center: [center[1], center[0]], zoom: 12, zoomSnap: 0.25, zoomDelta: 0.25, wheelPxPerZoomLevel: 80, zoomControl: false, preferCanvas: true,
  });
  const tileLayer = L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    subdomains: "abcd", tileSize: 256, maxZoom: 19, detectRetina: true,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(map);
  tileLayer.on("tileerror", () => {
    if (tileErrorShown) return; tileErrorShown = true;
    showStatus("Map tiles error. Using cache.", { persistent: true, error: true });
  });
  map.on("movestart zoomstart", handleMapMoveStart);
  map.on("moveend zoomend", endTouchMapInteraction);
  map.on("moveend zoomend resize", updateVisibleRoutesPanel);
  map.on("move zoom zoomend viewreset resize", scheduleZoneOverlayUpdate);
  map.on("dragstart zoomstart", () => { disableAutoFollowFromMapInteraction(); clearSelectedTransitLineFromMapInteraction(); });
  map.on("click", handleMapClick);
  requestAnimationFrame(() => { map.invalidateSize(); fitToActiveZone(); scheduleZoneOverlayUpdate(); });
}

function renderMissionLayers() {
  if (originalBoundaryLayer) originalBoundaryLayer.remove();
  if (activeBoundaryLayer) activeBoundaryLayer.remove();
  originalBoundaryLayer = L.geoJSON(originalZoneFeature, {
    interactive: false, pane: "overlayPane",
    style: { color: "#f6d047", dashArray: activeZoneFeature === originalZoneFeature ? null : "8 8", lineCap: "round", weight: activeZoneFeature === originalZoneFeature ? 5 : 3, opacity: activeZoneFeature === originalZoneFeature ? 1 : 0.85, fillOpacity: 0 },
  }).addTo(map);
  activeBoundaryLayer = L.geoJSON(activeZoneFeature, {
    interactive: false, pane: "overlayPane",
    style: { color: "#00f0ff", lineCap: "round", weight: 5, opacity: 1, fillOpacity: 0 },
  }).addTo(map);
  activeBoundaryLayer.bringToFront();
  scheduleZoneOverlayUpdate();
}

function renderLinesAndStops(featureCollection) {
  transitFeatureCollection = featureCollection;
  updateTransitToggleButton();
  updateLineNamesToggleButton();
  updateVisibleRoutesPanel();
  loadMissionStatus();
  scheduleZoneOverlayUpdate();
}

function toggleTransitLayer() {
  transitVisible = !transitVisible;
  if (!transitVisible) selectedTransitLineKey = null;
  safeSetStorageItem(TRANSIT_VISIBLE_KEY, String(transitVisible));
  renderLinesAndStops(transitFeatureCollection);
}

function updateTransitToggleButton() {
  const active = transitVisible;
  elements.transitToggleButton.setAttribute("aria-pressed", String(active));
  updateLineNamesToggleButton();
}

function toggleLineNames() {
  lineNamesVisible = !lineNamesVisible;
  safeSetStorageItem(LINE_NAMES_VISIBLE_KEY, String(lineNamesVisible));
  updateLineNamesToggleButton();
  scheduleZoneOverlayUpdate();
}

function updateLineNamesToggleButton() {
  elements.lineNamesToggleButton.setAttribute("aria-pressed", String(lineNamesVisible));
  elements.lineNamesToggleButton.disabled = !transitVisible;
}

function updateZoneOverlay() {
  if (!map || !originalZoneFeature || !activeZoneFeature) return;
  const size = map.getSize();
  elements.zoneOverlay.setAttribute("viewBox", `0 0 ${size.x} ${size.y}`);
  ensureOverlayLayers();
  overlayLayers.zone.replaceChildren();
  overlayLayers.transit.replaceChildren();
  overlayLayers.labels.replaceChildren();
  drawDimMaskOnOverlay(size, overlayLayers.zone);
  drawFeatureOnOverlay(originalZoneFeature, "zone-original", overlayLayers.zone);
  drawFeatureOnOverlay(activeZoneFeature, "zone-active", overlayLayers.zone);
  if (radiusFeature) drawFeatureOnOverlay(radiusFeature, "zone-radius", overlayLayers.zone);
  const showTransitOverlay = !noUiMode && !touchMapInteractionActive && transitVisible;
  if (showTransitOverlay && transitFeatureCollection) drawTransitOnOverlay(transitFeatureCollection, overlayLayers.transit);
  if (showTransitOverlay && lineNamesVisible && transitFeatureCollection) drawTransitLabelsOnOverlay(transitFeatureCollection, overlayLayers.labels);
  if (showTransitOverlay && droppedPinLatLng) drawNearbyStopNames(droppedPinLatLng, overlayLayers.labels);
}

function ensureOverlayLayers() {
  if (overlayLayers && overlayLayers.zone.isConnected) return;
  elements.zoneOverlay.replaceChildren();
  overlayLayers = {
    zone: document.createElementNS("http://www.w3.org/2000/svg", "g"),
    transit: document.createElementNS("http://www.w3.org/2000/svg", "g"),
    labels: document.createElementNS("http://www.w3.org/2000/svg", "g"),
  };
  overlayLayers.zone.setAttribute("data-layer", "zone");
  overlayLayers.transit.setAttribute("data-layer", "transit");
  overlayLayers.labels.setAttribute("data-layer", "labels");
  elements.zoneOverlay.append(overlayLayers.zone, overlayLayers.transit, overlayLayers.labels);
}

function scheduleZoneOverlayUpdate() {
  if (overlayUpdateFrame !== null || (touchMapInteractionActive && !isLikelyTouchDevice())) return;
  overlayUpdateFrame = requestAnimationFrame(() => { overlayUpdateFrame = null; updateZoneOverlay(); });
}

function handleMapMoveStart() {
  beginTouchMapInteraction();
  clearSelectedTransitLineFromMapInteraction();
}

function beginTouchMapInteraction() { if (isLikelyTouchDevice()) { touchMapInteractionActive = true; clearLongPressTimer(); scheduleZoneOverlayUpdate(); } }
function endTouchMapInteraction() { if (isLikelyTouchDevice()) { touchMapInteractionActive = false; scheduleZoneOverlayUpdate(); } }
function isLikelyTouchDevice() { return (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) || navigator.maxTouchPoints > 0; }

function clearSelectedTransitLineFromMapInteraction() {
  if (suppressTransitSelectionReset || !selectedTransitLineKey) return;
  selectedTransitLineKey = null;
  scheduleZoneOverlayUpdate();
}

function drawTransitOnOverlay(featureCollection, target) {
  const bounds = map.getBounds();
  const bbox = leafletBoundsToBbox(bounds);
  for (const f of featureCollection.features || []) {
    if (!featureBboxIntersects(f, bbox)) continue;
    if (f.properties?.layer === "line") {
      if (selectedTransitLineKey && getTransitLineKey(f) !== selectedTransitLineKey) continue;
      drawTransitLineFeature(f, target, bounds);
    } else if (!selectedTransitLineKey && f.properties?.layer === "stop") {
      drawTransitStopFeature(f, target, bounds);
    }
  }
}

function drawTransitLineFeature(feature, target, bounds) {
  for (const line of getLineCoordinateSequences(feature.geometry)) {
    if (!lineIntersectsBounds(line, bounds)) continue;
    const points = line.map(([lng, lat]) => {
      const p = map.latLngToContainerPoint([lat, lng]);
      return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    }).join(" ");
    if (!points) continue;
    const poly = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    poly.setAttribute("class", selectedTransitLineKey ? "transit-line transit-line-selected" : "transit-line"); poly.setAttribute("points", points);
    poly.style.setProperty("--line-color", feature.properties?.color || "#ff8a1c");
    target.appendChild(poly);
  }
}

function drawTransitLabelsOnOverlay(featureCollection, target) {
  const bounds = map.getBounds();
  const bbox = leafletBoundsToBbox(bounds);
  const labels = new Map();
  for (const f of featureCollection.features || []) {
    if (f.properties?.layer !== "line" || !f.properties?.label) continue;
    if (selectedTransitLineKey && getTransitLineKey(f) !== selectedTransitLineKey) continue;
    if (!featureBboxIntersects(f, bbox)) continue;
    const key = `${f.properties.route}|${f.properties.name}|${f.properties.label}`;
    for (const line of getLineCoordinateSequences(f.geometry)) {
      const candidate = getVisibleLineLabelCandidate(line, bounds);
      if (!candidate) continue;
      const current = labels.get(key);
      if (!current || candidate.length > current.length) {
        labels.set(key, { ...candidate, label: f.properties.label });
      }
    }
  }
  for (const entry of labels.values()) {
    drawOverlayText(entry.label, entry.point, "line-name-label", target);
  }
}

function getVisibleLineLabelCandidate(line, bounds) {
  if (!bounds || line.length < 2) return null;
  const clipped = turf.bboxClip(turf.lineString(line), [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]);
  const segments = getLineCoordinateSequences(clipped.geometry || clipped);
  if (!segments.length) return null;
  let best = null, maxLen = 0;
  for (const s of segments) { if (s.length < 2) continue; const l = turf.length(turf.lineString(s)); if (l > maxLen) { maxLen = l; best = s; } }
  if (!best || maxLen === 0) return null;
  const mid = turf.along(turf.lineString(best), maxLen / 2).geometry.coordinates;
  return { point: map.latLngToContainerPoint([mid[1], mid[0]]), length: maxLen };
}

function drawTransitStopFeature(feature, target, bounds) {
  for (const [lng, lat] of getPointCoordinates(feature.geometry)) {
    if (!bounds.contains([lat, lng])) continue;
    const p = map.latLngToContainerPoint([lat, lng]);
    const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    c.setAttribute("class", "transit-stop"); c.setAttribute("cx", p.x.toFixed(1)); c.setAttribute("cy", p.y.toFixed(1)); c.setAttribute("r", "3.5");
    target.appendChild(c);
  }
}

function drawNearbyStopNames(pin, target) {
  const nearby = getNearbyNamedStops(pin)
    .filter(s => s.distance <= SHRINK_RADIUS_MILES).sort((a, b) => a.distance - b.distance).slice(0, 80);
  for (const s of nearby) { const p = map.latLngToContainerPoint([s.lat, s.lng]); drawOverlayText(s.name, p, "pin-stop-label", target); }
}

function drawOverlayText(label, p, className, target = elements.zoneOverlay) {
  const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
  text.setAttribute("class", className); text.setAttribute("x", p.x.toFixed(1)); text.setAttribute("y", p.y.toFixed(1)); text.textContent = label;
  target.appendChild(text);
}

function getLineCoordinateSequences(g) {
  if (!g) return [];
  if (g.type === "LineString") return [g.coordinates];
  if (g.type === "MultiLineString") return g.coordinates;
  if (g.type === "GeometryCollection") return g.geometries.flatMap(getLineCoordinateSequences);
  return [];
}

function getPointCoordinates(g) {
  if (!g) return [];
  if (g.type === "Point") return [g.coordinates];
  if (g.type === "MultiPoint") return g.coordinates;
  if (g.type === "GeometryCollection") return g.geometries.flatMap(getPointCoordinates);
  return [];
}

function collectFeatures(geojson) {
  if (!geojson) return [];
  if (geojson.type === "FeatureCollection") return geojson.features;
  if (geojson.type === "Feature") return [geojson];
  if (geojson.type === "GeometryCollection") return geojson.geometries.map(g => ({ type: "Feature", properties: {}, geometry: g }));
  return [{ type: "Feature", properties: {}, geometry: geojson }];
}

function collectGeometries(geojson) {
  if (!geojson) return [];
  if (geojson.type === "FeatureCollection") return geojson.features.flatMap(collectGeometries);
  if (geojson.type === "Feature") return collectGeometries(geojson.geometry);
  if (geojson.type === "GeometryCollection") return geojson.geometries.flatMap(collectGeometries);
  return [geojson];
}

function isLineGeometry(g) { return g && ["LineString", "MultiLineString"].includes(g.type); }
function geometrySignature(g) { return JSON.stringify(g.coordinates); }
function coordinateSignature(lng, lat) { return `${Number(lng).toFixed(6)},${Number(lat).toFixed(6)}`; }
function formatLineLabel(r, n) { return (r && n && r !== n) ? `${r} - ${n}` : (r || n || ""); }
function getRouteGroup(f) {
  const t = String(f.properties?.type || "UNKNOWN").trim().toUpperCase();
  const s = String(f.properties?.service || "").toUpperCase();
  return (t === "LRT" || t === "OFF" || s.includes("RAIL")) ? "Rail" : "Bus";
}

function getTransitLineKey(featureOrLine) {
  const source = featureOrLine.properties || featureOrLine;
  return `${source.route || ""}|${source.name || ""}`;
}

function leafletBoundsToBbox(bounds) {
  return [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
}

function featureBboxIntersects(feature, viewportBbox) {
  const bbox = feature.properties?.bbox || getGeometryBounds(feature.geometry);
  if (!bbox) return false;
  return bbox[0] <= viewportBbox[2] && bbox[2] >= viewportBbox[0] && bbox[1] <= viewportBbox[3] && bbox[3] >= viewportBbox[1];
}

function lineIntersectsBounds(line, bounds) {
  if (!line.length) return false;
  if (line.some(([lng, lat]) => bounds.contains([lat, lng]))) return true;
  const viewport = turf.bboxPolygon([bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]);
  try {
    return turf.lineIntersect(turf.lineString(line), viewport).features.length > 0;
  } catch (error) {
    return false;
  }
}

function drawDimMaskOnOverlay(size, target = elements.zoneOverlay) {
  const vp = `M0 0H${size.x}V${size.y}H0Z`;
  const zp = getExteriorRings(activeZoneFeature).map(r => ringToPath(r)).join("");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("class", "zone-dim"); path.setAttribute("d", `${vp}${zp}`);
  target.appendChild(path);
}

function drawFeatureOnOverlay(f, className, target = elements.zoneOverlay) {
  for (const r of getExteriorRings(f)) {
    const pts = ringToPoints(r); if (!pts) continue;
    const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    poly.setAttribute("class", className); poly.setAttribute("points", pts);
    target.appendChild(poly);
  }
}

function ringToPath(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return "";
  const cmds = ring.map(([lng, lat], i) => {
    const p = map.latLngToContainerPoint([lat, lng]);
    return `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
  });
  return `${cmds.join("")}Z`;
}

function ringToPoints(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return "";
  return ring.map(([lng, lat]) => {
    const p = map.latLngToContainerPoint([lat, lng]);
    return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
  }).join(" ");
}

function bindControls() {
  elements.zoomInButton.addEventListener("click", () => map.zoomIn());
  elements.zoomOutButton.addEventListener("click", () => map.zoomOut());

  elements.statusToggleButton.addEventListener("click", () => handlePanelToggleClick("status"));
  elements.rulesToggleButton.addEventListener("click", () => handlePanelToggleClick("rules"));
  elements.rulesRefreshButton?.addEventListener("click", () => loadMissionRules({ checkRemote: true, forceRemote: true }));
  bindDevSettingsChord();
  elements.warningDisableToggle?.addEventListener("change", () => {
    warningDisabled = !!elements.warningDisableToggle.checked;
    safeSetStorageItem(WARNING_DISABLED_KEY, String(warningDisabled));
    validatePlayerBounds();
    showStatus(warningDisabled ? "Boundary warning disabled." : "Boundary warning enabled.");
  });
  elements.copyCoordinatesToggle?.addEventListener("change", () => {
    copyCoordinatesOnTap = !!elements.copyCoordinatesToggle.checked;
    safeSetStorageItem(COPY_COORDINATES_KEY, String(copyCoordinatesOnTap));
    showStatus(copyCoordinatesOnTap ? "Map tap coordinates enabled." : "Map tap coordinates disabled.");
  });
  elements.offlineModeToggle?.addEventListener("change", () => {
    offlineMode = !!elements.offlineModeToggle.checked;
    safeSetStorageItem(OFFLINE_MODE_KEY, String(offlineMode));
    updateDevSettingsControls();
    showStatus(offlineMode ? "Offline mode enabled." : "Offline mode disabled.");
  });
  elements.noUiModeToggle?.addEventListener("change", () => {
    setNoUiMode(!!elements.noUiModeToggle.checked);
  });
  if (elements.warningDisableToggle) elements.warningDisableToggle.checked = warningDisabled;
  if (elements.copyCoordinatesToggle) elements.copyCoordinatesToggle.checked = copyCoordinatesOnTap;
  if (elements.offlineModeToggle) elements.offlineModeToggle.checked = offlineMode;
  if (elements.noUiModeToggle) elements.noUiModeToggle.checked = noUiMode;
  updateDevSettingsControls();

  elements.centerButton.addEventListener("click", centerOnPlayerAndFollow);
  elements.transitToggleButton.addEventListener("click", toggleTransitLayer);
  elements.lineNamesToggleButton.addEventListener("click", toggleLineNames);
  elements.resetButton.addEventListener("click", resetMap);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopForegroundTracking(); else startForegroundTracking();
  });
  window.addEventListener("pagehide", stopForegroundTracking);
  window.addEventListener("pageshow", () => { if (!document.hidden) startForegroundTracking(); });
}

function handlePanelToggleClick(id) {
  if (suppressTabClickCount > 0) {
    suppressTabClickCount--;
    return;
  }
  const now = Date.now();
  if (lastDevChordClick && lastDevChordClick.id !== id && now - lastDevChordClick.time < 450) {
    lastDevChordClick = null;
    setTabState("dev", isFullscreen);
    return;
  }
  lastDevChordClick = { id, time: now };
  toggleTab(id);
}

function toggleTab(id) {
  if (activeTabId === id) {
    setTabState(isFullscreen ? id : null, false);
  } else {
    setTabState(id, isFullscreen);
  }
}

function bindDevSettingsChord() {
  const buttons = [
    { el: elements.statusToggleButton, id: "status" },
    { el: elements.rulesToggleButton, id: "rules" },
  ];

  for (const { el, id } of buttons) {
    el.addEventListener("pointerdown", () => {
      devChordPointers.add(id);
      if (devChordPointers.has("status") && devChordPointers.has("rules")) {
        suppressTabClickCount = 2;
        setTabState("dev", isFullscreen);
      }
    });
    el.addEventListener("pointerup", () => devChordPointers.delete(id));
    el.addEventListener("pointercancel", () => devChordPointers.delete(id));
    el.addEventListener("pointerleave", () => devChordPointers.delete(id));
  }
}

function setTabState(id, fullscreen = false) {
  activeTabId = id;
  isFullscreen = fullscreen;
  const isOpen = activeTabId !== null;
  const isStatus = activeTabId === "status";
  const isRules = activeTabId === "rules";
  const isDev = activeTabId === "dev";

  document.body.classList.toggle("pane-open", isOpen);
  document.body.classList.toggle("pane-fullscreen", isOpen && isFullscreen);
  elements.bottomPanel.classList.toggle("is-open", isOpen);
  elements.bottomPanel.classList.toggle("is-fullscreen", isOpen && isFullscreen);

  elements.statusToggleButton.setAttribute("aria-expanded", String(isStatus));
  elements.statusContent.hidden = !isStatus;

  elements.rulesToggleButton.setAttribute("aria-expanded", String(isRules));
  elements.rulesContent.hidden = !isRules;

  if (elements.devContent) elements.devContent.hidden = !isDev;
  if (isDev) updateDevSettingsControls();

  if (isStatus) {
    updateVisibleRoutesPanel();
    loadMissionStatus();
  }
  if (isRules) loadMissionRules();
}

function updateDevSettingsControls() {
  if (elements.warningDisableToggle) elements.warningDisableToggle.checked = warningDisabled;
  if (elements.copyCoordinatesToggle) elements.copyCoordinatesToggle.checked = copyCoordinatesOnTap;
  if (elements.offlineModeToggle) elements.offlineModeToggle.checked = offlineMode;
  if (elements.noUiModeToggle) elements.noUiModeToggle.checked = noUiMode;
  if (elements.rulesRefreshButton) elements.rulesRefreshButton.disabled = !!offlineMode;
  document.body.classList.toggle("no-ui-mode", noUiMode);
  scheduleZoneOverlayUpdate();
}

function setNoUiMode(enabled, { persist = true, silent = false } = {}) {
  const next = !!enabled;
  if (noUiMode === next) {
    if (elements.noUiModeToggle) elements.noUiModeToggle.checked = noUiMode;
    return;
  }
  noUiMode = next;
  if (persist) safeSetStorageItem(NO_UI_MODE_KEY, String(noUiMode));
  document.body.classList.toggle("no-ui-mode", noUiMode);
  if (!noUiMode) resetNoUiExitTracker();
  updateDevSettingsControls();
  if (!silent) showStatus(noUiMode ? "No UI mode enabled." : "No UI mode disabled.");
}

function bindPaneSwipes() {
  const targets = [
    { el: elements.bottomPanel, id: null, tabRail: false },
    { el: elements.bottomPanelToggles, id: null, tabRail: true },
    { el: elements.statusToggleButton, id: "status", tabRail: true },
    { el: elements.rulesToggleButton, id: "rules", tabRail: true },
  ];
  for (const t of targets) {
    t.el.addEventListener("pointerdown", (e) => beginPanelSwipe(e, t.id, t.tabRail));
    t.el.addEventListener("pointermove", updatePanelSwipe);
    t.el.addEventListener("pointerup", endPanelSwipe);
    t.el.addEventListener("pointercancel", cancelPanelSwipe);
    t.el.addEventListener("lostpointercapture", cancelPanelSwipe);
  }
}

function handleMapClick(event) {
  if (noUiMode) {
    registerNoUiExitClick();
    return;
  }
  if (copyCoordinatesOnTap) copyMapCoordinates(event.latlng);
}

function copyMapCoordinates(latlng) {
  if (!latlng) return;
  const nearbyStop = getNearbyNamedStops(latlng, 1).sort((a, b) => a.distance - b.distance)[0];
  const baseText = `${latlng.lat.toFixed(6)}, ${latlng.lng.toFixed(6)}`;
  const text = nearbyStop
    ? `${baseText} | nearest stop: ${nearbyStop.name} (${nearbyStop.distance.toFixed(2)} mi)`
    : baseText;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(
      () => showStatus(`Copied ${text}.`),
      () => showStatus(text, { persistent: true })
    );
    return;
  }
  showStatus(text, { persistent: true });
}

function registerNoUiExitClick() {
  noUiExitClickCount += 1;
  clearTimeout(noUiExitClickTimer);
  noUiExitClickTimer = setTimeout(resetNoUiExitTracker, 1200);
  if (noUiExitClickCount < 6) return;
  resetNoUiExitTracker();
  if (elements.noUiModeToggle) elements.noUiModeToggle.checked = false;
  setNoUiMode(false);
}

function resetNoUiExitTracker() {
  noUiExitClickCount = 0;
  clearTimeout(noUiExitClickTimer);
  noUiExitClickTimer = null;
}

function beginPanelSwipe(event, id, tabRail = false) {
  if (event.button !== undefined && event.button !== 0) return;
  if (tabRail) event.stopPropagation();
  paneSwipeStart = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, id, tabRail };
  paneSwipeHandled = false;
  try { event.currentTarget.setPointerCapture(event.pointerId); } catch (e) {}
}

function updatePanelSwipe(event) {
  if (!paneSwipeStart || event.pointerId !== paneSwipeStart.pointerId) return;
  const dx = event.clientX - paneSwipeStart.x, dy = event.clientY - paneSwipeStart.y;
  if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.4) { cancelPanelSwipe(); return; }
  if (Math.abs(dy) < 42 || Math.abs(dy) < Math.abs(dx) * 1.2) return;

  const targetTab = paneSwipeStart.id || activeTabId || "status";
  const shouldFullscreen = dy < -200;
  const shouldOpen = dy < 0;

  if (isFullscreen) {
    if (dy > 70 && paneSwipeStart.tabRail) {
      setTabState(targetTab, false);
    } else {
      return;
    }
  } else if (shouldFullscreen) {
    setTabState(targetTab, true);
  } else if (shouldOpen) {
    setTabState(targetTab, false);
  } else {
    setTabState(null);
  }

  paneSwipeHandled = true;
}

function endPanelSwipe(event) {
  if (!paneSwipeStart || event.pointerId !== paneSwipeStart.pointerId) return;
  if (paneSwipeHandled) { event.preventDefault(); event.stopPropagation(); }
  cancelPanelSwipe();
}

function cancelPanelSwipe() { paneSwipeStart = null; paneSwipeHandled = false; }

async function loadMissionStatus() {
  if (!elements.statusCards) return;
  try {
    const area = calculateAreaSquareMiles(originalZoneFeature);
    const serviceLines = getStatusServiceLines();
    const stopCount = countPointGeometries(transitFeatureCollection);
    elements.statusCards.replaceChildren(
      renderStatusCard(serviceLines.length, "Service Lines", "Matched transit routes."),
      renderStatusCard(stopCount, "Stops", "Total stops and stations."),
      renderStatusCard(area.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 }), "Play Area mi²", "Mission area size."),
      renderLineListCard(serviceLines)
    );
  } catch (error) { elements.statusCards.replaceChildren(renderStatusCard("!", "Status Error", error.message)); }
}

function calculateAreaSquareMiles(f) { return turf.area(f) / 2589988.110336; }
function countPointGeometries(geojson) {
  if (!geojson) return 0;
  return (geojson.features || []).filter(f => f.properties?.layer === "stop").length;
}

function getStatusServiceLines() {
  if (transitServiceLines.length) return transitServiceLines;
  if (!transitFeatureCollection) return [];
  const lines = new Map();
  for (const f of transitFeatureCollection.features || []) {
    if (f.properties?.layer !== "line" || !f.properties?.label) continue;
    const key = `${f.properties.route}|${f.properties.name}`;
    if (!lines.has(key)) lines.set(key, { route: f.properties.route || "", name: f.properties.name || "", key, label: f.properties.label, color: f.properties.color || "#ff8a1c", stops: [] });
  }
  return [...lines.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
}

function renderStatusCard(value, title, description) {
  const art = document.createElement("article");
  art.className = "status-card";
  art.innerHTML = `<span class="status-number">${value}</span><h2>${title}</h2><p>${description}</p>`;
  return art;
}

function renderLineListCard(lines) {
  const art = document.createElement("article");
  art.className = "status-card status-card-wide";
  art.innerHTML = `<h2>Lines in Use</h2>`;
  const list = document.createElement("ul");
  list.className = "status-line-list";
  for (const l of lines) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.className = "status-line-button"; btn.style.borderLeft = `4px solid ${l.color}`;
    btn.setAttribute("aria-pressed", String(selectedTransitLineKey === getTransitLineKey(l)));
    btn.type = "button"; btn.textContent = l.label;
    btn.addEventListener("click", () => {
      art.querySelectorAll(".status-line-button").forEach(b => b.setAttribute("aria-pressed", "false"));
      btn.setAttribute("aria-pressed", "true");
      renderSelectedLine(art, l);
      focusTransitLine(l);
    });
    li.appendChild(btn); list.appendChild(li);
  }
  art.appendChild(list);
  return art;
}

function renderSelectedLine(container, line) {
  container.querySelector(".status-selected-line")?.remove();

  const section = document.createElement("section");
  section.className = "status-selected-line";

  const heading = document.createElement("h3");
  heading.textContent = line.label;

  const stops = line.stops || [];
  const summary = document.createElement("p");
  summary.textContent = `${stops.length.toLocaleString()} stops/stations`;

  const list = document.createElement("ol");
  list.className = "status-stop-list";
  const names = stops.length ? stops : ["No matching stops found."];
  for (const stop of names) {
    const item = document.createElement("li");
    item.textContent = stop;
    list.appendChild(item);
  }

  section.append(heading, summary, list);
  container.appendChild(section);
}

function focusTransitLine(line) {
  if (!map || !transitFeatureCollection) return;
  selectedTransitLineKey = getTransitLineKey(line);
  transitVisible = true;
  safeSetStorageItem(TRANSIT_VISIBLE_KEY, String(transitVisible));
  updateTransitToggleButton();

  const bounds = getTransitLineBounds(selectedTransitLineKey);
  scheduleZoneOverlayUpdate();
  if (!bounds || !bounds.isValid()) return;

  suppressTransitSelectionReset = true;
  map.fitBounds(bounds, { padding: [48, 48], maxZoom: 15, animate: true });
  window.setTimeout(() => { suppressTransitSelectionReset = false; }, 700);
}

function getTransitLineBounds(lineKey) {
  const bounds = L.latLngBounds();
  for (const feature of transitFeatureCollection.features || []) {
    if (feature.properties?.layer !== "line" || getTransitLineKey(feature) !== lineKey) continue;
    for (const [lng, lat] of getAllCoordinates(feature.geometry)) {
      bounds.extend([lat, lng]);
    }
  }
  return bounds;
}

let rulesMarkdown = null;
let rulesVersion = 0;
async function loadMissionRules(options = {}) {
  if (!elements.rulesCards) return;
  try {
    if (!rulesMarkdown) {
      const bundledText = await fetchRulesText("rules.md");
      const bundledRules = parseVersionedRules(bundledText);
      const cachedRules = readCachedRules();
      const activeRules = chooseNewestRules(bundledRules, cachedRules);
      rulesMarkdown = activeRules.markdown;
      rulesVersion = activeRules.version;
    }
    elements.rulesCards.replaceChildren(...parseRulesMarkdown(rulesMarkdown).map(renderRulesCategory));

    if (options.checkRemote && !offlineMode) {
      await refreshRemoteRules(options.forceRemote);
    }
  } catch (e) { elements.rulesCards.innerHTML = `<article class="rule-card"><h2>Rules Error</h2><p>${e.message}</p></article>`; }
}

async function refreshRemoteRules(forceRemote = false) {
  const button = elements.rulesRefreshButton;
  if (button) button.disabled = true;
  try {
    if (offlineMode) {
      if (forceRemote) showStatus("Offline mode is enabled. Remote rules refresh is disabled.", { error: true });
      return;
    }
    const remoteText = await fetchRemoteRulesText();
    const remoteRules = parseVersionedRules(remoteText);
    if (!Number.isFinite(remoteRules.version) || remoteRules.version <= 0) {
      throw new Error("Remote rules are missing V=# on the first line.");
    }
    if (remoteRules.version > rulesVersion) {
      rulesMarkdown = remoteRules.markdown;
      rulesVersion = remoteRules.version;
      writeCachedRules(remoteRules);
      elements.rulesCards.replaceChildren(...parseRulesMarkdown(rulesMarkdown).map(renderRulesCategory));
      showStatus(`Rules updated to V=${rulesVersion}.`);
    } else if (forceRemote) {
      showStatus(`Rules already current at V=${rulesVersion}.`);
    }
  } catch (error) {
    if (forceRemote) showStatus(error.message || "Could not refresh rules.", { error: true });
    console.warn("Rules refresh failed.", error);
  } finally {
    if (button) button.disabled = false;
  }
}

async function fetchRemoteRulesText() {
  try {
    return await fetchRulesText(REMOTE_RULES_PROXY_URL);
  } catch (proxyError) {
    console.warn("Rules proxy fetch failed; trying remote URL.", proxyError);
    return fetchRulesText(REMOTE_RULES_URL);
  }
}

async function fetchRulesText(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Could not load ${url}.`);
  return res.text();
}

function parseVersionedRules(text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const match = lines[0]?.match(/^V=(\d+)\s*$/i);
  return {
    version: match ? Number(match[1]) : 0,
    markdown: match ? lines.slice(1).join("\n").trimStart() : normalized,
  };
}

function readCachedRules() {
  const markdown = safeGetStorageItem(RULES_CACHE_TEXT_KEY);
  const version = Number(safeGetStorageItem(RULES_CACHE_VERSION_KEY) || 0);
  if (!markdown || !Number.isFinite(version) || version <= 0) return null;
  return { markdown, version };
}

function writeCachedRules(rules) {
  safeSetStorageItem(RULES_CACHE_TEXT_KEY, rules.markdown);
  safeSetStorageItem(RULES_CACHE_VERSION_KEY, String(rules.version));
}

function chooseNewestRules(...rulesList) {
  return rulesList
    .filter(Boolean)
    .sort((a, b) => b.version - a.version)[0] || { markdown: "", version: 0 };
}

function parseRulesMarkdown(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const cats = []; let curCat = null, curRule = null;
  for (const line of lines) {
    const cm = line.match(/^#\s+(.+?)\s*$/);
    if (cm) {
      if (curRule && curCat) curCat.rules.push(curRule);
      if (curCat) cats.push(curCat);
      curCat = { title: cm[1].trim(), rules: [] }; curRule = null; continue;
    }
    const rm = line.match(/^##\s+(.+?)\s*$/);
    if (rm) {
      if (!curCat) curCat = { title: "Rules", rules: [] };
      if (curRule) curCat.rules.push(curRule);
      curRule = { title: rm[1].trim(), body: [] }; continue;
    }
    if (curRule) curRule.body.push(line);
  }
  if (curRule && curCat) curCat.rules.push(curRule);
  if (curCat) cats.push(curCat);
  return cats.filter(c => c.rules.length);
}

function renderRulesCategory(cat) {
  const sec = document.createElement("section");
  sec.className = "rules-category";
  sec.innerHTML = `<h2 class="rules-category-title">${cat.title}</h2>`;
  const grid = document.createElement("div");
  grid.className = "rules-grid-pane";
  cat.rules.forEach(r => {
    const card = document.createElement("article"); card.className = "rule-card";
    card.innerHTML = `<h2>${r.title}</h2><div class="rule-body">${parseInlineMarkdown(r.body.join("\n").trim())}</div>`;
    grid.appendChild(card);
  });
  sec.appendChild(grid); return sec;
}

function parseInlineMarkdown(text) {
  return text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`(.+?)`/g, "<code>$1</code>")
    .split("\n").map(l => l.trim()).filter(Boolean).map(l => (l.startsWith("- ") || l.startsWith("* ")) ? `<li>${l.substring(2)}</li>` : `<p>${l}</p>`)
    .join("").replace(/(<li>.*?<\/li>)+/g, "<ul>$&</ul>");
}

function bindConnectivityEvents() {
  window.addEventListener("online", () => { tileErrorShown = false; showStatus("Back online."); });
  window.addEventListener("offline", () => showStatus("Offline.", { persistent: true, error: true }));
  if (navigator.onLine === false) showStatus("Offline.", { persistent: true, error: true });
}

function centerOnPlayerAndFollow() {
  if (!playerMarker) { showStatus("Waiting for location...", { persistent: true }); startForegroundTracking(); return; }
  autoFollowEnabled = true; updateCenterButton(); map.panTo(playerMarker.getLatLng(), { animate: true });
}

function disableAutoFollowFromMapInteraction() { if (autoFollowEnabled) { autoFollowEnabled = false; updateCenterButton(); } }
function updateCenterButton() {
  elements.centerButton.setAttribute("aria-pressed", String(autoFollowEnabled));
}

function updateVisibleRoutesPanel() {
  if (!elements.visibleRoutesList || !elements.visibleRoutesSummary) return;
  const routes = getVisibleTransitRoutes();
  elements.visibleRoutesSummary.textContent = `${routes.length.toLocaleString()} lines`;
  elements.visibleRoutesList.replaceChildren();
  if (!routes.length) {
    const e = document.createElement("p"); e.className = "visible-routes-empty";
    e.textContent = transitVisible ? "No lines visible." : "Transit hidden.";
    elements.visibleRoutesList.appendChild(e); return;
  }
  elements.visibleRoutesList.append(renderVisibleRouteGroup("Rail", routes.filter(r => r.group === "Rail")), renderVisibleRouteGroup("Bus", routes.filter(r => r.group === "Bus")));
}

function getVisibleTransitRoutes() {
  if (!map || !transitVisible || !transitFeatureCollection) return [];
  const vb = map.getBounds();
  const vp = turf.bboxPolygon([vb.getWest(), vb.getSouth(), vb.getEast(), vb.getNorth()]);
  const routes = new Map();
  for (const f of transitFeatureCollection.features || []) {
    if (f.properties?.layer !== "line" || !f.properties?.label) continue;
    if (!lineFeatureIntersectsViewport(f, vp, vb)) continue;
    const g = getRouteGroup(f), k = `${g}|${f.properties.route}|${f.properties.name}`;
    if (!routes.has(k)) routes.set(k, { group: g, label: f.properties.label, color: f.properties.color || "#ff8a1c" });
  }
  return [...routes.values()].sort((a, b) => (a.group !== b.group) ? (a.group === "Rail" ? -1 : 1) : a.label.localeCompare(b.label, undefined, { numeric: true }));
}

function lineFeatureIntersectsViewport(f, vp, vb) {
  for (const line of getLineCoordinateSequences(f.geometry)) if (line.some(([lng, lat]) => vb.contains([lat, lng]))) return true;
  try { return turf.lineIntersect(f, vp).features.length > 0; } catch (e) { return false; }
}

function renderVisibleRouteGroup(title, routes) {
  const g = document.createElement("section"); g.className = "visible-routes-group";
  g.innerHTML = `<h3>${title} (${routes.length} lines)</h3>`;
  const list = document.createElement("ul");
  for (const r of routes) {
    const li = document.createElement("li"); li.className = "visible-routes-route"; li.style.setProperty("--line-color", r.color);
    li.innerHTML = `<span class="visible-routes-route-color"></span><span class="visible-routes-route-label" title="${r.label}">${r.label}</span>`;
    list.appendChild(li);
  }
  if (!routes.length) list.innerHTML = `<li class="visible-routes-route" style="--line-color: rgba(247,250,252,0.24)"><span class="visible-routes-route-color"></span><span class="visible-routes-route-label">None</span></li>`;
  g.appendChild(list); return g;
}

function startForegroundTracking() {
  if (watchId !== null || document.hidden || !("geolocation" in navigator)) return;
  watchId = navigator.geolocation.watchPosition(handlePositionUpdate, handlePositionError, { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 });
}

function stopForegroundTracking() { if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; } }

function handlePositionUpdate(pos) {
  const lng = pos.coords.longitude, lat = pos.coords.latitude;
  lastPlayerPosition = turf.point([lng, lat]);
  if (!playerMarker) {
    playerMarker = L.marker([lat, lng], { icon: L.divIcon({ className: "", html: '<div class="player-marker"></div>', iconSize: [56, 56], iconAnchor: [28, 28] }), zIndexOffset: 1000 }).addTo(map);
  } else playerMarker.setLatLng([lat, lng]);
  if (autoFollowEnabled) map.panTo([lat, lng], { animate: true });
  validatePlayerBounds();
}

function handlePositionError(e) {
  const msgs = { 1: "Location denied.", 2: "Location unavailable.", 3: "Location timeout." };
  showStatus(msgs[e.code] || e.message || "Location error.", true);
}

function validatePlayerBounds() {
  if (!lastPlayerPosition || !activeZoneFeature || warningDisabled) {
    setBoundaryWarningActive(false);
    return;
  }
  const inside = turf.booleanPointInPolygon(lastPlayerPosition, activeZoneFeature);
  setBoundaryWarningActive(!inside);
}

function setBoundaryWarningActive(active) {
  if (warningActive === active) return;
  warningActive = active;
  document.body.classList.toggle("boundary-warning-active", warningActive);
  if (warningActive) {
    showStatus("WARNING: YOU HAVE LEFT THE MISSION AREA. RETURN IMMEDIATELY.", { persistent: true, error: true });
  } else {
    elements.statusPanel.classList.remove("is-visible", "is-error");
  }
}

function bindLongPress() {
  const c = map.getContainer();
  c.addEventListener("pointerdown", (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    if (e.target.closest("#zoomControls, #mapActions, .bottom-panel, #statusPanel")) return;
    if (e.pointerType === "touch") {
      if (!activeTouchPointerIds.has(e.pointerId)) { activeTouchPointerIds.add(e.pointerId); activeTouchPointers++; }
      try { c.setPointerCapture(e.pointerId); } catch (err) {}
      if (activeTouchPointers > 1) { clearLongPressTimer(); touchMapInteractionActive = true; return; }
    }
    longPressPoint = map.mouseEventToLatLng(e); longPressStartClient = { x: e.clientX, y: e.clientY };
    clearTimeout(longPressTimer);
    longPressTimer = setTimeout(() => { if (longPressPoint) shrinkToPin(longPressPoint); clearLongPressTimer(); }, 550);
  });
  c.addEventListener("pointermove", (e) => { if (longPressStartClient && Math.hypot(e.clientX - longPressStartClient.x, e.clientY - longPressStartClient.y) > 10) clearLongPressTimer(); });
  c.addEventListener("pointerup", (e) => { endTouchPointer(e); clearLongPressTimer(); });
  c.addEventListener("pointercancel", (e) => { endTouchPointer(e); clearLongPressTimer(); });
  c.addEventListener("lostpointercapture", endTouchPointer);
  c.addEventListener("pointerleave", (e) => { clearLongPressTimer(); if (e.pointerType === "touch" && !c.hasPointerCapture?.(e.pointerId)) endTouchPointer(e); });
  map.on("contextmenu", (e) => { e.originalEvent.preventDefault(); shrinkToPin(e.latlng); });
}

function endTouchPointer(e) {
  if (e.pointerType !== "touch") return;
  if (activeTouchPointerIds.delete(e.pointerId)) activeTouchPointers = Math.max(0, activeTouchPointers - 1);
  if (activeTouchPointers === 0) { touchMapInteractionActive = false; scheduleZoneOverlayUpdate(); }
}

function shrinkToPin(latlng, options = {}) {
  const snap = options.snap === false ? { lat: latlng.lat, lng: latlng.lng, name: "restored pin" } : findNearestNamedStop(latlng);
  if (!snap) {
    showStatus("Pin must be placed on an approved RTD stop or station. Move closer and try again.", { persistent: true, error: true });
    return;
  }
  const active = L.latLng(snap.lat, snap.lng);
  const circle = turf.circle(turf.point([active.lng, active.lat]), SHRINK_RADIUS_MILES, { steps: 144, units: "miles" });
  const intersect = turf.intersect(originalZoneFeature, circle);
  if (!intersect || !["Polygon", "MultiPolygon"].includes(intersect.geometry.type)) { showStatus("No overlap.", true); return; }
  activeZoneFeature = turf.cleanCoords(intersect); radiusFeature = circle; droppedPinLatLng = active;
  renderMissionLayers(); renderPin(active, circle);
  if (options.persist !== false) savePin(active);
  validatePlayerBounds();
  if (options.showMessage !== false) showStatus(`Area shrunk.${snap ? ` Centered on ${snap.name}.` : ""}`);
}

function findNearestNamedStop(latlng) {
  if (!namedStops.length) return null;
  const n = getNearbyNamedStops(latlng, 1).sort((a, b) => a.distance - b.distance)[0];
  if (!n || n.distance > 0.03) return null;
  return n;
}

function buildStopBuckets(stops) {
  const buckets = new Map();
  for (const stop of stops) {
    const key = stopBucketKey(stop.lat, stop.lng);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(stop);
  }
  return buckets;
}

function stopBucketKey(lat, lng) {
  return `${Math.floor(lat * 100)}:${Math.floor(lng * 100)}`;
}

function getNearbyNamedStops(latlng, radiusBuckets = 3) {
  if (!transitStopBuckets) transitStopBuckets = buildStopBuckets(namedStops);
  const centerLatBucket = Math.floor(latlng.lat * 100);
  const centerLngBucket = Math.floor(latlng.lng * 100);
  const candidates = [];
  for (let latBucket = centerLatBucket - radiusBuckets; latBucket <= centerLatBucket + radiusBuckets; latBucket++) {
    for (let lngBucket = centerLngBucket - radiusBuckets; lngBucket <= centerLngBucket + radiusBuckets; lngBucket++) {
      candidates.push(...(transitStopBuckets.get(`${latBucket}:${lngBucket}`) || []));
    }
  }
  const source = candidates.length ? candidates : namedStops;
  return source.map(s => ({
    ...s,
    distance: turf.distance(turf.point([latlng.lng, latlng.lat]), turf.point([s.lng, s.lat]), { units: "miles" }),
  }));
}

function renderPin(latlng, circle) {
  if (pinMarker) pinMarker.remove(); if (radiusLayer) radiusLayer.remove();
  pinMarker = L.marker(latlng, { icon: L.divIcon({ className: "", html: '<div class="pin-marker"></div>', iconSize: [34, 34], iconAnchor: [17, 34] }), zIndexOffset: 900 }).addTo(map);
  radiusLayer = L.geoJSON(circle, { interactive: false, pane: "overlayPane", style: { color: "#ff3df2", dashArray: "6 6", lineCap: "round", weight: 4, opacity: 1, fillOpacity: 0 } }).addTo(map);
  radiusLayer.bringToFront();
}

function resetMap() {
  activeZoneFeature = originalZoneFeature; radiusFeature = null; droppedPinLatLng = null; activeTouchPointers = 0; activeTouchPointerIds.clear(); touchMapInteractionActive = false;
  if (pinMarker) pinMarker.remove(); if (radiusLayer) radiusLayer.remove(); pinMarker = null; radiusLayer = null;
  safeRemoveStorageItem(STORED_PIN_KEY); renderMissionLayers(); scheduleZoneOverlayUpdate(); validatePlayerBounds();
  showStatus("Map reset.");
}

function savePin(latlng) { safeSetStorageItem(STORED_PIN_KEY, JSON.stringify({ lat: latlng.lat, lng: latlng.lng, savedAt: new Date().toISOString() })); }
function restoreStoredPin() {
  const raw = safeGetStorageItem(STORED_PIN_KEY); if (!raw) return false;
  try {
    const p = JSON.parse(raw); if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) throw new Error();
    shrinkToPin(L.latLng(p.lat, p.lng), { persist: false, showMessage: false, snap: false }); return true;
  } catch (e) { safeRemoveStorageItem(STORED_PIN_KEY); return false; }
}

function fitToActiveZone() { if (map && activeZoneFeature) map.fitBounds(L.geoJSON(activeZoneFeature).getBounds(), { padding: [36, 36], maxZoom: 16 }); scheduleZoneOverlayUpdate(); }
function getExteriorRings(f) {
  if (!f?.geometry) return [];
  if (f.geometry.type === "Polygon") return [f.geometry.coordinates[0]];
  if (f.geometry.type === "MultiPolygon") return f.geometry.coordinates.map(p => p[0]);
  return [];
}

function showStatus(msg, opts = {}) {
  const n = typeof opts === "boolean" ? { persistent: opts } : opts;
  clearTimeout(showStatus.timeoutId);
  elements.statusPanel.textContent = msg;
  elements.statusPanel.classList.toggle("is-error", !!n.error);
  elements.statusPanel.classList.add("is-visible");
  if (!n.persistent) showStatus.timeoutId = setTimeout(() => elements.statusPanel.classList.remove("is-visible"), 5200);
}

function clearLongPressTimer() { clearTimeout(longPressTimer); longPressTimer = null; longPressPoint = null; longPressStartClient = null; }
