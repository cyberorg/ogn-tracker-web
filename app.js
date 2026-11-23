(() => {
'use strict';
const BIR = [32.037, 76.708];
const PINNED_STORAGE_KEY = 'ogn_pinned_aircraft';
const MENU_PREFS_STORAGE_KEY = 'ogn_menu_prefs';
const ALERTS_24H_STORAGE_KEY = 'ogn_alerts_24h';
const NAME_CACHE_STORAGE_KEY = 'ogn_name_cache';
const NAME_CACHE_MAX = 1000;
const WX_CACHE_TTL_MS = 30 * 60 * 1000;
const ALERT_24H_TTL_MS = 24 * 60 * 60 * 1000;
const OFFLINE_THRESHOLD_SEC = 180;
const MIN_VALID_TEMP_C = -50;
const MAX_VALID_TEMP_C = 55;
const TRACK_COLORS = ['#38bdf8','#f97316','#a855f7','#22c55e','#f43f5e','#eab308','#ec4899','#14b8a6','#818cf8','#84cc16'];

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cleanName = s => {
  const raw = String(s ?? '');
  if (!raw || /[\u0000-\u001F\u007F-\u009F\uFFFD]/.test(raw) || /[\u2400-\u243F]/.test(raw)) return '';
  return raw.replace(/\s+/g, ' ').trim();
};
const extractStreamName = raw => {
  const m = String(raw ?? '').match(/Name="([^"]*)"/);
  return m ? cleanName(m[1]) : '';
};
const cleanAlertStatus = s => {
  const raw = String(s ?? '').trim();
  const colon = raw.indexOf(':');
  return (colon === -1 ? raw : raw.slice(0, colon)).trim();
};

// Persistent menu preferences across reloads & reconnects
let altUnit = 'm';
let speedUnit = 'kmh';
let tempUnit = 'c';
let climbUnit = 'mps';
let alertsEnabled = false;
let savedTypes = ['para', 'wx'];
let savedMarkerWindow = '900';
let savedTrackWindow = '900';
let savedVarioTrackMode = false;
let savedBaroEnabled = false;
let savedBaseLayer = 'terrain';
let savedOverlays = [];
let applyingSavedLayers = false;
let baroEnabled = false;
let collectorPaused = false;
let lastFetchOkAtMs = 0;
let lastFetchAttemptAtMs = 0;
let lastStatusKind = 'connecting';
let lastStatusText = 'Connecting…';
let hashLookupMessageUntilMs = 0;
let hashMessagePopup = null;

try {
  const prefs = JSON.parse(localStorage.getItem(MENU_PREFS_STORAGE_KEY) || '{}');
  if (prefs.altUnit === 'ft') altUnit = 'ft';
  if (prefs.speedUnit === 'kt' || prefs.speedUnit === 'mph') speedUnit = prefs.speedUnit;
  if (prefs.tempUnit === 'f') tempUnit = 'f';
  // Old Imperial preferences used fps; the Aviation/US presets now use fpm.
  if (prefs.climbUnit === 'fps' || prefs.climbUnit === 'fpm') climbUnit = 'fpm';
  if (typeof prefs.alertsEnabled === 'boolean') alertsEnabled = prefs.alertsEnabled;
  if (Array.isArray(prefs.types) && prefs.types.length > 0) savedTypes = prefs.types;
  if (typeof prefs.markerWindow === 'string' && prefs.markerWindow) savedMarkerWindow = prefs.markerWindow;
  if (typeof prefs.trackWindow === 'string' && prefs.trackWindow) savedTrackWindow = prefs.trackWindow;
  if (typeof prefs.varioTrackMode === 'boolean') savedVarioTrackMode = prefs.varioTrackMode;
  if (typeof prefs.baroEnabled === 'boolean') {
    savedBaroEnabled = prefs.baroEnabled;
    baroEnabled = prefs.baroEnabled;
  }
  if (typeof prefs.baseLayer === 'string' && prefs.baseLayer) savedBaseLayer = prefs.baseLayer;
  if (Array.isArray(prefs.overlays)) savedOverlays = prefs.overlays.filter(v => typeof v === 'string');
} catch (e) {}

function getCurrentTypesArray() {
  const boxes = [...$('type').querySelectorAll('input[type="checkbox"]')];
  const allBox = boxes.find(b => b.value === 'all');
  if (allBox && allBox.checked) return ['all'];
  const chosen = boxes.filter(b => b.value !== 'all' && b.checked).map(b => b.value);
  return chosen.length > 0 ? chosen : ['all'];
}

function isDefaultFilterState() {
  const activeTypes = getCurrentTypesArray();
  const searchQ = $('search') ? $('search').value.trim() : '';
  const defaultTypes = ['para', 'wx'];
  const typesMatch = activeTypes.length === defaultTypes.length && defaultTypes.every(t => activeTypes.includes(t));
  return typesMatch &&
    !searchQ &&
    $('markerWindow').value === '900' &&
    $('trackWindow').value === '900' &&
    !varioTrackMode &&
    !baroEnabled &&
    isMetricPreset();
}

function updateFilterBadge() {
  $('mapFilterToggle').classList.toggle('has-badge', !isDefaultFilterState());
}

function updateSearchUi() {
  const has = $('search').value.trim().length > 0;
  $('btnClearSearch').hidden = !has;
  updateFilterBadge();
}

function saveMenuPrefs() {
  const layers = currentLayerSelection();
  savedBaseLayer = layers.baseLayer;
  savedOverlays = layers.overlays;
  try {
    localStorage.setItem(MENU_PREFS_STORAGE_KEY, JSON.stringify({
      altUnit,
      speedUnit,
      tempUnit,
      climbUnit,
      alertsEnabled,
      types: getCurrentTypesArray(),
      markerWindow: $('markerWindow').value,
      trackWindow: $('trackWindow').value,
      varioTrackMode,
      baroEnabled,
      baseLayer: savedBaseLayer,
      overlays: savedOverlays
    }));
  } catch (e) {}
  updateFilterBadge();
}

function applySavedMenuPrefs() {
  const boxes = [...$('type').querySelectorAll('input[type="checkbox"]')];
  const validValues = new Set(boxes.map(b => b.value));
  const targetTypes = savedTypes.filter(v => validValues.has(v));
  const useAll = targetTypes.length === 0 || targetTypes.includes('all');
  boxes.forEach(b => {
    if (b.value === 'all') b.checked = useAll;
    else b.checked = !useAll && targetTypes.includes(b.value);
  });

  if ([...$('markerWindow').options].some(o => o.value === savedMarkerWindow)) {
    $('markerWindow').value = savedMarkerWindow;
  }
  if ([...$('trackWindow').options].some(o => o.value === savedTrackWindow)) {
    $('trackWindow').value = savedTrackWindow;
  }

  $('btnNotify').classList.toggle('active', alertsEnabled);
  $('btnNotify').textContent = alertsEnabled ? '🔔 ON' : '🔔 OFF';
  $('btnNotify').setAttribute('aria-pressed', String(alertsEnabled));
  varioTrackMode = savedVarioTrackMode;
  syncTrackModeButtons();
  baroEnabled = savedBaroEnabled;
  syncBaroButton();
  updateSearchUi();
  updateFilterBadge();
}

function resetFilters() {
  $('search').value = '';
  savedTypes = ['para', 'wx'];
  savedMarkerWindow = '900';
  savedTrackWindow = '900';
  savedVarioTrackMode = false;
  savedBaroEnabled = false;
  baroEnabled = false;
  altUnit = 'm'; speedUnit = 'kmh'; tempUnit = 'c'; climbUnit = 'mps';
  applySavedMenuPrefs();
  redrawAllTracks();
  saveMenuPrefs();
  syncUnitButtons();
  $('listHint').textContent = '';
  needMeta = true;
  render();
  fetchLive(true);
  showToast('Filters reset');
}

function fitToResults() {
  const visible = filtered();
  const pts = visible.filter(a => Number.isFinite(a.lat) && Number.isFinite(a.lon)).map(a => [a.lat, a.lon]);
  if (!pts.length) {
    showToast('No visible results to fit');
    return;
  }
  if (pts.length === 1) {
    map.setView(pts[0], Math.max(map.getZoom(), 12));
  } else {
    const bounds = L.latLngBounds(pts);
    map.fitBounds(bounds.pad(0.15), { maxZoom: 13 });
  }
}

function isMetricPreset() {
  return altUnit === 'm' && speedUnit === 'kmh' && tempUnit === 'c' && climbUnit === 'mps';
}

function isAviationPreset() {
  return altUnit === 'ft' && speedUnit === 'kt' && tempUnit === 'f' && climbUnit === 'fpm';
}

function isUsPreset() {
  return altUnit === 'ft' && speedUnit === 'mph' && tempUnit === 'f' && climbUnit === 'fpm';
}

function useImperialDistanceUnits() {
  return isAviationPreset() || isUsPreset() || altUnit === 'ft' || speedUnit === 'kt' || speedUnit === 'mph';
}

function fmtAltValue(meters) {
  if (meters == null) return '';
  if (altUnit === 'ft') return `${Math.round(meters * 3.28084).toLocaleString()} ft`;
  return `${Math.round(meters).toLocaleString()} m`;
}
const fmtAlt = v => fmtAltValue(v);
function fmtAltCompact(meters) {
  if (meters == null) return '';
  if (altUnit === 'ft') return `${Math.round(meters * 3.28084)}ft`;
  return `${Math.round(meters)}m`;
}

function fmtWindSpeed(kmh) {
  if (kmh == null) return '';
  if (speedUnit === 'kt') return `${Math.round(kmh * 0.539957)} kt`;
  if (speedUnit === 'mph') return `${Math.round(kmh * 0.621371)} mph`;
  return `${Math.round(kmh)} km/h`;
}

function fmtDistanceKm(km) {
  if (km == null || !Number.isFinite(km)) return '';
  if (useImperialDistanceUnits()) return `${(km * 0.621371).toFixed(1)} mi`;
  return `${km.toFixed(1)} km`;
}

function fmtTemp(c) {
  if (c == null || c < MIN_VALID_TEMP_C || c > MAX_VALID_TEMP_C) return '';
  if (tempUnit === 'f') return `${Math.round((c * 9 / 5) + 32)}°F`;
  return `${Math.round(c)}°C`;
}

function fmtClimb(mps) {
  if (mps == null) return '';
  if (climbUnit === 'fpm') return `${Math.round(mps * 196.850394).toLocaleString()} fpm`;
  return `${Number(mps).toFixed(1)} m/s`;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function distMeters(lat1, lon1, lat2, lon2) {
  return haversineKm(lat1, lon1, lat2, lon2) * 1000;
}

let initialCenter = BIR, initialZoom = 11, pendingHashSelect = null, hashSelectAddress = null;
if (location.hash.length > 1) {
  const parts = location.hash.slice(1).split(',');
  const lat = parseFloat(parts[0]), lon = parseFloat(parts[1]), z = parseInt(parts[2], 10);
  if (Number.isFinite(lat) && Number.isFinite(lon) && Number.isFinite(z)) {
    initialCenter = [lat, lon];
    initialZoom = Math.max(2, Math.min(18, z));
    if (parts[3]) {
      pendingHashSelect = decodeURIComponent(parts[3]).toLowerCase();
      hashSelectAddress = pendingHashSelect;
    }
  }
}

const terrainLayer = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
  maxNativeZoom: 17, maxZoom: 19,
  attribution: 'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> | Map style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a>'
});
const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 19, attribution: 'Tiles &copy; Esri'
});
const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
});

const map = L.map('map', { zoomControl: false, layers: [terrainLayer] }).setView(initialCenter, initialZoom);
L.control.zoom({ position: 'bottomleft' }).addTo(map);

const FullscreenControl = L.Control.extend({
  options: { position: 'topright' },
  onAdd: function () {
    const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control-fullscreen');
    const button = L.DomUtil.create('button', 'leaflet-control-fullscreen-btn', container);
    button.type = 'button';
    button.textContent = '⤢';
    button.setAttribute('aria-label', 'Maximize map');
    button.title = 'Maximize map';
    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.on(button, 'click', event => {
      L.DomEvent.preventDefault(event);
      toggleMapFullscreen();
    });
    this._button = button;
    return container;
  }
});

function mapIsFullscreen() {
  return document.fullscreenElement === $('mapWrap') || $('mapWrap').classList.contains('map-fullscreen');
}

function exitMapFullscreen() {
  const wrap = $('mapWrap');
  if (!mapIsFullscreen()) return Promise.resolve();
  if (document.fullscreenElement === wrap) return document.exitFullscreen();
  wrap.classList.remove('map-fullscreen');
  syncMapFullscreenUi();
  return Promise.resolve();
}

function toggleMapFullscreen() {
  const wrap = $('mapWrap');
  if (mapIsFullscreen()) {
    exitMapFullscreen();
  } else if (wrap.requestFullscreen) {
    wrap.requestFullscreen().catch(() => {
      wrap.classList.add('map-fullscreen');
      syncMapFullscreenUi();
    });
  } else {
    wrap.classList.add('map-fullscreen');
    syncMapFullscreenUi();
  }
}

function syncMapFullscreenUi() {
  const button = mapFullscreenControl?._button;
  if (!button) return;
  const active = mapIsFullscreen();
  button.textContent = active ? '⤡' : '⤢';
  button.setAttribute('aria-label', active ? 'Restore map' : 'Maximize map');
  button.title = active ? 'Restore map' : 'Maximize map';
  button.setAttribute('aria-pressed', String(active));
  requestAnimationFrame(() => map.invalidateSize());
}

const mapFullscreenControl = new FullscreenControl().addTo(map);
document.addEventListener('fullscreenchange', syncMapFullscreenUi);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && $('mapWrap').classList.contains('map-fullscreen')) {
    toggleMapFullscreen();
  }
});
syncMapFullscreenUi();

raisePopupPane();

let lastBottomBarSpace = -1;
let emergencyBannerDismissedSig = null;

function syncBottomBarOffset() {
  const wrap = $('mapWrap');
  const bar = visibleBottomBarEl();
  const hasBar = !!bar;
  wrap.classList.toggle('has-bottom-bar', hasBar);

  // On mobile the replay bar floats over the map; shrinking the map would leave a dark
  // empty band between the map and the aircraft sidebar. Only shrink on desktop.
  const overlayBar = window.matchMedia('(max-width:800px)').matches;
  let space = 0;
  if (hasBar && !overlayBar) {
    const wrapRect = wrap.getBoundingClientRect();
    const barRect = bar.getBoundingClientRect();
    space = Math.max(0, Math.ceil(wrapRect.bottom - barRect.top + 8));
  }

  const spaceChanged = space !== lastBottomBarSpace;
  if (spaceChanged) {
    wrap.style.setProperty('--bottom-bar-space', `${space}px`);
    lastBottomBarSpace = space;
  }

  const mapRect = $('map').getBoundingClientRect();
  if (hasBar) {
    // Cap popup content to the shortened map, leaving room for wrapper/tip.
    wrap.style.setProperty('--popup-max-h', `${Math.max(0, Math.floor(mapRect.height - 44))}px`);
  } else {
    wrap.style.removeProperty('--popup-max-h');
  }

  requestAnimationFrame(() => {
    if (spaceChanged) map.invalidateSize({ pan: false, animate: false });
    keepPopupAboveBottomBar();
  });
}

function syncUnitButtons() {
  $('presetMetricBtn').classList.toggle('active', isMetricPreset());
  $('presetAviationBtn').classList.toggle('active', isAviationPreset());
  $('presetUsBtn').classList.toggle('active', isUsPreset());
  $('unitAltBtn').textContent = `Alt: ${altUnit === 'ft' ? 'ft' : 'm'}`;
  $('unitSpeedBtn').textContent = `Speed: ${speedUnit === 'kt' ? 'kt' : speedUnit === 'mph' ? 'mph' : 'km/h'}`;
  $('unitTempBtn').textContent = `Temp: ${tempUnit === 'f' ? '°F' : '°C'}`;
  $('unitClimbBtn').textContent = `Vario: ${climbUnit === 'fpm' ? 'fpm' : 'm/s'}`;
  syncVarioLegend();
  updateFilterBadge();
  syncScaleControl();
}

function applyUnitPreset(mode) {
  if (mode === 'aviation') {
    altUnit = 'ft'; speedUnit = 'kt'; tempUnit = 'f'; climbUnit = 'fpm';
  } else if (mode === 'us') {
    altUnit = 'ft'; speedUnit = 'mph'; tempUnit = 'f'; climbUnit = 'fpm';
  } else {
    altUnit = 'm'; speedUnit = 'kmh'; tempUnit = 'c'; climbUnit = 'mps';
  }
  saveMenuPrefs();
  syncUnitButtons();
  render();
}

map.on('zoomend moveend resize', updateMarkerLabels);
map.on('zoomend resize', () => keepPopupAboveBottomBar());
map.on('move zoom zoomanim resize zoomend viewreset', syncRaisedPopupPane);
window.addEventListener('resize', syncBottomBarOffset);
// Tracker markers center themselves via centerPopupInView(); keep all other popups clear of the bottom bar.
map.on('popupopen', e => {
  if (e.popup?._source?._trackerMarker) return;
  requestAnimationFrame(() => keepPopupAboveBottomBar(e.popup.getElement()));
});

const thermalLayer = L.heatLayer([], { radius: 18, blur: 14, maxZoom: 14, gradient: {0.2:'#38bdf8', 0.5:'#f5c451', 0.8:'#f97316', 1.0:'#ef4444'} });
const coverageLayer = L.layerGroup();
const airspaceLayer = L.geoJSON(null, {
  style: { color: '#f5c451', weight: 2, fillOpacity: 0.12 },
  onEachFeature: (f, l) => {
    if (f.properties && (f.properties.name || f.properties.title)) {
      l.bindPopup(`<b>${esc(f.properties.name || f.properties.title)}</b>`);
    }
  }
});

const baseMaps = { "Terrain (OpenTopoMap)": terrainLayer, "Satellite (Esri)": satelliteLayer, "Standard (OSM)": osmLayer };
const overlayMaps = { "Thermals (Today)": thermalLayer, "RF Coverage (SNR)": coverageLayer, "Airspace / Hazards": airspaceLayer };
const layersControl = L.control.layers(baseMaps, overlayMaps, { position: 'bottomright' }).addTo(map);

let scaleControl = null;
let scaleControlImperial = null;

function reorderBottomRightControls() {
  const scaleEl = scaleControl?.getContainer();
  const layersEl = layersControl.getContainer();
  const corner = layersEl?.parentElement;
  if (!corner || !scaleEl) return;

  const attributionEl = corner.querySelector('.leaflet-control-attribution');
  if (attributionEl) {
    // Leaflet adds attribution first; reorder to Layers → scale → attribution.
    corner.insertBefore(layersEl, attributionEl);
    corner.insertBefore(scaleEl, attributionEl);
  } else {
    corner.appendChild(scaleEl);
  }
}

function syncScaleControl() {
  const useImperial = useImperialDistanceUnits();
  if (scaleControl && scaleControlImperial === useImperial) return;
  if (scaleControl) map.removeControl(scaleControl);

  scaleControl = L.control.scale({
    position: 'bottomright',
    metric: !useImperial,
    imperial: useImperial,
    maxWidth: 100,
    imperialMaxWidth: 100
  }).addTo(map);
  scaleControlImperial = useImperial;
  reorderBottomRightControls();
}

const BASE_LAYER_KEYS = { terrain: terrainLayer, satellite: satelliteLayer, osm: osmLayer };
const OVERLAY_KEYS = { thermals: thermalLayer, coverage: coverageLayer, airspace: airspaceLayer };

function currentLayerSelection() {
  const baseLayer = Object.keys(BASE_LAYER_KEYS).find(key => map.hasLayer(BASE_LAYER_KEYS[key])) || 'terrain';
  const overlays = Object.keys(OVERLAY_KEYS).filter(key => map.hasLayer(OVERLAY_KEYS[key]));
  return { baseLayer, overlays };
}

function applySavedLayers() {
  applyingSavedLayers = true;
  try {
    const baseKey = BASE_LAYER_KEYS[savedBaseLayer] ? savedBaseLayer : 'terrain';
    for (const [key, layer] of Object.entries(BASE_LAYER_KEYS)) {
      if (key === baseKey) {
        if (!map.hasLayer(layer)) map.addLayer(layer);
      } else if (map.hasLayer(layer)) {
        map.removeLayer(layer);
      }
    }

    const wanted = new Set(savedOverlays);
    for (const [key, layer] of Object.entries(OVERLAY_KEYS)) {
      const has = map.hasLayer(layer);
      if (wanted.has(key) && !has) map.addLayer(layer);
      else if (!wanted.has(key) && has) map.removeLayer(layer);
    }
  } finally {
    applyingSavedLayers = false;
  }
}

map.on('baselayerchange overlayadd overlayremove', () => {
  if (!applyingSavedLayers) saveMenuPrefs();
});

const clusterGroup = L.markerClusterGroup({
  maxClusterRadius: 35, spiderfyOnMaxZoom: true, showCoverageOnHover: false, zoomToBoundsOnClick: true, spiderfyDistanceMultiplier: 1.5,
  iconCreateFunction: cluster => L.divIcon({ html: `<div>${cluster.getChildCount()}</div>`, className: 'ogn-cluster', iconSize: L.point(34, 34) })
}).addTo(map);
const emergencyGroup = L.layerGroup().addTo(map);
const replayGroup = L.layerGroup();
const replayTrackGroup = L.layerGroup();

let isSpiderfied = false;
clusterGroup.on('spiderfied', () => { isSpiderfied = true; });
clusterGroup.on('unspiderfied', () => { isSpiderfied = false; render(); });

const markers = new Map();
let aircraft = [];
let fetching = false;
let wasDisconnected = false;
let liveFailures = 0;
let serverClockOffsetMs = 0;
let userLocationMarker = null;
let needMeta = true;
let lastNameUpdated = 0;
let lastMetaBounds = null;
const knownIds = new Set();

let followedAddress = null;
let varioTrackMode = savedVarioTrackMode;
let activeTrackAddress = null;
const lastPinnedStatus = new Map();
const alerts24hHistory = new Map();
let replayActive = false, replayTimer = null;
let replayFollowAddress = null;
let replayPoints = [];
let replayTrackPoints = [];
let replayTrackSegments = [];   // Distinct flights: [{startTs, endTs, points}]
let replayTrackPromise = null;
const REPLAY_TRACK_GAP_S = 600; // No fixes for 10 minutes starts a new track
const compactReplayUi = () => window.matchMedia('(max-width:800px)').matches;
let replayOnlyFocus = false;
let replayDirection = 1;
let replaySpeedValue = 1;
const REPLAY_RANGE_LABELS = ['15m', '1h', '6h', 'Today'];
const REPLAY_RANGE_TITLES = ['Last 15 minutes', 'Last hour', 'Last 6 hours', 'Today (from midnight)'];
const REPLAY_RANGE_MINUTES = [15, 60, 360];
let replayRangeIndex = REPLAY_RANGE_LABELS.length - 1;
let replayTsMs = 0;
let replayLastTickMs = 0;
let lastReplaySliceMinute = null;

try {
  const savedAlerts = JSON.parse(localStorage.getItem(ALERTS_24H_STORAGE_KEY) || '[]');
  const nowInit = Date.now();
  if (Array.isArray(savedAlerts)) {
    for (const item of savedAlerts) {
      if (item && item.address && item.status && Number.isFinite(Number(item.tsMs))) {
        if ((nowInit - Number(item.tsMs)) <= ALERT_24H_TTL_MS && !/^need a ride/i.test(String(item.status))) {
          alerts24hHistory.set(String(item.address).toLowerCase(), {
            address: String(item.address).toLowerCase(),
            name: String(item.name || item.address).toUpperCase(),
            status: cleanAlertStatus(item.status),
            lastStatus: cleanAlertStatus(item.lastStatus || item.status),
            lat: Number.isFinite(Number(item.lat)) ? Number(item.lat) : null,
            lon: Number.isFinite(Number(item.lon)) ? Number(item.lon) : null,
            raw: String(item.raw || ''),
            tsMs: Number(item.tsMs),
            latestTsMs: Number.isFinite(Number(item.latestTsMs)) ? Number(item.latestTsMs) : Number(item.tsMs),
            normalAfter: Boolean(item.normalAfter),
            alertStillOn: Boolean(item.alertStillOn)
          });
        }
      }
    }
  }
} catch (e) {}

function save24hAlerts(nowMs) {
  try {
    const pruned = [...alerts24hHistory.values()]
      .filter(item => (nowMs - item.tsMs) <= ALERT_24H_TTL_MS && !/^need a ride/i.test(String(item.status)))
      .sort((a, b) => b.tsMs - a.tsMs)
      .slice(0, 100);
    localStorage.setItem(ALERTS_24H_STORAGE_KEY, JSON.stringify(pruned));
  } catch (e) {}
}

const pinnedAircraft = new Set();
try {
  const savedPins = JSON.parse(localStorage.getItem(PINNED_STORAGE_KEY) || '[]');
  if (Array.isArray(savedPins)) savedPins.forEach(id => { if (typeof id === 'string' && id) pinnedAircraft.add(id.toLowerCase()); });
} catch (e) {}

function savePinnedAircraft() {
  try { localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify([...pinnedAircraft])); } catch (e) {}
}

function togglePin(address) {
  if (pinnedAircraft.has(address)) pinnedAircraft.delete(address);
  else pinnedAircraft.add(address);
  savePinnedAircraft();
  render();
  requestAnimationFrame(() => focusListRow(address));
}

const selectedTracks = new Map();
let trackReqSeq = 0, colorSeq = 0;

const ddbCache = new Map();
const aprsCache = new Map();
const lastKnownCache = new Map();
const telemetryCache = new Map();
const parsedLineCache = new Map();
const nameCache = new Map();
try {
  const savedNames = JSON.parse(localStorage.getItem(NAME_CACHE_STORAGE_KEY) || '{}');
  if (savedNames && typeof savedNames === 'object' && !Array.isArray(savedNames)) {
    for (const [id, name] of Object.entries(savedNames)) {
      const clean = cleanName(name);
      const key = String(id || '').trim().toLowerCase();
      if (key && clean) nameCache.set(key, clean);
    }
  }
} catch (e) {}

function saveNameCache() {
  try {
    const entries = [...nameCache.entries()]
      .filter(([id, name]) => id && cleanName(name))
      .slice(-NAME_CACHE_MAX);
    localStorage.setItem(NAME_CACHE_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch (e) {}
}

const lastAltCache = new Map();
const lastClimbCache = new Map();
const wxCache = new Map();
const stationStatsCache = new Map();

const serverNow = () => Date.now() + serverClockOffsetMs;

function fmtAge(sec) {
  if (sec < 60) return `${sec}s ago`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM > 0 ? `${h}h ${remM}m ago` : `${h}h ago`;
}

function updateStatusUpdated() {
  const el = $('statusUpdated');
  if (!el) return;
  if (!lastFetchOkAtMs) {
    el.textContent = '';
    return;
  }
  const sec = Math.max(0, Math.floor((Date.now() - lastFetchOkAtMs) / 1000));
  el.textContent = `· updated ${sec < 60 ? `${sec}s` : fmtAge(sec).replace(' ago', '')} ago`;
}

function setStatus(kind, text) {
  lastStatusKind = kind;
  lastStatusText = text;
  $('statusDot').className = 'dot ' + kind;
  $('statusText').textContent = text;
  updateStatusUpdated();
}

function showToast(msg, durationMs = 1800) {
  let t = document.getElementById('appToast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'appToast';
    t.className = 'app-toast';
    t.setAttribute('role', 'status');
    t.setAttribute('aria-live', 'polite');
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.remove('show'), durationMs);
}

function showMessagePopup(msg) {
  if (hashMessagePopup) {
    map.closePopup(hashMessagePopup);
    hashMessagePopup = null;
  }
  const latlng = Array.isArray(initialCenter) &&
    Number.isFinite(initialCenter[0]) && Number.isFinite(initialCenter[1])
    ? initialCenter
    : map.getCenter();

  hashMessagePopup = L.popup({ maxWidth: 320, autoPan: false, keepInView: false })
    .setLatLng(latlng)
    .setContent(`<div class="message-popup"><div class="popup-title"><span class="popup-name">${esc(msg)}</span></div></div>`)
    .openOn(map);

  requestAnimationFrame(() => {
    if (hashMessagePopup) keepPopupAboveBottomBar(hashMessagePopup.getElement());
  });
}

function showHashLookupMessage(msg) {
  hashLookupMessageUntilMs = Date.now() + 6000;
  setStatus('error', msg);
  showToast(msg, 6000);
  showMessagePopup(msg);
}

async function loadHashAircraft(id) {
  if (!id) return;
  try {
    const res = await fetch(`ogn-proxy.php?info=1&id=${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Live data may have arrived while this lookup was in flight.
    if (markers.has(id)) {
      if (pendingHashSelect === id) {
        pendingHashSelect = null;
        toggleSelection(id, true);
      }
      return;
    }

    if (!data.found) {
      showHashLookupMessage('Aircraft not seen in last 24 hours');
      return;
    }

    const tsMs = (Number(data.timestamp) || 0) * 1000;
    if (!Number.isFinite(tsMs) || !data.raw) {
      showHashLookupMessage('Could not load last known position');
      return;
    }

    lastKnownCache.set(id, {
      raw: data.raw,
      received_at: new Date(tsMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      timestamp: tsMs
    });
    if (data.name) { nameCache.set(id, String(data.name)); saveNameCache(); }
    const ddbId = String(data.ddb_id || '').toLowerCase();
    if (ddbId) {
      ddbCache.set(ddbId, {
        callsign: String(data.callsign || ''),
        registration: String(data.registration || ''),
        model: String(data.model || ''),
        ddbAircraftType: String(data.aircraft_type || '')
      });
    }

    rebuildAircraftArray();
    render();
    if (markers.has(id) && pendingHashSelect === id) {
      pendingHashSelect = null;
      toggleSelection(id, true);
    }
  } catch (err) {
    console.warn('ogn-tracker hash aircraft lookup failed', err);
    showHashLookupMessage('Could not load last known position');
  }
}

function updateUrlHash() {
  const c = map.getCenter();
  const sel = activeTrackAddress ? `,${encodeURIComponent(activeTrackAddress)}` : '';
  const hash = `#${c.lat.toFixed(4)},${c.lng.toFixed(4)},${map.getZoom()}${sel}`;
  if (location.hash !== hash) history.replaceState(null, '', hash);
}

function getShareUrl() {
  updateUrlHash();
  return location.href;
}

async function copyTextToClipboard(text, okMsg = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    showToast(okMsg);
    return true;
  } catch (e) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
      showToast(okMsg);
      return true;
    } catch (_) {
      showToast('Copy failed');
      return false;
    }
  }
}

function pickTrackColor() {
  const used = new Set();
  for (const entry of selectedTracks.values()) used.add(entry.color);
  for (const c of TRACK_COLORS) if (!used.has(c)) return c;
  return TRACK_COLORS[colorSeq++ % TRACK_COLORS.length];
}

function varioColor(climb) {
  if (climb == null) return '#57d3b0';
  if (climb >= 2.5) return '#ef4444';
  if (climb >= 1.0) return '#f97316';
  if (climb >= 0.2) return '#eab308';
  if (climb >= -0.5) return '#22c55e';
  if (climb >= -2.0) return '#38bdf8';
  return '#3b82f6';
}

function buildTrackLayer(points, flatColor) {
  if (!points || points.length < 2) return null;
  if (!varioTrackMode) {
    return L.polyline(points.map(p => [p[0], p[1]]), { color: flatColor, weight: 3, opacity: 0.9 });
  }
  const grp = L.layerGroup();
  for (let i = 1; i < points.length; i++) {
    const p0 = points[i - 1], p1 = points[i];
    const dt = p1[3] - p0[3];
    const climb = (p0[2] != null && p1[2] != null && dt > 0 && dt < 300) ? (p1[2] - p0[2]) / dt : null;
    L.polyline([[p0[0], p0[1]], [p1[0], p1[1]]], { color: varioColor(climb), weight: 3.5, opacity: 0.92 }).addTo(grp);
  }
  return grp;
}

function redrawAllTracks() {
  for (const [addr, entry] of selectedTracks.entries()) {
    if (entry.layer) map.removeLayer(entry.layer);
    entry.layer = buildTrackLayer(entry.points, entry.color);
    if (entry.layer) entry.layer.addTo(map);
  }
  updateReplayTrackLine();
}

function syncVarioLegend() {
  const legend = $('varioLegend');
  if (!legend) return;
  legend.hidden = !varioTrackMode;
  if (!varioTrackMode) return;
  $('varioLegendLow').textContent = `↓ ${fmtClimb(-2)}`;
  $('varioLegendHigh').textContent = `+${fmtClimb(2.5)} ↑`;
  legend.setAttribute('aria-label', `Vario colour scale from ${fmtClimb(-2)} sink to +${fmtClimb(2.5)} climb`);
}

function syncTrackModeButtons() {
  syncVarioLegend();
  const flatBtn = $('btnTrackFlat');
  const varioBtn = $('btnTrackVario');
  if (!flatBtn || !varioBtn) return;
  flatBtn.classList.toggle('active', !varioTrackMode);
  varioBtn.classList.toggle('active', varioTrackMode);
  flatBtn.setAttribute('aria-pressed', String(!varioTrackMode));
  varioBtn.setAttribute('aria-pressed', String(varioTrackMode));
}

function setTrackColorMode(vario) {
  if (varioTrackMode === vario) return;
  varioTrackMode = vario;
  savedVarioTrackMode = vario;
  // Persist immediately, before any redraw work that could be interrupted.
  saveMenuPrefs();
  syncTrackModeButtons();
  redrawAllTracks();
}

function syncBaroButton() {
  const btn = $('btnBaro');
  if (!btn) return;
  btn.classList.toggle('active', baroEnabled);
  btn.setAttribute('aria-pressed', String(baroEnabled));
  btn.textContent = `📈 ${baroEnabled ? 'ON' : 'OFF'}`;
}

function setBaroEnabled(on) {
  if (baroEnabled === on) return;
  baroEnabled = on;
  savedBaroEnabled = on;
  // Persist immediately, before refreshing any open popup.
  saveMenuPrefs();
  syncBaroButton();
  for (const [address, marker] of markers) {
    if (marker.isPopupOpen()) refreshMarkerPopup(address);
  }
}

function toggleFollow(address) {
  if (!address) return;
  followedAddress = (followedAddress === address) ? null : address;
  document.querySelectorAll('.follow-btn[data-follow]').forEach(btn => {
    const active = btn.dataset.follow === followedAddress;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
    btn.textContent = active ? '◎ Unfollow' : '◎ Follow';
    const a = aircraft.find(x => x.address === btn.dataset.follow);
    btn.title = `${active ? 'Unfollow' : 'Follow'} ${a ? displayName(a) : btn.dataset.follow}`;
  });
  updateListHint();
  followCenteringPaused = false;
  syncRecenterButton();
}

// --- Shared follow-centering control (live and replay) ---
const FOLLOW_CENTER_MIN_ZOOM = 15;
let followCenteringPaused = false;

function activeFollowAddress() {
  return replayActive ? replayFollowAddress : followedAddress;
}

function syncRecenterButton() {
  const btn = $('recenterBtn');
  if (!btn) return;
  const addr = activeFollowAddress();
  const needsRecenter = !!addr && followCenteringPaused;
  btn.hidden = !needsRecenter;
  if (needsRecenter) {
    const a = aircraft.find(x => x.address === addr);
    const name = a ? displayName(a) : addr.toUpperCase();
    btn.title = `Center map on ${name}`;
    btn.setAttribute('aria-label', btn.title);
  }
}

function pauseFollowCentering() {
  if (!activeFollowAddress() || followCenteringPaused) return;
  followCenteringPaused = true;
  syncRecenterButton();
}

function centerOnFollowed(force = false) {
  const addr = activeFollowAddress();
  if (!addr) return false;
  if (!force && (followCenteringPaused || map.getZoom() < FOLLOW_CENTER_MIN_ZOOM)) return false;
  let lat, lon;
  if (replayActive) {
    const p = replayPoints.find(x => x.id === addr);
    if (!p) return false;
    lat = p.lat; lon = p.lon;
  } else {
    const a = aircraft.find(x => x.address === addr);
    if (!a) return false;
    lat = a.lat; lon = a.lon;
  }
  followCenteringPaused = false;
  syncRecenterButton();
  const dest = L.latLng(lat, lon);
  if (map.getCenter().distanceTo(dest) > 1) map.setView(dest, map.getZoom(), { animate: true });
  return true;
}

// Shared altitude-profile renderer for the popup barograph.
function barogramChart(address, scrubIdx = null) {
  const entry = selectedTracks.get(address);
  if (!entry || !entry.points) return null;
  const pts = entry.points.filter(p => p[2] != null);
  if (pts.length < 2) return null;

  const minAlt = Math.min(...pts.map(p => p[2]));
  const maxAlt = Math.max(...pts.map(p => p[2]));
  const spanAlt = Math.max(10, maxAlt - minAlt);
  const t0 = pts[0][3], t1 = pts[pts.length - 1][3], spanT = Math.max(1, t1 - t0);

  const coords = pts.map(p => {
    const x = ((p[3] - t0) / spanT) * 460;
    const y = 65 - (((p[2] - minAlt) / spanAlt) * 58);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  let scrubSvg = '';
  let scrubSuffix = '';
  if (scrubIdx != null && scrubIdx >= 0 && scrubIdx < pts.length) {
    const sp = pts[scrubIdx];
    const sx = (((sp[3] - t0) / spanT) * 460).toFixed(1);
    const sy = (65 - (((sp[2] - minAlt) / spanAlt) * 58)).toFixed(1);
    const timeStr = new Date(sp[3] * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    scrubSvg = `
      <line x1="${sx}" y1="4" x2="${sx}" y2="68" stroke="#edf4f8" stroke-width="1" stroke-dasharray="2 2" opacity="0.75" />
      <circle cx="${sx}" cy="${sy}" r="3.5" fill="${entry.color}" stroke="#101923" stroke-width="1.5" />
    `;
    scrubSuffix = ` · ${fmtAlt(sp[2])} @ ${timeStr}`;
  }

  const title = `Min ${fmtAlt(minAlt)} / Max ${fmtAlt(maxAlt)}${scrubSuffix}`;
  const svg = `
    <polyline fill="none" stroke="${entry.color}" stroke-width="2" points="${coords}" />
    ${scrubSvg}
    <text x="4" y="12" fill="#9aabba" font-size="10">${esc(fmtAlt(maxAlt))}</text>
    <text x="4" y="66" fill="#9aabba" font-size="10">${esc(fmtAlt(minAlt))}</text>
  `;
  return { title, svg };
}

function barogramScrubIndex(svgEl, clientX, address) {
  const entry = selectedTracks.get(address);
  if (!entry || !entry.points) return null;
  const pts = entry.points.filter(p => p[2] != null);
  if (pts.length < 2) return null;
  const rect = svgEl.getBoundingClientRect();
  if (rect.width <= 0) return null;
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  const t0 = pts[0][3], t1 = pts[pts.length - 1][3];
  const targetTs = t0 + ratio * Math.max(1, t1 - t0);
  let bestIdx = 0, bestDiff = Math.abs(pts[0][3] - targetTs);
  for (let i = 1; i < pts.length; i++) {
    const diff = Math.abs(pts[i][3] - targetTs);
    if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
  }
  return bestIdx;
}

// The popup barograph supports scrubbing via delegation
// because popup contents are rebuilt as live data arrives.
function updatePopupBarogram(svg, idx = null) {
  const chart = barogramChart(svg.dataset.addr, idx);
  if (!chart) return;
  svg.innerHTML = chart.svg;
  svg.setAttribute('aria-label', `Altitude profile: ${chart.title}`);
  const label = svg.parentElement?.querySelector('.baro-head strong');
  if (label) label.textContent = chart.title;
}
let hoveredPopupBaro = null;
map.getContainer().addEventListener('pointermove', e => {
  const svg = e.target.closest?.('.popup-baro-svg');
  if (svg) {
    hoveredPopupBaro = svg;
    const idx = barogramScrubIndex(svg, e.clientX, svg.dataset.addr);
    if (idx != null) updatePopupBarogram(svg, idx);
  } else if (hoveredPopupBaro) {
    const previous = hoveredPopupBaro;
    hoveredPopupBaro = null;
    if (previous.isConnected) updatePopupBarogram(previous);
  }
});

function removeTrack(address) {
  const entry = selectedTracks.get(address);
  if (entry) {
    if (entry.layer) map.removeLayer(entry.layer);
    selectedTracks.delete(address);
  }
  if (activeTrackAddress === address) {
    activeTrackAddress = [...selectedTracks.keys()].pop() || null;
    updateUrlHash();
  }
  updateListHint();
}

function clearAllTracks() {
  for (const entry of selectedTracks.values()) {
    if (entry.layer) map.removeLayer(entry.layer);
  }
  selectedTracks.clear();
  activeTrackAddress = null;
  updateListHint();
  updateUrlHash();
}

function buildTrackQuery(address) {
  const val = $('trackWindow').value;
  if (val === 'today') {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    return `ogn-proxy.php?track=1&id=${encodeURIComponent(address)}&since=${Math.floor(d.getTime() / 1000)}`;
  }
  return `ogn-proxy.php?track=1&id=${encodeURIComponent(address)}&window=${encodeURIComponent(val)}`;
}

async function loadTrack(address) {
  const entry = selectedTracks.get(address);
  if (!entry) return;
  if (entry.layer) { map.removeLayer(entry.layer); entry.layer = null; }
  const reqId = ++trackReqSeq;
  entry.reqId = reqId;

  try {
    const res = await fetch(buildTrackQuery(address));
    if (!res.ok) return;
    const data = await res.json();
    const current = selectedTracks.get(address);
    if (!current || current.reqId !== reqId) return;

    current.points = Array.isArray(data.points) ? data.points : [];
    current.layer = buildTrackLayer(current.points, current.color);
    if (current.layer) current.layer.addTo(map);
    refreshMarkerPopup(address);
  } catch (err) {
    console.warn('Track fetch failed:', err);
  }
}

function downloadIgc(address) {
  const entry = selectedTracks.get(address);
  if (!entry || !entry.points || entry.points.length < 2) return alert('No track points loaded yet.');
  const a = aircraft.find(x => x.address === address);
  const name = a ? displayName(a) : address.toUpperCase();
  const d0 = new Date(entry.points[0][3] * 1000);
  const pad = (n, l = 2) => String(Math.floor(Math.abs(n))).padStart(l, '0');
  const dateStr = `${pad(d0.getUTCDate())}${pad(d0.getUTCMonth() + 1)}${pad(d0.getUTCFullYear() % 100)}`;

  const lines = [
    'AOGN001',
    `HFDTE${dateStr}`,
    `HFPLTPILOTINCHARGE:${name}`,
    `HFGIDGLIDERID:${name}`
  ];

  for (const [lat, lon, alt, ts] of entry.points) {
    const dt = new Date(ts * 1000);
    const hms = `${pad(dt.getUTCHours())}${pad(dt.getUTCMinutes())}${pad(dt.getUTCSeconds())}`;
    const latDeg = Math.floor(Math.abs(lat)), latMin = Math.round((Math.abs(lat) - latDeg) * 60000);
    const lonDeg = Math.floor(Math.abs(lon)), lonMin = Math.round((Math.abs(lon) - lonDeg) * 60000);
    const latStr = `${pad(latDeg, 2)}${pad(latMin, 5)}${lat >= 0 ? 'N' : 'S'}`;
    const lonStr = `${pad(lonDeg, 3)}${pad(lonMin, 5)}${lon >= 0 ? 'E' : 'W'}`;
    const altVal = Math.max(0, Math.round(alt || 0));
    lines.push(`B${hms}${latStr}${lonStr}A00000${pad(altVal, 5)}`);
  }

  const blob = new Blob([lines.join('\r\n') + '\r\n'], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${name.replace(/[^a-z0-9_-]/gi, '_')}_${dateStr}.igc`;
  link.click();
  URL.revokeObjectURL(url);
}

function jumpToAlertAddress(address) {
  const key = String(address || '').toLowerCase();
  if (!key) return;
  if (markers.has(key)) {
    toggleSelection(key, true);
    return;
  }
  const item = alerts24hHistory.get(key);
  if (item && Number.isFinite(item.lat) && Number.isFinite(item.lon)) {
    if (window.innerWidth <= 800) $('map').scrollIntoView({ behavior: 'smooth', block: 'start' });
    const nowMs = serverNow();
    const lastSeenMs = item.latestTsMs || item.tsMs;
    const lastSeenAge = fmtAge(Math.max(0, Math.floor((nowMs - lastSeenMs) / 1000)));
    const exactTime = new Date(lastSeenMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const outcome = describeAlertOutcome(item, nowMs);
    const lastStatus = item.lastStatus || item.status;
    const liveA = aircraft.find(x => x.address === key);
    let altM = Number.isFinite(item.alt) ? item.alt : liveA?.altitude;
    if (altM == null && item.raw) {
      const altMatch = item.raw.match(/\/A=(-?\d{6})/);
      if (altMatch) altM = Math.round(parseInt(altMatch[1], 10) * 0.3048);
    }
    if (altM == null) {
      const lastAlt = lastAltCache.get(key);
      if (lastAlt) {
        const d = distMeters(lastAlt.lat, lastAlt.lon, item.lat, item.lon);
        if (d <= 20) altM = lastAlt.alt;
      }
    }
    const latStr = item.lat.toFixed(6), lonStr = item.lon.toFixed(6);
    const mapsUrl = `https://www.google.com/maps?q=${encodeURIComponent(latStr + ',' + lonStr)}`;
    const posText = altM != null ? `${latStr},${lonStr},${fmtAltCompact(altM)}` : `${latStr},${lonStr}`;
    const shareUrl = `${location.href.replace(/#.*/, '')}#${item.lat.toFixed(4)},${item.lon.toFixed(4)},${Math.max(map.getZoom(), 12)},${encodeURIComponent(item.address)}`;
    const sarTxt = [
      `SAR Info: ${item.name}`,
      `Status: ${item.status || 'Unknown'}`,
      `Coords: ${latStr}, ${lonStr}`,
      `Alt: ${altM != null ? fmtAlt(altM) : 'N/A'}`,
      `Last heard: ${lastSeenAge}`,
      `Map: ${mapsUrl}`,
      `Tracker: ${shareUrl}`
    ].join('\n');
    map.setView([item.lat, item.lon], Math.max(map.getZoom(), 12));
    L.popup({ maxWidth: 360 })
      .setLatLng([item.lat, item.lon])
      .setContent(`
        <div class="popup-title">${esc(item.name)}</div>
        <div class="popup-actions">
          <button type="button" data-act="alert-sar" data-sar="${esc(sarTxt)}">📋 SAR</button>
        </div>
        <div class="popup-grid" style="margin-top:6px">
          <div class="popup-value"><span>Alert</span><br><b style="color:var(--red)">${esc(item.status)}</b></div>
          <div class="popup-value"><span>Last status</span><br><b>${esc(lastStatus)}</b></div>
          <div class="popup-value" style="grid-column:1/-1"><span>Last seen</span><br><b>${esc(`${exactTime} (${lastSeenAge})`)}</b></div>
          ${outcome ? `<div class="popup-value" style="grid-column:1/-1"><span>State</span><br><b style="color:var(--yellow)">${esc(outcome)}</b></div>` : ''}
          <div class="popup-value" style="grid-column:1/-1"><span>Position</span><br><a href="${mapsUrl}" target="_blank" rel="noopener noreferrer" style="color:#57d3b0;font-weight:700;text-decoration:underline">${esc(posText)}</a></div>
        </div>
        ${item.raw ? `<div class="popup-raw">${esc(item.raw)}</div>` : ''}
      `)
      .openOn(map);
  }
}

function focusListRow(address) {
  if (!address) return;
  const row = $(`aircraftList`)?.querySelector(`.aircraft[data-key="${CSS.escape(address)}"]`);
  if (row) row.focus({ preventScroll: true });
}

function toggleSelection(address, openOnMap = false) {
  if (selectedTracks.has(address)) {
    removeTrack(address);
  } else {
    selectedTracks.set(address, { color: pickTrackColor(), layer: null, points: [], reqId: 0 });
    activeTrackAddress = address;
    updateUrlHash();
    loadTrack(address);
    if (openOnMap) {
      if (window.innerWidth <= 800) $('map').scrollIntoView({ behavior: 'smooth', block: 'start' });
      const m = markers.get(address);
      if (m) {
        if (m._isEmergency) {
          map.setView(m.getLatLng(), Math.max(map.getZoom(), 12));
          m.openPopup();
        } else {
          clusterGroup.zoomToShowLayer(m, () => m.openPopup());
        }
      }
    }
  }
  updateListHint();
  render();
  requestAnimationFrame(() => focusListRow(address));
}

map.on('click', () => {
  if (selectedTracks.size > 0) {
    clearAllTracks();
    render();
  }
});

map.on('dragstart', () => { pauseFollowCentering(); });
map.on('zoomend', () => { syncRecenterButton(); });
$('recenterBtn').addEventListener('click', () => { centerOnFollowed(true); });

function sanitizeWeather(wx) {
  if (!wx || typeof wx !== 'object') return null;
  const dir = (wx.dir != null && Number.isFinite(Number(wx.dir))) ? Number(wx.dir) : null;
  const spdKmh = (wx.spdKmh != null && Number.isFinite(Number(wx.spdKmh))) ? Number(wx.spdKmh) : null;
  const gustKmh = (wx.gustKmh != null && Number.isFinite(Number(wx.gustKmh))) ? Number(wx.gustKmh) : null;
  const rawTemp = (wx.tempC != null && Number.isFinite(Number(wx.tempC))) ? Number(wx.tempC) : null;
  const tempC = (rawTemp != null && rawTemp >= MIN_VALID_TEMP_C && rawTemp <= MAX_VALID_TEMP_C) ? rawTemp : null;
  const rawPress = (wx.pressureHpa != null && Number.isFinite(Number(wx.pressureHpa))) ? Number(wx.pressureHpa) : null;
  const pressureHpa = (rawPress != null && rawPress >= 850 && rawPress <= 1085) ? Number(rawPress.toFixed(1)) : null;
  const rawHum = (wx.humidityPct != null && Number.isFinite(Number(wx.humidityPct))) ? Number(wx.humidityPct) : null;
  const humidityPct = (rawHum != null && rawHum >= 0 && rawHum <= 100) ? rawHum : null;

  const hasNonTempWx = (dir != null || spdKmh != null || gustKmh != null || pressureHpa != null || humidityPct != null);
  if (!hasNonTempWx) {
    return null;
  }
  return { dir, spdKmh, gustKmh, tempC, pressureHpa, humidityPct };
}

function parseAprsWeather(line) {
  const colonIdx = line.indexOf(':');
  const payload = colonIdx !== -1 ? line.slice(colonIdx + 1) : line;

  const wxMatch = payload.match(/_(\d{3})\/(\d{3})(?:g(\d{3}))?(?:t(-?\d{3}))?(?:h(\d{2,3}))?(?:b(\d{4,5}))?/);

  let dir = null, spdKmh = null, gustKmh = null, tempC = null, humidityPct = null, pressureHpa = null;

  if (wxMatch) {
    dir = parseInt(wxMatch[1], 10);
    spdKmh = Math.round(parseInt(wxMatch[2], 10) * 1.60934);
    if (wxMatch[3] != null) gustKmh = Math.round(parseInt(wxMatch[3], 10) * 1.60934);
    if (wxMatch[4] != null) tempC = Math.round((parseInt(wxMatch[4], 10) - 32) * 5 / 9);
    if (wxMatch[5] != null) {
      const rawH = parseInt(wxMatch[5], 10);
      humidityPct = rawH === 0 ? 100 : Math.min(100, Math.max(0, rawH));
    }
    if (wxMatch[6] != null) pressureHpa = Number((parseInt(wxMatch[6], 10) / 10).toFixed(1));
  }

  if (tempC == null) {
    const cMatch = payload.match(/(?:^|[\s,(])([+-]?\d{1,2}(?:\.\d+)?)\s*°?C(?=$|[\s,;)/])/);
    if (cMatch) tempC = Math.round(parseFloat(cMatch[1]));
  }

  if (humidityPct == null) {
    const pctMatch = payload.match(/(?:^|[\s,(])(?:rh\s*[:=]?\s*|hum(?:idity)?\s*[:=]?\s*)?(\d{1,3})\s*%(?=$|[\s,;)/])/i);
    if (pctMatch) {
      const rawPct = parseInt(pctMatch[1], 10);
      if (rawPct >= 0 && rawPct <= 100) humidityPct = rawPct;
    }
  }

  if (pressureHpa == null) {
    const hpaMatch = payload.match(/(?:^|[\s,(])(\d{3,4}(?:\.\d+)?)\s*(?:hpa|mbar)(?=$|[\s,;)/])/i);
    const bLooseMatch = !wxMatch ? payload.match(/(?:^|[\s,(])b(\d{4,5})(?=$|[\s,;)/])/) : null;
    if (hpaMatch) pressureHpa = Number(parseFloat(hpaMatch[1]).toFixed(1));
    else if (bLooseMatch) pressureHpa = Number((parseInt(bLooseMatch[1], 10) / 10).toFixed(1));
  }

  return sanitizeWeather({ dir, spdKmh, gustKmh, tempC, pressureHpa, humidityPct });
}

function parseAprsLineCached(line, timestampMs) {
  const key = `${line}|${timestampMs}`;
  if (parsedLineCache.has(key)) {
    const cached = parsedLineCache.get(key);
    return cached ? { ...cached, weather: cached.weather ? { ...cached.weather } : null } : null;
  }
  const parsed = parseAprsLine(line, timestampMs);
  parsedLineCache.set(key, parsed);
  if (parsedLineCache.size > 6000) {
    const firstKey = parsedLineCache.keys().next().value;
    parsedLineCache.delete(firstKey);
  }
  return parsed ? { ...parsed, weather: parsed.weather ? { ...parsed.weather } : null } : null;
}

function parseAprsLine(line, timestampMs) {
  const baseMatch = line.match(/(\d{6})h(\d{2})(\d{2}\.\d+)([NS])(.)(\d{3})(\d{2}\.\d+)([EW])(.)/);
  if (!baseMatch) {
    const callsignMatch = line.match(/^([^>]+)>/);
    const liveLabel = callsignMatch ? callsignMatch[1].trim() : '';
    const weather = parseAprsWeather(line);
    if (!liveLabel || !weather) return null;
    const rxMatch = line.match(/q[A-Z]{2},([^:,]+)[:\,]/);
    return {
      __telemetryOnly: true,
      id: liveLabel,
      liveLabel,
      address: liveLabel.toLowerCase(),
      receiver: rxMatch ? rxMatch[1] : '',
      weather,
      receivedAtMs: timestampMs
    };
  }

  const callsignMatch = line.match(/^([^>]+)>/);
  const liveLabel = callsignMatch ? callsignMatch[1] : 'Unknown';
  const rxMatch = line.match(/q[A-Z]{2},([^:,]+)[:\,]/);
  const receiver = rxMatch ? rxMatch[1] : '';

  const symChar = baseMatch[9];
  let type = 0;
  if (symChar === '_' || symChar === '&' || symChar === '#' || symChar === 'r') type = 15;

  let ognId = '', ddbId = '';
  const idMatch = line.match(/\bid([0-9a-fA-F]{2})([0-9a-fA-F]{6,8})\b/i);
  if (idMatch) {
    const parsedType = (parseInt(idMatch[1], 16) >> 2) & 0x0F;
    if (type !== 15 && parsedType > 0) {
      if (parsedType === 15 && (/\bFNT7[0-9a-f]\b/i.test(line) || /^FNT[0-9a-f]{6}$/i.test(liveLabel))) type = 7;
      else if (parsedType === 7 && /^[^>]+>OGADSB\b/i.test(line)) type = 16;
      else type = parsedType;
    }
    ddbId = idMatch[2].slice(-6).toLowerCase();
    ognId = (idMatch[1] + idMatch[2]).toLowerCase();
  } else {
    const hexMatch = liveLabel.match(/([0-9A-F]{6})$/i);
    ddbId = hexMatch ? hexMatch[1].toLowerCase() : liveLabel.toLowerCase();
  }

  if (type === 0) {
    if (symChar === 'g') type = 7;
    else if (symChar === "'") type = 1;
    else if (symChar === '^') type = 8;
    else if (symChar === 'X') type = 3;
    else if (symChar === 'O') type = 11;
  }

  let lat = parseInt(baseMatch[2], 10) + (parseFloat(baseMatch[3]) / 60);
  if (baseMatch[4] === 'S') lat = -lat;
  let lon = parseInt(baseMatch[6], 10) + (parseFloat(baseMatch[7]) / 60);
  if (baseMatch[8] === 'W') lon = -lon;

  const remainder = line.substring(baseMatch.index + baseMatch[0].length);
  let course = null, speed = null, altitude = null, climb = null;
  const csMatch = remainder.match(/^(\d{3})\/(\d{3})/);
  if (csMatch && symChar !== '_') {
    course = parseInt(csMatch[1], 10);
    speed = parseInt(csMatch[2], 10) * 1.852;
  }
  const altMatch = remainder.match(/\/A=(-?\d{6})/);
  if (altMatch) altitude = parseInt(altMatch[1], 10) * 0.3048;

  if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;
  if (altitude != null && (altitude < -500 || (type !== 11 && altitude > 18000))) return null;
  if (speed != null && speed > 1300) return null;
  if ([4, 6, 7, 13].includes(type) && ((altitude != null && altitude > 10000) || (speed != null && speed > 250))) return null;
  if (type === 1 && ((altitude != null && altitude > 16000) || (speed != null && speed > 400))) return null;

  const fpmMatch = line.match(/\s([-+]\d+)fpm\b/);
  if (fpmMatch) climb = parseInt(fpmMatch[1], 10) * 0.00508;
  const snrMatch = line.match(/\b(\d+(?:\.\d+)?)dB\b/i);
  const snr = snrMatch ? parseFloat(snrMatch[1]) : null;
  const weather = parseAprsWeather(line);

  return {
    lat, lon, id: liveLabel, liveLabel, registration: '', callsign: '', model: '', ddbAircraftType: '',
    altitude, speed, course, climb: climb ? Number(climb.toFixed(1)) : null,
    snr, weather, type, receiver, address: liveLabel.toLowerCase(), ognId, ddbId, receivedAtMs: timestampMs
  };
}

const OGN_TYPES = {
  1:'Glider', 2:'Towplane', 3:'Helicopter', 4:'Parachutist', 5:'Drop plane', 6:'Hang glider',
  7:'Paraglider', 8:'Powered', 9:'Jet', 10:'UFO', 11:'Balloon', 12:'Airship', 13:'Drone', 15:'Ground Station', 16:'Ultralight'
};

const ICONS = {
  default: "M12 1.5C12.7 1.5 13 3.2 13 7.5L23.2 9.4V10.9L13 10.6L12.7 19.2L15.8 20.6V21.8L12 21L8.2 21.8V20.6L11.3 19.2L11 10.6L0.8 10.9V9.4L11 7.5C11 3.2 11.3 1.5 12 1.5Z",
  airplane: "M12 2l2 6h8v2l-8 3v6l3 2v2l-5-1-5 1v-2l3-2v-6l-8-3V8h8l2-6z",
  heli: "M12 3.5C14.1 3.5 15.3 5.5 15.3 8.5C15.3 11 14 12.6 12.8 13.3L12.7 19.5L15 20.5V21.7L12 21.1L9 21.7V20.5L11.3 19.5L11.2 13.3C10 12.6 8.7 11 8.7 8.5C8.7 5.5 9.9 3.5 12 3.5ZM4.2 3.2L19.8 14.8L19 15.8L3.4 4.2ZM19.8 3.2L4.2 14.8L5 15.8L20.6 4.2Z",
  para: "M12 2C4 2 1 7 1 9C3 7 7 6 12 6C17 6 21 7 23 9C23 7 20 2 12 2ZM2 9L11 18M22 9L13 18M10 20A2 2 0 1 0 14 20A2 2 0 1 0 10 20Z",
  hang: "M12 2L24 16L12 12L0 16ZM12 12L12 20M10 20h4",
  balloon: "M12 2C6 2 4 8 4 12C4 16 9 19 10 20L9 22h6L14 20C15 19 20 16 20 12C20 8 18 2 12 2Z",
  tower: "M12 2L12 22M12 2L8 8h8zM6 22h12M8 16h8M9 10h6"
};

function getResolvedType(a) {
  if (a.type != null && a.type > 0) return a.type;
  if (a.ddbAircraftType != null && String(a.ddbAircraftType).trim() !== '' && Number(a.ddbAircraftType) > 0) return Number(a.ddbAircraftType);
  return 0;
}
function isFanet(a) {
  const pkt = a.aprsPacket || '';
  return /^[^>]+>OGNFNT\b/i.test(pkt) || /^FNT[0-9a-f]{6}$/i.test(a.liveLabel || '') || /\bFNT[17][0-9a-f]\b/i.test(pkt);
}
function typeName(a) {
  const rType = getResolvedType(a);
  if (rType != null && OGN_TYPES[rType]) return OGN_TYPES[rType];
  if (a.ddbAircraftType != null && String(a.ddbAircraftType).trim() !== '') return String(a.ddbAircraftType);
  return 'Aircraft / Station';
}
function displayModel(a) {
  const m = (a.model || '').trim(), t = (typeName(a) || '').trim();
  return (!m || m.toLowerCase() === t.toLowerCase()) ? '' : m;
}
function displayName(a) {
  const candidates = /([0-9A-F]{6})$/i.test(a.liveLabel)
    ? [a.streamName, a.callsign, a.registration,
       a.ddbId && a.ddbId.length === 6 && /^[0-9a-f]{6}$/i.test(a.ddbId) ? a.ddbId.toUpperCase() : '',
       a.ognId ? a.ognId.toUpperCase() : '', a.liveLabel]
    : [a.streamName, a.liveLabel];
  for (const candidate of candidates) {
    const name = cleanName(candidate);
    if (name) return name;
  }
  return 'Unknown';
}
function displayStreamName(a) {
  const s = cleanName(a.streamName), n = displayName(a);
  return (!s || s.toLowerCase() === n.toLowerCase()) ? '' : s;
}
function displayRegistration(a) {
  const r = (a.registration || '').trim(), n = (displayName(a) || '').trim();
  return (!r || r.toLowerCase() === n.toLowerCase()) ? '' : r;
}

const FANET_STATUS = {
  0:'Other', 1:'Walking', 2:'Vehicle', 3:'Bike', 4:'Boot', 8:'Need a ride', 9:'Landed well',
  12:'Need technical support', 13:'Need medical help', 14:'Distress call', 15:'Distress call automatically'
};
const SQUAWK_ALERTS = { '7700':'Squawk 7700 (Emergency)', '7600':'Squawk 7600 (Radio Failure)', '7500':'Squawk 7500 (Hijack)' };

function parseFanetStatus(packet) {
  if (!packet) return '';
  const match = packet.match(/\bFNT([17])([0-9a-f])\b/i);
  if (!match) return '';
  if (match[1] === '1') return 'Airborne';
  return FANET_STATUS[parseInt(match[2], 16)] || '';
}
function parseEmergencyStatus(packet) {
  if (!packet) return '';
  const fnt = parseFanetStatus(packet);
  if (fnt === 'Distress call' || fnt === 'Distress call automatically' || fnt === 'Need medical help' || fnt === 'Need technical support') return fnt;
  const sqMatch = packet.match(/\bsq(7700|7600|7500)\b/i);
  if (sqMatch) return SQUAWK_ALERTS[sqMatch[1]];
  if (/^[^>]+>EMERGENCY[,:]/i.test(packet)) return 'APRS Emergency';
  const colonIdx = packet.indexOf(':');
  if (colonIdx !== -1) {
    const kwMatch = packet.slice(colonIdx + 1).match(/\b(MAYDAY|SOS|EMERGENCY)\b/i);
    if (kwMatch) return `Alert (${kwMatch[1].toUpperCase()})`;
  }
  return '';
}
function isEmergency(a) { return Boolean(parseEmergencyStatus(a.aprsPacket)); }
function getDisplayStatus(a) { return parseEmergencyStatus(a.aprsPacket) || parseFanetStatus(a.aprsPacket); }
function statusColor(a, status) {
  if (isEmergency(a)) return 'var(--red)';
  if (status === 'Need technical support') return 'var(--yellow)';
  return 'var(--accent)';
}

function isInCurrentViewport(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  try {
    return map.getBounds().contains([lat, lon]);
  } catch (e) {
    return false;
  }
}

function describeAlertOutcome(item, nowMs) {
  if (item.normalAfter) return 'Update: Seems back to normal';
  const latestAgeSec = Math.max(0, Math.floor((nowMs - (item.latestTsMs || item.tsMs)) / 1000));
  if (item.alertStillOn) {
    return latestAgeSec < OFFLINE_THRESHOLD_SEC ? 'still live · alert on' : 'Went offline with alert still on';
  }
  return latestAgeSec >= OFFLINE_THRESHOLD_SEC ? 'offline' : '';
}

function record24hAlerts(list, nowMs) {
  let changed = false;
  for (const [key, item] of alerts24hHistory.entries()) {
    if ((nowMs - item.tsMs) > ALERT_24H_TTL_MS || /^need a ride/i.test(String(item.status))) {
      alerts24hHistory.delete(key);
      changed = true;
    }
  }
  for (const a of list) {
    const emergText = parseEmergencyStatus(a.aprsPacket);
    if (!emergText || /^need a ride/i.test(emergText)) continue;
    const prev = alerts24hHistory.get(a.address);
    const nextTs = Math.max(a.receivedAtMs || nowMs, prev ? prev.tsMs : 0);
    const nextLatestTs = Math.max(a.receivedAtMs || nowMs, prev ? (prev.latestTsMs || 0) : 0);
    const nextLat = Number.isFinite(a.lat) ? a.lat : (prev ? prev.lat : null);
    const nextLon = Number.isFinite(a.lon) ? a.lon : (prev ? prev.lon : null);
    if (!prev || prev.status !== emergText || prev.tsMs !== nextTs || prev.latestTsMs !== nextLatestTs) {
      alerts24hHistory.set(a.address, {
        address: a.address,
        name: displayName(a),
        status: emergText,
        lastStatus: emergText,
        lat: nextLat,
        lon: nextLon,
        alt: Number.isFinite(a.altitude) ? a.altitude : (prev ? prev.alt : null),
        raw: a.aprsPacket || (prev ? prev.raw : ''),
        tsMs: nextTs,
        latestTsMs: nextLatestTs,
        normalAfter: false,
        alertStillOn: true
      });
      changed = true;
    }
  }
  if (changed) save24hAlerts(nowMs);
}

function buildAlertRowHtml(it, nowMs) {
  const lastSeenMs = it.latestTsMs || it.tsMs;
  const ageSec = Math.max(0, Math.floor((nowMs - lastSeenMs) / 1000));
  const outcome = describeAlertOutcome(it, nowMs);
  const statusText = it.status || 'Emergency alert';
  const lastStatus = it.lastStatus || statusText;
  const outcomeHtml = outcome ? `<br><span style="color:var(--yellow);font-weight:600">${esc(outcome)}</span>` : '';
  const lastStatusHtml = (lastStatus && lastStatus !== statusText) ? `<br><span style="color:var(--muted)">Last: ${esc(lastStatus)}</span>` : '';
  // Show when the alert itself was received; the age below stays "last seen",
  // matching the age shown for aircraft in the main list.
  const alertTime = new Date(it.tsMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const label = `${it.name} - ${statusText}`;
  return `<div class="aircraft emergency" data-alert-addr="${esc(it.address)}" data-key="${esc(it.address)}" tabindex="0" role="option" aria-selected="false" aria-label="${esc(label)}">
    <div class="stripe" style="background:var(--red)"></div>
    <div>
      <div class="callsign">${esc(it.name)}</div>
      <div class="meta"><span style="color:var(--red);font-weight:600">${esc(statusText)}</span>${lastStatusHtml}${outcomeHtml}</div>
    </div>
    <div class="alt station-alt" title="Alert received"><span data-ts="${it.tsMs}">${esc(alertTime)}</span><div class="age-row"><span class="age" data-ts="${lastSeenMs}" title="Last seen">${fmtAge(ageSec)}</span></div></div>
  </div>`;
}

let alertsCollapsed = true;
try {
  const savedAlertsCollapsed = localStorage.getItem('ogn_alerts_collapsed');
  if (savedAlertsCollapsed === '0') alertsCollapsed = false;
  else if (savedAlertsCollapsed === '1') alertsCollapsed = true;
} catch (e) {}

function render24hAlertsSummary(nowMs) {
  const box = $('alerts24hSummary');
  const head = $('alertsSectionHead');
  const toggle = $('alertsToggle');
  const countEl = $('alertsCount');
  for (const [key, item] of alerts24hHistory.entries()) {
    if ((nowMs - item.tsMs) > ALERT_24H_TTL_MS || /^need a ride/i.test(String(item.status))) {
      alerts24hHistory.delete(key);
    }
  }
  const allItems = [...alerts24hHistory.values()].sort((a, b) => (b.latestTsMs || b.tsMs) - (a.latestTsMs || a.tsMs));

  if (!allItems.length) {
    box.hidden = true;
    box.innerHTML = '';
    if (head) head.hidden = true;
    if (countEl) countEl.textContent = '0';
    return;
  }

  if (head) {
    head.hidden = false;
    head.classList.toggle('collapsed', alertsCollapsed);
  }
  if (toggle) toggle.setAttribute('aria-expanded', String(!alertsCollapsed));
  if (countEl) countEl.textContent = String(allItems.length);
  box.hidden = alertsCollapsed;
  box.innerHTML = `<div class="aircraft-list alerts-list" role="listbox" aria-label="Emergency alerts">${allItems.map(it => buildAlertRowHtml(it, nowMs)).join('')}</div>`;
}

function formatWeatherHtml(wx, compact = false) {
  const clean = sanitizeWeather(wx);
  if (!clean) return '';
  const parts = [];
  if (clean.spdKmh != null) {
    const arrow = clean.dir != null
      ? `<span style="display:inline-block;font-size:${compact ? '12px' : '19px'};line-height:1;vertical-align:-2px;transform:rotate(${Number(clean.dir) || 0}deg);margin-right:2px" aria-label="Wind direction">↑</span>`
      : '';
    const gustStr = clean.gustKmh != null ? ` (${fmtWindSpeed(clean.gustKmh)})` : '';
    parts.push(`${arrow}${fmtWindSpeed(clean.spdKmh)}${gustStr}`);
  }
  const tempStr = fmtTemp(clean.tempC);
  if (tempStr) parts.push(tempStr);
  if (clean.humidityPct != null) parts.push(`${clean.humidityPct}% RH`);
  if (clean.pressureHpa != null) parts.push(`${clean.pressureHpa.toFixed(1)} hPa`);
  return parts.join(' · ');
}

function mergeWeather(existing, incoming) {
  const a = sanitizeWeather(existing);
  const b = sanitizeWeather(incoming);
  if (!a) return b;
  if (!b) return a;
  const merged = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v != null) merged[k] = v;
  }
  return sanitizeWeather(merged);
}

function playBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    osc.type = 'sine'; osc.frequency.value = 880;
    osc.connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + 0.25);
  } catch (e) {}
}

function checkPinnedNotifications() {
  if (!alertsEnabled) return;
  const notifyStatuses = new Set(['Distress call', 'Distress call automatically', 'Need medical help', 'Need a ride', 'Landed well']);
  for (const a of aircraft) {
    if (!pinnedAircraft.has(a.address)) continue;
    const st = getDisplayStatus(a);
    const prev = lastPinnedStatus.get(a.address);
    if (st && st !== prev && (notifyStatuses.has(st) || isEmergency(a))) {
      playBeep();
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(`${displayName(a)}: ${st}`, { body: `Alt: ${fmtAlt(a.altitude) || 'N/A'} · ${a.lat.toFixed(4)}, ${a.lon.toFixed(4)}` });
      }
    }
    if (st) lastPinnedStatus.set(a.address, st);
  }
}

function getStationKeys(station) {
  const rawKeys = [station.id, station.address, station.liveLabel, station.streamName, station.callsign, displayName(station)]
    .filter(Boolean)
    .map(s => String(s).trim().toLowerCase());
  const expanded = new Set(rawKeys);
  for (const k of rawKeys) {
    if (nameCache.has(k)) expanded.add(String(nameCache.get(k)).trim().toLowerCase());
  }
  return expanded;
}

function updateWeatherCache(keys, wx, tsMs) {
  const clean = sanitizeWeather(wx);
  if (!clean) return;
  for (const rawKey of keys) {
    const k = String(rawKey || '').trim().toLowerCase();
    if (!k) continue;
    const prev = wxCache.get(k);
    const merged = mergeWeather(prev ? prev.wx : null, clean);
    if (merged) {
      wxCache.set(k, { wx: merged, ts: Math.max(tsMs || 0, prev ? prev.ts : 0) });
    }
  }
}

function readCachedWeather(keys, nowMs, ttlMs) {
  let combined = null;
  for (const rawKey of keys) {
    const k = String(rawKey || '').trim().toLowerCase();
    if (!k) continue;
    const entry = wxCache.get(k);
    if (!entry) continue;
    if ((nowMs - entry.ts) > ttlMs) {
      wxCache.delete(k);
      continue;
    }
    const cleanEntryWx = sanitizeWeather(entry.wx);
    if (!cleanEntryWx) {
      wxCache.delete(k);
      continue;
    }
    combined = mergeWeather(combined, cleanEntryWx);
  }
  return combined;
}

function applyCachedAircraftMeta(a) {
  if (nameCache.has(a.address)) a.streamName = nameCache.get(a.address);
  else if (nameCache.has(a.ddbId)) a.streamName = nameCache.get(a.ddbId);

  const details = ddbCache.get(a.ddbId);
  if (details) {
    if (details.callsign) a.callsign = details.callsign;
    if (details.registration) a.registration = details.registration;
    if (details.model) a.model = details.model;
    if (details.ddbAircraftType !== '') a.ddbAircraftType = details.ddbAircraftType;
  }
}

function rebuildAircraftArray() {
  const now = serverNow();
  const maxAgeMs = (Number($('markerWindow').value) || 900) * 1000;
  const wxTtlMs = Math.max(maxAgeMs, WX_CACHE_TTL_MS);
  aircraft = [];
  const telemetryOnly = [];
  const seenStations = new Map();

  for (const [id, cached] of aprsCache.entries()) {
    if (now - cached.timestamp > maxAgeMs) { aprsCache.delete(id); continue; }
    const a = parseAprsLineCached(cached.raw, cached.timestamp);
    if (!a) continue;
    if (a.__telemetryOnly) {
      telemetryOnly.push(a);
      continue;
    }
    a.aprsPacket = cached.raw;
    a.aprsReceivedAt = cached.received_at;

    if (a.altitude != null) lastAltCache.set(a.address, { lat: a.lat, lon: a.lon, alt: a.altitude });
    else {
      const lastAlt = lastAltCache.get(a.address);
      if (lastAlt) {
        const d = distMeters(lastAlt.lat, lastAlt.lon, a.lat, a.lon);
        if (d <= 20) a.altitude = lastAlt.alt;
      }
    }

    if (a.climb != null) lastClimbCache.set(a.address, a.climb);
    else if (lastClimbCache.has(a.address)) a.climb = lastClimbCache.get(a.address);

    applyCachedAircraftMeta(a);

    if (getResolvedType(a) === 15) {
      const dispName = displayName(a), coordKey = a.lat.toFixed(4) + '_' + a.lon.toFixed(4);
      if (seenStations.has(dispName) || seenStations.has(coordKey)) {
        const existing = seenStations.get(dispName) || seenStations.get(coordKey);
        if (/^[0-9a-f]{6}$/.test(a.ddbId) && !/^[0-9a-f]{6}$/.test(existing.ddbId)) {
          a.weather = mergeWeather(existing.weather, a.weather);
          const idx = aircraft.indexOf(existing);
          if (idx > -1) aircraft[idx] = a;
          seenStations.set(dispName, a); seenStations.set(coordKey, a);
        } else {
          existing.weather = mergeWeather(existing.weather, a.weather);
        }
        continue;
      }
      seenStations.set(dispName, a); seenStations.set(coordKey, a);
    }
    aircraft.push(a);
  }

  for (const [id, cached] of lastKnownCache.entries()) {
    // Once live data for this aircraft arrives, the live packet supersedes it.
    if (aprsCache.has(id) || aircraft.some(a => a.address === id)) continue;
    const a = parseAprsLineCached(cached.raw, cached.timestamp);
    if (!a) continue;
    a.id = id;
    a.address = id;
    a.aprsPacket = cached.raw;
    a.aprsReceivedAt = cached.received_at;
    a.__lastKnown = true;
    applyCachedAircraftMeta(a);
    aircraft.push(a);
  }

  for (const [id, cached] of telemetryCache.entries()) {
    if (now - cached.timestamp > wxTtlMs) { telemetryCache.delete(id); continue; }
    const tel = parseAprsLineCached(cached.raw, cached.timestamp);
    if (tel && tel.__telemetryOnly) telemetryOnly.push(tel);
  }

  for (const tel of telemetryOnly) {
    if (tel.weather) {
      updateWeatherCache([tel.id, tel.address, tel.liveLabel], tel.weather, tel.receivedAtMs);
    }
    const target = aircraft.find(a => getStationKeys(a).has(tel.address));
    if (target) {
      target.weather = mergeWeather(target.weather, tel.weather);
      updateWeatherCache(getStationKeys(target), target.weather, tel.receivedAtMs);
    }
  }

  const stations = aircraft.filter(a => getResolvedType(a) === 15);
  for (let i = 0; i < stations.length; i++) {
    for (let j = i + 1; j < stations.length; j++) {
      const s1 = stations[i], s2 = stations[j];
      if ((s1.weather || s2.weather) && haversineKm(s1.lat, s1.lon, s2.lat, s2.lon) < 0.2) {
        const combined = mergeWeather(s1.weather, s2.weather);
        s1.weather = combined ? { ...combined } : null;
        s2.weather = combined ? { ...combined } : null;
        if (combined) {
          updateWeatherCache(getStationKeys(s1), combined, Math.max(s1.receivedAtMs, s2.receivedAtMs));
          updateWeatherCache(getStationKeys(s2), combined, Math.max(s1.receivedAtMs, s2.receivedAtMs));
        }
      }
    }
  }

  for (const a of aircraft) {
    const keys = getStationKeys(a);
    if (a.weather) {
      updateWeatherCache(keys, a.weather, a.receivedAtMs);
    }
    const cachedWx = readCachedWeather(keys, now, wxTtlMs);
    if (cachedWx) {
      a.weather = mergeWeather(cachedWx, a.weather);
    } else {
      a.weather = sanitizeWeather(a.weather);
    }
  }

  record24hAlerts(aircraft, now);
  checkPinnedNotifications();
}

function getStationReceptionStats(station) {
  const keys = getStationKeys(station);
  if (keys.size === 0) return { count: 0, best24h: null };
  let heard24h = 0, best24h = null;
  for (const k of keys) {
    const rec = stationStatsCache.get(k);
    if (!rec) continue;
    if (rec.heard_24h != null && rec.heard_24h > heard24h) heard24h = rec.heard_24h;
    if (rec.max_km > 0 && (!best24h || rec.max_km > best24h.max_km)) best24h = rec;
  }
  return { count: heard24h, best24h };
}

function formatSnrHtml(snr) {
  if (snr == null) return '';
  if (snr === 0) return '0.0 dB';
  const cls = snr >= 25 ? 'snr-strong' : snr >= 12 ? 'snr-good' : 'snr-weak';
  const label = snr >= 25 ? 'Strong' : snr >= 12 ? 'Good' : 'Weak';
  return `${snr.toFixed(1)} dB <span class="snr-badge ${cls}">${label}</span>`;
}

// Leaflet's map pane is its own stacking context, which traps popups under map controls.
// Move the popup pane next to the other map overlays and follow the map pane's transform.
function raisePopupPane() {
  const pane = map.getPane('popupPane');
  const container = map.getContainer();
  if (!pane || !container || pane.parentElement === container) return;
  pane.classList.add('popup-pane-raised');
  container.appendChild(pane);
  syncRaisedPopupPane();
}

function syncRaisedPopupPane() {
  const pane = map.getPane('popupPane');
  const mapPane = map.getPane('mapPane');
  if (!pane || !mapPane) return;
  const transform = getComputedStyle(mapPane).transform;
  if (pane.style.transform !== transform) pane.style.transform = transform;
}

function visibleBottomBarEl() {
  const replay = $('replayBar');
  if (replay?.classList.contains('show')) return replay;
  return null;
}

// Bottom edge of the map area that is safe for popups (above the replay bar).
function popupSafeBottom(mapRect) {
  const bar = visibleBottomBarEl();
  if (!bar) return null;
  return bar.getBoundingClientRect().top - mapRect.top - 8;
}

function panPopupInView(popupEl, center) {
  if (!popupEl) return;
  const mapRect = $('map').getBoundingClientRect();
  const popupRect = popupEl.getBoundingClientRect();
  const safeBottom = popupSafeBottom(mapRect);
  const margin = 8;
  let dx = 0, dy = 0;
  if (center) {
    const popupCenterX = popupRect.left - mapRect.left + popupRect.width / 2;
    const popupCenterY = popupRect.top - mapRect.top + popupRect.height / 2;
    const targetX = mapRect.width / 2;
    const targetY = safeBottom == null ? mapRect.height / 2
      : Math.max(popupRect.height / 2 + margin, Math.min(safeBottom / 2, safeBottom - popupRect.height / 2 - margin));
    dx = popupCenterX - targetX;
    dy = popupCenterY - targetY;
  } else if (safeBottom != null) {
    const overflow = popupRect.bottom - mapRect.top - safeBottom;
    if (overflow > 2) dy = overflow;
  }
  if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
  // Centering on open animates; later corrections apply immediately so the popup never sits over the bar.
  map.panBy([dx, dy], { animate: center });
}

function centerPopupInView(marker) {
  if (!marker || !marker.isPopupOpen()) return;
  panPopupInView(marker.getPopup()?.getElement(), true);
}

function keepPopupAboveBottomBar(popupEl = $('map').querySelector('.leaflet-popup')) {
  panPopupInView(popupEl, false);
}

function keepOpenPopupAboveBar(marker) {
  if (!marker?.isPopupOpen()) return;
  requestAnimationFrame(() => {
    if (marker.isPopupOpen()) keepPopupAboveBottomBar(marker.getPopup()?.getElement());
  });
}

function signalBarsHtml(snr) {
  if (snr == null) return '';
  let bars = 0, cls = 'sig-weak';
  if (snr >= 25) { bars = 4; cls = 'sig-strong'; }
  else if (snr >= 18) { bars = 3; cls = 'sig-strong'; }
  else if (snr >= 12) { bars = 2; cls = 'sig-good'; }
  else if (snr > 0) { bars = 1; cls = 'sig-weak'; }
  const items = [1, 2, 3, 4].map(n => `<i${n <= bars ? ' class="on"' : ''}></i>`).join('');
  return `<span class="sig-bars ${cls}" title="Signal: ${snr.toFixed(1)} dB" aria-label="Signal ${snr.toFixed(1)} dB">${items}</span>`;
}

function markerIcon(a) {
  const type = getResolvedType(a);
  const angle = (a.course == null || type === 15) ? 0 : a.course;
  const emergClass = isEmergency(a) ? ' emergency' : '';
  const trackColor = selectedTracks.get(a.address)?.color || '#57d3b0';
  const name = esc(displayName(a));
  let svgPath = ICONS.default;
  switch(type) {
    case 2: case 5: case 8: case 9: case 13: case 16: svgPath = ICONS.airplane; break;
    case 3: svgPath = ICONS.heli; break;
    case 4: case 7: svgPath = ICONS.para; break;
    case 6: svgPath = ICONS.hang; break;
    case 11: case 12: svgPath = ICONS.balloon; break;
    case 15: svgPath = ICONS.tower; break;
  }
  return L.divIcon({
    className: 'glider-icon', iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -24],
    html: `<div class="glider-wrap${emergClass}" style="--marker-color:${trackColor}"><svg viewBox="0 0 24 24" style="transform:rotate(${angle}deg)" aria-hidden="true"><path d="${svgPath}"/></svg><div class="glider-label" title="${name}">${name}</div></div>`
  });
}

function markerRectsOverlap(a, b, pad = 0) {
  return !(a.right + pad < b.left || b.right + pad < a.left ||
           a.bottom + pad < b.top || b.bottom + pad < a.top);
}

function updateMarkerLabels() {
  const showNames = map.getZoom() >= 12;
  const mapRect = $('map').getBoundingClientRect();
  const barRect = visibleBottomBarEl()?.getBoundingClientRect();
  const candidates = [];

  const collect = (m, priority) => {
    const el = m.getElement?.();
    if (!el) return;
    el.classList.remove('show-name');
    if (!showNames) return;
    const iconRect = el.getBoundingClientRect();
    if (iconRect.width <= 0 || iconRect.height <= 0) return;
    const label = el.querySelector('.glider-label');
    if (!label) return;
    const labelRect = label.getBoundingClientRect();
    if (labelRect.width <= 0 || labelRect.height <= 0) return;
    if (labelRect.left < mapRect.left + 2 || labelRect.right > mapRect.right - 2 ||
        labelRect.top < mapRect.top + 2 || labelRect.bottom > mapRect.bottom - 2) return;
    if (barRect && markerRectsOverlap(labelRect, barRect, 4)) return;
    candidates.push({ el, iconRect, labelRect, priority });
  };

  if (replayActive) {
    replayGroup.eachLayer(m => {
      collect(m, m._replayId === replayFollowAddress ? 4 : 0);
    });
  } else {
    for (const m of markers.values()) {
      const a = m._data;
      if (!a) continue;
      const priority = (isEmergency(a) ? 4 : 0) + (selectedTracks.has(a.address) ? 2 : 0) +
        (pinnedAircraft.has(a.address) ? 1 : 0);
      collect(m, priority);
    }
  }

  if (!candidates.length) return;
  candidates.sort((a, b) => b.priority - a.priority ||
    a.labelRect.left - b.labelRect.left || a.labelRect.top - b.labelRect.top);

  const shown = [];
  for (const c of candidates) {
    if (candidates.some(o => o !== c && markerRectsOverlap(c.labelRect, o.iconRect, 2))) continue;
    if (shown.some(rect => markerRectsOverlap(c.labelRect, rect, 3))) continue;
    c.el.classList.add('show-name');
    shown.push(c.labelRect);
  }
}

function popupRow(label, value) {
  if (value == null || String(value).trim() === '') return '';
  return `<div class="popup-value"><span>${esc(label)}</span><br><b>${esc(String(value))}</b></div>`;
}
function popupRowHtml(label, html) {
  if (!html) return '';
  return `<div class="popup-value"><span>${esc(label)}</span><br><b>${html}</b></div>`;
}

function popup(a) {
  const latStr = a.lat.toFixed(6), lonStr = a.lon.toFixed(6);
  const mapsUrl = `https://www.google.com/maps?q=${encodeURIComponent(latStr + ',' + lonStr)}`;
  const posText = [latStr, lonStr, a.altitude != null ? fmtAltCompact(a.altitude) : ''].filter(Boolean).join(', ');
  const positionRow = `<div class="popup-value" style="grid-column:1/-1"><span>Position</span><br><a href="${mapsUrl}" target="_blank" rel="noopener noreferrer" style="color:#57d3b0;font-weight:700;text-decoration:underline">${esc(posText)}</a></div>`;
  const statusText = getDisplayStatus(a);
  const wxText = formatWeatherHtml(a.weather, false);
  const weatherRow = wxText
    ? `<div class="popup-value" style="grid-column:1/-1"><span>Weather</span><br><b>${wxText}</b></div>`
    : '';
  const ageSec = Math.max(0, Math.floor((serverNow() - a.receivedAtMs) / 1000));
  const lastSeenText = a.aprsReceivedAt ? `${a.aprsReceivedAt} (${fmtAge(ageSec)})` : fmtAge(ageSec);
  const course = a.course != null && Number.isFinite(Number(a.course)) ? Number(a.course) : null;
  const courseValue = course != null
    ? `${Math.round(course)}° <span class="popup-course-arrow" style="transform:rotate(${course}deg)" aria-hidden="true">↑</span>`
    : null;

  const isStation = getResolvedType(a) === 15;
  const stationRows = [];
  if (isStation) {
    const rxStats = getStationReceptionStats(a);
    if (rxStats) {
      stationRows.push(popupRow('Aircraft heard', String(rxStats.count)));
      if (rxStats.best24h) {
        const bestAgeSec = Math.max(0, Math.floor((serverNow() / 1000) - rxStats.best24h.ts));
        stationRows.push(popupRow('Farthest heard (24h)', `${rxStats.best24h.max_km.toFixed(1)} km (${rxStats.best24h.label} · ${fmtAge(bestAgeSec)})`));
      }
    }
  }

  const isTracked = selectedTracks.has(a.address);
  const baro = baroEnabled ? barogramChart(a.address) : null;
  const baroVisible = !!baro;
  const detailRows = [
    popupRow('Aircraft type', typeName(a)),
    popupRow('Over-the-air Name', displayStreamName(a)),
    popupRow('Callsign / CN', a.callsign),
    popupRow('Registration', displayRegistration(a)),
    popupRow('Aircraft model', displayModel(a))
  ].join('');
  const rawSection = a.aprsPacket
    ? `<div class="popup-raw">${esc(a.aprsPacket)}</div>${a.aprsReceivedAt ? `<div class="muted">Recv: ${esc(a.aprsReceivedAt)}</div>` : ''}` : '';
  const detailsBlock = (detailRows.replace(/\s+/g, '') || rawSection)
    ? `<details class="popup-details" data-popup-details="1"><summary>Details & raw packet</summary><div class="popup-grid" style="margin-top:6px">${detailRows}</div>${rawSection}</details>`
    : '';
  const actionButtons = isStation
    ? `<button type="button" data-act="share" data-addr="${esc(a.address)}">🔗 Link</button>`
    : `<button type="button" data-act="track" data-addr="${esc(a.address)}" class="${isTracked ? 'active' : ''}" aria-pressed="${isTracked}">Track</button>
      <button type="button" data-act="replay" data-addr="${esc(a.address)}" title="Replay this aircraft over the last 24 hours">⏱ Replay</button>
      <button type="button" data-act="sar" data-addr="${esc(a.address)}">📋 SAR</button>
      <button type="button" data-act="share" data-addr="${esc(a.address)}">🔗 Link</button>
      <button type="button" data-act="igc" data-addr="${esc(a.address)}">⬇ IGC</button>`;

  const telemetryRows = [
    positionRow,
    popupRow('Climb', a.climb != null ? fmtClimb(a.climb) : null),
    popupRow('Ground speed', a.speed != null ? fmtWindSpeed(a.speed) : null),
    popupRowHtml('Track Direction', courseValue),
    popupRow('Last seen', lastSeenText),
    popupRowHtml('Signal (SNR)', formatSnrHtml(a.snr)),
    weatherRow,
    popupRow('Receiver', a.receiver),
    ...stationRows
  ].join('');

  const baroBlock = baroVisible
    ? `<div class="popup-baro">
        <div class="baro-head"><strong>${esc(baro.title)}</strong></div>
        <svg class="baro-svg popup-baro-svg" data-addr="${esc(a.address)}" viewBox="0 0 460 70" preserveAspectRatio="none" role="img" aria-label="Altitude profile: ${esc(baro.title)}" tabindex="0">${baro.svg}</svg>
      </div>`
    : '';

  return `<div class="popup-title"><span class="popup-name">${esc(displayName(a))}</span>${statusText ? `<span class="popup-status" style="color:${statusColor(a, statusText)}" title="${esc(statusText)}">${esc(statusText)}</span>` : ''}</div>
    <div class="popup-actions">${actionButtons}</div>
    <div class="popup-grid">${telemetryRows}</div>
    ${baroBlock}
    ${detailsBlock}`;
}

function refreshMarkerPopup(address, data = null) {
  const m = markers.get(address);
  if (!m || !m.isPopupOpen()) return;
  const a = data || m._data || aircraft.find(x => x.address === address);
  if (!a) return;
  const popupEl = m.getPopup()?.getElement();
  const detailsEl = popupEl?.querySelector('[data-popup-details]');
  if (detailsEl) m._detailsOpen = detailsEl.open;
  const html = popup(a);
  if (m._popupSig !== html) {
    m._popupSig = html;
    m.setPopupContent(html);
    keepOpenPopupAboveBar(m);
  }
  const newDetails = m.getPopup()?.getElement()?.querySelector('[data-popup-details]');
  if (newDetails) {
    newDetails.open = !!m._detailsOpen;
    newDetails.onTogglePopupDetails = newDetails.onTogglePopupDetails || (() => { m._detailsOpen = newDetails.open; keepOpenPopupAboveBar(m); });
    newDetails.removeEventListener('toggle', newDetails.onTogglePopupDetails);
    newDetails.addEventListener('toggle', newDetails.onTogglePopupDetails);
  }
}

function updateCoverageLayer() {
  coverageLayer.clearLayers();
  if (!map.hasLayer(coverageLayer)) return;
  const rxPos = new Map();
  for (const a of aircraft) {
    if (getResolvedType(a) === 15) {
      for (const k of getStationKeys(a)) rxPos.set(k, a);
    }
  }
  for (const a of aircraft) {
    if (a.snr == null || getResolvedType(a) === 15) continue;
    const color = a.snr >= 25 ? '#57d3b0' : a.snr >= 12 ? '#f5c451' : '#f07878';
    const rx = a.receiver ? rxPos.get(a.receiver.toLowerCase()) : null;
    if (rx) {
      const dist = fmtDistanceKm(haversineKm(rx.lat, rx.lon, a.lat, a.lon));
      L.polyline([[rx.lat, rx.lon], [a.lat, a.lon]], {
        color, weight: 2.5, opacity: 0.85, dashArray: '6 4'
      }).bindTooltip(`${displayName(rx)} → ${displayName(a)} · ${a.snr.toFixed(1)} dB · ${dist}`, { sticky: true })
        .addTo(coverageLayer);
    } else {
      L.circleMarker([a.lat, a.lon], {
        radius: 20, color, fillColor: color, fillOpacity: 0.22, weight: 2
      }).bindTooltip(`${a.receiver || 'Receiver'} → ${displayName(a)} · ${a.snr.toFixed(1)} dB`)
        .addTo(coverageLayer);
    }
  }
}

function getSelectedTypes() {
  const boxes = [...$('type').querySelectorAll('input[type="checkbox"]')];
  const allBox = boxes.find(b => b.value === 'all');
  if (!allBox || allBox.checked) return null;
  const chosen = new Set(boxes.filter(b => b.value !== 'all' && b.checked).map(b => b.value));
  return chosen.size > 0 ? chosen : null;
}

function filtered() {
  const q = $('search').value.trim().toLowerCase();
  const selectedTypes = getSelectedTypes();
  return aircraft.filter(a => {
    if (a.address === pendingHashSelect || lastKnownCache.has(a.address)) return true;
    const matches = !q || `${displayName(a)} ${a.id} ${a.callsign} ${a.registration} ${a.model} ${a.ognId} ${a.address}`.toLowerCase().includes(q);
    if (isEmergency(a)) return matches;
    if (!selectedTypes) return matches;
    const rType = getResolvedType(a);
    const typeMatch =
      (selectedTypes.has('glider') && rType === 1) ||
      (selectedTypes.has('para') && rType === 7) ||
      (selectedTypes.has('fanet') && isFanet(a) && rType !== 15) ||
      (selectedTypes.has('other') && rType !== 1 && rType !== 7 && rType !== 15) ||
      (selectedTypes.has('station') && rType === 15) ||
      (selectedTypes.has('wx') && Boolean(a.weather));
    return matches && typeMatch;
  });
}

function buildRowHtml(a, now) {
  const ageSec = Math.max(0, Math.floor((now - a.receivedAtMs) / 1000));
  const trackEntry = selectedTracks.get(a.address);
  const isSelected = trackEntry ? ' selected' : '';
  const isPinned = pinnedAircraft.has(a.address);
  const pinnedClass = isPinned ? ' pinned' : '';
  const emergClass = isEmergency(a) ? ' emergency' : '';
  const rType = getResolvedType(a);
  const statusText = getDisplayStatus(a);
  const barColor = statusColor(a, statusText);

  const wxCompactHtml = a.weather ? formatWeatherHtml(a.weather, true) : '';
  const metrics = rType === 15
    ? []
    : [a.speed != null ? fmtWindSpeed(a.speed) : '', a.climb != null ? fmtClimb(a.climb) : ''].filter(Boolean);
  const wxListHtml = wxCompactHtml ? `<span class="wx-line">💨 ${wxCompactHtml}</span>` : '';
  const metricsHtml = metrics.length ? `<br>${metrics.join(' · ')}` : '';
  const statusHtml = statusText ? `<br><span style="color:${barColor};font-weight:600">${esc(statusText)}</span>` : '';
  const trackDotHtml = trackEntry ? `<span class="track-dot" style="background:${trackEntry.color}" title="Track shown"></span>` : '';

  let rightColHtml = `${fmtAlt(a.altitude)}<div class="age-row">${signalBarsHtml(a.snr)}<span class="age" data-ts="${a.receivedAtMs}">${fmtAge(ageSec)}</span></div>`;
  let altClass = 'alt';
  if (rType === 15) {
    altClass = 'alt station-alt';
    const rxStats = getStationReceptionStats(a);
    const heardCount = rxStats ? rxStats.count : 0;
    rightColHtml = `${esc(`24h · ${heardCount}`)}<div class="age-row">${signalBarsHtml(a.snr)}<span class="age" data-ts="${a.receivedAtMs}">${fmtAge(ageSec)}</span></div>`;
  }
  if (rType !== 15) {
    const isFollowed = followedAddress === a.address;
    rightColHtml += `<button type="button" class="follow-btn${isFollowed ? ' active' : ''}" data-follow="${esc(a.address)}" title="${isFollowed ? 'Unfollow' : 'Follow'} ${esc(displayName(a))}" aria-pressed="${isFollowed}">${isFollowed ? '◎ Unfollow' : '◎ Follow'}</button>`;
  }

  const label = `${displayName(a)} ${statusText ? '- ' + statusText : ''}`.trim();
  return `<div class="aircraft${emergClass}${pinnedClass}${isSelected}" data-key="${esc(a.address)}" tabindex="0" role="option" aria-selected="${trackEntry ? 'true' : 'false'}" aria-label="${esc(label)}">
    <div class="stripe" style="background:${barColor}"></div><div><div class="callsign">${trackDotHtml}${esc(displayName(a))}<button type="button" class="pin-btn${pinnedClass}" data-pin="${esc(a.address)}" title="${isPinned ? 'Unpin' : 'Pin to top'}" aria-label="${isPinned ? 'Unpin' : 'Pin to top'} ${esc(displayName(a))}" aria-pressed="${isPinned ? 'true' : 'false'}">📌</button></div>
    <div class="meta">${esc([displayRegistration(a), displayModel(a), typeName(a)].filter(Boolean).join(' · '))}${statusHtml}${metricsHtml}${wxListHtml}</div></div>
    <div class="${altClass}">${rightColHtml}</div>
  </div>`;
}

let renderScheduled = false;
function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    render();
  });
}

function isUserInteractingWithList() {
  const ae = document.activeElement;
  return !!(ae && $('aircraftList').contains(ae));
}

function updateListHint() {
  const hint = $('listHint');
  const q = $('search').value.trim();
  const visible = filtered();
  const visibleKeys = new Set(visible.map(a => a.address));
  const hiddenTracks = [...selectedTracks.keys()].filter(k => !visibleKeys.has(k));
  const outsideCount = visible.reduce((n, a) => n + (isInCurrentViewport(a.lat, a.lon) ? 0 : 1), 0);
  const parts = [];
  if (q) parts.push(`Filtering by "${q}".`);
  if (hiddenTracks.length) {
    const names = hiddenTracks.slice(0, 3).map(addr => {
      const a = aircraft.find(x => x.address === addr);
      return a ? displayName(a) : addr.toUpperCase();
    });
    parts.push(`${hiddenTracks.length} selected track${hiddenTracks.length > 1 ? 's' : ''} hidden by filter/search: ${names.join(', ')}${hiddenTracks.length > 3 ? '…' : ''}.`);
  }
  if (outsideCount) parts.push(`${outsideCount} aircraft outside the current map view; pan or zoom to see them.`);
  if (followedAddress && !visibleKeys.has(followedAddress)) {
    parts.push('Followed aircraft is currently outside current filter/view.');
  }
  hint.textContent = parts.join(' ');
}

function render() {
  if (replayActive) return;
  const visible = filtered();
  const listVisible = visible.filter(a => isInCurrentViewport(a.lat, a.lon));
  const keep = new Set(visible.map(a => a.address));
  const now = serverNow();

  render24hAlertsSummary(now);
  updateListHint();

  const emergencies = visible.filter(isEmergency);
  if (emergencies.length > 0) {
    const first = emergencies[0];
    const msg = `🚨 ${emergencies.length} Emergency: ${displayName(first)} (${getDisplayStatus(first)})`;
    const sig = `${first.address}|${emergencies.length}|${msg}`;
    if (emergencyBannerDismissedSig && emergencyBannerDismissedSig !== sig) emergencyBannerDismissedSig = null;
    if ($('emergencyBannerText').textContent !== msg) $('emergencyBannerText').textContent = msg;
    $('emergencyJump').dataset.addr = first.address;
    $('emergencyBanner').dataset.sig = sig;
    $('emergencyBanner').classList.toggle('show', !emergencyBannerDismissedSig);
  } else {
    $('emergencyBanner').classList.remove('show');
    emergencyBannerDismissedSig = null;
  }

  if (!isSpiderfied) {
    for (const [key, m] of markers) {
      if (!keep.has(key)) {
        if (m._isEmergency) emergencyGroup.removeLayer(m);
        else clusterGroup.removeLayer(m);
        markers.delete(key);
      }
    }
  }

  visible.forEach(a => {
    const key = a.address;
    const emerg = isEmergency(a);
    const trackColor = selectedTracks.get(key)?.color || '';
    const iconSig = `${getResolvedType(a)}_${a.course ?? ''}_${emerg ? 1 : 0}_${trackColor}_${displayName(a)}`;
    let m = markers.get(key);

    if (!m) {
      if (isSpiderfied && !emerg) return;
      m = L.marker([a.lat, a.lon], { icon: markerIcon(a), zIndexOffset: emerg ? 1000 : 0 });
      m._iconSig = iconSig; m._isEmergency = emerg; m._trueLat = a.lat; m._trueLon = a.lon; m._data = a; m._trackerMarker = true;
      m.on('click', () => toggleSelection(key, false));
      m._detailsOpen = false;
      m._popupSig = '';
      m.on('popupopen', () => {
        const html = popup(m._data);
        if (m._popupSig !== html) {
          m._popupSig = html;
          m.setPopupContent(html);
        }
        const d = m.getPopup()?.getElement()?.querySelector('[data-popup-details]');
        if (d) {
          d.open = !!m._detailsOpen;
          d.onTogglePopupDetails = d.onTogglePopupDetails || (() => { m._detailsOpen = d.open; keepOpenPopupAboveBar(m); });
          d.removeEventListener('toggle', d.onTogglePopupDetails);
          d.addEventListener('toggle', d.onTogglePopupDetails);
        }
        requestAnimationFrame(() => centerPopupInView(m));
      });
      m.bindPopup(() => popup(m._data), { maxWidth: 360, autoPan: false, keepInView: false });
      markers.set(key, m);
      if (emerg) emergencyGroup.addLayer(m);
      else clusterGroup.addLayer(m);
    } else {
      m._data = a;
      const moved = m._trueLat !== a.lat || m._trueLon !== a.lon;
      if ((!isSpiderfied || m._isEmergency) && moved) {
        m.setLatLng([a.lat, a.lon]);
        m._trueLat = a.lat; m._trueLon = a.lon;
      }
      if (moved) {
        const trackEntry = selectedTracks.get(key);
        if (trackEntry && trackEntry.points) {
          trackEntry.points.push([a.lat, a.lon, a.altitude, Math.floor(a.receivedAtMs / 1000)]);
          if (trackEntry.layer) map.removeLayer(trackEntry.layer);
          trackEntry.layer = buildTrackLayer(trackEntry.points, trackEntry.color);
          if (trackEntry.layer) trackEntry.layer.addTo(map);
        }
      }
      if (!isSpiderfied && m._isEmergency !== emerg) {
        if (m._isEmergency) { emergencyGroup.removeLayer(m); clusterGroup.addLayer(m); }
        else { clusterGroup.removeLayer(m); emergencyGroup.addLayer(m); }
        m._isEmergency = emerg;
      }
      if ((!isSpiderfied || m._isEmergency) && m._iconSig !== iconSig) {
        m.setIcon(markerIcon(a)); m.setZIndexOffset(emerg ? 1000 : 0); m._iconSig = iconSig;
      }
      refreshMarkerPopup(key, a);
    }

    if (followedAddress === key) centerOnFollowed();
  });

  updateCoverageLayer();
  $('listCount').textContent = listVisible.length;

  const sorted = listVisible.slice().sort((a, b) => {
    const ea = isEmergency(a) ? 1 : 0, eb = isEmergency(b) ? 1 : 0;
    if (ea !== eb) return eb - ea;
    const pa = pinnedAircraft.has(a.address) ? 1 : 0, pb = pinnedAircraft.has(b.address) ? 1 : 0;
    if (pa !== pb) return pb - pa;
    return displayName(a).localeCompare(displayName(b), undefined, { sensitivity: 'base', numeric: true });
  });

  const listEl = $('aircraftList');
  const prevScroll = listEl.scrollTop;
  const activeKey = (document.activeElement && listEl.contains(document.activeElement))
    ? (document.activeElement.closest('.aircraft')?.dataset.key || null)
    : null;

  if (!sorted.length) {
    const q = $('search').value.trim();
    const selectedTypes = getSelectedTypes();
    let title = 'No aircraft or stations in current map view.';
    let detail = 'Try panning/zooming, increasing the Active window, or changing filters.';
    let actions = `<button type="button" data-empty-act="reset">Reset filters</button>`;
    if (collectorPaused) {
      title = 'Collector paused (>2m old).';
      detail = 'No fresh positions are available. Check collector cron/process and data freshness.';
      actions = `<button type="button" data-empty-act="refresh">Refresh now</button>`;
    } else if (q || selectedTypes) {
      title = 'No matches for current filters/search.';
      detail = 'Clear search or reset filters to see aircraft in the current map view.';
      actions = `<button type="button" data-empty-act="clear-search">Clear search</button><button type="button" data-empty-act="reset">Reset filters</button>`;
    } else if (aircraft.length === 0) {
      title = lastFetchOkAtMs ? 'No live traffic in this area right now.' : 'Waiting for live data…';
      detail = lastFetchOkAtMs ? 'Data source is connected, but nothing is in the current view/window.' : 'Connecting to the live feed. This may take a few seconds.';
      actions = `<button type="button" data-empty-act="refresh">Refresh now</button><button type="button" data-empty-act="reset">Reset filters</button>`;
    }
    listEl.innerHTML = `<div class="empty"><b>${esc(title)}</b><div>${esc(detail)}</div><div class="empty-actions">${actions}</div></div>`;
  } else {
    const existingRows = [...listEl.querySelectorAll('.aircraft[data-key]')];
    const existingMap = new Map(existingRows.map(r => [r.dataset.key, r]));
    const frag = document.createDocumentFragment();
    let changedStructure = existingRows.length !== sorted.length;

    sorted.forEach(a => {
      const key = a.address;
      const html = buildRowHtml(a, now);
      let row = existingMap.get(key);
      if (row) {
        if (row.outerHTML !== html) {
          const tmp = document.createElement('div');
          tmp.innerHTML = html;
          const fresh = tmp.firstElementChild;
          row.replaceWith(fresh);
          row = fresh;
        }
        existingMap.delete(key);
      } else {
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        row = tmp.firstElementChild;
        changedStructure = true;
      }
      frag.appendChild(row);
    });

    if (existingMap.size > 0) changedStructure = true;
    if (changedStructure || listEl.children.length !== sorted.length) {
      listEl.replaceChildren(frag);
    } else {
      // Order same and no structural change; rows were updated in place above.
    }

    // Restore focus/scroll to avoid disruption during periodic refresh.
    if (Math.abs(listEl.scrollTop - prevScroll) > 2) listEl.scrollTop = prevScroll;
    if (activeKey && !isUserInteractingWithList()) {
      const focusRow = listEl.querySelector(`.aircraft[data-key="${CSS.escape(activeKey)}"]`);
      if (focusRow && document.activeElement !== focusRow) focusRow.focus({ preventScroll: true });
    }
  }

  if (pendingHashSelect && markers.has(pendingHashSelect)) {
    const target = pendingHashSelect;
    pendingHashSelect = null;
    toggleSelection(target, true);
  }
  updateMarkerLabels();
}

$('alertsToggle').addEventListener('click', () => {
  alertsCollapsed = !alertsCollapsed;
  try { localStorage.setItem('ogn_alerts_collapsed', alertsCollapsed ? '1' : '0'); } catch (e) {}
  render24hAlertsSummary(serverNow());
});

$('alerts24hSummary').addEventListener('click', e => {
  const btn = e.target.closest('[data-alert-addr]');
  if (!btn) return;
  const addr = btn.dataset.alertAddr;
  if (addr) jumpToAlertAddress(addr);
});

$('aircraftList').addEventListener('click', e => {
  const emptyAct = e.target.closest('[data-empty-act]');
  if (emptyAct) {
    const act = emptyAct.dataset.emptyAct;
    if (act === 'reset') resetFilters();
    else if (act === 'clear-search') { $('search').value = ''; updateSearchUi(); render(); }
    else if (act === 'fit') fitToResults();
    else if (act === 'refresh') fetchLive(true);
    return;
  }
  const pinBtn = e.target.closest('.pin-btn');
  if (pinBtn) {
    e.stopPropagation();
    togglePin(pinBtn.dataset.pin);
    return;
  }
  const followBtn = e.target.closest('.follow-btn');
  if (followBtn) {
    e.stopPropagation();
    toggleFollow(followBtn.dataset.follow);
    return;
  }
  const row = e.target.closest('.aircraft');
  if (row) toggleSelection(row.dataset.key, true);
});

$('aircraftList').addEventListener('keydown', e => {
  const row = e.target.closest('.aircraft');
  if (!row) return;
  if (e.key === 'Enter' || e.key === ' ') {
    const pinBtn = e.target.closest('.pin-btn');
    if (pinBtn) {
      e.preventDefault();
      togglePin(pinBtn.dataset.pin);
      return;
    }
    const followBtn = e.target.closest('.follow-btn');
    if (followBtn) {
      e.preventDefault();
      toggleFollow(followBtn.dataset.follow);
      return;
    }
    e.preventDefault();
    toggleSelection(row.dataset.key, true);
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const rows = [...$('aircraftList').querySelectorAll('.aircraft[data-key]')];
    const idx = rows.indexOf(row);
    if (idx === -1) return;
    const next = rows[e.key === 'ArrowDown' ? idx + 1 : idx - 1];
    if (next) next.focus();
  }
});

document.addEventListener('click', e => {
  const btn = e.target.closest('.popup-actions button');
  if (!btn) return;
  const addr = btn.dataset.addr, act = btn.dataset.act;
  if (act === 'alert-sar') {
    const txt = btn.dataset.sar || '';
    if (!txt) return;
    navigator.clipboard.writeText(txt).then(() => { btn.textContent = '✓ Copied'; setTimeout(() => { btn.textContent = '📋 SAR'; }, 1500); }).catch(() => copyTextToClipboard(txt, 'SAR copied'));
    return;
  }
  if (act === 'replay') {
    if (!addr) return;
    replayFollowAddress = addr.toLowerCase();
    replayOnlyFocus = true;
    replayDirection = 1;
    followCenteringPaused = false;
    syncReplayDirectionButton();
    syncRecenterButton();
    $('replaySlider').value = '0';
    markers.get(addr)?.closePopup();
    setReplayMode(true, { startAtTrackStart: true, play: true });
    syncReplayFollowLabel();
    return;
  }
  const a = aircraft.find(x => x.address === addr);
  if (act === 'track') {
    if (!addr) return;
    toggleSelection(addr, false);
    const m = markers.get(addr);
    const aa = aircraft.find(x => x.address === addr);
    if (m && aa && m.isPopupOpen()) {
      const d = m.getPopup()?.getElement()?.querySelector('[data-popup-details]');
      if (d) m._detailsOpen = d.open;
      const html = popup(aa);
      if (m._popupSig !== html) { m._popupSig = html; m.setPopupContent(html); keepOpenPopupAboveBar(m); }
      const nd = m.getPopup()?.getElement()?.querySelector('[data-popup-details]');
      if (nd) {
        nd.open = !!m._detailsOpen;
        nd.onTogglePopupDetails = nd.onTogglePopupDetails || (() => { m._detailsOpen = nd.open; });
        nd.removeEventListener('toggle', nd.onTogglePopupDetails);
        nd.addEventListener('toggle', nd.onTogglePopupDetails);
      }
    }
  } else if (act === 'share') {
    const base = getShareUrl();
    const url = addr ? `${base.replace(/#.*/, '')}#${map.getCenter().lat.toFixed(4)},${map.getCenter().lng.toFixed(4)},${map.getZoom()},${encodeURIComponent(addr)}` : base;
    copyTextToClipboard(url, 'Link copied');
  } else if (act === 'sar' && a) {
    const ageSec = Math.max(0, Math.floor((serverNow() - a.receivedAtMs) / 1000));
    const shareUrl = `${location.href.replace(/#.*/, '')}#${a.lat.toFixed(4)},${a.lon.toFixed(4)},${Math.max(map.getZoom(), 12)},${encodeURIComponent(a.address)}`;
    const txt = [
      `SAR Info: ${displayName(a)}`,
      `Status: ${getDisplayStatus(a) || 'Unknown'}`,
      `Coords: ${a.lat.toFixed(6)}, ${a.lon.toFixed(6)}`,
      `Alt: ${a.altitude != null ? fmtAlt(a.altitude) : 'N/A'}`,
      `Last heard: ${fmtAge(ageSec)}`,
      `Map: https://www.google.com/maps?q=${a.lat.toFixed(6)},${a.lon.toFixed(6)}`,
      `Tracker: ${shareUrl}`
    ].join('\n');
    navigator.clipboard.writeText(txt).then(() => { btn.textContent = '✓ Copied'; setTimeout(() => { btn.textContent = '📋 SAR'; }, 1500); }).catch(() => copyTextToClipboard(txt, 'SAR copied'));
  } else if (act === 'igc') {
    if (!selectedTracks.has(addr)) {
      selectedTracks.set(addr, { color: pickTrackColor(), layer: null, points: [], reqId: 0 });
      loadTrack(addr).then(() => downloadIgc(addr));
    } else {
      downloadIgc(addr);
    }
  }
});

let lastThermalBoundsKey = '';

function thermalNormLon(lon) {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

// Mirror ogn-proxy.php parse_bounds() so panning inside the same 0.1° cell
// doesn't trigger another request.
function thermalParamsForBounds(b) {
  const south = Math.max(-90, Math.min(90, Math.floor(b.getSouth() * 10) / 10));
  const north = Math.max(-90, Math.min(90, Math.ceil(b.getNorth() * 10) / 10));
  const rawWest = b.getWest(), rawEast = b.getEast();
  const fullWorld = (rawEast - rawWest) >= 360;
  const west = fullWorld ? -180 : thermalNormLon(Math.floor(rawWest * 10) / 10);
  const east = fullWorld ? 180 : thermalNormLon(Math.ceil(rawEast * 10) / 10);
  return new URLSearchParams({
    thermals: '1',
    south: south.toFixed(1), north: north.toFixed(1),
    west: west.toFixed(1), east: east.toFixed(1)
  });
}

async function fetchThermals(force = false) {
  if (!map.hasLayer(thermalLayer)) return;
  const params = thermalParamsForBounds(map.getBounds());
  const key = params.toString();
  if (!force && key === lastThermalBoundsKey) return;
  lastThermalBoundsKey = key;

  try {
    const res = await fetch(`ogn-proxy.php?${params}`, { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      thermalLayer.setLatLngs(Array.isArray(data.points) ? data.points : []);
    }
  } catch (e) {}
}

map.on('overlayadd', e => {
  if (e.layer === thermalLayer) fetchThermals(true);
  if (e.layer === coverageLayer) updateCoverageLayer();
});

map.on('overlayremove', e => {
  if (e.layer === thermalLayer) lastThermalBoundsKey = '';
});

setInterval(() => fetchThermals(true), 600000);

const WIDE_VIEW_AREA = 100;
let nextLivePollAtMs = 0;

function currentViewArea() {
  const b = map.getBounds();
  const spanLat = Math.max(0, b.getNorth() - b.getSouth());
  let spanLon = b.getEast() - b.getWest();
  if (spanLon < 0) spanLon += 360;
  return spanLat * Math.min(spanLon, 360);
}

function livePollIntervalMs(area) {
  if (area >= 2000) return 20000;
  if (area >= 500) return 10000;
  if (area >= WIDE_VIEW_AREA) return 7000;
  return 5000;
}

function boundsMovedSignificantly(b) {
  if (!lastMetaBounds) return true;
  const c = b.getCenter();
  const dLat = Math.abs(c.lat - lastMetaBounds.lat);
  const dLng = Math.abs(c.lng - lastMetaBounds.lng);
  const dSpan = Math.abs((b.getNorth() - b.getSouth()) - lastMetaBounds.spanLat);
  return dLat > 0.2 || dLng > 0.2 || dSpan > 0.25;
}

async function fetchLive(force = false) {
  if (replayActive || fetching || (document.hidden && !force)) return;
  const nowAttemptMs = Date.now();
  if (!force && nowAttemptMs < nextLivePollAtMs) return;
  nextLivePollAtMs = nowAttemptMs + livePollIntervalMs(currentViewArea());
  lastFetchAttemptAtMs = nowAttemptMs;
  fetching = true;
  try {
    const b = map.getBounds();
    const shouldFetchMeta = needMeta || boundsMovedSignificantly(b);
    const params = new URLSearchParams({
      live: '1',
      south: (Math.floor(b.getSouth() * 10) / 10).toFixed(1),
      north: (Math.ceil(b.getNorth() * 10) / 10).toFixed(1),
      west: (Math.floor(b.getWest() * 10) / 10).toFixed(1),
      east: (Math.ceil(b.getEast() * 10) / 10).toFixed(1),
      window: $('markerWindow').value,
      meta: shouldFetchMeta ? '1' : '0'
    });
    if (shouldFetchMeta) params.set('nc', String(Date.now()));

    const response = await fetch(`ogn-proxy.php?${params}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();

    let serverNamesChanged = false;
    const namesUpdated = Number(payload.names_updated) || 0;
    if (namesUpdated && namesUpdated !== lastNameUpdated) {
      lastNameUpdated = namesUpdated;
      serverNamesChanged = true;
    }

    if (wasDisconnected) {
      wasDisconnected = false;
      applySavedMenuPrefs();
      syncUnitButtons();
      needMeta = true;
    }

    if (payload.server_time) serverClockOffsetMs = (Number(payload.server_time) * 1000) - Date.now();
    const nowTick = serverNow();

    let nameChanged = false;
    const serverNames = payload.names && typeof payload.names === 'object' ? payload.names : null;
    if (payload.ddb && typeof payload.ddb === 'object') {
      for (const [id, info] of Object.entries(payload.ddb)) ddbCache.set(id, info);
    }
    if (payload.station_stats && typeof payload.station_stats === 'object') {
      stationStatsCache.clear();
      for (const [id, st] of Object.entries(payload.station_stats)) stationStatsCache.set(id.toLowerCase(), st);
    }
    if (Array.isArray(payload.alerts_24h)) {
      alerts24hHistory.clear();
      for (const al of payload.alerts_24h) {
        if (al && al.address && al.status && al.ts && !/^need a ride/i.test(String(al.status))) {
          const addrKey = String(al.address).toLowerCase();
          const latVal = Number.isFinite(Number(al.lat)) ? Number(al.lat) : null;
          const lonVal = Number.isFinite(Number(al.lon)) ? Number(al.lon) : null;
          alerts24hHistory.set(addrKey, {
            address: addrKey,
            name: String(al.name || al.address).toUpperCase(),
            status: cleanAlertStatus(al.status),
            lastStatus: cleanAlertStatus(al.last_status || al.status),
            lat: latVal,
            lon: lonVal,
            alt: Number.isFinite(Number(al.alt)) ? Number(al.alt) : null,
            raw: String(al.raw || ''),
            tsMs: Number(al.ts) * 1000,
            latestTsMs: Number.isFinite(Number(al.latest_ts)) ? Number(al.latest_ts) * 1000 : Number(al.ts) * 1000,
            normalAfter: Boolean(al.normal_after),
            alertStillOn: Boolean(al.alert_still_on)
          });
        }
      }
      save24hAlerts(nowTick);
    }

    const incoming = payload.packets && typeof payload.packets === 'object' ? payload.packets : {};
    const incomingIds = new Set(Object.keys(incoming));
    const rawNamedIds = new Set();
    let sawUnknown = false;
    for (const existingId of aprsCache.keys()) {
      if (!incomingIds.has(existingId)) aprsCache.delete(existingId);
    }
    for (const [id, pkt] of Object.entries(incoming)) {
      if (!knownIds.has(id)) { knownIds.add(id); sawUnknown = true; }
      const tsMs = (Number(pkt.timestamp) || Math.floor(Date.now() / 1000)) * 1000;
      const prev = aprsCache.get(id);
      const raw = pkt.raw || '';
      const streamName = extractStreamName(raw);
      if (streamName) rawNamedIds.add(id);
      if (streamName && nameCache.get(id) !== streamName) {
        nameCache.set(id, streamName);
        nameChanged = true;
      }
      if (!prev || prev.timestamp !== tsMs || prev.raw !== raw) {
        aprsCache.set(id, {
          raw,
          received_at: new Date(tsMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
          timestamp: tsMs
        });
      }
    }

    const incomingTel = payload.telemetry && typeof payload.telemetry === 'object' ? payload.telemetry : {};
    const incomingTelIds = new Set(Object.keys(incomingTel));
    for (const existingTelId of telemetryCache.keys()) {
      if (!incomingTelIds.has(existingTelId)) telemetryCache.delete(existingTelId);
    }
    for (const [id, pkt] of Object.entries(incomingTel)) {
      const tsMs = (Number(pkt.timestamp) || Math.floor(Date.now() / 1000)) * 1000;
      const raw = pkt.raw || '';
      const streamName = extractStreamName(raw);
      if (streamName) rawNamedIds.add(id);
      if (streamName && nameCache.get(id) !== streamName) {
        nameCache.set(id, streamName);
        nameChanged = true;
      }
      const prev = telemetryCache.get(id);
      if (!prev || prev.timestamp !== tsMs || prev.raw !== raw) {
        telemetryCache.set(id, { raw, timestamp: tsMs });
      }
    }

    // Server names are applied only when this payload did not carry a fresher
    // over-the-air Name for the same ID (which may be newer than the proxy cache).
    if (serverNames) {
      for (const [id, name] of Object.entries(serverNames)) {
        if (rawNamedIds.has(id)) continue;
        const clean = cleanName(name);
        if (clean && String(nameCache.get(id) || '').toLowerCase() !== clean.toLowerCase()) {
          nameCache.set(id, clean);
          nameChanged = true;
        }
      }
    }

    const incomingWx = payload.station_weather && typeof payload.station_weather === 'object' ? payload.station_weather : {};
    for (const [id, entry] of Object.entries(incomingWx)) {
      if (entry && entry.wx && typeof entry.wx === 'object') {
        const tsMs = (Number(entry.timestamp) || Math.floor(Date.now() / 1000)) * 1000;
        updateWeatherCache([id], entry.wx, tsMs);
      }
    }

    if (nameChanged) saveNameCache();

    // Ask for full metadata only when the server's name version changed (or a
    // new device appeared). An over-the-air Name already updates nameCache here.
    needMeta = sawUnknown || serverNamesChanged;
    if (shouldFetchMeta) {
      const c = b.getCenter();
      lastMetaBounds = { lat: c.lat, lng: c.lng, spanLat: b.getNorth() - b.getSouth() };
    }

    const updatedMs = (Number(payload.updated) || 0) * 1000;
    collectorPaused = !updatedMs || (nowTick - updatedMs) > 120000;

    // The payload is already cached here. A rendering failure must not be
    // reported as a live-data disconnect.
    lastFetchOkAtMs = Date.now();
    liveFailures = 0;

    try {
      rebuildAircraftArray();
      render();
    } catch (err) {
      console.error('ogn-tracker render error', err);
      setStatus('warning', 'Live data received · display refresh issue');
      return;
    }

    // Keep a shared-link lookup message visible briefly even if live data lands.
    if (Date.now() < hashLookupMessageUntilMs) return;

    const updatedSecAgo = updatedMs ? Math.max(0, Math.floor((nowTick - updatedMs) / 1000)) : null;
    if (collectorPaused) {
      setStatus('error', updatedSecAgo != null ? `Collector paused (${fmtAge(updatedSecAgo).replace(' ago', '')} old)` : 'Collector paused (>2m old)');
    } else {
      const identified = aircraft.filter(a => a.callsign || a.registration || a.streamName || !/([0-9A-F]{6})$/i.test(a.liveLabel)).length;
      setStatus('live', `${aircraft.length} tracking · ${identified} identified`);
    }
  } catch (err) {
    console.warn('ogn-tracker live fetch failed', err);
    wasDisconnected = true;
    liveFailures++;
    const viewArea = currentViewArea();
    const staleAgeMs = lastFetchOkAtMs ? Date.now() - lastFetchOkAtMs : Infinity;
    const reconnectAfterMs = Math.max(60000, livePollIntervalMs(viewArea) * 4);
    const stale = Number.isFinite(staleAgeMs)
      ? ` · last update ${fmtAge(Math.max(0, Math.floor(staleAgeMs / 1000)))}` : '';
    const wideHint = viewArea >= WIDE_VIEW_AREA
      ? ' · wide view: zoom in for faster updates' : '';

    let kind = 'error';
    let label;
    if (!Number.isFinite(staleAgeMs)) {
      label = 'Waiting for live data';
    } else if (staleAgeMs <= reconnectAfterMs) {
      kind = 'warning';
      label = 'Live data delayed';
    } else {
      label = 'Reconnecting to live data';
    }
    setStatus(kind, `${label}${stale}${wideHint}`);
  } finally {
    fetching = false;
    updateStatusUpdated();
  }
}

function replaySpeed() {
  return Math.max(1, Math.min(50, Math.round(replaySpeedValue)));
}

function adjustReplaySpeed(delta) {
  replaySpeedValue = replaySpeed() + delta;
  syncReplaySpeedUi();
}

function syncReplaySpeedUi() {
  const speed = replaySpeed();
  const out = $('replaySpeedValue');
  if (out) {
    out.textContent = `${speed}×`;
    out.title = `Replay speed: ${speed}× (use ◀ / ▶ beside the slider)`;
  }
  for (const id of ['replaySpeedDown', 'replaySpeedUp']) {
    $(id)?.setAttribute('aria-valuetext', `${speed} times normal speed`);
  }
}

function replaySpanMs() {
  const nowMs = serverNow();
  if (replayRangeIndex >= REPLAY_RANGE_MINUTES.length) {
    const d = new Date(nowMs);
    const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    return Math.max(60000, nowMs - midnight);
  }
  return REPLAY_RANGE_MINUTES[replayRangeIndex] * 60000;
}

/** Split an aircraft's 24h fixes into distinct tracks on reception gaps. */
function computeReplayTrackSegments(points) {
  const valid = (Array.isArray(points) ? points : [])
    .filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[3]))
    .slice()
    .sort((a, b) => a[3] - b[3]);
  const segments = [];
  let current = [];
  for (const p of valid) {
    if (current.length && p[3] - current[current.length - 1][3] > REPLAY_TRACK_GAP_S) {
      segments.push({ startTs: current[0][3], endTs: current[current.length - 1][3], points: current });
      current = [];
    }
    current.push(p);
  }
  if (current.length) {
    segments.push({ startTs: current[0][3], endTs: current[current.length - 1][3], points: current });
  }
  return segments;
}

/** Effective replay bounds: extends back to the focused aircraft's earliest fix. */
function replayWindow() {
  const end = serverNow();
  const rangeStart = end - replaySpanMs();
  const start = replayTrackSegments.length
    ? Math.min(rangeStart, replayTrackSegments[0].startTs * 1000 - 60000)
    : rangeStart;
  return { start, end: Math.max(end, start + 60000) };
}

function currentReplayTrackIndex() {
  if (!replayTrackSegments.length) return -1;
  let idx = 0;
  for (let i = 0; i < replayTrackSegments.length; i++) {
    if (replayTsMs >= replayTrackSegments[i].startTs * 1000) idx = i;
    else break;
  }
  return idx;
}

function syncReplayTrackMarks() {
  const box = $('replayTrackMarks');
  if (!box) return;
  const segs = replayFollowAddress ? replayTrackSegments : [];
  const fmt = t => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const marks = [];
  segs.forEach((seg, i) => {
    marks.push({ ts: seg.startTs, kind: 'start', title: `Track ${i + 1} start: ${fmt(seg.startTs)}` });
    marks.push({ ts: seg.endTs, kind: 'end', title: `Track ${i + 1} end: ${fmt(seg.endTs)}` });
  });
  const sig = marks.map(m => `${m.kind}:${m.ts}`).join(',');
  if (box.dataset.sig !== sig) {
    box.replaceChildren();
    marks.forEach(m => {
      const tick = document.createElement('i');
      tick.className = `replay-track-mark ${m.kind}`;
      tick.title = m.title;
      box.appendChild(tick);
    });
    box.dataset.sig = sig;
  }
  if (!marks.length) return;
  const { start, end } = replayWindow();
  [...box.children].forEach((tick, i) => {
    const ratio = (marks[i].ts * 1000 - start) / Math.max(1, end - start);
    tick.hidden = ratio < 0 || ratio > 1;
    tick.style.left = `calc(8px + (100% - 16px) * ${ratio})`;
  });
}

function syncReplayTrackUi() {
  const count = replayTrackSegments.length;
  const hasTracks = !!replayFollowAddress && count > 0;
  const label = `${currentReplayTrackIndex() + 1}/${count}`;
  for (const [id, icon, word] of [['replayPrevTrack', '⏮', 'Previous'], ['replayNextTrack', '⏭', 'Next']]) {
    const btn = $(id);
    if (!btn) continue;
    btn.hidden = !hasTracks || count < 2;
    if (!btn.hidden) {
      btn.textContent = compactReplayUi() ? icon : `${icon} ${label}`;
      btn.title = `${word} track (${label})`;
      btn.setAttribute('aria-label', btn.title);
    }
  }
  syncReplayTrackMarks();
  if (replayActive) syncBottomBarOffset();
}

/** Move to an adjacent track's first fix, wrapping at either end. */
function jumpToReplayTrack(delta) {
  if (replayTrackSegments.length < 2) return;
  const idx = (currentReplayTrackIndex() + delta + replayTrackSegments.length) % replayTrackSegments.length;
  replayTsMs = replayTrackSegments[idx].startTs * 1000;
  updateReplaySliderFromTs();
  lastReplaySliceMinute = null;
  followCenteringPaused = false;
  syncRecenterButton();
  centerOnFollowed(true);
  syncReplayTrackUi();
  loadReplaySlice();
}

function syncReplayRangeButton() {
  const btn = $('replayRange');
  if (!btn) return;
  const label = REPLAY_RANGE_LABELS[replayRangeIndex];
  const title = `Replay window: ${REPLAY_RANGE_TITLES[replayRangeIndex]} (click to cycle)`;
  btn.textContent = label;
  btn.title = title;
  btn.setAttribute('aria-label', title);
}

function syncReplayDirectionButton() {
  const btn = $('replayReverse');
  if (!btn) return;
  const reversed = replayDirection < 0;
  btn.classList.toggle('active', reversed);
  btn.setAttribute('aria-pressed', String(reversed));
  btn.title = reversed ? 'Rewinding — click to play forward' : 'Rewind replay';
  btn.setAttribute('aria-label', reversed ? 'Rewind active, click to play forward' : 'Rewind replay');
}

function syncReplayFollowLabel() {
  const scopeBtn = $('replayClearFollow');
  const hasFocus = !!replayFollowAddress;
  if (scopeBtn) {
    scopeBtn.hidden = !hasFocus;
    scopeBtn.textContent = compactReplayUi()
      ? (replayOnlyFocus ? '👁' : '🎯')
      : (replayOnlyFocus ? '👁 All' : '🎯 Only');
    scopeBtn.title = replayOnlyFocus ? 'Show all aircraft while staying centered' : 'Show only this aircraft';
    scopeBtn.setAttribute('aria-label', scopeBtn.title);
  }
  syncReplayTrackUi();
}

function replayTsFromSlider() {
  const slider = $('replaySlider');
  const ratio = Number(slider.value) / Math.max(1, Number(slider.max));
  const { start, end } = replayWindow();
  return start + (end - start) * ratio;
}

function updateReplaySliderFromTs() {
  const slider = $('replaySlider');
  const max = Math.max(1, Number(slider.max));
  const { start, end } = replayWindow();
  const ratio = (replayTsMs - start) / Math.max(1, end - start);
  slider.value = String(Math.max(0, Math.min(max, ratio * max)));
}

function stopReplayPlayback() {
  if (!replayTimer) return;
  clearInterval(replayTimer);
  replayTimer = null;
  replayLastTickMs = 0;
  $('replayPlay').textContent = '▶';
  $('replayPlay').setAttribute('aria-label', 'Play replay');
}

function startReplayPlayback() {
  if (replayTimer) return;
  if (!replayTsMs) replayTsMs = replayTsFromSlider();
  replayLastTickMs = Date.now();
  $('replayPlay').textContent = '⏸';
  $('replayPlay').setAttribute('aria-label', 'Pause replay');
  replayTimer = setInterval(() => {
    const wallNow = Date.now();
    const elapsedMs = Math.max(0, wallNow - replayLastTickMs);
    replayLastTickMs = wallNow;
    replayTsMs += elapsedMs * replaySpeed() * replayDirection;
    const { start, end } = replayWindow();
    if (replayTsMs > end) replayTsMs = start;
    else if (replayTsMs < start) replayTsMs = end;
    updateReplaySliderFromTs();
    syncReplayTrackUi();
    const minute = Math.floor(replayTsMs / 60000);
    if (minute !== lastReplaySliceMinute) loadReplaySlice();
  }, 1000);
}

function replayTrackLayers(points, weight, opacity, dashed = false) {
  if (points.length < 2) return [];
  if (!varioTrackMode) {
    const color = selectedTracks.get(replayFollowAddress)?.color || '#57d3b0';
    return [L.polyline(points.map(p => [p[0], p[1]]), { color, weight, opacity, dashArray: dashed ? '3 6' : null })];
  }
  const layers = [];
  for (let i = 1; i < points.length; i++) {
    const p0 = points[i - 1], p1 = points[i];
    const dt = p1[3] - p0[3];
    const climb = (p0[2] != null && p1[2] != null && dt > 0 && dt < 300) ? (p1[2] - p0[2]) / dt : null;
    layers.push(L.polyline([[p0[0], p0[1]], [p1[0], p1[1]]], {
      color: varioColor(climb), weight, opacity, dashArray: dashed ? '3 6' : null
    }));
  }
  return layers;
}

function updateReplayTrackLine() {
  replayTrackGroup.clearLayers();
  if (!replayFollowAddress) return;
  const segments = replayTrackSegments.length ? replayTrackSegments : [{ points: replayTrackPoints }];
  for (const seg of segments) {
    const valid = (seg.points || []).filter(p =>
      Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[3]));
    replayTrackLayers(valid, 2, 0.25, true).forEach(l => l.addTo(replayTrackGroup));
    if (replayTsMs) {
      const upTo = valid.filter(p => p[3] * 1000 <= replayTsMs);
      replayTrackLayers(upTo, 3, 0.9).forEach(l => l.addTo(replayTrackGroup));
    }
  }
}

async function loadReplayTrack() {
  replayTrackPoints = [];
  replayTrackSegments = [];
  replayTrackGroup.clearLayers();
  syncReplayTrackUi();
  if (!replayFollowAddress) return;
  // Always load the full 24h so every distinct track is available, regardless
  // of the replay window selected with the range button.
  const since = Math.floor(serverNow() / 1000) - 86400;
  const params = new URLSearchParams({ track: '1', id: replayFollowAddress, since: String(since) });
  try {
    const res = await fetch(`ogn-proxy.php?${params}`);
    if (!res.ok) return;
    const data = await res.json();
    replayTrackPoints = Array.isArray(data.points) ? data.points : [];
    replayTrackSegments = computeReplayTrackSegments(replayTrackPoints);
    updateReplayTrackLine();
    syncReplayTrackUi();
  } catch (e) {}
}

async function loadReplaySlice() {
  const ts = replayTsMs
    ? Math.floor(replayTsMs / 1000)
    : Math.floor(replayTsFromSlider() / 1000);
  if (!replayTsMs) replayTsMs = ts * 1000;
  lastReplaySliceMinute = Math.floor(ts / 60);
  $('replayTime').textContent = new Date(ts * 1000).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', hour12: !compactReplayUi()
  });
  updateReplayTrackLine();
  const hasFocus = !!replayFollowAddress;
  const filtering = hasFocus && replayOnlyFocus;
  const b = filtering
    ? { getSouth: () => -90, getNorth: () => 90, getWest: () => -180, getEast: () => 180 }
    : map.getBounds();
  const params = new URLSearchParams({
    replay: '1', ts: String(ts),
    south: b.getSouth().toFixed(1), north: b.getNorth().toFixed(1),
    west: b.getWest().toFixed(1), east: b.getEast().toFixed(1)
  });
  if (filtering) params.set('id', replayFollowAddress);
  try {
    const res = await fetch(`ogn-proxy.php?${params}`);
    if (!res.ok) return;
    const data = await res.json();
    replayGroup.clearLayers();
    const points = data.aircraft || [];
    replayPoints = points;
    points.forEach(p => {
      const isFocused = hasFocus && p.id === replayFollowAddress;
      const name = esc(p.label);
      const marker = L.marker([p.lat, p.lon], {
        icon: L.divIcon({
          className: `glider-icon replay-icon${isFocused ? ' focused' : ''}`,
          html: `<div class="replay-dot${isFocused ? ' focused' : ''}"></div><div class="glider-label" title="${name}">${name}</div>`,
          iconSize: [16, 16], iconAnchor: [8, 8]
        })
      }).bindTooltip(`${p.label}${p.alt != null ? ' · ' + fmtAlt(p.alt) : ''}${p.ts ? ' · ' + new Date(p.ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}`);
      marker._replayId = p.id;
      marker.addTo(replayGroup);
    });
    updateMarkerLabels();
    if (hasFocus) centerOnFollowed();
  } catch (e) {}
}

function setReplayMode(on, opts = {}) {
  replayActive = on;
  $('btnReplay').classList.toggle('active', on);
  $('btnReplay').setAttribute('aria-pressed', String(on));
  $('replayBar').classList.toggle('show', on);
  syncBottomBarOffset();
  if (on) {
    map.removeLayer(clusterGroup); map.removeLayer(emergencyGroup);
    replayTrackGroup.addTo(map);
    replayGroup.addTo(map);
    replayTsMs = replayTsFromSlider();
    syncReplayFollowLabel();
    replayTrackPromise = loadReplayTrack();
    if (opts.startAtTrackStart && replayFollowAddress) {
      // Wait for the 24h track so playback begins at the aircraft's first fix
      // (earliest point of its first track), not at the window boundary.
      replayTrackPromise.then(() => {
        if (replayTrackSegments.length) {
          replayTsMs = replayTrackSegments[0].startTs * 1000;
          updateReplaySliderFromTs();
          syncReplayTrackUi();
        }
        lastReplaySliceMinute = null;
        loadReplaySlice();
        if (opts.play) startReplayPlayback();
      });
    } else {
      loadReplaySlice();
    }
  } else {
    stopReplayPlayback();
    replayTsMs = 0;
    lastReplaySliceMinute = null;
    replayFollowAddress = null;
    replayPoints = [];
    replayOnlyFocus = false;
    replayDirection = 1;
    followCenteringPaused = false;
    syncReplayDirectionButton();
    syncReplayFollowLabel();
    syncRecenterButton();
    map.removeLayer(replayGroup); replayGroup.clearLayers();
    map.removeLayer(replayTrackGroup); replayTrackGroup.clearLayers();
    replayTrackPoints = [];
    replayTrackSegments = [];
    replayTrackPromise = null;
    syncReplayTrackUi();
    clusterGroup.addTo(map); emergencyGroup.addTo(map);
    fetchLive(true);
  }
}

function parseOpenAirToGeoJson(text) {
  const features = [];
  let name = 'Airspace', coords = [];
  const flush = () => {
    if (coords.length >= 3) {
      coords.push(coords[0]);
      features.push({ type: 'Feature', properties: { name }, geometry: { type: 'Polygon', coordinates: [coords] } });
    }
    coords = [];
  };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('*')) continue;
    if (line.startsWith('AC ')) { flush(); name = line.slice(3).trim(); }
    else if (line.startsWith('AN ')) { name = line.slice(3).trim(); }
    else if (line.startsWith('DP ')) {
      const m = line.match(/DP\s+(\d+):(\d+):(\d+(?:\.\d+)?)\s*([NS])\s+(\d+):(\d+):(\d+(?:\.\d+)?)\s*([EW])/i);
      if (m) {
        let lat = +m[1] + +m[2] / 60 + +m[3] / 3600; if (m[4].toUpperCase() === 'S') lat = -lat;
        let lon = +m[5] + +m[6] / 60 + +m[7] / 3600; if (m[8].toUpperCase() === 'W') lon = -lon;
        coords.push([lon, lat]);
      }
    }
  }
  flush();
  return { type: 'FeatureCollection', features };
}

let moveTimer = null;
map.on('moveend', () => {
  updateUrlHash();
  render24hAlertsSummary(serverNow());
  scheduleRender();
  clearTimeout(moveTimer);
  moveTimer = setTimeout(() => {
    if (replayActive) loadReplaySlice();
    else { fetchLive(true); fetchThermals(); }
  }, 300);
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !replayActive) {
    applySavedMenuPrefs();
    syncUnitButtons();
    fetchLive(true);
  }
});
window.addEventListener('online', () => {
  applySavedMenuPrefs();
  syncUnitButtons();
  fetchLive(true);
});

let searchTimer = null;
$('search').addEventListener('input', () => {
  updateSearchUi();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    render();
    const q = $('search').value.trim();
    if (q) {
      $('listHint').textContent = `Filtering by "${q}". Tracks are kept; hidden tracks may not be in list.`;
    } else if ($('listHint').textContent.startsWith('Filtering by ')) {
      $('listHint').textContent = '';
    }
  }, 120);
});
$('btnClearSearch').addEventListener('click', () => {
  $('search').value = '';
  updateSearchUi();
  $('listHint').textContent = '';
  render();
  $('search').focus();
});

$('type').addEventListener('change', e => {
  const cb = e.target.closest('input[type="checkbox"]');
  if (!cb) return;
  const boxes = [...$('type').querySelectorAll('input[type="checkbox"]')];
  const allBox = boxes.find(b => b.value === 'all');
  if (cb.value === 'all') {
    if (cb.checked) {
      boxes.forEach(b => { if (b.value !== 'all') b.checked = false; });
    } else if (!boxes.some(b => b.value !== 'all' && b.checked)) {
      cb.checked = true;
    }
  } else {
    if (allBox && cb.checked) allBox.checked = false;
    if (allBox && !boxes.some(b => b.value !== 'all' && b.checked)) allBox.checked = true;
  }
  saveMenuPrefs();
  clearAllTracks();
  render();
});

applySavedLayers();
applySavedMenuPrefs();
syncUnitButtons();

$('presetMetricBtn').addEventListener('click', () => applyUnitPreset('metric'));
$('presetAviationBtn').addEventListener('click', () => applyUnitPreset('aviation'));
$('presetUsBtn').addEventListener('click', () => applyUnitPreset('us'));
$('btnTrackFlat').addEventListener('click', () => setTrackColorMode(false));
$('btnTrackVario').addEventListener('click', () => setTrackColorMode(true));
$('btnBaro').addEventListener('click', () => setBaroEnabled(!baroEnabled));
$('unitAltBtn').addEventListener('click', () => {
  altUnit = altUnit === 'm' ? 'ft' : 'm';
  saveMenuPrefs();
  syncUnitButtons();
  render();
});
$('unitSpeedBtn').addEventListener('click', () => {
  speedUnit = speedUnit === 'kmh' ? 'kt' : speedUnit === 'kt' ? 'mph' : 'kmh';
  saveMenuPrefs();
  syncUnitButtons();
  render();
});
$('unitTempBtn').addEventListener('click', () => {
  tempUnit = tempUnit === 'c' ? 'f' : 'c';
  saveMenuPrefs();
  syncUnitButtons();
  render();
});
$('unitClimbBtn').addEventListener('click', () => {
  climbUnit = climbUnit === 'mps' ? 'fpm' : 'mps';
  saveMenuPrefs();
  syncUnitButtons();
  render();
});

$('markerWindow').addEventListener('change', () => {
  saveMenuPrefs();
  clearAllTracks();
  needMeta = true;
  fetchLive(true);
});
$('trackWindow').addEventListener('change', () => {
  saveMenuPrefs();
  for (const addr of selectedTracks.keys()) loadTrack(addr);
});

$('scrollToListBtn')?.addEventListener('click', () => {
  Promise.resolve(exitMapFullscreen()).catch(() => {}).finally(() => {
    requestAnimationFrame(() => {
      $('aircraftSidebar')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
});

const mapFilterControl = $('mapFilterControl');
const mapFilterToggle = $('mapFilterToggle');
const mapFilterPanel = $('mapFilterPanel');
function openFilterPanel() {
  mapFilterPanel.hidden = false;
  mapFilterToggle.setAttribute('aria-expanded', 'true');
  const first = mapFilterPanel.querySelector('input,select,button');
  if (first) first.focus();
}
function closeFilterPanel(restoreFocus = false) {
  if (mapFilterPanel.hidden) return;
  mapFilterPanel.hidden = true;
  mapFilterToggle.setAttribute('aria-expanded', 'false');
  if (restoreFocus) mapFilterToggle.focus();
}
mapFilterToggle.addEventListener('click', event => {
  event.stopPropagation();
  if (mapFilterPanel.hidden) openFilterPanel();
  else closeFilterPanel(true);
});
mapFilterPanel.addEventListener('click', event => event.stopPropagation());
document.addEventListener('click', e => {
  if (!mapFilterControl.contains(e.target)) closeFilterPanel(false);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !mapFilterPanel.hidden) {
    event.preventDefault();
    closeFilterPanel(true);
  }
});

$('emergencyJump').addEventListener('click', () => {
  const addr = $('emergencyJump').dataset.addr;
  if (addr) jumpToAlertAddress(addr);
});
$('emergencyBannerClose').addEventListener('click', () => {
  emergencyBannerDismissedSig = $('emergencyBanner').dataset.sig || null;
  $('emergencyBanner').classList.remove('show');
});

$('btnReplay').addEventListener('click', () => setReplayMode(!replayActive));
$('replayExit').addEventListener('click', () => setReplayMode(false));
$('replaySlider').addEventListener('input', () => {
  replayTsMs = replayTsFromSlider();
  lastReplaySliceMinute = null;
  syncReplayTrackUi();
  loadReplaySlice();
});
$('replayPlay').addEventListener('click', () => {
  if (replayTimer) stopReplayPlayback();
  else startReplayPlayback();
});
/** Tap for one step; press-and-hold (mouse or touch) repeats, accelerating slightly. */
function bindReplaySpeedHold(id, delta) {
  const btn = $(id);
  if (!btn) return;
  let timer = null;
  let period = 0;
  let lastPointerTs = 0;
  const blockSelection = e => e.preventDefault();

  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    period = 0;
    document.removeEventListener('selectstart', blockSelection, true);
    document.removeEventListener('dragstart', blockSelection, true);
  };
  const tick = () => {
    adjustReplaySpeed(delta);
    period = Math.max(35, period ? period - 8 : 80);
    timer = setTimeout(tick, period);
  };

  btn.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault(); // block drag/selection and the touch callout on long press
    lastPointerTs = Date.now();
    stop();
    // Selection is hit-tested outside the button while dragging, so guard it globally.
    document.addEventListener('selectstart', blockSelection, true);
    document.addEventListener('dragstart', blockSelection, true);
    adjustReplaySpeed(delta);
    timer = setTimeout(tick, 300);
    try { btn.setPointerCapture(e.pointerId); } catch (_) { /* older browsers */ }
  });
  btn.addEventListener('selectstart', blockSelection);
  btn.addEventListener('contextmenu', blockSelection);
  for (const evt of ['pointerup', 'pointercancel', 'lostpointercapture']) btn.addEventListener(evt, stop);
  btn.addEventListener('click', e => {
    // Pointer-driven clicks were handled on pointerdown; only keyboard activation needs this.
    if (Date.now() - lastPointerTs > 600) adjustReplaySpeed(delta);
  });
  btn.addEventListener('wheel', e => {
    e.preventDefault();
    const wheelDelta = e.deltaY < 0 ? 1 : (e.deltaY > 0 ? -1 : 0);
    if (wheelDelta) adjustReplaySpeed(wheelDelta);
  }, { passive: false });
}

bindReplaySpeedHold('replaySpeedDown', -1);
bindReplaySpeedHold('replaySpeedUp', 1);
$('replayReverse').addEventListener('click', () => {
  replayDirection = -replayDirection;
  syncReplayDirectionButton();
});
$('replayRange').addEventListener('click', () => {
  replayRangeIndex = (replayRangeIndex + 1) % REPLAY_RANGE_LABELS.length;
  syncReplayRangeButton();
  $('replaySlider').value = '0';
  replayTsMs = replayWindow().start;
  updateReplaySliderFromTs();
  lastReplaySliceMinute = null;
  syncReplayTrackUi();
  if (replayActive) { loadReplaySlice(); replayTrackPromise = loadReplayTrack(); }
});
$('replayPrevTrack').addEventListener('click', () => jumpToReplayTrack(-1));
$('replayNextTrack').addEventListener('click', () => jumpToReplayTrack(1));
$('replayClearFollow').addEventListener('click', () => {
  replayOnlyFocus = !replayOnlyFocus;
  syncReplayFollowLabel();
  loadReplaySlice();
});
syncReplaySpeedUi();
syncReplayDirectionButton();
syncReplayRangeButton();
syncReplayFollowLabel();

$('btnResetFilters').addEventListener('click', resetFilters);

$('btnNotify').addEventListener('click', async () => {
  if (!alertsEnabled && 'Notification' in window && Notification.permission === 'default') {
    await Notification.requestPermission();
  }
  alertsEnabled = !alertsEnabled;
  saveMenuPrefs();
  $('btnNotify').classList.toggle('active', alertsEnabled);
  $('btnNotify').textContent = alertsEnabled ? '🔔 ON' : '🔔 OFF';
  $('btnNotify').setAttribute('aria-pressed', String(alertsEnabled));
});

$('btnAirspace').addEventListener('click', () => $('airspaceFile').click());
$('airspaceFile').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  try {
    const gj = file.name.toLowerCase().endsWith('.txt') ? parseOpenAirToGeoJson(text) : JSON.parse(text);
    airspaceLayer.clearLayers();
    airspaceLayer.addData(gj);
    if (!map.hasLayer(airspaceLayer)) airspaceLayer.addTo(map);
  } catch (err) {
    alert('Could not parse airspace file. Please use valid GeoJSON or OpenAir (.txt).');
  }
  e.target.value = '';
});

$('locate').addEventListener('click', () => {
  const btn = $('locate');
  btn.disabled = true; btn.textContent = '◎ Locating…';
  const resetBtn = () => { btn.disabled = false; btn.textContent = '◎ Locate'; };
  const showLocation = (lat, lon, zoom, label) => {
    resetBtn();
    const pos = [lat, lon];
    map.setView(pos, Math.max(map.getZoom(), zoom));
    if (userLocationMarker) userLocationMarker.setLatLng(pos).setPopupContent(label);
    else userLocationMarker = L.circleMarker(pos, { radius: 7, color: '#ffffff', weight: 2, fillColor: '#38bdf8', fillOpacity: 1 }).bindPopup(label).addTo(map);
    needMeta = true; fetchLive(true);
  };
  const fallbackToIp = async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    try {
      const res = await fetch('https://get.geojs.io/v1/ip/geo.json', { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error();
      const data = await res.json();
      const lat = parseFloat(data.latitude), lon = parseFloat(data.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error();
      const place = [data.city, data.country].filter(Boolean).join(', ');
      showLocation(lat, lon, 10, place ? `Approximate location (IP: ${place})` : 'Approximate location (IP)');
    } catch (e) {
      clearTimeout(timer); resetBtn();
      alert('Could not determine your location.');
    }
  };
  if (!window.isSecureContext || !navigator.geolocation) { fallbackToIp(); return; }
  const onSuccess = p => showLocation(p.coords.latitude, p.coords.longitude, 12, 'Your location');
  navigator.geolocation.getCurrentPosition(
    onSuccess,
    err => {
      if (err.code === 1) { resetBtn(); alert('Location permission denied.'); return; }
      navigator.geolocation.getCurrentPosition(onSuccess, fallbackToIp, { enableHighAccuracy: false, timeout: 6000, maximumAge: 300000 });
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
  );
});

render24hAlertsSummary(serverNow());
syncUnitButtons();
updateSearchUi();
if (hashSelectAddress) loadHashAircraft(hashSelectAddress);
fetchLive(true);
setInterval(() => fetchLive(false), 5000);

setInterval(() => {
  if (document.hidden || replayActive) return;
  const now = serverNow();
  document.querySelectorAll('#aircraftList .age[data-ts]').forEach(el => {
    const ts = Number(el.dataset.ts);
    if (ts) el.textContent = fmtAge(Math.max(0, Math.floor((now - ts) / 1000)));
  });
  if (!$('alerts24hSummary').hidden) render24hAlertsSummary(now);
  updateStatusUpdated();
}, 1000);
})();
