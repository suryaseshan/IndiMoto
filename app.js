const emptyFeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

const map = new maplibregl.Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/liberty",
  center: [78.9629, 20.5937],
  zoom: 4,
  attributionControl: true,
});

map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), "bottom-left");
map.addControl(createCompassControl(), "bottom-left");

const mapReady = new Promise((resolve) => {
  map.on("load", () => {
    setupRouteLayers();
    resolve();
  });
});

let startMarker = null;
let endMarker = null;

const form = document.querySelector("#routeForm");
const startInput = document.querySelector("#startInput");
const endInput = document.querySelector("#endInput");
const swapButton = document.querySelector("#swapButton");
const statusLine = document.querySelector("#status");
const routeChoices = document.querySelector("#routeChoices");
const choiceTemplate = document.querySelector("#routeChoiceTemplate");
const locationHistory = document.querySelector("#locationHistory");
const recentRoutes = document.querySelector("#recentRoutes");

const CACHE_TTL = 1000 * 60 * 60 * 24 * 14;
const HISTORY_KEY = "motoroute.history.v1";
const CACHE_KEY_PREFIX = "motoroute.cache.v1:";

const metrics = {
  distance: document.querySelector("#distanceMetric"),
  time: document.querySelector("#timeMetric"),
  turns: document.querySelector("#turnMetric"),
  flow: document.querySelector("#flowMetric"),
  elevation: document.querySelector("#elevationMetric"),
};

const characterText = document.querySelector("#characterText");
const featureList = document.querySelector("#featureList");
const rideChecks = document.querySelector("#rideChecks");
const directionsList = document.querySelector("#directionsList");

let routeOptions = [];
let selectedRouteIndex = 0;
let currentStartPlace = null;
let currentEndPlace = null;
let trailRequestId = 0;

renderSavedDestinations();
registerMapCache();
map.on("rotate", updateCompass);
map.on("pitch", updateCompass);

document.querySelectorAll(".tab-button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".tab-button").forEach((tab) => tab.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.remove("active"));
    button.classList.add("active");
    document.querySelector(`#${button.dataset.tab}Tab`).classList.add("active");
  });
});

swapButton.addEventListener("click", () => {
  const start = startInput.value;
  startInput.value = endInput.value;
  endInput.value = start;
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const start = startInput.value.trim();
  const end = endInput.value.trim();
  const style = new FormData(form).get("style");

  if (!start || !end) return;

  setLoading(true, "Finding locations from open map data...");
  await clearRoute();

  try {
    const [startPlace, endPlace] = await Promise.all([geocode(start), geocode(end)]);
    currentStartPlace = startPlace;
    currentEndPlace = endPlace;
    setLoading(true, "Building fast, twisty, state-highway, and backroad route options...");
    routeOptions = await getRoutes(startPlace, endPlace, style);
    selectedRouteIndex = pickBestRoute(routeOptions, style);
    await renderRoute(startPlace, endPlace, selectedRouteIndex);
    renderRouteChoices();
    saveDestinationPair(start, end);
    statusLine.textContent = `${routeOptions.length} route options found in one build. Pick any card to highlight that route on the map.`;
  } catch (error) {
    statusLine.textContent = error.message || "Could not build that route. Try more specific locations.";
    await clearRoute();
  } finally {
    setLoading(false);
  }
});

async function geocode(query) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "1");
  url.searchParams.set("q", query);

  const results = await cachedJson(`geocode:${normalizeCacheKey(query)}`, () => fetch(url, {
    headers: {
      Accept: "application/json",
    },
  }).then((response) => {
    if (!response.ok) throw new Error("Location search is unavailable right now.");
    return response.json();
  }));

  if (!results.length) {
    throw new Error(`No open-map match found for "${query}".`);
  }

  return {
    label: results[0].display_name,
    lat: Number(results[0].lat),
    lon: Number(results[0].lon),
  };
}

async function getRoutes(start, end, style) {
  const requests = buildRouteRequests(start, end);
  const results = await Promise.allSettled(requests.map((request) => fetchRouteRequest(request)));
  const routes = results
    .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
    .map((entry, index) => enrichRoute(entry.route, index, entry.request))
    .filter(uniqueRoute)
    .sort((a, b) => b.scores[style] - a.scores[style]);

  if (!routes.length) {
    throw new Error("No routable road connection was found between those locations.");
  }

  return routes.slice(0, 7);
}

async function fetchRouteRequest(request) {
  const coords = request.points.map((point) => `${point.lon},${point.lat}`).join(";");
  const url = new URL(`https://router.project-osrm.org/route/v1/driving/${coords}`);
  url.searchParams.set("overview", "full");
  url.searchParams.set("geometries", "geojson");
  url.searchParams.set("steps", "true");
  url.searchParams.set("alternatives", request.allowAlternatives ? "true" : "false");
  url.searchParams.set("annotations", "true");

  const data = await cachedJson(`route:${request.id}:${coords}:${url.search}`, async () => {
    const response = await fetch(url);
    const payload = await response.json();
    if (!response.ok) return { code: "Error", routes: [] };
    return payload;
  });

  if (data.code !== "Ok" || !data.routes?.length) {
    return [];
  }

  return data.routes.map((route) => ({ route, request }));
}

function buildRouteRequests(start, end) {
  const detours = buildDetourPoints(start, end);
  return [
    {
      id: "direct",
      label: "Recommended ride",
      type: "balanced",
      color: "#0f766e",
      points: [start, end],
      allowAlternatives: true,
    },
    {
      id: "twisty-north",
      label: "Twisty backroads",
      type: "twisty",
      color: "#a16207",
      points: [start, detours.left, end],
      allowAlternatives: false,
    },
    {
      id: "offbeat-south",
      label: "Off-beaten-path scout",
      type: "offroad",
      color: "#7c3f12",
      points: [start, detours.right, end],
      allowAlternatives: false,
    },
    {
      id: "state-highway",
      label: "State highway run",
      type: "highway",
      color: "#1d4ed8",
      points: [start, detours.forward, end],
      allowAlternatives: false,
    },
    {
      id: "wide-loop",
      label: "Wide loop alternative",
      type: "twisty",
      color: "#9333ea",
      points: [start, detours.wide, end],
      allowAlternatives: false,
    },
  ];
}

function buildDetourPoints(start, end) {
  const mid = {
    lat: (start.lat + end.lat) / 2,
    lon: (start.lon + end.lon) / 2,
  };
  const dLat = end.lat - start.lat;
  const dLon = end.lon - start.lon;
  const length = Math.hypot(dLat, dLon) || 1;
  const offset = Math.max(0.08, Math.min(1.15, length * 0.34));
  const perpendicular = {
    lat: -dLon / length,
    lon: dLat / length,
  };
  const along = {
    lat: dLat / length,
    lon: dLon / length,
  };

  return {
    left: clampPoint({
      lat: mid.lat + perpendicular.lat * offset,
      lon: mid.lon + perpendicular.lon * offset,
    }),
    right: clampPoint({
      lat: mid.lat - perpendicular.lat * offset,
      lon: mid.lon - perpendicular.lon * offset,
    }),
    forward: clampPoint({
      lat: mid.lat + along.lat * offset * 0.42,
      lon: mid.lon + along.lon * offset * 0.42,
    }),
    wide: clampPoint({
      lat: mid.lat + perpendicular.lat * offset * 1.7,
      lon: mid.lon + perpendicular.lon * offset * 1.7,
    }),
  };
}

function clampPoint(point) {
  return {
    lat: Math.max(-85, Math.min(85, point.lat)),
    lon: Math.max(-180, Math.min(180, point.lon)),
  };
}

function enrichRoute(route, index, request) {
  const steps = route.legs.flatMap((leg) => leg.steps || []);
  const coordinates = route.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
  const bearings = calculateBearingChanges(coordinates);
  const namedRoads = summarizeRoadNames(steps);
  const roadSignals = readRoadSignals(steps);
  const turns = steps.filter((step) => !["depart", "arrive", "continue"].includes(step.maneuver?.type)).length;
  const averageSpeedKph = route.distance > 0 ? (route.distance / 1000) / (route.duration / 3600) : 0;
  const curveScore = Math.min(100, Math.round((bearings.significantChanges / Math.max(route.distance / 1000, 1)) * 18));
  const flowScore = Math.max(0, Math.min(100, Math.round(100 - turns / Math.max(route.distance / 15000, 1) + averageSpeedKph / 5)));
  const backroadScore = Math.max(0, Math.min(100, Math.round(curveScore * 0.45 + (100 - flowScore) * 0.25 + roadSignals.unnamedRatio * 45)));
  const highwayScore = Math.max(0, Math.min(100, Math.round(averageSpeedKph * 0.9 + roadSignals.stateHighwayRatio * 65)));

  return {
    index,
    id: `${request.id}-${index}`,
    label: request.label,
    type: request.type,
    color: request.color,
    signature: routeSignature(route.geometry.coordinates),
    route,
    coordinates,
    steps,
    namedRoads,
    roadSignals,
    turns,
    averageSpeedKph,
    curveScore,
    flowScore,
    backroadScore,
    highwayScore,
    scores: {
      quick: 100000 - route.duration,
      balanced: 100000 - route.duration * 0.72 + curveScore * 180 + flowScore * 80,
      twisty: curveScore * 520 + bearings.totalChange * 0.08 - route.duration * 0.38,
      highway: highwayScore * 900 + flowScore * 160 - route.duration * 0.28,
      offroad: backroadScore * 900 + curveScore * 180 - route.duration * 0.24,
    },
  };
}

function uniqueRoute(option, index, routes) {
  return routes.findIndex((route) => route.signature === option.signature) === index;
}

function routeSignature(coords) {
  if (!coords.length) return "";
  const first = coords[0];
  const mid = coords[Math.floor(coords.length / 2)];
  const last = coords[coords.length - 1];
  return [first, mid, last].map(([lon, lat]) => `${lat.toFixed(2)},${lon.toFixed(2)}`).join("|");
}

function pickBestRoute(routes, style) {
  const best = routes.reduce((bestIndex, route, index) => {
    return route.scores[style] > routes[bestIndex].scores[style] ? index : bestIndex;
  }, 0);
  return best;
}

async function renderRoute(start, end, index) {
  await mapReady;
  selectedRouteIndex = index;
  const selected = routeOptions[index];
  const alternatives = routeOptions
    .filter((_, routeIndex) => routeIndex !== index)
    .map((option) => routeFeature(option, false));

  setMapSource("route-halo", featureCollection([routeFeature(selected, true)]));
  setMapSource("selected-route", featureCollection([routeFeature(selected, true)]));
  setMapSource("selected-route-elevation", emptyFeatureCollection);
  setMapSource("route-base", featureCollection([routeFeature(selected, true)]));
  setMapSource("route-alternatives", featureCollection(alternatives));
  renderMapMarkers(start, end);
  fitMapToRoute(selected.route.geometry.coordinates);

  renderInsights(selected);
  updateElevationMetric(selected);
  renderDirections(selected.steps);
  renderTrailOverlay(selected);
  updateChoiceState();
}

function routeFeature(option, isSelected) {
  return {
    type: "Feature",
    properties: {
      color: option.color,
      selected: isSelected,
    },
    geometry: option.route.geometry,
  };
}

function elevationRouteSegments(profile) {
  if (profile.points.length < 2) return emptyFeatureCollection;
  const elevations = profile.points.map((point) => point.elevation);
  const minElevation = Math.min(...elevations);
  const maxElevation = Math.max(...elevations);
  const range = Math.max(1, maxElevation - minElevation);
  const features = [];

  for (let index = 1; index < profile.points.length; index += 1) {
    const start = profile.points[index - 1];
    const end = profile.points[index];
    const ratio = ((start.elevation + end.elevation) / 2 - minElevation) / range;
    features.push({
      type: "Feature",
      properties: {
        elevationColor: elevationColor(ratio),
      },
      geometry: {
        type: "LineString",
        coordinates: [
          [start.lon, start.lat],
          [end.lon, end.lat],
        ],
      },
    });
  }

  return featureCollection(features);
}

function elevationColor(ratio) {
  if (ratio > 0.78) return "#0b1f5f";
  if (ratio > 0.58) return "#1d4ed8";
  if (ratio > 0.38) return "#2563eb";
  if (ratio > 0.18) return "#3b82f6";
  return "#93c5fd";
}

function featureCollection(features) {
  return {
    type: "FeatureCollection",
    features,
  };
}

function renderRouteChoices() {
  routeChoices.innerHTML = "";
  routeOptions.forEach((option, index) => {
    const button = choiceTemplate.content.firstElementChild.cloneNode(true);
    button.classList.add("visible");
    button.querySelector(".choice-name").innerHTML = `${escapeHtml(routeName(index, option))}<small>${escapeHtml(routeBadge(option))}</small>`;
    button.querySelector(".choice-meta").textContent = `${formatDistance(option.route.distance)} - ${formatDuration(option.route.duration)}`;
    button.addEventListener("click", () => {
      if (!currentStartPlace || !currentEndPlace) return;
      renderRoute(currentStartPlace, currentEndPlace, index);
    });
    routeChoices.append(button);
  });
  updateChoiceState();
}

function updateChoiceState() {
  routeChoices.querySelectorAll(".route-choice").forEach((button, index) => {
    button.classList.toggle("active", index === selectedRouteIndex);
  });
}

function renderInsights(option) {
  const route = option.route;
  const longestStep = option.steps.reduce((longest, step) => (step.distance > longest.distance ? step : longest), { distance: 0 });
  const roadNames = option.namedRoads.slice(0, 2).map((road) => road.name);
  const routeKind = routeBadge(option).toLowerCase();

  metrics.distance.textContent = formatDistance(route.distance);
  metrics.time.textContent = formatDuration(route.duration);
  metrics.turns.textContent = String(option.turns);
  metrics.flow.textContent = flowLabel(option.flowScore);
  metrics.elevation.textContent = "Loading";

  characterText.textContent = `${formatDistance(route.distance)}, ${formatDuration(route.duration).toLowerCase()}. ${routeKind}; twist ${option.curveScore}/100, backroad ${option.backroadScore}/100.`;

  featureList.innerHTML = "";
  [roadNames.length ? `Roads: ${roadNames.join(", ")}.` : "Roads: mostly unnamed/local segments.", `Longest leg: ${formatDistance(longestStep.distance)}${longestStep.name ? ` on ${longestStep.name}` : ""}.`, option.type === "offroad" ? "Trail overlay appears when OSM trail data is nearby." : "Select Trails to scout nearby mapped tracks."].forEach((item) => appendListItem(featureList, item));

  rideChecks.innerHTML = "";
  ["Confirm closures, surface, fuel, daylight, and local motorcycle access.", "Trail overlays are scouting hints, not legal-access guarantees."].forEach((item) => appendListItem(rideChecks, item));
}

function renderDirections(steps) {
  directionsList.innerHTML = "";
  steps
    .filter((step) => step.maneuver?.type !== "arrive")
    .forEach((step) => {
      const instruction = `${maneuverText(step)} ${step.name ? `onto ${step.name}` : ""}`.replace(/\s+/g, " ").trim();
      appendListItem(directionsList, `${instruction} - ${formatDistance(step.distance)}`);
    });
}

async function updateElevationMetric(option) {
  try {
    const profile = await fetchElevationProfile(option.route.geometry.coordinates);
    if (routeOptions[selectedRouteIndex]?.signature !== option.signature) return;
    metrics.elevation.textContent = `+${formatFeet(profile.gainFeet)} / -${formatFeet(profile.lossFeet)}`;
    setMapSource("selected-route-elevation", elevationRouteSegments(profile));
  } catch {
    if (routeOptions[selectedRouteIndex]?.signature === option.signature) {
      metrics.elevation.textContent = "Unavailable";
      setMapSource("selected-route-elevation", emptyFeatureCollection);
    }
  }
}

async function fetchElevationProfile(coordinates) {
  const points = sampleLngLatPoints(coordinates, 80);
  if (points.length < 2) return { gainFeet: 0, lossFeet: 0 };

  const latitudes = points.map(([lon, lat]) => lat.toFixed(5)).join(",");
  const longitudes = points.map(([lon]) => lon.toFixed(5)).join(",");
  const url = new URL("https://api.open-meteo.com/v1/elevation");
  url.searchParams.set("latitude", latitudes);
  url.searchParams.set("longitude", longitudes);

  const data = await cachedJson(`elevation:${normalizeCacheKey(`${latitudes}|${longitudes}`)}`, async () => {
    const response = await fetch(url);
    if (!response.ok) throw new Error("Elevation unavailable.");
    return response.json();
  });

  const rawElevations = Array.isArray(data.elevation) ? data.elevation : [];
  const elevations = rawElevations.filter(Number.isFinite);
  let gainMeters = 0;
  let lossMeters = 0;

  for (let index = 1; index < elevations.length; index += 1) {
    const change = elevations[index] - elevations[index - 1];
    if (change > 0) gainMeters += change;
    if (change < 0) lossMeters += Math.abs(change);
  }

  return {
    gainFeet: gainMeters * 3.28084,
    lossFeet: lossMeters * 3.28084,
    points: points
      .map(([lon, lat], index) => ({
        lon,
        lat,
        elevation: rawElevations[index],
      }))
      .filter((point) => Number.isFinite(point.elevation)),
  };
}

function sampleLngLatPoints(points, count) {
  if (points.length <= count) return points;
  const samples = [];
  for (let index = 0; index < count; index += 1) {
    const pointIndex = Math.round((index * (points.length - 1)) / (count - 1));
    samples.push(points[pointIndex]);
  }
  return samples;
}

async function renderTrailOverlay(option) {
  const requestId = ++trailRequestId;
  await mapReady;
  setMapSource("trail-overlay", emptyFeatureCollection);

  if (option.type !== "offroad") return;

  const samplePoints = sampleRoutePoints(option.coordinates, 3);
  if (!samplePoints.length) return;

  try {
    const features = await fetchTrailFeatures(samplePoints);
    if (requestId !== trailRequestId) return;
    setMapSource("trail-overlay", features);
    if (features.features.length) {
      statusLine.textContent = `${routeOptions.length} route options found. Trail scout overlay shows ${features.features.length} nearby mapped trail segment${features.features.length === 1 ? "" : "s"}.`;
    } else {
      statusLine.textContent = `${routeOptions.length} route options found. No nearby mapped off-road trail segments were returned for this area.`;
    }
  } catch {
    if (requestId === trailRequestId) {
      statusLine.textContent = `${routeOptions.length} route options found. Trail overlay is unavailable right now, but the off-beaten-path route is highlighted.`;
    }
  }
}

async function fetchTrailFeatures(points) {
  const radiusMeters = 22000;
  const aroundQueries = points
    .map(([lat, lon]) => `way(around:${radiusMeters},${lat.toFixed(5)},${lon.toFixed(5)})["highway"~"^(track|path|bridleway|cycleway)$"];`)
    .join("");
  const query = `[out:json][timeout:18];(${aroundQueries});out geom 80;`;
  const url = new URL("https://overpass-api.de/api/interpreter");
  url.searchParams.set("data", query);

  const data = await cachedJson(`trails:${normalizeCacheKey(query)}`, async () => {
    const response = await fetch(url);
    if (!response.ok) throw new Error("Trail data unavailable.");
    return response.json();
  });

  const features = (data.elements || [])
    .filter((element) => element.type === "way" && Array.isArray(element.geometry) && element.geometry.length > 1)
    .map((element) => ({
      type: "Feature",
      properties: {
        name: element.tags?.name || element.tags?.highway || "Mapped trail",
        surface: element.tags?.surface || "unknown",
      },
      geometry: {
        type: "LineString",
        coordinates: element.geometry.map((point) => [point.lon, point.lat]),
      },
    }));

  return {
    type: "FeatureCollection",
    features,
  };
}

function sampleRoutePoints(points, count) {
  if (!points.length) return [];
  if (points.length <= count) return points;
  const samples = [];
  for (let index = 1; index <= count; index += 1) {
    const pointIndex = Math.floor((points.length * index) / (count + 1));
    samples.push(points[pointIndex]);
  }
  return samples;
}

function setupRouteLayers() {
  addGeoJsonSource("route-alternatives");
  addGeoJsonSource("trail-overlay");
  addGeoJsonSource("route-halo");
  addGeoJsonSource("route-base");
  addGeoJsonSource("selected-route");
  addGeoJsonSource("selected-route-elevation", true);

  map.addLayer({
    id: "route-alternatives-line",
    type: "line",
    source: "route-alternatives",
    layout: {
      "line-cap": "round",
      "line-join": "round",
    },
    paint: {
      "line-color": ["coalesce", ["get", "color"], "#b45309"],
      "line-width": 4,
      "line-opacity": 0.42,
      "line-dasharray": [1, 1.8],
    },
  });

  map.addLayer({
    id: "trail-overlay-line",
    type: "line",
    source: "trail-overlay",
    layout: {
      "line-cap": "round",
      "line-join": "round",
    },
    paint: {
      "line-color": "#7c3f12",
      "line-width": 3,
      "line-opacity": 0.76,
      "line-dasharray": [0.6, 1.8],
    },
  });

  map.addLayer({
    id: "route-halo-line",
    type: "line",
    source: "route-halo",
    layout: {
      "line-cap": "round",
      "line-join": "round",
    },
    paint: {
      "line-color": "#ffffff",
      "line-width": 12,
      "line-opacity": 0.92,
    },
  });

  map.addLayer({
    id: "route-base-line",
    type: "line",
    source: "route-base",
    layout: {
      "line-cap": "round",
      "line-join": "round",
    },
    paint: {
      "line-color": ["coalesce", ["get", "color"], "#0f766e"],
      "line-width": 5,
      "line-opacity": 0.62,
    },
  });

  map.addLayer({
    id: "selected-route-blue-line",
    type: "line",
    source: "selected-route",
    layout: {
      "line-cap": "round",
      "line-join": "round",
    },
    paint: {
      "line-color": "#2563eb",
      "line-width": 8,
      "line-opacity": 0.98,
    },
  });

  map.addLayer({
    id: "selected-route-elevation-line",
    type: "line",
    source: "selected-route-elevation",
    layout: {
      "line-cap": "round",
      "line-join": "round",
    },
    paint: {
      "line-color": ["coalesce", ["get", "elevationColor"], "#2563eb"],
      "line-width": 8,
      "line-opacity": 0.98,
    },
  });
}

function addGeoJsonSource(id, lineMetrics = false) {
  if (map.getSource(id)) return;
  map.addSource(id, {
    type: "geojson",
    lineMetrics,
    data: emptyFeatureCollection,
  });
}

function setMapSource(id, data) {
  const source = map.getSource(id);
  if (source) source.setData(data);
}

function renderMapMarkers(start, end) {
  if (startMarker) startMarker.remove();
  if (endMarker) endMarker.remove();

  startMarker = new maplibregl.Marker({ color: "#0f766e" })
    .setLngLat([start.lon, start.lat])
    .setPopup(new maplibregl.Popup().setHTML(`<strong>Start</strong><br>${escapeHtml(shortLabel(start.label))}`))
    .addTo(map);

  endMarker = new maplibregl.Marker({ color: "#b45309" })
    .setLngLat([end.lon, end.lat])
    .setPopup(new maplibregl.Popup().setHTML(`<strong>Destination</strong><br>${escapeHtml(shortLabel(end.label))}`))
    .addTo(map);
}

function fitMapToRoute(coordinates) {
  if (!coordinates.length) return;
  const bounds = coordinates.reduce((routeBounds, coordinate) => routeBounds.extend(coordinate), new maplibregl.LngLatBounds(coordinates[0], coordinates[0]));
  map.fitBounds(bounds, {
    padding: {
      top: 48,
      right: window.innerWidth > 900 ? 470 : 48,
      bottom: window.innerWidth > 900 ? 48 : 360,
      left: 48,
    },
    duration: 650,
  });
}

function calculateBearingChanges(points) {
  let totalChange = 0;
  let significantChanges = 0;

  for (let index = 2; index < points.length; index += 4) {
    const previous = bearing(points[index - 2], points[index - 1]);
    const next = bearing(points[index - 1], points[index]);
    const change = Math.abs(((next - previous + 540) % 360) - 180);
    totalChange += change;
    if (change > 18) significantChanges += 1;
  }

  return { totalChange, significantChanges };
}

function bearing([lat1, lon1], [lat2, lon2]) {
  const toRad = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * toRad) * Math.cos(lat2 * toRad);
  const x =
    Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad) -
    Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos((lon2 - lon1) * toRad);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function summarizeRoadNames(steps) {
  const counts = new Map();
  steps.forEach((step) => {
    const name = step.name || step.ref;
    if (!name) return;
    const current = counts.get(name) || { name, distance: 0 };
    current.distance += step.distance;
    counts.set(name, current);
  });
  return [...counts.values()].sort((a, b) => b.distance - a.distance);
}

function readRoadSignals(steps) {
  const totalDistance = steps.reduce((sum, step) => sum + (step.distance || 0), 0) || 1;
  const stateHighwayPatterns = /\b(SH|SR|S\.H\.|State Highway|State Hwy|State Route)\b/i;
  const stateHighwayDistance = steps.reduce((sum, step) => {
    const road = `${step.name || ""} ${step.ref || ""}`;
    return sum + (stateHighwayPatterns.test(road) ? step.distance || 0 : 0);
  }, 0);
  const unnamedDistance = steps.reduce((sum, step) => {
    return sum + (!step.name && !step.ref ? step.distance || 0 : 0);
  }, 0);

  return {
    stateHighwayRatio: stateHighwayDistance / totalDistance,
    unnamedRatio: unnamedDistance / totalDistance,
  };
}

function maneuverText(step) {
  const type = step.maneuver?.type || "continue";
  const modifier = step.maneuver?.modifier || "";
  const labels = {
    depart: "Start",
    turn: `Turn ${modifier}`,
    "new name": "Continue",
    continue: "Continue",
    merge: `Merge ${modifier}`,
    ramp: `Take the ramp ${modifier}`,
    fork: `Keep ${modifier}`,
    "end of road": `At the end of the road, go ${modifier}`,
    roundabout: "Enter the roundabout",
    rotary: "Enter the rotary",
    notification: "Continue",
  };
  return labels[type] || type.replaceAll("-", " ");
}

function routeName(index, option) {
  if (index === 0) return option.label || "Recommended ride";
  if (option.type === "highway") return "State highway run";
  if (option.type === "offroad") return "Trail scout route";
  if (option.label) return option.label;
  if (option.curveScore > 45) return "Twistier alternative";
  if (option.flowScore > 72) return "Smoother alternative";
  return `Alternative ${index + 1}`;
}

function routeBadge(option) {
  if (option.type === "highway") return `State hwy ${Math.round(option.highwayScore)}/100`;
  if (option.type === "offroad") return `Backroad ${Math.round(option.backroadScore)}/100`;
  if (option.type === "twisty") return `Twist ${Math.round(option.curveScore)}/100`;
  if (option.type === "balanced") return "Balanced open-road option";
  return "Route option";
}

function flowLabel(score) {
  if (score >= 76) return "Fast";
  if (score >= 54) return "Steady";
  if (score >= 34) return "Technical";
  return "Complex";
}

function formatDistance(meters) {
  if (!Number.isFinite(meters)) return "--";
  const km = meters / 1000;
  return km >= 10 ? `${Math.round(km)} km` : `${km.toFixed(1)} km`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "--";
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  if (!hours) return `${remaining} min`;
  return remaining ? `${hours} hr ${remaining} min` : `${hours} hr`;
}

function formatFeet(value) {
  if (!Number.isFinite(value)) return "--";
  return `${Math.round(value).toLocaleString("en-US")} ft`;
}

function appendListItem(list, text) {
  const item = document.createElement("li");
  item.textContent = text;
  list.append(item);
}

function saveDestinationPair(start, end) {
  const pair = {
    start,
    end,
    savedAt: Date.now(),
  };
  const existing = readHistory().filter((item) => normalizeCacheKey(`${item.start}|${item.end}`) !== normalizeCacheKey(`${start}|${end}`));
  localStorage.setItem(HISTORY_KEY, JSON.stringify([pair, ...existing].slice(0, 8)));
  renderSavedDestinations();
}

function readHistory() {
  try {
    const history = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    return Array.isArray(history) ? history.filter((item) => item?.start && item?.end) : [];
  } catch {
    return [];
  }
}

function renderSavedDestinations() {
  const history = readHistory();
  const locations = [...new Set(history.flatMap((item) => [item.start, item.end]))].slice(0, 12);
  locationHistory.innerHTML = "";
  locations.forEach((location) => {
    const option = document.createElement("option");
    option.value = location;
    locationHistory.append(option);
  });

  recentRoutes.innerHTML = "";
  history.slice(0, 4).forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "recent-route";
    button.textContent = `${shortInput(item.start)} to ${shortInput(item.end)}`;
    button.title = `${item.start} to ${item.end}`;
    button.addEventListener("click", () => {
      startInput.value = item.start;
      endInput.value = item.end;
    });
    recentRoutes.append(button);
  });

  if (!history.length) {
    const empty = document.createElement("span");
    empty.className = "recent-empty";
    empty.textContent = "No saved routes yet";
    recentRoutes.append(empty);
  }
}

async function cachedJson(key, fetcher) {
  const storageKey = `${CACHE_KEY_PREFIX}${key}`;
  const cached = readCachedJson(storageKey);
  if (cached) return cached;

  const value = await fetcher();
  try {
    localStorage.setItem(storageKey, JSON.stringify({ savedAt: Date.now(), value }));
  } catch {
    pruneAppCache();
    try {
      localStorage.setItem(storageKey, JSON.stringify({ savedAt: Date.now(), value }));
    } catch {
      // Storage can be full or disabled. The app still works without this cache.
    }
  }
  return value;
}

function readCachedJson(storageKey) {
  try {
    const entry = JSON.parse(localStorage.getItem(storageKey) || "null");
    if (!entry || Date.now() - entry.savedAt > CACHE_TTL) {
      localStorage.removeItem(storageKey);
      return null;
    }
    return entry.value;
  } catch {
    localStorage.removeItem(storageKey);
    return null;
  }
}

function pruneAppCache() {
  Object.keys(localStorage)
    .filter((key) => key.startsWith(CACHE_KEY_PREFIX))
    .slice(0, 20)
    .forEach((key) => localStorage.removeItem(key));
}

function normalizeCacheKey(value) {
  return String(value).trim().toLowerCase().replace(/\s+/g, " ").slice(0, 220);
}

function shortInput(value) {
  const text = String(value).trim();
  return text.length > 28 ? `${text.slice(0, 27)}...` : text;
}

function createCompassControl() {
  return {
    onAdd(controlMap) {
      const container = document.createElement("div");
      container.className = "maplibregl-ctrl compass";
      container.setAttribute("aria-label", "Map compass");
      container.title = "North";
      container.innerHTML = "<span>N</span><i></i>";
      controlMap.__motorouteCompass = container;
      updateCompass();
      return container;
    },
    onRemove(controlMap) {
      if (controlMap.__motorouteCompass?.parentNode) {
        controlMap.__motorouteCompass.parentNode.removeChild(controlMap.__motorouteCompass);
      }
      controlMap.__motorouteCompass = null;
    },
  };
}

function updateCompass() {
  const compassControl = map.__motorouteCompass;
  if (!compassControl) return;
  const bearing = map.getBearing ? map.getBearing() : 0;
  compassControl.querySelector("i").style.transform = `rotate(${-bearing}deg)`;
}

function registerMapCache() {
  if (!("serviceWorker" in navigator) || location.protocol === "file:") return;
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

async function clearRoute() {
  await mapReady;
  setMapSource("route-halo", emptyFeatureCollection);
  setMapSource("route-base", emptyFeatureCollection);
  setMapSource("selected-route", emptyFeatureCollection);
  setMapSource("selected-route-elevation", emptyFeatureCollection);
  setMapSource("route-alternatives", emptyFeatureCollection);
  setMapSource("trail-overlay", emptyFeatureCollection);
  if (startMarker) startMarker.remove();
  if (endMarker) endMarker.remove();
  startMarker = null;
  endMarker = null;
  routeChoices.innerHTML = "";
  routeOptions = [];
  currentStartPlace = null;
  currentEndPlace = null;
  trailRequestId += 1;
  metrics.distance.textContent = "--";
  metrics.time.textContent = "--";
  metrics.turns.textContent = "--";
  metrics.flow.textContent = "--";
  metrics.elevation.textContent = "--";
  characterText.textContent = "Your route summary will appear here after planning.";
  featureList.innerHTML = "<li>Search with open map data, then compare route alternatives.</li>";
  rideChecks.innerHTML = "<li>Review local road rules, weather, fuel range, and daylight before riding.</li>";
  directionsList.innerHTML = "<li>Directions will appear after a route is built.</li>";
}

function setLoading(isLoading, message) {
  form.querySelector(".primary-action").disabled = isLoading;
  if (message) statusLine.textContent = message;
}

function shortLabel(label) {
  return label.split(",").slice(0, 3).join(",");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
