"use strict";

const MAP_URL = "assets/Map.json";
const LINES_URL = "assets/Lines.json";
const STOPS_URL = "assets/Stops.json";
const DEDUCTION_STATE_KEY = "hideDenver.deductionBoard";
const DEFAULT_RADIUS_MILES = 10;

const elements = {
  map: document.querySelector("#deductionMap"),
  backButton: document.querySelector("#deductionBackButton"),
  fitButton: document.querySelector("#deductionFitButton"),
  gpsButton: document.querySelector("#deductionGpsButton"),
  resetButton: document.querySelector("#deductionResetButton"),
  constraintType: document.querySelector("#constraintType"),
  constraintEffect: document.querySelector("#constraintEffect"),
  constraintRadius: document.querySelector("#constraintRadius"),
  constraintNote: document.querySelector("#constraintNote"),
  useMapCenterButton: document.querySelector("#useMapCenterButton"),
  useGpsButton: document.querySelector("#useGpsButton"),
  pickPointButton: document.querySelector("#pickPointButton"),
  pickSecondPointButton: document.querySelector("#pickSecondPointButton"),
  startAreaButton: document.querySelector("#startAreaButton"),
  finishAreaButton: document.querySelector("#finishAreaButton"),
  constraintHelp: document.querySelector("#constraintHelp"),
  poiName: document.querySelector("#poiName"),
  poiKind: document.querySelector("#poiKind"),
  addPoiButton: document.querySelector("#addPoiButton"),
  applyNearestButton: document.querySelector("#applyNearestButton"),
  constraintList: document.querySelector("#constraintList"),
  poiList: document.querySelector("#poiList"),
  status: document.querySelector("#deductionStatus"),
};

let map;
let originalZoneFeature;
let remainingZoneFeature;
let transitLayer;
let originalLayer;
let eliminatedLayer;
let remainingLayer;
let evidenceLayer;
let poiLayer;
let draftLayer;
let gpsMarker;
let constraints = [];
let places = [];
let pendingMode = null;
let draftPoints = [];
let thermometerStartLatLng = null;
let gpsWatchId = null;
let lastGpsLatLng = null;

bootstrap();

async function bootstrap() {
  try {
    showStatus("Loading deduction board...", { persistent: true });
    originalZoneFeature = await loadPrimaryPolygon();
    remainingZoneFeature = originalZoneFeature;
    createMap();
    bindControls();
    restoreState();
    await loadTransitLayer();
    recalculateBoard({ fit: true, announce: false });
    showStatus("Deduction board ready. Add evidence from physical questions.");
  } catch (error) {
    showStatus(error.message || String(error), { persistent: true, error: true });
  }
}

function createMap() {
  map = L.map(elements.map, {
    zoomControl: false,
    attributionControl: true,
  });

  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    maxZoom: 20,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(map);

  originalLayer = L.geoJSON(null, {
    interactive: false,
    style: {
      color: "#f6d047",
      dashArray: "8 7",
      fillOpacity: 0,
      lineCap: "round",
      weight: 3,
    },
  }).addTo(map);

  eliminatedLayer = L.geoJSON(null, {
    interactive: false,
    style: {
      color: "transparent",
      fillColor: "#05070a",
      fillOpacity: 0.58,
      weight: 0,
    },
  }).addTo(map);

  remainingLayer = L.geoJSON(null, {
    interactive: false,
    style: {
      color: "#00f0ff",
      fillColor: "#00f0ff",
      fillOpacity: 0.12,
      lineCap: "round",
      weight: 4,
    },
  }).addTo(map);

  evidenceLayer = L.geoJSON(null, {
    interactive: false,
    style: (feature) => ({
      color: feature.properties?.effect === "keep" ? "#65d46e" : "#ff5a5f",
      fillColor: feature.properties?.effect === "keep" ? "#65d46e" : "#ff5a5f",
      fillOpacity: feature.properties?.effect === "keep" ? 0.1 : 0.2,
      dashArray: feature.properties?.effect === "keep" ? "4 6" : null,
      weight: 2,
    }),
  }).addTo(map);

  poiLayer = L.layerGroup().addTo(map);
  draftLayer = L.layerGroup().addTo(map);
}

async function loadPrimaryPolygon() {
  const response = await fetch(MAP_URL, { cache: "no-store" });
  if (!response.ok) throw new Error(`Could not load ${MAP_URL}.`);
  const geojson = await response.json();
  const polygons = collectPolygonFeatures(geojson);
  if (!polygons.length) throw new Error("No mission boundary polygon was found.");
  polygons.sort((a, b) => turf.area(b) - turf.area(a));
  return turf.cleanCoords(polygons[0]);
}

async function loadTransitLayer() {
  try {
    const [linesResponse, stopsResponse] = await Promise.all([
      fetch(LINES_URL, { cache: "no-store" }),
      fetch(STOPS_URL, { cache: "no-store" }),
    ]);
    if (!linesResponse.ok || !stopsResponse.ok) return;
    const [lines, stops] = await Promise.all([linesResponse.json(), stopsResponse.json()]);
    transitLayer = L.geoJSON(
      {
        type: "FeatureCollection",
        features: [
          ...geometryCollectionToFeatures(lines, { layer: "line" }),
          ...geometryCollectionToFeatures(stops, { layer: "stop" }),
        ],
      },
      {
        interactive: false,
        pointToLayer: (_feature, latlng) =>
          L.circleMarker(latlng, {
            radius: 2.5,
            color: "#111827",
            fillColor: "#ffffff",
            fillOpacity: 0.85,
            weight: 1,
          }),
        style: (feature) =>
          feature.properties?.layer === "line"
            ? {
                color: "#ffb15f",
                lineCap: "round",
                lineJoin: "round",
                opacity: 0.42,
                weight: 3,
              }
            : {},
      },
    ).addTo(map);
    transitLayer.bringToBack();
  } catch (error) {
    console.warn("Transit layer unavailable.", error);
  }
}

function bindControls() {
  elements.backButton.addEventListener("click", () => {
    window.location.href = "index.html";
  });
  elements.fitButton.addEventListener("click", fitToRemainingZone);
  elements.gpsButton.addEventListener("click", toggleGpsTracking);
  elements.resetButton.addEventListener("click", resetBoard);
  elements.useMapCenterButton.addEventListener("click", () => {
    applyPointConstraint(map.getCenter());
  });
  elements.useGpsButton.addEventListener("click", useGpsForActiveConstraint);
  elements.pickPointButton.addEventListener("click", () => {
    pendingMode = getPrimaryPickMode();
    clearDraft();
    showStatus(getPrimaryPickMessage());
  });
  elements.pickSecondPointButton.addEventListener("click", () => {
    pendingMode = "thermometer-end";
    showStatus("Tap the seekers' ending location for the thermometer.");
  });
  elements.startAreaButton.addEventListener("click", startManualArea);
  elements.finishAreaButton.addEventListener("click", finishManualArea);
  elements.addPoiButton.addEventListener("click", () => {
    pendingMode = "poi";
    clearDraft();
    showStatus("Tap the map icon location for this place.");
  });
  elements.applyNearestButton.addEventListener("click", applyNearestConstraint);
  elements.constraintType.addEventListener("change", updateFormState);
  map.on("click", handleMapClick);
  window.addEventListener("pagehide", stopGpsTracking);
  updateFormState();
}

function handleMapClick(event) {
  if (pendingMode === "constraint-point") {
    applyPointConstraint(event.latlng);
    pendingMode = null;
    return;
  }

  if (pendingMode === "measuring-point") {
    applyMeasuringConstraint(event.latlng);
    pendingMode = null;
    return;
  }

  if (pendingMode === "thermometer-start") {
    thermometerStartLatLng = event.latlng;
    pendingMode = null;
    showStatus("Thermometer start saved. Press Pick End after the seekers travel.");
    updateFormState();
    return;
  }

  if (pendingMode === "thermometer-end") {
    applyThermometerConstraint(event.latlng);
    pendingMode = null;
    thermometerStartLatLng = null;
    updateFormState();
    return;
  }

  if (pendingMode === "poi") {
    addPlace(event.latlng);
    pendingMode = null;
    return;
  }

  if (pendingMode === "manual-area") {
    draftPoints.push([event.latlng.lng, event.latlng.lat]);
    renderDraftArea();
  }
}

function updateFormState() {
  const type = elements.constraintType.value;
  const isRadius = type === "radar" || type === "tentacle";
  const isManual = type === "manual";
  const needsPrimaryPoint = ["radar", "measuring", "thermometer", "tentacle"].includes(type);
  elements.constraintRadius.closest("label").hidden = !isRadius;
  elements.useMapCenterButton.disabled = !["radar", "measuring", "tentacle"].includes(type);
  elements.useGpsButton.disabled =
    !lastGpsLatLng || (!needsPrimaryPoint && pendingMode !== "thermometer-end");
  elements.pickPointButton.disabled = !needsPrimaryPoint;
  elements.pickSecondPointButton.disabled = type !== "thermometer" || !thermometerStartLatLng;
  elements.startAreaButton.disabled = !isManual;
  elements.finishAreaButton.disabled = pendingMode !== "manual-area";
  elements.applyNearestButton.disabled = type !== "nearest";
  elements.constraintHelp.textContent = getConstraintHelp(type);
}

function toggleGpsTracking() {
  if (gpsWatchId !== null) {
    stopGpsTracking();
    showStatus("GPS tracking stopped.");
    return;
  }

  if (!("geolocation" in navigator)) {
    showStatus("This browser does not support GPS location.", { error: true });
    return;
  }

  elements.gpsButton.setAttribute("aria-pressed", "true");
  elements.gpsButton.textContent = "GPS On";
  showStatus("Starting GPS for seeker position...", { persistent: true });
  gpsWatchId = navigator.geolocation.watchPosition(handleGpsPosition, handleGpsError, {
    enableHighAccuracy: true,
    maximumAge: 2000,
    timeout: 10000,
  });
}

function stopGpsTracking() {
  if (gpsWatchId === null) return;
  navigator.geolocation.clearWatch(gpsWatchId);
  gpsWatchId = null;
  elements.gpsButton.setAttribute("aria-pressed", "false");
  elements.gpsButton.textContent = "GPS";
  updateFormState();
}

function handleGpsPosition(position) {
  lastGpsLatLng = L.latLng(position.coords.latitude, position.coords.longitude);
  if (!gpsMarker) {
    gpsMarker = L.marker(lastGpsLatLng, {
      icon: L.divIcon({
        className: "",
        html: '<div class="player-marker"></div>',
        iconSize: [56, 56],
        iconAnchor: [28, 28],
      }),
      zIndexOffset: 1100,
    }).addTo(map);
  } else {
    gpsMarker.setLatLng(lastGpsLatLng);
  }
  updateFormState();
  showStatus(
    `GPS ready for seeker position. Accuracy: ${Math.round(position.coords.accuracy * 3.28084).toLocaleString()} ft.`,
  );
}

function handleGpsError(error) {
  const messages = {
    1: "Location permission was denied. Enable browser location access for this site.",
    2: "GPS location is currently unavailable.",
    3: "GPS request timed out.",
  };
  showStatus(messages[error.code] || error.message || "Unable to read GPS location.", {
    error: true,
  });
  stopGpsTracking();
}

function useGpsForActiveConstraint() {
  if (!lastGpsLatLng) {
    showStatus("GPS is not ready yet.", { error: true });
    return;
  }

  if (pendingMode === "thermometer-end") {
    applyThermometerConstraint(lastGpsLatLng);
    pendingMode = null;
    thermometerStartLatLng = null;
    updateFormState();
    return;
  }

  const type = elements.constraintType.value;
  if (type === "thermometer") {
    thermometerStartLatLng = lastGpsLatLng;
    showStatus("Thermometer start set from GPS. Press Pick End, then use GPS again or tap the map.");
    updateFormState();
    return;
  }

  applyPointConstraint(lastGpsLatLng);
}

function getPrimaryPickMode() {
  const type = elements.constraintType.value;
  if (type === "measuring") return "measuring-point";
  if (type === "thermometer") return "thermometer-start";
  return "constraint-point";
}

function getPrimaryPickMessage() {
  const type = elements.constraintType.value;
  if (type === "measuring") return "Tap the seekers' location for the measuring question.";
  if (type === "thermometer") return "Tap the seekers' starting location for the thermometer.";
  if (type === "tentacle") return "Tap the seekers' location for the tentacle question.";
  return "Tap the map where the seekers asked the radar question.";
}

function getConstraintHelp(type) {
  const help = {
    radar:
      "Official radar answers map to a circle around the seekers: yes keeps the circle, no eliminates it.",
    measuring:
      "Select the referenced place, then pick the seekers' location. Closer keeps the place-centered circle; further eliminates it.",
    thermometer:
      "Pick the start, then the end. Use Keep only for hotter and Eliminate this area for colder.",
    nearest:
      "Add all matching map-app places inside the mission boundary, select the named place, then apply.",
    tentacle:
      "Add all places in the requested category. Keep only means the hider named the selected place; eliminate means not within reach.",
    manual:
      "Use this for photos, local knowledge, or any answer that needs hand-drawn evidence.",
  };
  return help[type] || "";
}

function applyPointConstraint(latlng) {
  if (elements.constraintType.value === "measuring") {
    applyMeasuringConstraint(latlng);
    return;
  }
  if (elements.constraintType.value === "tentacle") {
    applyTentacleConstraint(latlng);
    return;
  }

  const radius = Number.parseFloat(elements.constraintRadius.value) || DEFAULT_RADIUS_MILES;
  if (radius <= 0) {
    showStatus("Radius must be greater than zero.", { error: true });
    return;
  }

  const circle = turf.circle(turf.point([latlng.lng, latlng.lat]), radius, {
    steps: 160,
    units: "miles",
  });
  addConstraint({
    type: "radar",
    effect: elements.constraintEffect.value,
    label:
      getNote() ||
      `${elements.constraintEffect.value === "keep" ? "Inside" : "Not inside"} ${formatMiles(radius)} radius`,
    geometry: circle.geometry,
    details: {
      radius,
      center: [latlng.lng, latlng.lat],
    },
  });
}

function applyMeasuringConstraint(latlng) {
  const selected = getSelectedPlace();
  if (!selected) {
    showStatus("Select the referenced place first.", { error: true });
    return;
  }

  const seekerPoint = turf.point([latlng.lng, latlng.lat]);
  const placePoint = turf.point(selected.coordinates);
  const radius = turf.distance(seekerPoint, placePoint, { units: "miles" });
  const circle = turf.circle(placePoint, radius, {
    steps: 160,
    units: "miles",
  });
  addConstraint({
    type: "measuring",
    effect: elements.constraintEffect.value,
    label:
      getNote() ||
      `${elements.constraintEffect.value === "keep" ? "Closer to" : "Further from"} ${selected.name} than seekers`,
    geometry: circle.geometry,
    details: {
      placeId: selected.id,
      placeName: selected.name,
      seeker: [latlng.lng, latlng.lat],
      radius,
    },
  });
}

function applyThermometerConstraint(endLatLng) {
  if (!thermometerStartLatLng) {
    showStatus("Pick the thermometer start point first.", { error: true });
    return;
  }

  const hotter = elements.constraintEffect.value === "keep";
  const area = buildCloserHalfPlane(
    hotter ? endLatLng : thermometerStartLatLng,
    hotter ? thermometerStartLatLng : endLatLng,
  );
  if (!area) {
    showStatus("Could not build the thermometer area.", { error: true });
    return;
  }

  addConstraint({
    type: "thermometer",
    effect: "keep",
    label: getNote() || `Thermometer: ${hotter ? "hotter" : "colder"}`,
    geometry: area.geometry,
    details: {
      start: [thermometerStartLatLng.lng, thermometerStartLatLng.lat],
      end: [endLatLng.lng, endLatLng.lat],
    },
  });
}

function startManualArea() {
  pendingMode = "manual-area";
  draftPoints = [];
  clearDraft();
  updateFormState();
  showStatus("Tap at least three points, then press Finish.");
}

function finishManualArea() {
  if (draftPoints.length < 3) {
    showStatus("Manual areas need at least three map points.", { error: true });
    return;
  }
  const ring = [...draftPoints, draftPoints[0]];
  addConstraint({
    type: "manual",
    effect: elements.constraintEffect.value,
    label: getNote() || "Manual map area",
    geometry: {
      type: "Polygon",
      coordinates: [ring],
    },
    details: {},
  });
  pendingMode = null;
  draftPoints = [];
  clearDraft();
  updateFormState();
}

function addPlace(latlng) {
  const name = elements.poiName.value.trim();
  if (!name) {
    showStatus("Name the place before adding it.", { error: true });
    return;
  }

  places.push({
    id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
    name,
    kind: elements.poiKind.value,
    coordinates: [latlng.lng, latlng.lat],
  });
  elements.poiName.value = "";
  saveState();
  renderPlaces();
  showStatus(`${name} added as a nearest-place reference.`);
}

function applyNearestConstraint() {
  if (places.length < 2) {
    showStatus("Nearest-place constraints need at least two places to compare.", {
      error: true,
    });
    return;
  }

  const selected = getSelectedPlace();
  if (!selected) {
    showStatus("Choose a place from the Places list first.", { error: true });
    return;
  }

  const cell = getVoronoiCellForPlace(selected);
  if (!cell) {
    showStatus("Could not build a nearest-place area for that place.", { error: true });
    return;
  }

  const type = elements.constraintType.value;
  if (type === "tentacle") {
    applyTentacleConstraint(map.getCenter(), cell);
    return;
  }

  addConstraint({
    type: "nearest",
    effect: elements.constraintEffect.value,
    label:
      getNote() ||
      `${elements.constraintEffect.value === "keep" ? "Nearest is" : "Nearest is not"} ${selected.name}`,
    geometry: cell.geometry,
    details: {
      placeId: selected.id,
      placeName: selected.name,
      kind: selected.kind,
    },
  });
}

function applyTentacleConstraint(latlng, nearestCell = null) {
  const radius = Number.parseFloat(elements.constraintRadius.value) || DEFAULT_RADIUS_MILES;
  if (radius <= 0) {
    showStatus("Radius must be greater than zero.", { error: true });
    return;
  }

  const seekerCircle = turf.circle(turf.point([latlng.lng, latlng.lat]), radius, {
    steps: 160,
    units: "miles",
  });

  if (elements.constraintEffect.value === "eliminate") {
    addConstraint({
      type: "tentacle",
      effect: "eliminate",
      label: getNote() || `Tentacle miss outside ${formatMiles(radius)}`,
      geometry: seekerCircle.geometry,
      details: { radius, center: [latlng.lng, latlng.lat] },
    });
    return;
  }

  const selected = getSelectedPlace();
  if (!selected) {
    showStatus("Select the answered place first.", { error: true });
    return;
  }
  const cell = nearestCell || getVoronoiCellForPlace(selected);
  const area = cell ? safeIntersect(cell, seekerCircle) : null;
  if (!area) {
    showStatus("The selected place has no matching tentacle area in range.", {
      error: true,
    });
    return;
  }
  addConstraint({
    type: "tentacle",
    effect: "keep",
    label: getNote() || `Tentacle answer: ${selected.name} within ${formatMiles(radius)}`,
    geometry: area.geometry,
    details: {
      placeId: selected.id,
      placeName: selected.name,
      radius,
      center: [latlng.lng, latlng.lat],
    },
  });
}

function buildCloserHalfPlane(nearLatLng, farLatLng) {
  const bbox = turf.bbox(originalZoneFeature);
  const padLng = Math.max((bbox[2] - bbox[0]) * 2, 0.05);
  const padLat = Math.max((bbox[3] - bbox[1]) * 2, 0.05);
  const rect = [
    [bbox[0] - padLng, bbox[1] - padLat],
    [bbox[2] + padLng, bbox[1] - padLat],
    [bbox[2] + padLng, bbox[3] + padLat],
    [bbox[0] - padLng, bbox[3] + padLat],
  ];
  const lat0 = ((bbox[1] + bbox[3]) / 2) * (Math.PI / 180);
  const scaleX = Math.cos(lat0);
  const project = ([lng, lat]) => [lng * scaleX, lat];
  const unproject = ([x, y]) => [x / scaleX, y];
  const near = project([nearLatLng.lng, nearLatLng.lat]);
  const far = project([farLatLng.lng, farLatLng.lat]);
  const midpoint = [(near[0] + far[0]) / 2, (near[1] + far[1]) / 2];
  const normal = [near[0] - far[0], near[1] - far[1]];
  const inside = (point) => {
    const projected = project(point);
    return (
      (projected[0] - midpoint[0]) * normal[0] +
        (projected[1] - midpoint[1]) * normal[1] >=
      -1e-12
    );
  };
  const intersect = (a, b) => {
    const pa = project(a);
    const pb = project(b);
    const da = (pa[0] - midpoint[0]) * normal[0] + (pa[1] - midpoint[1]) * normal[1];
    const db = (pb[0] - midpoint[0]) * normal[0] + (pb[1] - midpoint[1]) * normal[1];
    const t = da / (da - db);
    return unproject([pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t]);
  };

  let output = rect;
  const input = output;
  output = [];
  for (let i = 0; i < input.length; i += 1) {
    const current = input[i];
    const previous = input[(i + input.length - 1) % input.length];
    const currentInside = inside(current);
    const previousInside = inside(previous);
    if (currentInside) {
      if (!previousInside) output.push(intersect(previous, current));
      output.push(current);
    } else if (previousInside) {
      output.push(intersect(previous, current));
    }
  }

  if (output.length < 3) return null;
  output.push(output[0]);
  return {
    type: "Feature",
    properties: {},
    geometry: {
      type: "Polygon",
      coordinates: [output],
    },
  };
}

function getVoronoiCellForPlace(place) {
  const bbox = turf.bbox(originalZoneFeature);
  const paddingLng = Math.max((bbox[2] - bbox[0]) * 0.08, 0.01);
  const paddingLat = Math.max((bbox[3] - bbox[1]) * 0.08, 0.01);
  const points = turf.featureCollection(
    places.map((item) =>
      turf.point(item.coordinates, {
        id: item.id,
        name: item.name,
      }),
    ),
  );
  const cells = turf.voronoi(points, {
    bbox: [
      bbox[0] - paddingLng,
      bbox[1] - paddingLat,
      bbox[2] + paddingLng,
      bbox[3] + paddingLat,
    ],
  });
  const selectedPoint = turf.point(place.coordinates);
  const cell = cells.features.find((feature) =>
    turf.booleanPointInPolygon(selectedPoint, feature, { ignoreBoundary: false }),
  );
  if (!cell) return null;
  const clipped = safeIntersect(originalZoneFeature, cell);
  return clipped ? turf.cleanCoords(clipped) : null;
}

function addConstraint(constraint) {
  constraints.push({
    id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
    createdAt: new Date().toISOString(),
    ...constraint,
  });
  elements.constraintNote.value = "";
  recalculateBoard({ fit: true });
}

function recalculateBoard(options = {}) {
  let next = originalZoneFeature;
  const validConstraints = [];

  for (const constraint of constraints) {
    const feature = {
      type: "Feature",
      properties: {},
      geometry: constraint.geometry,
    };

    try {
      const clipped = safeIntersect(originalZoneFeature, feature);
      if (!clipped) continue;
      next =
        constraint.effect === "keep"
          ? safeIntersect(next, clipped)
          : safeDifference(next, clipped);
      validConstraints.push(constraint);
    } catch (error) {
      console.warn("Skipping invalid constraint.", error);
    }

    if (!next) break;
  }

  constraints = validConstraints;
  remainingZoneFeature = next;
  saveState();
  renderBoard();
  if (options.fit) fitToRemainingZone();
  if (options.announce !== false) {
    showStatus(
      remainingZoneFeature
        ? `Possible area: ${formatArea(remainingZoneFeature)}.`
        : "No possible area remains. Check for conflicting evidence.",
      { error: !remainingZoneFeature },
    );
  }
}

function renderBoard() {
  originalLayer.clearLayers().addData(originalZoneFeature);
  eliminatedLayer.clearLayers();
  remainingLayer.clearLayers();
  evidenceLayer.clearLayers();

  const eliminatedFeature = remainingZoneFeature
    ? safeDifference(originalZoneFeature, remainingZoneFeature)
    : originalZoneFeature;
  if (eliminatedFeature) eliminatedLayer.addData(eliminatedFeature);
  if (remainingZoneFeature) remainingLayer.addData(remainingZoneFeature);

  evidenceLayer.addData({
    type: "FeatureCollection",
    features: constraints.map((constraint) => ({
      type: "Feature",
      properties: {
        id: constraint.id,
        effect: constraint.effect,
      },
      geometry: constraint.geometry,
    })),
  });
  remainingLayer.bringToFront();
  evidenceLayer.bringToFront();
  renderConstraints();
  renderPlaces();
}

function renderConstraints() {
  elements.constraintList.replaceChildren();
  if (!constraints.length) {
    elements.constraintList.appendChild(renderEmptyItem("No evidence yet."));
    return;
  }

  constraints.forEach((constraint, index) => {
    const item = document.createElement("li");
    item.className = `deduction-list-item is-${constraint.effect}`;
    const title = document.createElement("strong");
    title.textContent = constraint.label;
    const meta = document.createElement("span");
    meta.textContent = `${formatConstraintType(constraint.type)} - ${constraint.effect === "keep" ? "kept" : "eliminated"}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      constraints.splice(index, 1);
      recalculateBoard({ fit: false });
    });
    item.append(title, meta, remove);
    elements.constraintList.appendChild(item);
  });
}

function renderPlaces() {
  poiLayer.clearLayers();
  elements.poiList.replaceChildren();
  if (!places.length) {
    elements.poiList.appendChild(renderEmptyItem("No places added."));
    return;
  }

  places.forEach((place, index) => {
    const marker = L.circleMarker([place.coordinates[1], place.coordinates[0]], {
      radius: 7,
      color: "#111827",
      fillColor: "#f6d047",
      fillOpacity: 0.95,
      weight: 2,
    })
      .bindTooltip(place.name, { direction: "top", offset: [0, -8] })
      .addTo(poiLayer);
    marker.on("click", () => selectPlace(place.id));

    const item = document.createElement("li");
    item.className = "deduction-list-item";
    if (place.selected) item.classList.add("is-selected");
    const title = document.createElement("strong");
    title.textContent = place.name;
    const meta = document.createElement("span");
    meta.textContent = formatPlaceKind(place.kind);
    const select = document.createElement("button");
    select.type = "button";
    select.textContent = place.selected ? "Selected" : "Select";
    select.addEventListener("click", () => selectPlace(place.id));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      places.splice(index, 1);
      saveState();
      renderPlaces();
    });
    item.append(title, meta, select, remove);
    elements.poiList.appendChild(item);
  });
}

function selectPlace(id) {
  places = places.map((place) => ({
    ...place,
    selected: place.id === id,
  }));
  saveState();
  renderPlaces();
}

function getSelectedPlace() {
  return places.find((place) => place.selected);
}

function renderEmptyItem(text) {
  const item = document.createElement("li");
  item.className = "deduction-empty";
  item.textContent = text;
  return item;
}

function renderDraftArea() {
  clearDraft();
  if (!draftPoints.length) return;
  const latLngs = draftPoints.map(([lng, lat]) => [lat, lng]);
  L.polyline(latLngs, {
    color: "#ffffff",
    dashArray: "4 5",
    weight: 3,
  }).addTo(draftLayer);
  for (const point of latLngs) {
    L.circleMarker(point, {
      radius: 5,
      color: "#111827",
      fillColor: "#ffffff",
      fillOpacity: 1,
      weight: 2,
    }).addTo(draftLayer);
  }
  elements.finishAreaButton.disabled = draftPoints.length < 3;
}

function clearDraft() {
  draftLayer.clearLayers();
  draftPoints = pendingMode === "manual-area" ? draftPoints : [];
  elements.finishAreaButton.disabled = true;
}

function resetBoard() {
  constraints = [];
  places = [];
  pendingMode = null;
  draftPoints = [];
  remainingZoneFeature = originalZoneFeature;
  clearDraft();
  saveState();
  renderBoard();
  fitToRemainingZone();
  showStatus("Deduction board reset.");
}

function fitToRemainingZone() {
  const feature = remainingZoneFeature || originalZoneFeature;
  if (!map || !feature) return;
  map.fitBounds(L.geoJSON(feature).getBounds(), {
    paddingTopLeft: [24, 24],
    paddingBottomRight: [window.innerWidth >= 900 ? 420 : 24, 80],
    maxZoom: 16,
  });
}

function safeIntersect(a, b) {
  try {
    const result = turf.intersect(a, b);
    return result && ["Polygon", "MultiPolygon"].includes(result.geometry?.type)
      ? turf.cleanCoords(result)
      : null;
  } catch (error) {
    return null;
  }
}

function safeDifference(a, b) {
  if (!a) return null;
  try {
    const result = turf.difference(a, b);
    return result && ["Polygon", "MultiPolygon"].includes(result.geometry?.type)
      ? turf.cleanCoords(result)
      : null;
  } catch (error) {
    return a;
  }
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

function geometryCollectionToFeatures(geojson, extraProperties = {}) {
  if (!geojson) return [];
  if (geojson.type === "FeatureCollection") {
    return geojson.features.flatMap((feature) =>
      geometryCollectionToFeatures(feature, {
        ...extraProperties,
        ...(feature.properties || {}),
      }),
    );
  }
  if (geojson.type === "Feature") {
    return geometryCollectionToFeatures(geojson.geometry, {
      ...extraProperties,
      ...(geojson.properties || {}),
    });
  }
  if (geojson.type === "GeometryCollection") {
    return geojson.geometries.flatMap((geometry) =>
      geometryCollectionToFeatures(geometry, extraProperties),
    );
  }
  if (!geojson.type) return [];
  return [
    {
      type: "Feature",
      properties: extraProperties,
      geometry: geojson,
    },
  ];
}

function getNote() {
  return elements.constraintNote.value.trim();
}

function formatMiles(value) {
  return `${Number(value).toLocaleString(undefined, {
    maximumFractionDigits: 1,
  })} mi`;
}

function formatArea(feature) {
  const squareMiles = turf.area(feature) / 2589988.110336;
  return `${squareMiles.toLocaleString(undefined, {
    maximumFractionDigits: 2,
  })} sq mi`;
}

function formatConstraintType(type) {
  const labels = {
    radar: "Radar",
    nearest: "Nearest place",
    manual: "Manual",
  };
  return labels[type] || type;
}

function formatPlaceKind(kind) {
  return String(kind || "custom").replace(/^\w/, (letter) => letter.toUpperCase());
}

function saveState() {
  try {
    window.localStorage.setItem(
      DEDUCTION_STATE_KEY,
      JSON.stringify({
        constraints,
        places,
      }),
    );
  } catch (error) {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}

function restoreState() {
  try {
    const raw = window.localStorage.getItem(DEDUCTION_STATE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    constraints = Array.isArray(parsed.constraints) ? parsed.constraints : [];
    places = Array.isArray(parsed.places) ? parsed.places : [];
  } catch (error) {
    constraints = [];
    places = [];
  }
}

function showStatus(message, options = {}) {
  window.clearTimeout(showStatus.timeoutId);
  elements.status.textContent = message;
  elements.status.classList.toggle("is-error", Boolean(options.error));
  elements.status.classList.add("is-visible");
  if (!options.persistent) {
    showStatus.timeoutId = window.setTimeout(() => {
      elements.status.classList.remove("is-visible");
    }, options.error ? 5200 : 3200);
  }
}
