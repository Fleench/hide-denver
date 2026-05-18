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

const elements = {
  map: document.querySelector("#map"),
  zoneOverlay: document.querySelector("#zoneOverlay"),
  centerButton: document.querySelector("#centerButton"),
  transitToggleButton: document.querySelector("#transitToggleButton"),
  lineNamesToggleButton: document.querySelector("#lineNamesToggleButton"),
  resetButton: document.querySelector("#resetButton"),
  statusButton: document.querySelector("#statusButton"),
  rulesButton: document.querySelector("#rulesButton"),
  testingIgnoreButton: document.querySelector("#testingIgnoreButton"),
  statusPanel: document.querySelector("#statusPanel"),
  warningOverlay: document.querySelector("#warningOverlay"),
};

let map;
let originalZoneFeature;
let activeZoneFeature;
let originalBoundaryLayer;
let activeBoundaryLayer;
let transitFeatureCollection = null;
let transitVisible = localStorage.getItem(TRANSIT_VISIBLE_KEY) !== "false";
let lineNamesVisible = localStorage.getItem(LINE_NAMES_VISIBLE_KEY) === "true";
let namedStops = [];
let droppedPinLatLng = null;
let radiusFeature = null;
let playerMarker;
let pinMarker;
let radiusLayer;
let watchId = null;
let lastPlayerPosition = null;
let overlayUpdateFrame = null;
let longPressTimer = null;
let longPressPoint = null;
let longPressStartClient = null;
let warningIgnoredForTesting = false;

bootstrap();

async function bootstrap() {
  try {
    showStatus("Loading mission area...");
    const [zoneFeature, linesStopsFeatureCollection] = await Promise.all([
      loadPrimaryPolygon(),
      loadLinesAndStops(),
    ]);
    originalZoneFeature = zoneFeature;
    transitFeatureCollection = linesStopsFeatureCollection;
    activeZoneFeature = originalZoneFeature;

    createMap();
    renderLinesAndStops(linesStopsFeatureCollection);
    renderMissionLayers();
    bindControls();
    bindLongPress();
    restoreStoredPin();
    fitToActiveZone();
    startForegroundTracking();
    showStatus("Long-press the map to shrink the mission area to a 1/4-mile radius.");
  } catch (error) {
    showStatus(error.message || String(error), true);
  }
}

// GeoJSON loading: read the local map export and extract the largest Polygon/MultiPolygon.
async function loadPrimaryPolygon() {
  const response = await fetch(MAP_URL, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Could not load ${MAP_URL}. Start the local server from the website folder.`);
  }

  const geojson = await response.json();
  const polygons = collectPolygonFeatures(geojson);

  if (!polygons.length) {
    throw new Error("No Polygon or MultiPolygon geometry was found in assets/Map.json.");
  }

  polygons.sort((a, b) => turf.area(b) - turf.area(a));
  return turf.cleanCoords(polygons[0]);
}

function collectPolygonFeatures(geojson) {
  if (!geojson) return [];

  if (geojson.type === "FeatureCollection") {
    return geojson.features.flatMap(collectPolygonFeatures);
  }

  if (geojson.type === "Feature") {
    return collectPolygonFeatures(geojson.geometry).map((feature) => ({
      ...feature,
      properties: geojson.properties || {},
    }));
  }

  if (geojson.type === "GeometryCollection") {
    return geojson.geometries.flatMap(collectPolygonFeatures);
  }

  if (geojson.type === "Polygon" || geojson.type === "MultiPolygon") {
    return [
      {
        type: "Feature",
        properties: {},
        geometry: geojson,
      },
    ];
  }

  return [];
}

async function loadLinesAndStops() {
  const [
    linesResponse,
    stopsResponse,
    busRoutesResponse,
    busStopsResponse,
    railLinesResponse,
    railStationsResponse,
  ] = await Promise.all([
    fetch(LINES_URL, { cache: "no-store" }),
    fetch(STOPS_URL, { cache: "no-store" }),
    fetch(BUS_ROUTES_URL, { cache: "no-store" }),
    fetch(BUS_STOPS_URL, { cache: "no-store" }),
    fetch(RAIL_LINES_URL, { cache: "no-store" }),
    fetch(RAIL_STATIONS_URL, { cache: "no-store" }),
  ]);

  if (!linesResponse.ok) {
    throw new Error(`Could not load ${LINES_URL}.`);
  }
  if (!stopsResponse.ok) {
    throw new Error(`Could not load ${STOPS_URL}.`);
  }
  if (!busRoutesResponse.ok) throw new Error(`Could not load ${BUS_ROUTES_URL}.`);
  if (!busStopsResponse.ok) throw new Error(`Could not load ${BUS_STOPS_URL}.`);
  if (!railLinesResponse.ok) throw new Error(`Could not load ${RAIL_LINES_URL}.`);
  if (!railStationsResponse.ok) throw new Error(`Could not load ${RAIL_STATIONS_URL}.`);

  const [
    linesGeojson,
    stopsGeojson,
    busRoutesGeojson,
    busStopsGeojson,
    railLinesGeojson,
    railStationsGeojson,
  ] = await Promise.all([
    linesResponse.json(),
    stopsResponse.json(),
    busRoutesResponse.json(),
    busStopsResponse.json(),
    railLinesResponse.json(),
    railStationsResponse.json(),
  ]);
  const routeMetadata = buildRouteMetadata([busRoutesGeojson, railLinesGeojson]);
  const stopMetadata = buildStopMetadata([busStopsGeojson, railStationsGeojson]);
  namedStops = buildNamedFilteredStops(stopsGeojson, stopMetadata);

  return {
    type: "FeatureCollection",
    features: [
      ...geometryCollectionToFeatures(linesGeojson, { layer: "line" }).map((feature) => ({
        ...feature,
        properties: {
          ...feature.properties,
          ...(routeMetadata.get(geometrySignature(feature.geometry)) || {}),
        },
      })),
      ...geometryCollectionToFeatures(stopsGeojson, { layer: "stop" }),
    ],
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
        label: formatLineLabel(route, name),
      });
    }
  }
  return metadata;
}

function buildStopMetadata(stopGeojsons) {
  const metadata = new Map();
  for (const source of stopGeojsons) {
    for (const feature of collectFeatures(source)) {
      if (feature.geometry?.type !== "Point") continue;
      const [lng, lat] = feature.geometry.coordinates;
      const name = String(feature.properties?.STOPNAME || feature.properties?.NAME || "").trim();
      if (!name) continue;
      metadata.set(coordinateSignature(lng, lat), { name, lat, lng });
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
    const exactMetadata = stopMetadata.get(coordinateSignature(lng, lat));
    if (exactMetadata) {
      stops.push(exactMetadata);
      continue;
    }

    const nearestMetadata = findNearestMetadataStop(lat, lng, metadataStops);
    if (nearestMetadata) stops.push(nearestMetadata);
  }
  return stops;
}

function findNearestMetadataStop(lat, lng, metadataStops) {
  if (!metadataStops.length) return null;

  const point = turf.point([lng, lat]);
  let bestMatch = null;
  let bestDistance = Infinity;

  for (const stop of metadataStops) {
    const distance = turf.distance(
      point,
      turf.point([stop.lng, stop.lat]),
      { units: "miles" },
    );
    if (distance < bestDistance) {
      bestDistance = distance;
      bestMatch = stop;
    }
  }

  if (bestDistance > 0.03) return null;
  return bestMatch;
}

function geometryCollectionToFeatures(geojson, properties = {}) {
  if (geojson.type === "FeatureCollection") {
    return geojson.features.map((feature) => ({
      ...feature,
      properties: {
        ...properties,
        ...(feature.properties || {}),
      },
    }));
  }

  if (geojson.type === "Feature") {
    return [
      {
        ...geojson,
        properties: {
          ...properties,
          ...(geojson.properties || {}),
        },
      },
    ];
  }

  if (geojson.type === "GeometryCollection") {
    return geojson.geometries.map((geometry) => ({
      type: "Feature",
      properties,
      geometry,
    }));
  }

  return [
    {
      type: "Feature",
      properties,
      geometry: geojson,
    },
  ];
}

// Map settings: a clean streets-first basemap plus a bright polygon for the valid mission area.
function createMap() {
  const center = turf.center(originalZoneFeature).geometry.coordinates;

  map = L.map(elements.map, {
    center: [center[1], center[0]],
    zoom: 12,
    zoomSnap: 0.25,
    zoomDelta: 0.25,
    wheelPxPerZoomLevel: 80,
    zoomControl: true,
    preferCanvas: true,
  });

  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    subdomains: "abcd",
    tileSize: 256,
    zoomOffset: 0,
    maxZoom: 19,
    detectRetina: true,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(map);

  map.on("move zoom zoomend viewreset resize", scheduleZoneOverlayUpdate);

  requestAnimationFrame(() => {
    map.invalidateSize();
    fitToActiveZone();
    scheduleZoneOverlayUpdate();
  });
}

function renderMissionLayers() {
  if (originalBoundaryLayer) originalBoundaryLayer.remove();
  if (activeBoundaryLayer) activeBoundaryLayer.remove();

  originalBoundaryLayer = L.geoJSON(originalZoneFeature, {
    interactive: false,
    pane: "overlayPane",
    style: {
      color: "#f6d047",
      dashArray: activeZoneFeature === originalZoneFeature ? null : "8 8",
      lineCap: "round",
      lineJoin: "round",
      weight: activeZoneFeature === originalZoneFeature ? 5 : 3,
      opacity: activeZoneFeature === originalZoneFeature ? 1 : 0.85,
      fillOpacity: 0,
    },
  }).addTo(map);

  activeBoundaryLayer = L.geoJSON(activeZoneFeature, {
    interactive: false,
    pane: "overlayPane",
    style: {
      color: "#00f0ff",
      lineCap: "round",
      lineJoin: "round",
      weight: 5,
      opacity: 1,
      fillOpacity: 0,
    },
  }).addTo(map);

  activeBoundaryLayer.bringToFront();
  scheduleZoneOverlayUpdate();
}

function renderLinesAndStops(featureCollection) {
  transitFeatureCollection = featureCollection;
  updateTransitToggleButton();
  updateLineNamesToggleButton();
  scheduleZoneOverlayUpdate();
}

function toggleTransitLayer() {
  transitVisible = !transitVisible;
  localStorage.setItem(TRANSIT_VISIBLE_KEY, String(transitVisible));
  renderLinesAndStops(transitFeatureCollection);
}

function updateTransitToggleButton() {
  elements.transitToggleButton.textContent = transitVisible
    ? "Hide Lines/Stops"
    : "Show Lines/Stops";
  elements.transitToggleButton.setAttribute("aria-pressed", String(transitVisible));
}

function toggleLineNames() {
  lineNamesVisible = !lineNamesVisible;
  localStorage.setItem(LINE_NAMES_VISIBLE_KEY, String(lineNamesVisible));
  updateLineNamesToggleButton();
  scheduleZoneOverlayUpdate();
}

function updateLineNamesToggleButton() {
  elements.lineNamesToggleButton.textContent = lineNamesVisible
    ? "Hide Line Names"
    : "Show Line Names";
  elements.lineNamesToggleButton.setAttribute("aria-pressed", String(lineNamesVisible));
}

function updateZoneOverlay() {
  if (!map || !originalZoneFeature || !activeZoneFeature) return;

  const size = map.getSize();
  elements.zoneOverlay.setAttribute("viewBox", `0 0 ${size.x} ${size.y}`);
  elements.zoneOverlay.setAttribute("width", String(size.x));
  elements.zoneOverlay.setAttribute("height", String(size.y));
  elements.zoneOverlay.replaceChildren();

  drawDimMaskOnOverlay(size);
  drawFeatureOnOverlay(originalZoneFeature, "zone-original");
  drawFeatureOnOverlay(activeZoneFeature, "zone-active");
  if (radiusFeature) drawFeatureOnOverlay(radiusFeature, "zone-radius");

  if (transitVisible && transitFeatureCollection) {
    drawTransitOnOverlay(transitFeatureCollection);
  }
  if (lineNamesVisible && transitFeatureCollection) {
    drawTransitLabelsOnOverlay(transitFeatureCollection);
  }
  if (droppedPinLatLng) drawNearbyStopNames(droppedPinLatLng);
}

function scheduleZoneOverlayUpdate() {
  if (overlayUpdateFrame !== null) return;
  overlayUpdateFrame = window.requestAnimationFrame(() => {
    overlayUpdateFrame = null;
    updateZoneOverlay();
  });
}

function drawTransitOnOverlay(featureCollection) {
  for (const feature of featureCollection.features || []) {
    if (feature.properties?.layer === "line") {
      drawTransitLineFeature(feature);
    } else if (feature.properties?.layer === "stop") {
      drawTransitStopFeature(feature);
    }
  }
}

function drawTransitLineFeature(feature) {
  for (const line of getLineCoordinateSequences(feature.geometry)) {
    const points = line
      .map(([lng, lat]) => {
        const point = map.latLngToContainerPoint([lat, lng]);
        return `${point.x.toFixed(1)},${point.y.toFixed(1)}`;
      })
      .join(" ");

    if (!points) continue;

    const polyline = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    polyline.setAttribute("class", "transit-line");
    polyline.setAttribute("points", points);
    elements.zoneOverlay.appendChild(polyline);
  }
}

function drawTransitLabelsOnOverlay(featureCollection) {
  const bounds = map.getBounds();
  for (const feature of featureCollection.features || []) {
    if (feature.properties?.layer !== "line" || !feature.properties?.label) continue;
    for (const line of getLineCoordinateSequences(feature.geometry)) {
      drawLineLabel(feature.properties.label, line, bounds);
    }
  }
}

function drawLineLabel(label, line, bounds) {
  if (!line.length) return;
  const point = getVisibleLineLabelPoint(line, bounds);
  if (!point) return;
  drawOverlayText(label, point, "line-name-label");
}

function getVisibleLineLabelPoint(line, bounds) {
  if (!bounds || line.length < 2) return null;

  const clipped = turf.bboxClip(
    turf.lineString(line),
    [
      bounds.getWest(),
      bounds.getSouth(),
      bounds.getEast(),
      bounds.getNorth(),
    ],
  );
  const segments = getLineCoordinateSequences(clipped.geometry || clipped);
  if (!segments.length) return null;

  let longestSegment = null;
  let longestLength = 0;
  for (const segment of segments) {
    if (segment.length < 2) continue;
    const length = turf.length(turf.lineString(segment), { units: "miles" });
    if (length > longestLength) {
      longestLength = length;
      longestSegment = segment;
    }
  }

  if (!longestSegment || longestLength === 0) return null;

  const midpoint = turf.along(
    turf.lineString(longestSegment),
    longestLength / 2,
    { units: "miles" },
  ).geometry.coordinates;
  return map.latLngToContainerPoint([midpoint[1], midpoint[0]]);
}

function drawTransitStopFeature(feature) {
  for (const [lng, lat] of getPointCoordinates(feature.geometry)) {
    const point = map.latLngToContainerPoint([lat, lng]);
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("class", "transit-stop");
    circle.setAttribute("cx", point.x.toFixed(1));
    circle.setAttribute("cy", point.y.toFixed(1));
    circle.setAttribute("r", "3.5");
    elements.zoneOverlay.appendChild(circle);
  }
}

function drawNearbyStopNames(pinLatLng) {
  const nearbyStops = namedStops
    .map((stop) => ({
      ...stop,
      distance: turf.distance(
        turf.point([pinLatLng.lng, pinLatLng.lat]),
        turf.point([stop.lng, stop.lat]),
        { units: "miles" },
      ),
    }))
    .filter((stop) => stop.distance <= SHRINK_RADIUS_MILES)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 80);

  for (const stop of nearbyStops) {
    const point = map.latLngToContainerPoint([stop.lat, stop.lng]);
    drawOverlayText(stop.name, point, "pin-stop-label");
  }
}

function drawOverlayText(label, point, className) {
  const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
  text.setAttribute("class", className);
  text.setAttribute("x", point.x.toFixed(1));
  text.setAttribute("y", point.y.toFixed(1));
  text.textContent = label;
  elements.zoneOverlay.appendChild(text);
}

function getLineCoordinateSequences(geometry) {
  if (!geometry) return [];

  if (geometry.type === "LineString") return [geometry.coordinates];
  if (geometry.type === "MultiLineString") return geometry.coordinates;
  if (geometry.type === "GeometryCollection") {
    return geometry.geometries.flatMap(getLineCoordinateSequences);
  }

  return [];
}

function getPointCoordinates(geometry) {
  if (!geometry) return [];

  if (geometry.type === "Point") return [geometry.coordinates];
  if (geometry.type === "MultiPoint") return geometry.coordinates;
  if (geometry.type === "GeometryCollection") {
    return geometry.geometries.flatMap(getPointCoordinates);
  }

  return [];
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
  return [{ type: "Feature", properties: {}, geometry: geojson }];
}

function collectGeometries(geojson) {
  if (!geojson) return [];
  if (geojson.type === "FeatureCollection") return geojson.features.flatMap(collectGeometries);
  if (geojson.type === "Feature") return collectGeometries(geojson.geometry);
  if (geojson.type === "GeometryCollection") return geojson.geometries.flatMap(collectGeometries);
  return [geojson];
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
  if (route && name && route !== name) return `${route} - ${name}`;
  return route || name || "";
}

function drawDimMaskOnOverlay(size) {
  const viewportPath = `M0 0H${size.x}V${size.y}H0Z`;
  const activeZonePaths = getExteriorRings(activeZoneFeature)
    .map((ring) => ringToPath(ring))
    .join("");

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("class", "zone-dim");
  path.setAttribute("d", `${viewportPath}${activeZonePaths}`);
  elements.zoneOverlay.appendChild(path);
}

function drawFeatureOnOverlay(feature, className) {
  const rings = getExteriorRings(feature);
  for (const ring of rings) {
    const points = ringToPoints(ring);

    if (!points) continue;

    const polygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    polygon.setAttribute("class", className);
    polygon.setAttribute("points", points);
    elements.zoneOverlay.appendChild(polygon);
  }
}

function ringToPath(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return "";

  const commands = ring.map(([lng, lat], index) => {
    const point = map.latLngToContainerPoint([lat, lng]);
    return `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
  });

  return `${commands.join("")}Z`;
}

function ringToPoints(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return "";

  return ring
    .map(([lng, lat]) => {
      const point = map.latLngToContainerPoint([lat, lng]);
      return `${point.x.toFixed(1)},${point.y.toFixed(1)}`;
    })
    .join(" ");
}

function bindControls() {
  elements.centerButton.addEventListener("click", fitToActiveZone);
  elements.transitToggleButton.addEventListener("click", toggleTransitLayer);
  elements.lineNamesToggleButton.addEventListener("click", toggleLineNames);
  elements.resetButton.addEventListener("click", resetMap);
  elements.statusButton.addEventListener("click", () => {
    window.location.href = "status.html";
  });
  elements.rulesButton.addEventListener("click", () => {
    window.location.href = "rules.html";
  });
  elements.testingIgnoreButton.addEventListener("click", () => {
    warningIgnoredForTesting = true;
    elements.warningOverlay.hidden = true;
    showStatus("Out-of-bounds warning ignored for this testing session.");
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopForegroundTracking();
    } else {
      startForegroundTracking();
    }
  });

  window.addEventListener("pagehide", stopForegroundTracking);
  window.addEventListener("pageshow", () => {
    if (!document.hidden) startForegroundTracking();
  });
}

// Foreground lifecycle state: geolocation watch runs only while the page is visible.
function startForegroundTracking() {
  if (watchId !== null || document.hidden) return;

  if (!("geolocation" in navigator)) {
    showStatus("This browser does not support location tracking.", true);
    return;
  }

  watchId = navigator.geolocation.watchPosition(handlePositionUpdate, handlePositionError, {
    enableHighAccuracy: true,
    maximumAge: 2000,
    timeout: 10000,
  });
}

function stopForegroundTracking() {
  if (watchId === null) return;
  navigator.geolocation.clearWatch(watchId);
  watchId = null;
}

// Real-time geofence validation: every GPS update checks the active play zone.
function handlePositionUpdate(position) {
  const lng = position.coords.longitude;
  const lat = position.coords.latitude;
  lastPlayerPosition = turf.point([lng, lat]);

  const latLng = [lat, lng];
  if (!playerMarker) {
    playerMarker = L.marker(latLng, {
      icon: L.divIcon({
        className: "",
        html: '<div class="player-marker"></div>',
        iconSize: [56, 56],
        iconAnchor: [28, 28],
      }),
      zIndexOffset: 1000,
    }).addTo(map);
  } else {
    playerMarker.setLatLng(latLng);
  }

  validatePlayerBounds();
}

function handlePositionError(error) {
  const messages = {
    1: "Location permission was denied. Enable browser location access for this site.",
    2: "Location is currently unavailable.",
    3: "Location request timed out.",
  };
  showStatus(messages[error.code] || error.message || "Unable to read location.", true);
}

function validatePlayerBounds() {
  if (!lastPlayerPosition || !activeZoneFeature) return;
  const inside = turf.booleanPointInPolygon(lastPlayerPosition, activeZoneFeature, {
    ignoreBoundary: false,
  });
  if (inside) {
    warningIgnoredForTesting = false;
    elements.warningOverlay.hidden = true;
    return;
  }

  elements.warningOverlay.hidden = warningIgnoredForTesting;
}

// Dynamic shrink math: long-press creates a 1/4-mile circle and intersects it with the uMap polygon.
function bindLongPress() {
  const container = map.getContainer();

  container.addEventListener("pointerdown", (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    if (event.target.closest("#controls, #statusPanel, #warningOverlay")) return;

    longPressPoint = map.mouseEventToLatLng(event);
    longPressStartClient = { x: event.clientX, y: event.clientY };
    window.clearTimeout(longPressTimer);
    longPressTimer = window.setTimeout(() => {
      if (longPressPoint) shrinkToPin(longPressPoint);
      clearLongPressTimer();
    }, 550);
  });

  container.addEventListener("pointermove", (event) => {
    if (!longPressStartClient) return;
    const dx = event.clientX - longPressStartClient.x;
    const dy = event.clientY - longPressStartClient.y;
    if (Math.hypot(dx, dy) > 10) clearLongPressTimer();
  });

  container.addEventListener("pointerup", clearLongPressTimer);
  container.addEventListener("pointercancel", clearLongPressTimer);
  container.addEventListener("pointerleave", clearLongPressTimer);

  map.on("contextmenu", (event) => {
    event.originalEvent.preventDefault();
    shrinkToPin(event.latlng);
  });
}

function shrinkToPin(latlng, options = {}) {
  const snappedStop = options.snap === false ? null : findNearestNamedStop(latlng);
  const activeLatLng = snappedStop ? L.latLng(snappedStop.lat, snappedStop.lng) : latlng;
  const activePinPoint = turf.point([activeLatLng.lng, activeLatLng.lat]);
  const activeCircle = turf.circle(activePinPoint, SHRINK_RADIUS_MILES, {
    steps: 144,
    units: "miles",
  });
  const intersection = turf.intersect(originalZoneFeature, activeCircle);

  if (
    !intersection ||
    !["Polygon", "MultiPolygon"].includes(intersection.geometry.type)
  ) {
    showStatus("The 1/4-mile circle does not overlap the mission area.", true);
    return;
  }

  activeZoneFeature = turf.cleanCoords(intersection);
  radiusFeature = activeCircle;
  droppedPinLatLng = activeLatLng;
  warningIgnoredForTesting = false;
  renderMissionLayers();
  renderPin(activeLatLng, activeCircle);
  if (options.persist !== false) {
    savePin(activeLatLng);
  }
  validatePlayerBounds();
  if (options.showMessage !== false) {
    const snapMessage = snappedStop ? ` Pin centered on ${snappedStop.name}.` : "";
    showStatus(`Mission area shrunk to the intersection of the original zone and the 1/4-mile pin radius.${snapMessage}`);
  }
}

function findNearestNamedStop(latlng) {
  if (!namedStops.length) return null;

  const nearest = namedStops
    .map((stop) => ({
      ...stop,
      distance: turf.distance(
        turf.point([latlng.lng, latlng.lat]),
        turf.point([stop.lng, stop.lat]),
        { units: "miles" },
      ),
    }))
    .sort((a, b) => a.distance - b.distance)[0];

  if (!nearest || nearest.distance > 0.03) return null;
  return nearest;
}

function renderPin(latlng, circleFeature) {
  if (pinMarker) pinMarker.remove();
  if (radiusLayer) radiusLayer.remove();

  pinMarker = L.marker(latlng, {
    icon: L.divIcon({
      className: "",
      html: '<div class="pin-marker"></div>',
      iconSize: [34, 34],
      iconAnchor: [17, 34],
    }),
    zIndexOffset: 900,
  }).addTo(map);

  radiusLayer = L.geoJSON(circleFeature, {
    interactive: false,
    pane: "overlayPane",
    style: {
      color: "#ff3df2",
      dashArray: "6 6",
      lineCap: "round",
      weight: 4,
      opacity: 1,
      fillOpacity: 0,
    },
  }).addTo(map);

  radiusLayer.bringToFront();
}

function resetMap() {
  activeZoneFeature = originalZoneFeature;
  radiusFeature = null;
  droppedPinLatLng = null;
  warningIgnoredForTesting = false;
  if (pinMarker) pinMarker.remove();
  if (radiusLayer) radiusLayer.remove();
  pinMarker = null;
  radiusLayer = null;
  localStorage.removeItem(STORED_PIN_KEY);
  renderMissionLayers();
  fitToActiveZone();
  scheduleZoneOverlayUpdate();
  validatePlayerBounds();
  showStatus("Map reset to the original mission boundary.");
}

function savePin(latlng) {
  localStorage.setItem(
    STORED_PIN_KEY,
    JSON.stringify({
      lat: latlng.lat,
      lng: latlng.lng,
      savedAt: new Date().toISOString(),
    }),
  );
}

function restoreStoredPin() {
  const rawPin = localStorage.getItem(STORED_PIN_KEY);
  if (!rawPin) return;

  try {
    const parsed = JSON.parse(rawPin);
    if (!Number.isFinite(parsed.lat) || !Number.isFinite(parsed.lng)) {
      throw new Error("Stored pin is malformed.");
    }

    shrinkToPin(L.latLng(parsed.lat, parsed.lng), {
      persist: false,
      showMessage: false,
    });
    showStatus("Restored saved pin from this browser.");
  } catch (error) {
    localStorage.removeItem(STORED_PIN_KEY);
    showStatus("Saved pin could not be restored and was cleared.", true);
  }
}

function fitToActiveZone() {
  if (!map || !activeZoneFeature) return;
  const bounds = L.geoJSON(activeZoneFeature).getBounds();
  map.fitBounds(bounds, {
    padding: [36, 36],
    maxZoom: 16,
  });
  scheduleZoneOverlayUpdate();
}

function getExteriorRings(feature) {
  if (!feature?.geometry) return [];

  if (feature.geometry.type === "Polygon") {
    return [feature.geometry.coordinates[0]];
  }

  if (feature.geometry.type === "MultiPolygon") {
    return feature.geometry.coordinates.map((polygon) => polygon[0]);
  }

  return [];
}

function showStatus(message, persistent = false) {
  elements.statusPanel.textContent = message;
  elements.statusPanel.classList.add("is-visible");
  if (!persistent) {
    window.clearTimeout(showStatus.timeoutId);
    showStatus.timeoutId = window.setTimeout(() => {
      elements.statusPanel.classList.remove("is-visible");
    }, 5200);
  }
}

function clearLongPressTimer() {
  if (longPressTimer !== null) {
    window.clearTimeout(longPressTimer);
    longPressTimer = null;
  }
  longPressPoint = null;
  longPressStartClient = null;
}
