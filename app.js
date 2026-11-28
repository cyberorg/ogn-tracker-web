(() => {
'use strict';
const BIR = [32.037, 76.708];
const PINNED_STORAGE_KEY = 'ogn_pinned_aircraft';
const MENU_PREFS_STORAGE_KEY = 'ogn_menu_prefs';
const ALERTS_24H_STORAGE_KEY = 'ogn_alerts_24h';
const NAME_CACHE_STORAGE_KEY = 'ogn_name_cache';
const AIRSPACE_STORAGE_KEY = 'ogn_custom_airspace_geojson';
const BOOKMARKS_STORAGE_KEY = 'ogn_map_bookmarks';
const NAME_CACHE_MAX = 1000;
const WX_CACHE_TTL_MS = 30 * 60 * 1000;
const ALERT_24H_TTL_MS = 24 * 60 * 60 * 1000;
const LAST_KNOWN_TTL_MS = 24 * 60 * 60 * 1000;
const SOUNDING_NO_DATA_MSG = 'Not enough circling tracks in the last hour to reconstruct wind aloft.';
const SOUNDING_CEILING_TIP = 'Estimated from the last hour of local sailplane/paraglider climbs (≥0.5 m/s, at least 2 aircraft); 90th percentile, rounded to 10 m. Not a forecast or hard ceiling.';
const SOUNDING_CLOUD_TIP = 'Estimated cloud base from the nearest recent station temperature and humidity using the Magnus dewpoint and Bolton LCL. AGL is above ground; MSL is shown when station elevation is known.';
const OFFLINE_THRESHOLD_SEC = 180;
const MIN_VALID_TEMP_C = -50;
const MAX_VALID_TEMP_C = 55;
const TRACK_COLORS = ['#38bdf8','#f97316','#a855f7','#22c55e','#f43f5e','#eab308','#ec4899','#14b8a6','#818cf8','#84cc16'];
const LIVE_TRACK_MAX_POINTS = 1500; // matches the backend's non-full track thinning target

const $ = id => document.getElementById(id);

// Floating map panels share one stacking order: the last one opened wins.
// Emergency alerts are deliberately excluded and keep --emergency-z so they always win.
const OVERLAY_Z_BASE = 1050; // matches CSS --overlay-z; above Leaflet controls (1000)
let overlayZSeq = OVERLAY_Z_BASE;
function bringToFront(el) {
  if (!el) return;
  el.style.zIndex = String(++overlayZSeq);
}

// Only one popup may be open: opening another closes the previous one. Map clicks
// and Escape still do not dismiss a popup; its close button or an explicit app
// action does.
const POPUP_OPTIONS = { autoClose: true, closeOnClick: false, closeOnEscapeKey: false };

const THEME = (() => {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
  return {
    accent: v('--accent', '#57d3b0'),
    yellow: v('--yellow', '#f5c451'),
    red: v('--red', '#f07878'),
    text: v('--text', '#edf4f8'),
    bg: v('--bg', '#101923'),
    muted: v('--muted', '#9aabba')
  };
})();

function s3dRefreshThemeColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
  Object.assign(THEME, {
    accent: v('--accent', THEME.accent),
    yellow: v('--yellow', THEME.yellow),
    red: v('--red', THEME.red),
    text: v('--text', THEME.text),
    bg: v('--bg', THEME.bg),
    muted: v('--muted', THEME.muted)
  });
  s3dClearCssColorCache();
  for (const item of map3dDomMarkers.values()) s3dRefreshMarkerStyle(item);
}

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
let lastSoundingData = null;
let lastSoundingBoundsKey = '';
let lastSoundingAttemptAtMs = 0;
let lastSoundingSuccessAtMs = 0;
let soundingRefreshFailed = false;
let soundingPopupFetchSeq = 0;
let soundingPopupPendingKey = '';
let savedTypes = ['para', 'wx'];
let savedMarkerWindow = '900';
let savedTrackWindow = '900';
let savedVarioTrackMode = false;
let savedBaroEnabled = false;
let savedView3d = false;
let savedBaseLayer = 'terrain';
let savedOverlays = [];
let listSort = 'name';
let search24hResults = [];   // aircraft found outside the viewport via the 24h search fallback
let search24hSeq = 0;
let applyingSavedLayers = false;
let baroEnabled = false;
let collectorPaused = false;
let lastFetchOkAtMs = 0;
let lastFetchAttemptAtMs = 0;
let feedDataUpdatedMs = 0;   // newest timestamp actually stored by the collector
let lastStatusKind = 'connecting';
let lastStatusText = 'Connecting…';
let hashLookupMessageUntilMs = 0;
let hashMessagePopup = null;
let bookmarks = [];
let measureMode = false;
let measurePoints = [];
let selectedMeasureIndex = -1;
let measureLine = null;
let measureMarkers = [];
let measure3dLayer = null;
let measure3dLine = null;
let measure3dDots = [];
let measure3dDrag = null;
let replayTimeMode = 'browser'; // 'browser' clock or time at the current trackpoint
const locationTzCache = new Map();

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
  if (typeof prefs.trackWindow === 'string' && prefs.trackWindow) {
    savedTrackWindow = prefs.trackWindow === 'today' ? '86400' : prefs.trackWindow;
  }
  if (typeof prefs.varioTrackMode === 'boolean') savedVarioTrackMode = prefs.varioTrackMode;
  if (typeof prefs.baroEnabled === 'boolean') {
    savedBaroEnabled = prefs.baroEnabled;
    baroEnabled = prefs.baroEnabled;
  }
  if (typeof prefs.baseLayer === 'string' && prefs.baseLayer) savedBaseLayer = prefs.baseLayer;
  if (typeof prefs.view3d === 'boolean') savedView3d = prefs.view3d;
  if (Array.isArray(prefs.overlays)) savedOverlays = prefs.overlays.filter(v => typeof v === 'string');
  if (['name', 'type', 'climb', 'latest'].includes(prefs.listSort)) listSort = prefs.listSort;
  if (prefs.replayTimeMode === 'track') replayTimeMode = 'track';
} catch (e) {}

try {
  const raw = JSON.parse(localStorage.getItem(BOOKMARKS_STORAGE_KEY) || '[]');
  if (Array.isArray(raw)) {
    bookmarks = raw.filter(b => b && typeof b === 'object' && Number.isFinite(Number(b.lat)) &&
      Number.isFinite(Number(b.lon)) && Number.isFinite(Number(b.zoom)))
      .slice(0, 4)
      .map((b, i) => ({
        id: typeof b.id === 'string' && b.id ? b.id : `bm${i}`,
        name: String(b.name || `Site ${i + 1}`).slice(0, 24),
        lat: Number(b.lat), lon: Number(b.lon), zoom: Number(b.zoom)
      }));
  }
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
      view3d: map3dActive,
      baseLayer: savedBaseLayer,
      overlays: savedOverlays,
      listSort,
      replayTimeMode
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
  if ($('listSort') && [...$('listSort').options].some(o => o.value === listSort)) {
    $('listSort').value = listSort;
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
  // Restore the view mode on load and on reconnect (feed recovery, tab focus,
  // online event) so a 3D selection survives disconnects and reloads.
  if (savedView3d !== map3dActive) toggle3DView();
}

function resetFilters() {
  $('search').value = '';
  clearSearch24h();
  savedTypes = ['para', 'wx'];
  savedMarkerWindow = '900';
  savedTrackWindow = '900';
  listSort = 'name';
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

function bearingDeg(lat1, lon1, lat2, lon2) {
  const toRad = d => d * Math.PI / 180;
  const p1 = toRad(lat1), p2 = toRad(lat2), dl = toRad(lon2 - lon1);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
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
    initialZoom = Math.max(1, Math.min(16, z));
    if (parts[3]) {
      try {
        const decoded = decodeURIComponent(parts[3]).toLowerCase();
        if (decoded) {
          pendingHashSelect = decoded;
          hashSelectAddress = decoded;
        }
      } catch (err) {
        // Ignore malformed percent-encoding in a shared/bookmarked URL.
      }
    }
  }
}

const terrainLayer = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
  maxNativeZoom: 16, maxZoom: 16,
  attribution: 'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> | Map style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a>'
});
const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 16, attribution: 'Tiles &copy; Esri'
});
const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 16, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
});

const map = L.map('map', { zoomControl: false, closePopupOnClick: false, minZoom: 1, maxZoom: 16, layers: [terrainLayer] }).setView(initialCenter, initialZoom);

// Locate lives on the map, stacked above the zoom control at bottom-left.
const LocateControl = L.Control.extend({
  options: { position: 'bottomleft' },
  onAdd: function () {
    const container = L.DomUtil.create('div', 'leaflet-control-locate');
    const button = L.DomUtil.create('button', 'leaflet-control-locate-btn', container);
    button.type = 'button';
    button.id = 'locate';
    button.title = 'Locate me';
    button.setAttribute('aria-label', 'Locate me');
    button.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">' +
      '<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/>' +
      '<circle cx="12" cy="12" r="3" fill="currentColor"/>' +
      '</svg>';
    L.DomEvent.disableClickPropagation(container);
    return container;
  }
});
// Leaflet inserts bottom-corner controls at the top, so add zoom first and the
// locate control second to keep locate stacked above the zoom buttons.
L.control.zoom({ position: 'bottomleft' }).addTo(map);
new LocateControl().addTo(map);

// Reset camera sits directly above Locate; it is only useful in the 3D view.
const ResetCameraControl = L.Control.extend({
  options: { position: 'bottomleft' },
  onAdd: function () {
    const container = L.DomUtil.create('div', 'leaflet-control-reset-camera');
    const button = L.DomUtil.create('button', 'leaflet-control-reset-camera-btn', container);
    button.type = 'button';
    button.id = 'resetCamera';
    button.title = 'Reset camera tilt & north';
    button.setAttribute('aria-label', button.title);
    button.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">' +
      '<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/>' +
      '<path d="M12 5.5 14.4 12 12 10.2 9.6 12Z" fill="currentColor"/>' +
      '</svg>';
    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.on(button, 'click', event => {
      L.DomEvent.preventDefault(event);
      if (map3dReady) map3d.easeTo({ pitch: 58, bearing: 0, duration: 350 });
    });
    return container;
  }
});
new ResetCameraControl().addTo(map);

const FULLSCREEN_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">' +
  '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const RESTORE_FULLSCREEN_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">' +
  '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const FullscreenControl = L.Control.extend({
  options: { position: 'topright' },
  onAdd: function () {
    const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control-fullscreen');
    const button = L.DomUtil.create('button', 'leaflet-control-fullscreen-btn', container);
    button.type = 'button';
    button.innerHTML = FULLSCREEN_ICON;
    button.setAttribute('aria-label', 'Maximize map');
    button.title = 'Maximize map';

    const clearTracksButton = L.DomUtil.create('button', 'leaflet-control-clear-tracks-btn', container);
    clearTracksButton.type = 'button';
    clearTracksButton.hidden = true;
    clearTracksButton.innerHTML =
      '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">' +
      '<path d="M2.5 17.5c3-8 6.5 3 9.5-4 2-4.5 4-2 6-6.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
      '<path d="M15.5 15.5l5 5m0-5l-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
      '</svg>';
    clearTracksButton.setAttribute('aria-label', 'Clear all tracks');
    clearTracksButton.title = 'Clear all tracks';
    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.on(button, 'click', event => {
      L.DomEvent.preventDefault(event);
      toggleMapFullscreen();
    });
    L.DomEvent.on(clearTracksButton, 'click', event => {
      L.DomEvent.preventDefault(event);
      clearAllTracks();
      render();
    });
    this._button = button;
    this._clearTracksButton = clearTracksButton;
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
  button.innerHTML = active ? RESTORE_FULLSCREEN_ICON : FULLSCREEN_ICON;
  button.setAttribute('aria-label', active ? 'Restore map' : 'Maximize map');
  button.title = active ? 'Restore map' : 'Maximize map';
  button.setAttribute('aria-pressed', String(active));
  requestAnimationFrame(() => { map.invalidateSize(); resize3D(); });
}

function syncClearTracksButton() {
  const button = mapFullscreenControl?._clearTracksButton;
  if (!button) return;
  button.hidden = selectedTracks.size === 0;
}

const mapFullscreenControl = new FullscreenControl().addTo(map);
document.addEventListener('fullscreenchange', syncMapFullscreenUi);
syncMapFullscreenUi();

raisePopupPane();

/* Additive MapLibre 3D view. Leaflet remains the source of truth for aircraft,
   tracks, replay state, and UI; the MapLibre canvas mirrors it when enabled. */
const MAP3D_DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
// One shared base-layer choice drives both maps: the Leaflet layer in 2D and
// the MapLibre style in 3D.
const BASE_TO_3D = { osm: 'liberty', terrain: 'topo', satellite: 'satellite' };
const VIEW3D_TO_BASE = { liberty: 'osm', topo: 'terrain', satellite: 'satellite' };
const MAP3D_BASE_STYLES = {
  liberty: 'https://tiles.openfreemap.org/styles/liberty',
  satellite: {
    version: 8,
    sources: {
      esri: {
        type: 'raster',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        maxzoom: 19,
        attribution: 'Tiles &copy; Esri'
      }
    },
    layers: [{ id: 'esri-sat', type: 'raster', source: 'esri' }]
  },
  topo: {
    version: 8,
    sources: {
      opentopo: {
        type: 'raster',
        tiles: ['https://a.tile.opentopomap.org/{z}/{x}/{y}.png', 'https://b.tile.opentopomap.org/{z}/{x}/{y}.png', 'https://c.tile.opentopomap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxzoom: 17,
        attribution: 'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> | Map style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a>'
      }
    },
    layers: [{ id: 'opentopo-base', type: 'raster', source: 'opentopo' }]
  }
};
// A clear daytime sky: blue overhead fading to a pale haze at the horizon.
// MapLibre resets sky with the style, so it is reapplied after each style load.
const S3D_SKY = Object.freeze({
  'sky-color': '#5aa9e6',
  'sky-horizon-blend': 0.35,
  'horizon-color': '#eef5f8',
  'horizon-fog-blend': 0.25,
  'fog-color': '#dce9f0',
  'fog-ground-blend': 0.15,
  'atmosphere-blend': 0
});
const S3D_DEM = 'ogn-3d-dem';
const S3D_TRACKS = 'ogn-3d-tracks';
const S3D_CURTAINS = 'ogn-3d-curtains';
const S3D_AIRSPACE = 'ogn-3d-airspace';
const S3D_THERMALS = 'ogn-3d-thermals';
const S3D_REPLAY_TRACK = 'ogn-3d-replay-track';
const S3D_REPLAY_PROGRESS = 'ogn-3d-replay-progress';
const S3D_MARKERS = 'ogn-3d-markers';
const S3D_ARROWHEADS = 'ogn-3d-arrowheads';
// Aircraft are drawn at true MSL altitude, but never below the DEM surface.
const S3D_MARKER_CLEARANCE_M = 12;
const S3D_TERRAIN_SAMPLE_MIN_M = 20;
const S3D_TERRAIN_SAMPLE_MAX_M = 120;
const S3D_EMPTY_FC = Object.freeze({ type: 'FeatureCollection', features: [] });
const s3dFeatureCollection = features => ({ type: 'FeatureCollection', features });

let map3d = null;
let map3dReady = false;
let map3dActive = false;
let map3dPaused = false;
let map3dBaseKey = BASE_TO_3D[savedBaseLayer] || 'liberty';

// One attribution button serves both 2D and 3D. Its open panel always shows
// every credit, using each provider's requested wording, regardless of the
// selected base layer or view.
const MAP_ATTRIBUTION_HTML = `
<div class="ogn-attrib-line"><strong>Libraries:</strong>
  <a href="https://leafletjs.com/" target="_blank" rel="noopener">Leaflet</a> © 2010-2023 Vladimir Agafonkin, © 2010-2011 CloudMade (<a href="https://github.com/Leaflet/Leaflet/blob/v1.9.4/LICENSE" target="_blank" rel="noopener">BSD-2-Clause license</a>) |
  <a href="https://maplibre.org/" target="_blank" rel="noopener">MapLibre GL JS</a> © 2023 MapLibre contributors (<a href="https://github.com/maplibre/maplibre-gl-js/blob/v5.6.1/LICENSE.txt" target="_blank" rel="noopener">BSD-3-Clause license</a>; includes <a href="https://github.com/mapbox/mapbox-gl-js/blob/v1.13.3/LICENSE.txt" target="_blank" rel="noopener">Mapbox GL JS</a> © 2020 Mapbox and <a href="https://github.com/evanw/glfx.js/blob/master/LICENSE" target="_blank" rel="noopener">glfx.js</a> © 2011 Evan Wallace) |
  <a href="https://threejs.org/" target="_blank" rel="noopener">three.js</a> © 2010-2023 Three.js Authors (<a href="https://github.com/mrdoob/three.js/blob/r160/LICENSE" target="_blank" rel="noopener">MIT license</a>)
</div>
<div class="ogn-attrib-line"><strong>Map data:</strong>
  © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a> (<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">ODbL</a>) |
  <a href="https://openfreemap.org/#attribution" target="_blank" rel="noopener">OpenFreeMap</a> (<a href="https://github.com/hyperknot/openfreemap/blob/main/LICENSE.md" target="_blank" rel="noopener">MIT license</a>) © <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> (<a href="https://github.com/openmaptiles/openmaptiles/blob/master/LICENSE.md" target="_blank" rel="noopener">BSD + CC-BY license</a>) Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> |
  Map data: © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>, <a href="https://www.viewfinderpanoramas.org/" target="_blank" rel="noopener">SRTM</a> | Map style: © <a href="https://opentopomap.org/credits" target="_blank" rel="noopener">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/" target="_blank" rel="noopener">CC-BY-SA</a>) |
  Tiles © <a href="https://www.esri.com/en-us/legal/copyright-trademarks" target="_blank" rel="noopener">Esri</a> — <a href="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer" target="_blank" rel="noopener">Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community</a> (<a href="https://www.esri.com/en-us/legal/terms/full-master-agreement" target="_blank" rel="noopener">terms</a>)
</div>
<div class="ogn-attrib-line"><strong>Terrain:</strong>
  <a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noopener">Terrain Tiles</a> © <a href="https://mapzen.com/rights" target="_blank" rel="noopener">Mapzen</a> / <a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noopener">Tilezen</a> / <a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noopener">AWS Open Data</a> — <a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noopener">required source attributions</a>:
  <a href="https://nga.maps.arcgis.com/apps/MapSeries/index.html?appid=cf2fba21df7540fb981f8836f2a97e25" target="_blank" rel="noopener">ArcticDEM terrain data</a> DEM(s) were created from DigitalGlobe, Inc., imagery and funded under National Science Foundation awards 1043681, 1559691, and 1542736;
  <a href="https://ecat.ga.gov.au/geonetwork/srv/eng/search#!22be4b55-2465-4320-e053-10a3070a5236" target="_blank" rel="noopener">Australia terrain data</a> © <a href="https://www.ga.gov.au/" target="_blank" rel="noopener">Commonwealth of Australia (Geoscience Australia)</a> 2017 (<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>);
  <a href="https://www.data.gv.at/katalog/dataset/b5de6975-417b-4320-afdb-eb2a9e2a1dbf" target="_blank" rel="noopener">Austria terrain data</a> © offene Daten Österreichs – <a href="https://www.data.gv.at/katalog/dataset/b5de6975-417b-4320-afdb-eb2a9e2a1dbf" target="_blank" rel="noopener">Digitales Geländemodell (DGM) Österreich</a> (<a href="https://creativecommons.org/licenses/by/3.0/at/deed.de" target="_blank" rel="noopener">CC BY 3.0 AT</a>);
  <a href="https://ftp.maps.canada.ca/pub/nrcan_rncan/elevation/cdem_mnec/doc/CDEM_product_specs.pdf" target="_blank" rel="noopener">Canada terrain data</a> contains information licensed under the <a href="https://open.canada.ca/en/open-government-licence-canada" target="_blank" rel="noopener">Open Government Licence – Canada</a>;
  <a href="https://www.eea.europa.eu/en/datahub/datahubitem-view/d08852bc-7b5f-4835-a776-08362e2fbf4b" target="_blank" rel="noopener">Europe terrain data</a> produced using Copernicus data and information funded by the European Union - <a href="https://www.eea.europa.eu/en/datahub/datahubitem-view/d08852bc-7b5f-4835-a776-08362e2fbf4b" target="_blank" rel="noopener">EU-DEM layers</a>;
  <a href="https://www.ncei.noaa.gov/products/etopo-global-relief-model" target="_blank" rel="noopener">Global ETOPO1 terrain data</a> <a href="https://www.ncei.noaa.gov/products/etopo-global-relief-model" target="_blank" rel="noopener">U.S. National Oceanic and Atmospheric Administration</a>;
  <a href="https://en.www.inegi.org.mx/temas/relieve/continental" target="_blank" rel="noopener">Mexico terrain data</a> source: <a href="https://en.www.inegi.org.mx/temas/relieve/continental" target="_blank" rel="noopener">INEGI, Continental relief, 2016</a> (<a href="https://en.www.inegi.org.mx/inegi/terminos.html" target="_blank" rel="noopener">free use terms</a>);
  <a href="https://data.linz.govt.nz/layer/1768-nz-8m-digital-elevation-model-2012/" target="_blank" rel="noopener">New Zealand terrain data</a> Copyright 2011 Crown copyright (c) <a href="https://data.linz.govt.nz/" target="_blank" rel="noopener">Land Information New Zealand and the New Zealand Government</a> (All rights reserved) (<a href="https://data.linz.govt.nz/license/attribution-3-0-new-zealand/" target="_blank" rel="noopener">CC BY 3.0 NZ</a>);
  <a href="https://data.norge.no/nb/datasets/2ab68d79-bc7a-35cc-8c1d-752e512e0f3a/dtm-10-terrengmodell-utm33-historisk" target="_blank" rel="noopener">Norway terrain data</a> © <a href="https://www.kartverket.no/api-og-data" target="_blank" rel="noopener">Kartverket</a> (<a href="https://creativecommons.org/licenses/by/4.0/deed.no" target="_blank" rel="noopener">CC BY 4.0</a>);
  <a href="https://www.data.gov.uk/dataset/e529ca2f-b4ce-403e-8cef-ab821061c4f3/lidar-composite-digital-terrain-model-dtm-2m" target="_blank" rel="noopener">United Kingdom terrain data</a> © <a href="https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/" target="_blank" rel="noopener">Environment Agency copyright and/or database right 2015. All rights reserved.</a> (<a href="https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/" target="_blank" rel="noopener">OGL v3</a>);
  <a href="https://www.usgs.gov/faqs/where-can-i-find-3d-elevation-program-3dep-product-updates-and-status-maps" target="_blank" rel="noopener">United States 3DEP (formerly NED)</a> and global <a href="https://www.usgs.gov/centers/eros/science/usgs-eros-archive-digital-elevation-global-multi-resolution-terrain-elevation" target="_blank" rel="noopener">GMTED2010</a> and <a href="https://www.usgs.gov/centers/eros/science/usgs-eros-archive-digital-elevation-shuttle-radar-topography-mission-srtm" target="_blank" rel="noopener">SRTM</a> terrain data courtesy of the <a href="https://www.usgs.gov/information-policies-and-instructions/acknowledging-or-crediting-usgs" target="_blank" rel="noopener">U.S. Geological Survey</a>.
  Terrain Tiles was accessed on 2026-11-27 from <a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noopener">https://registry.opendata.aws/terrain-tiles/</a>.
</div>`;
const mapAttributionEl = document.createElement('details');
mapAttributionEl.id = 'mapAttribution';
mapAttributionEl.className = 'maplibregl-ctrl maplibregl-ctrl-attrib maplibregl-compact ogn-3d-attrib map-attribution';
mapAttributionEl.innerHTML =
  '<summary class="maplibregl-ctrl-attrib-button" title="Toggle attribution" aria-label="Toggle attribution"></summary>' +
  '<div class="maplibregl-ctrl-attrib-inner">' + MAP_ATTRIBUTION_HTML + '</div>';
$('mapWrap').appendChild(mapAttributionEl);
const mapAttributionInner = mapAttributionEl.querySelector('.maplibregl-ctrl-attrib-inner');
function updateMapAttribution() {
  // Kept as the single refresh hook for callers; the full list is static.
  mapAttributionInner.innerHTML = MAP_ATTRIBUTION_HTML;
}
mapAttributionEl.addEventListener('toggle', () => {
  mapAttributionEl.classList.toggle('maplibregl-compact-show', mapAttributionEl.open);
});
// The whole attribution control owns scroll gestures while open — including
// the (i) button and padding, not just the text — so neither the map nor the
// aircraft list can steal them.
mapAttributionEl.addEventListener('wheel', event => {
  if (!mapAttributionEl.open) return;
  event.preventDefault();
  event.stopPropagation();
  if (mapAttributionInner.scrollHeight <= mapAttributionInner.clientHeight + 1) return;
  const step = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? mapAttributionInner.clientHeight : 1;
  mapAttributionInner.scrollTop += event.deltaY * step;
}, { passive: false });
let attribTouchY = 0;
mapAttributionEl.addEventListener('touchstart', event => {
  attribTouchY = event.touches[0]?.clientY ?? 0;
}, { passive: true });
mapAttributionEl.addEventListener('touchmove', event => {
  if (!mapAttributionEl.open) return;
  event.preventDefault();
  event.stopPropagation();
  if (mapAttributionInner.scrollHeight <= mapAttributionInner.clientHeight + 1) return;
  const y = event.touches[0]?.clientY ?? attribTouchY;
  mapAttributionInner.scrollTop += attribTouchY - y;
  attribTouchY = y;
}, { passive: false });

let s3dStyleSwapSeq = 0;
// Programmatic camera moves register the camera state they will land on. The
// matching moveend consumes the token; an unmatched moveend is real user input
// and syncs immediately, so no fixed wall-clock window can swallow a drag.
let pendingLeafletCameraStops = [];
let pending3DCameraStops = [];

function armLeafletCameraStop(lat, lng, zoom = null) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
  pendingLeafletCameraStops.push({ lat, lng, zoom: Number.isFinite(zoom) ? zoom : null });
  if (pendingLeafletCameraStops.length > 8) pendingLeafletCameraStops.shift();
}

function arm3DCameraStop(lng, lat, zoom = null, wildcard = false) {
  if (!wildcard && (!Number.isFinite(lng) || !Number.isFinite(lat))) return;
  pending3DCameraStops.push({
    lng, lat, wildcard, zoom: Number.isFinite(zoom) ? zoom : null
  });
  if (pending3DCameraStops.length > 8) pending3DCameraStops.shift();
}

function consumeLeafletCameraStop() {
  if (!pendingLeafletCameraStops.length) return false;
  let center, zoom, point;
  try {
    center = map.getCenter();
    zoom = map.getZoom();
    point = map.latLngToContainerPoint(L.latLng(center.lat, center.lng));
  } catch (err) {
    pendingLeafletCameraStops.length = 0;
    return false;
  }
  // Prefer the newest matching stop: a coalesced move can represent several
  // queued camera commands, so earlier superseded stops must not linger.
  let idx = -1;
  for (let i = pendingLeafletCameraStops.length - 1; i >= 0; i--) {
    const token = pendingLeafletCameraStops[i];
    if (token.wildcard) { idx = i; break; }
    let expected;
    try { expected = map.latLngToContainerPoint(L.latLng(token.lat, token.lng)); } catch (err) { continue; }
    if (!point || !expected || !Number.isFinite(point.x) || !Number.isFinite(point.y) ||
        !Number.isFinite(expected.x) || !Number.isFinite(expected.y)) continue;
    if (Math.hypot(point.x - expected.x, point.y - expected.y) > 4) continue;
    if (token.zoom != null && (!Number.isFinite(zoom) || Math.abs(zoom - token.zoom) > 0.05)) continue;
    idx = i;
    break;
  }
  if (idx < 0) {
    pendingLeafletCameraStops.length = 0;
    return false;
  }
  pendingLeafletCameraStops.splice(0, idx + 1);
  return true;
}

function consume3DCameraStop() {
  if (!pending3DCameraStops.length) return false;
  let center, zoom, point;
  try {
    center = map3d.getCenter();
    zoom = map3d.getZoom();
    point = map3d.project?.([center.lng, center.lat]);
  } catch (err) {
    pending3DCameraStops.length = 0;
    return false;
  }
  let idx = -1;
  for (let i = pending3DCameraStops.length - 1; i >= 0; i--) {
    const token = pending3DCameraStops[i];
    if (token.wildcard) { idx = i; break; }
    let expected;
    try { expected = map3d.project?.([token.lng, token.lat]); } catch (err) { continue; }
    if (!point || !expected || !Number.isFinite(point.x) || !Number.isFinite(point.y) ||
        !Number.isFinite(expected.x) || !Number.isFinite(expected.y)) continue;
    if (Math.hypot(point.x - expected.x, point.y - expected.y) > 4) continue;
    if (token.zoom != null && (!Number.isFinite(zoom) || Math.abs(zoom - token.zoom) > 0.05)) continue;
    idx = i;
    break;
  }
  if (idx < 0) {
    pending3DCameraStops.length = 0;
    return false;
  }
  pending3DCameraStops.splice(0, idx + 1);
  return true;
}
let s3dReplayCenterSig = '';
let s3dReplayCenterRatio = null;
let s3dReplaySmoothSig = '';
let s3dReplaySmoothAlt = null;
let s3dDomMarkerSyncRaf = null;
let s3dDeferredSyncTimer = null;
let s3dProjectionFrame = 0;
const S3D_LABEL_DEFER_MS = 120;
let s3dTerrainRefreshRaf = null;
let s3dMarkerGeoJsonSig = '';
let s3dArrowLayer = null;
const S3D_TERRAIN_NULL_TTL_MS = 15000;
let s3dTerrainDegraded = false;
let s3dTerrainErrorNotifiedAtMs = 0;
let s3dTerrainRetryTimer = null;
// key -> { value, at }. A null value is a retryable miss, not a permanent result.
const s3dTerrainElevationCache = new Map();
const map3dDomMarkers = new Map();       // key -> { el, lat, lon, alt, html, isFocus, isReplay }
const map3dDomPopupState = new Map();    // key -> { popup, detailsOpen }

// CSS custom properties are static for a theme, so resolve each var() once
// instead of calling getComputedStyle() for every marker on every frame.
const s3dCssVarCache = new Map();

function s3dClearCssColorCache() {
  s3dCssVarCache.clear();
}

const s3dColorSchemeQuery = window.matchMedia?.('(prefers-color-scheme: dark)');
if (s3dColorSchemeQuery) {
  const onColorSchemeChange = () => s3dRefreshThemeColors();
  if (s3dColorSchemeQuery.addEventListener) s3dColorSchemeQuery.addEventListener('change', onColorSchemeChange);
  else if (s3dColorSchemeQuery.addListener) s3dColorSchemeQuery.addListener(onColorSchemeChange);
}

function s3dResolveColor(value, fallback) {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  const varMatch = raw.match(/^var\(\s*(--[\w-]+)\s*\)$/);
  if (varMatch) {
    const name = varMatch[1];
    if (!s3dCssVarCache.has(name)) {
      s3dCssVarCache.set(name,
        getComputedStyle(document.documentElement).getPropertyValue(name).trim());
    }
    return s3dCssVarCache.get(name) || fallback;
  }
  return raw;
}

// Terrain DEM queries are cached per coordinate. A null result is cached only
// briefly so a failed/late tile can recover without a page reload; real numbers
// stay cached until DEM tiles arrive or the style changes.
function s3dQueryTerrainElevation(lng, lat) {
  if (!map3d || !Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
  const now = Date.now();
  const cached = s3dTerrainElevationCache.get(key);
  if (cached && (cached.value != null || now - cached.at < S3D_TERRAIN_NULL_TTL_MS)) {
    return cached.value;
  }
  let value = null;
  try {
    const queried = map3d.queryTerrainElevation?.([lng, lat]);
    if (typeof queried === 'number' && Number.isFinite(queried)) value = queried;
  } catch (err) {}
  if (s3dTerrainElevationCache.size > 4000) {
    for (const [k, entry] of s3dTerrainElevationCache) {
      if (entry.value == null && now - entry.at >= S3D_TERRAIN_NULL_TTL_MS) {
        s3dTerrainElevationCache.delete(k);
      }
    }
    if (s3dTerrainElevationCache.size > 4000) s3dTerrainElevationCache.clear();
  }
  s3dTerrainElevationCache.set(key, { value, at: now });
  if (value != null) s3dMarkTerrainRecovered();
  else s3dScheduleTerrainRetry();
  return value;
}

function s3dWrapLon(lon) {
  return ((lon + 180) % 360 + 360) % 360 - 180;
}

// The aircraft model is a fixed screen-space size, so its ground footprint grows as
// the map zooms out. Cap the sample radius to keep low-zoom markers reasonable.
function s3dTerrainSampleRadiusM(lat) {
  const zoom = Number.isFinite(map3d?.getZoom?.()) ? map3d.getZoom() : 14;
  const metersPerPixel = 40075016.686 * Math.cos(lat * Math.PI / 180) /
    (512 * Math.pow(2, zoom));
  return Math.min(S3D_TERRAIN_SAMPLE_MAX_M,
    Math.max(S3D_TERRAIN_SAMPLE_MIN_M, metersPerPixel * S3D_ARROW_PX * 0.5));
}

// Highest DEM sample under the marker footprint, including nearby slope.
function s3dTerrainMaxM(lng, lat) {
  const radius = s3dTerrainSampleRadiusM(lat);
  const dLat = radius / 111320;
  const dLon = radius / (111320 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
  const clampLat = x => Math.max(-89.9, Math.min(89.9, x));
  const samples = [
    [lng, lat],
    [lng, clampLat(lat + dLat)],
    [lng, clampLat(lat - dLat)],
    [s3dWrapLon(lng + dLon), lat],
    [s3dWrapLon(lng - dLon), lat]
  ];
  let max = null;
  for (const [x, y] of samples) {
    const value = s3dQueryTerrainElevation(x, y);
    if (value == null || !Number.isFinite(value)) continue;
    max = max == null ? value : Math.max(max, value);
  }
  return max;
}

// Visual altitude only. The real aircraft altitude in the popup/list is never
// changed, so a below-terrain fix is still reported honestly.
function s3dRenderAltitude(lng, lat, altMSL) {
  const ground = s3dTerrainMaxM(lng, lat);
  const alt = Number.isFinite(altMSL) ? Number(altMSL) : null;
  if (alt == null) return ground ?? 0;
  if (ground == null) return alt;
  return Math.max(alt, ground + S3D_MARKER_CLEARANCE_M);
}

function s3dScheduleTerrainRefresh() {
  if (s3dTerrainRefreshRaf !== null) return;
  s3dTerrainRefreshRaf = requestAnimationFrame(() => {
    s3dTerrainRefreshRaf = null;
    s3dTerrainElevationCache.clear();
    s3dReplayCenterSig = '';
    s3dScheduleLabelUpdate();
    if (map3dActive && !map3dPaused) {
      sync3DTracks();
      positionMeasure3D();
    }
  });
}

// A null DEM sample used to stay cached forever. Expire retryable misses in the
// background so a late or recovered tile is picked up even on a static camera.
function s3dScheduleTerrainRetry() {
  if (s3dTerrainRetryTimer !== null || map3dPaused || !map3dActive) return;
  s3dTerrainRetryTimer = setTimeout(() => {
    s3dTerrainRetryTimer = null;
    if (map3dPaused || !map3dActive) return;
    const now = Date.now();
    let hasExpired = false;
    for (const [key, entry] of s3dTerrainElevationCache) {
      if (entry.value == null && now - entry.at >= S3D_TERRAIN_NULL_TTL_MS) {
        s3dTerrainElevationCache.delete(key);
        hasExpired = true;
      }
    }
    if (!hasExpired) return;
    s3dScheduleTerrainRefresh();
    s3dScheduleTerrainRetry();
  }, S3D_TERRAIN_NULL_TTL_MS + 250);
}

function s3dIsDemErrorEvent(e) {
  if (!e) return false;
  if (e.sourceId === S3D_DEM || e.error?.sourceId === S3D_DEM) return true;
  const text = [e.error?.message, e.error?.url, e.tile?.url, e.url]
    .filter(Boolean).map(String).join(' ');
  return /elevation-tiles-prod|terrain-tiles|\bDEM\b/i.test(text);
}

function s3dMarkTerrainDegraded() {
  const now = Date.now();
  const shouldNotify = !s3dTerrainDegraded || now - s3dTerrainErrorNotifiedAtMs > 60000;
  s3dTerrainDegraded = true;
  if (shouldNotify) {
    s3dTerrainErrorNotifiedAtMs = now;
    if (map3dActive) showToast('3D terrain unavailable — elevation is approximate', 3500);
  }
  // Drop retryable misses so a later tile load is picked up immediately.
  s3dScheduleTerrainRefresh();
  s3dScheduleTerrainRetry();
}

function s3dMarkTerrainRecovered() {
  if (!s3dTerrainDegraded) return;
  s3dTerrainDegraded = false;
  s3dTerrainErrorNotifiedAtMs = 0;
  if (s3dTerrainRetryTimer !== null) {
    clearTimeout(s3dTerrainRetryTimer);
    s3dTerrainRetryTimer = null;
  }
  if (map3dActive) showToast('3D terrain restored', 2500);
  s3dScheduleTerrainRefresh();
}

function s3dLineFeature(coords, color) {
  return {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: coords },
    properties: { color: s3dResolveColor(color, THEME.accent) }
  };
}

// Long tracks otherwise produce hundreds of overlapping 3D curtain segments,
// which look like a wall of lines. Keep the endpoints and sample evenly.
function s3dSimplifyPoints(points, maxPoints) {
  const valid = (points || []).filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (valid.length <= maxPoints) return valid;
  const out = [];
  for (let i = 0; i < maxPoints; i++) {
    out.push(valid[Math.round(i * (valid.length - 1) / (maxPoints - 1))]);
  }
  return out;
}

// --- Native 3D aircraft models and smooth track lines ---------------------
// MapLibre symbol/fill-extrusion layers cannot place a real 3D model at an
// arbitrary MSL altitude. A custom WebGL layer puts a small procedural
// aircraft model, and its track, directly in Mercator 3D space. three.js is MIT
// licensed and needs no API key.
const S3D_ARROW_LEN = 12;       // dart length in model units; also size fallback
const S3D_ARROW_WIDTH = 9;
const S3D_ARROW_HEIGHT = 3.5;
const S3D_ARROW_PX = 30;        // on-screen aircraft marker size at every zoom
const S3D_STATION_PX = 20;      // ground-station marker stays smaller
const S3D_TRACK_PX = 2;                      // slim continuous track line (2 px)
const S3D_PROGRESS_PX = S3D_TRACK_PX * 1.25; // replay progress is only slightly heavier
const S3D_MARKER_CULL_MARGIN_PX = 80;        // hide DOM/WebGL markers once fully outside the map

function s3dThree() {
  return window.THREE || null;
}

// --- S3D marker models start ---
// A procedural dart is shared by every 3D aircraft marker, tinted with the
// resolved stripe colour. Ground stations use a tower model instead. Templates
// are cached per model/colour and each marker holds two lightweight objects
// referencing that template.
const S3D_STATION_TYPE = 15;
const s3dMarkerTemplates = new Map();

function s3dTemplateKey(type, colorHex) {
  const color = s3dResolveColor(colorHex, THEME.accent);
  return `${type === S3D_STATION_TYPE ? 'station' : 'dart'}|${color}`;
}

function s3dModelPalette(colorHex) {
  const THREE = s3dThree();
  if (!THREE) return null;
  const base = new THREE.Color(s3dResolveColor(colorHex, THEME.accent));
  const white = new THREE.Color('#ffffff');
  return {
    accent: base.clone(),
    tip: base.clone().lerp(white, 0.35),
    tail: base.clone().multiplyScalar(0.62),
    pale: base.clone().lerp(white, 0.55),
    pink: base.clone(),
    dark: new THREE.Color('#0b121a'),
    white: white.clone()
  };
}

function s3dMeshFromFaces(faces) {
  const THREE = s3dThree();
  if (!THREE) return null;
  const positions = [], colors = [];
  for (const face of faces) {
    for (let i = 0; i < face.points.length; i++) {
      const point = face.points[i];
      const color = Array.isArray(face.color) ? face.color[i] : face.color;
      positions.push(...point);
      colors.push(color.r, color.g, color.b);
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geom.computeVertexNormals();
  const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.DoubleSide, depthTest: true, depthWrite: true
  }));
  mesh.frustumCulled = false;
  return mesh;
}

function s3dLinesFromSegments(segments, color, opacity) {
  const THREE = s3dThree();
  if (!THREE) return null;
  const base = new THREE.Color(color);
  const alpha = opacity == null ? 0.7 : opacity;
  const positions = [], colors = [];
  for (const [a, b] of segments) {
    for (const point of [a, b]) {
      positions.push(...point);
      colors.push(base.r, base.g, base.b, alpha);
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4));
  const line = new THREE.LineSegments(geom, new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, depthTest: true, depthWrite: false
  }));
  line.frustumCulled = false;
  return line;
}

function s3dDartModel(colorHex) {
  const THREE = s3dThree();
  if (!THREE) return null;
  // Same proportions as the original arrowhead, so the shared dart keeps the
  // familiar on-screen shape while picking up each aircraft's stripe colour.
  const halfLen = S3D_ARROW_LEN / 2, halfWidth = S3D_ARROW_WIDTH / 2;
  const tip = [0, halfLen, 0];
  const bl = [-halfWidth, -halfLen, 0];
  const br = [halfWidth, -halfLen, 0];
  const ridge = [0, 0, S3D_ARROW_HEIGHT];
  const backColor = new THREE.Color(0x000000);
  const tipColor = new THREE.Color(s3dResolveColor(colorHex, THEME.accent));
  const gradient = points => points.map(point => {
    const t = Math.max(0, Math.min(1, (point[1] + halfLen) / S3D_ARROW_LEN));
    const falloffStart = 0.90;
    const shade = t >= falloffStart
      ? 0.85 + 0.15 * ((t - falloffStart) / (1 - falloffStart))
      : 0.85 * Math.pow(t / falloffStart, 3.0);
    return backColor.clone().lerp(tipColor, shade);
  });
  const face = points => ({ points, color: gradient(points) });
  const group = new THREE.Group();
  group.rotation.order = 'ZYX';
  group.add(s3dMeshFromFaces([
    face([tip, bl, ridge]),
    face([tip, ridge, br]),
    face([tip, br, bl]),
    { points: [bl, br, ridge], color: backColor }
  ]));
  group.add(s3dLinesFromSegments([
    [tip, bl], [bl, br], [br, tip], [tip, ridge], [bl, ridge], [br, ridge]
  ], 0x0b121a, 0.78));
  group.add(s3dLinesFromSegments([
    [tip, [0, -halfLen, 0.2]]
  ], 0xffffff, 0.55));
  return group;
}

function s3dGroundStation(palette) {
  const THREE = s3dThree();
  if (!THREE) return null;
  const group = new THREE.Group();
  group.rotation.order = 'ZYX';
  const faces = [], pale = [], dark = [];

  const quad = (a, b, c, d, color) => {
    faces.push({ points: [a, b, c], color: color });
    faces.push({ points: [a, c, d], color: color });
    dark.push([a, b], [b, c], [c, d], [d, a]);
  };
  const b = 3.2;
  quad([-b, -b, 0], [b, -b, 0], [b, b, 0], [-b, b, 0], palette.tail);

  const legPoint = (sx, sy, t) => {
    const half = 1.6 + (0.45 - 1.6) * t;
    return [sx * half, sy * half, 0.15 + 11.35 * t];
  };
  for (const sx of [1, -1]) for (const sy of [1, -1]) {
    pale.push([legPoint(sx, sy, 0), legPoint(sx, sy, 1)]);
  }
  const corners = [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([sx, sy]) => legPoint(sx, sy, 1));
  faces.push({ points: [corners[0], corners[1], corners[2]], color: palette.accent });
  faces.push({ points: [corners[0], corners[2], corners[3]], color: palette.accent });
  dark.push([corners[0], corners[1]], [corners[1], corners[2]], [corners[2], corners[3]], [corners[3], corners[0]]);

  for (const t of [0.25, 0.5, 0.75]) {
    const ring = [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([sx, sy]) => legPoint(sx, sy, t));
    for (let i = 0; i < 4; i++) pale.push([ring[i], ring[(i + 1) % 4]]);
    pale.push([ring[0], ring[2]], [ring[1], ring[3]]);
  }

  pale.push([[0, 0, 11.5], [0, 0, 17]]);
  const top = [0, 0, 16.8];
  for (const sx of [1, -1]) pale.push([top, [sx * 5.5, sx * 5.5, 0]]);

  const cz = 15.5, rimZ = 14.4, R = 2.5, N = 12;
  for (let i = 0; i < N; i++) {
    const a1 = i * Math.PI * 2 / N, a2 = (i + 1) * Math.PI * 2 / N;
    const p1 = [Math.cos(a1) * R, Math.sin(a1) * R, rimZ];
    const p2 = [Math.cos(a2) * R, Math.sin(a2) * R, rimZ];
    faces.push({ points: [[0, 0, cz], p1, p2], color: i % 2 ? palette.tip : palette.pale });
    dark.push([p1, p2]);
  }
  faces.push({ points: [[-0.25, 0, 17.2], [0.25, 0, 17.2], [0, 0.35, 17.2]], color: palette.pink });

  group.add(s3dMeshFromFaces(faces));
  group.add(s3dLinesFromSegments(pale, palette.pale.getHex(), 0.85));
  group.add(s3dLinesFromSegments(dark, 0x0b121a, 0.78));
  return group;
}

function s3dFlattenModel(group) {
  const THREE = s3dThree();
  if (!THREE || !group) return null;
  group.updateMatrixWorld(true);
  const meshPositions = [], meshColors = [];
  const linePositions = [], lineColors = [];
  const v = new THREE.Vector3();
  group.traverse(child => {
    const pos = child.geometry?.attributes?.position;
    if (!pos) return;
    const matrix = child.matrixWorld;
    if (child.isMesh) {
      const col = child.geometry.attributes.color;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(matrix);
        meshPositions.push(v.x, v.y, v.z);
        if (col) meshColors.push(col.getX(i), col.getY(i), col.getZ(i));
        else meshColors.push(1, 1, 1);
      }
    } else if (child.isLineSegments) {
      const col = child.geometry.attributes.color;
      const materialColor = child.material?.color || new THREE.Color(0xffffff);
      const opacity = child.material?.opacity ?? 1;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(matrix);
        linePositions.push(v.x, v.y, v.z);
        if (col && col.itemSize === 4) {
          lineColors.push(col.getX(i), col.getY(i), col.getZ(i), col.getW(i));
        } else if (col) {
          lineColors.push(col.getX(i), col.getY(i), col.getZ(i), opacity);
        } else {
          lineColors.push(materialColor.r, materialColor.g, materialColor.b, opacity);
        }
      }
    }
  });

  const meshGeom = new THREE.BufferGeometry();
  meshGeom.setAttribute('position', new THREE.Float32BufferAttribute(meshPositions, 3));
  meshGeom.setAttribute('color', new THREE.Float32BufferAttribute(meshColors, 3));
  const mesh = new THREE.Mesh(meshGeom, new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.DoubleSide, depthTest: true, depthWrite: true
  }));
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;

  const lineGeom = new THREE.BufferGeometry();
  lineGeom.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
  lineGeom.setAttribute('color', new THREE.Float32BufferAttribute(lineColors, 4));
  const lines = new THREE.LineSegments(lineGeom, new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, depthTest: true, depthWrite: false
  }));
  lines.frustumCulled = false;
  lines.renderOrder = 2;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const positions of [meshPositions, linePositions]) {
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i], y = positions[i + 1], z = positions[i + 2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }
  const out = new THREE.Group();
  out.add(mesh, lines);
  out.userData.mesh = mesh;
  out.userData.lines = lines;
  out.userData.modelSize = Math.max(maxX - minX, maxY - minY, maxZ - minZ) || S3D_ARROW_LEN;
  return out;
}

function s3dBuildMarkerTemplate(type, colorHex) {
  const THREE = s3dThree();
  if (!THREE) return null;
  const key = s3dTemplateKey(type, colorHex);
  const cached = s3dMarkerTemplates.get(key);
  if (cached) return cached;
  const isStation = key.startsWith('station|');
  let built;
  if (isStation) {
    const palette = s3dModelPalette(key.slice(8));
    if (!palette) return null;
    built = s3dGroundStation(palette);
  } else {
    built = s3dDartModel(key.slice(5));
  }
  if (!built) return null;
  const template = s3dFlattenModel(built);
  s3dDisposeObject(built);
  if (!template) return null;
  template.userData.key = key;
  template.userData.modelId = isStation ? 'station' : 'dart';
  template.userData.markerPx = isStation ? S3D_STATION_PX : S3D_ARROW_PX;
  s3dMarkerTemplates.set(key, template);
  return template;
}

function s3dCreateMarkerInstance(type, colorHex) {
  const THREE = s3dThree();
  const template = s3dBuildMarkerTemplate(type, colorHex);
  if (!THREE || !template) return null;
  const group = new THREE.Group();
  group.rotation.order = 'ZYX';
  for (const child of template.children) {
    const copy = child.isMesh
      ? new THREE.Mesh(child.geometry, child.material)
      : new THREE.LineSegments(child.geometry, child.material);
    copy.frustumCulled = false;
    copy.renderOrder = child.renderOrder;
    // Geometry/material belong to the shared template; do not dispose them
    // when an individual marker leaves the scene.
    copy.userData.shared = true;
    group.add(copy);
  }
  group.userData.templateKey = template.userData.key;
  group.userData.modelSize = template.userData.modelSize;
  group.userData.markerPx = template.userData.markerPx;
  return group;
}
// --- S3D marker models end ---

function s3dDisposeObject(obj) {
  obj.traverse?.(child => {
    if (child.userData?.shared) return;
    child.geometry?.dispose?.();
    if (Array.isArray(child.material)) child.material.forEach(m => m.dispose?.());
    else child.material?.dispose?.();
  });
}

function s3dCurveFromPoints(points) {
  const THREE = s3dThree();
  if (!THREE || !window.maplibregl?.MercatorCoordinate) return null;
  const valid = s3dSimplifyPoints(points, 160);
  if (valid.length < 2) return null;
  const vecs = valid.map(p => {
    const elevation = s3dRenderAltitude(p[1], p[0], p[2]);
    const mc = maplibregl.MercatorCoordinate.fromLngLat([p[1], p[0]], elevation);
    return new THREE.Vector3(mc.x, mc.y, mc.z);
  });
  // Centripetal Catmull-Rom keeps the line continuous and smooth without the
  // overshoot that a uniform spline can introduce on uneven GPS sampling.
  return new THREE.CatmullRomCurve3(vecs, false, 'centripetal', 0.5);
}

function s3dCurvePoints(points) {
  const curve = s3dCurveFromPoints(points);
  if (!curve) return null;
  return curve.getPoints(Math.min(420, Math.max(2, curve.points.length * 2)));
}

function s3dLineRadius(points, widthPx) {
  const valid = (points || []).find(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (!valid || !window.maplibregl?.MercatorCoordinate || !map3d) return 0;
  const mc = maplibregl.MercatorCoordinate.fromLngLat([valid[1], valid[0]]);
  const metersPerPixel = 40075016.686 * Math.cos(valid[0] * Math.PI / 180) /
    (512 * Math.pow(2, map3d.getZoom()));
  return mc.meterInMercatorCoordinateUnits() * metersPerPixel * (widthPx || S3D_TRACK_PX) / 2;
}

// TubeGeometry bakes its radius into world-space vertices, which would make a
// line look thicker as the map zooms in. Keep the path fixed and rescale only
// the offset of each ring vertex from its centre point as the zoom changes.
function s3dResizeThreeLines(zoom) {
  if (!s3dArrowLayer?.lines || !Number.isFinite(zoom)) return;
  // Rebuilt tubes already bake in the current zoom. Skip the per-ring rescan
  // unless the camera zoom actually changed since the last resize.
  if (s3dArrowLayer.lastLineZoom === zoom) return;
  s3dArrowLayer.lastLineZoom = zoom;
  for (const group of Object.values(s3dArrowLayer.lines)) {
    for (const tube of group.children || []) {
      const info = tube.userData.lineGeom;
      if (!info) continue;
      const radius = info.baseRadius * Math.pow(2, info.baseZoom - zoom);
      if (!(radius > 0) || Math.abs(radius - info.currentRadius) / info.currentRadius < 1e-4) continue;
      const ratio = radius / info.baseRadius;
      const pos = tube.geometry.attributes.position.array;
      const base = info.basePositions;
      const centers = info.centers;
      const stride = info.ringStride;
      for (let ring = 0; ring < centers.length / 3; ring++) {
        const cx = centers[ring * 3], cy = centers[ring * 3 + 1], cz = centers[ring * 3 + 2];
        for (let k = 0; k < stride; k += 3) {
          const idx = ring * stride + k;
          pos[idx] = cx + (base[idx] - cx) * ratio;
          pos[idx + 1] = cy + (base[idx + 1] - cy) * ratio;
          pos[idx + 2] = cz + (base[idx + 2] - cz) * ratio;
        }
      }
      tube.geometry.attributes.position.needsUpdate = true;
      info.currentRadius = radius;
    }
  }
}

function s3dCreateArrowLayer() {
  const THREE = s3dThree();
  if (!THREE) return null;
  const lines = {
    tracks: new THREE.Group(),
    replay: new THREE.Group(),
    progress: new THREE.Group()
  };
  return {
    id: S3D_ARROWHEADS,
    type: 'custom',
    renderingMode: '3d',
    models: new Map(),
    lines,
    // Reused every frame: MapLibre renders continuously, so allocating these
    // per marker/frame is avoidable garbage collection pressure.
    _scratchMatrix: new THREE.Matrix4(),
    _scratchScale: new THREE.Vector3(),
    _scratchRotation: new THREE.Matrix4(),
    _seenKeys: new Set(),
    lastLineZoom: null,
    onAdd(map, gl) {
      this.map = map;
      this.camera = new THREE.Camera();
      this.scene = new THREE.Scene();
      this.scene.add(lines.tracks, lines.replay, lines.progress);
      this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
      this.renderer.autoClear = false;
    },
    render(gl, args) {
      if (map3dPaused) return;
      const matrix = args?.defaultProjectionData?.mainMatrix;
      if (!matrix || !this.renderer || !this.scene || !map3dDomMarkers) return;
      s3dResizeThreeLines(this.map.getZoom());
      const seen = this._seenKeys;
      seen.clear();
      // One frame token for every marker projected by this WebGL render, so the
      // DOM marker pass can reuse the exact same screen points.
      const projectionFrame = ++s3dProjectionFrame;
      const transform = this.map.transform;
      const pixelMatrix = transform?._pixelMatrix3D;
      const Mc = window.maplibregl?.MercatorCoordinate;
      for (const [key, item] of map3dDomMarkers.entries()) {
        if (!Number.isFinite(item.lon) || !Number.isFinite(item.lat)) continue;
        seen.add(key);
        const elevation = s3dRenderAltitude(item.lon, item.lat, item.alt);
        if (Mc && transform && typeof transform.coordinatePoint === 'function' && pixelMatrix) {
          try {
            const pt = transform.coordinatePoint(
              Mc.fromLngLat([item.lon, item.lat]), elevation, pixelMatrix);
            s3dSetCachedScreenProjection(item, pt, pixelMatrix, projectionFrame);
          } catch (err) {}
        }
        // Reuses the cached point above; falls back to its own projection if
        // MapLibre's internal matrix is unavailable on this frame.
        s3dUpdateDomMarkerPosition(item);
        if (item.onScreen === false) {
          const hiddenModel = this.models.get(key);
          if (hiddenModel) hiddenModel.visible = false;
          continue;
        }
        // Refreshed once per marker upsert, not once per render frame.
        const type = item.s3dType || getResolvedType(item.popupData || {});
        const color = item.s3dColor || s3dResolveColor(s3dMarkerColor(item), THEME.accent);
        const templateKey = item.s3dTemplateKey || s3dTemplateKey(type, color);
        let model = this.models.get(key);
        if (!model || model.userData.templateKey !== templateKey) {
          if (model) { this.scene.remove(model); s3dDisposeObject(model); }
          model = s3dCreateMarkerInstance(type, color);
          if (!model) continue;
          this.models.set(key, model);
          this.scene.add(model);
        }
        model.visible = true;
        const mc = maplibregl.MercatorCoordinate.fromLngLat([item.lon, item.lat], elevation);
        // Convert the model to a fixed on-screen size at every zoom. The
        // template's bounding size and per-model pixel size keep each marker
        // consistent while its origin stays at lat/lon/alt.
        const metersPerPixel = 40075016.686 * Math.cos(item.lat * Math.PI / 180) /
          (512 * Math.pow(2, this.map.getZoom()));
        const unit = mc.meterInMercatorCoordinateUnits();
        const markerPx = model.userData.markerPx ?? S3D_ARROW_PX;
        const scaleFactor = metersPerPixel * markerPx / model.userData.modelSize;
        const course = Number(item.popupData?.course);
        const rot = Number.isFinite(course) ? -course * Math.PI / 180 : 0;
        const m = this._scratchMatrix
          .makeTranslation(mc.x, mc.y, mc.z)
          .scale(this._scratchScale.set(unit * scaleFactor, -unit * scaleFactor, unit * scaleFactor))
          .multiply(this._scratchRotation.makeRotationZ(rot));
        model.matrixAutoUpdate = false;
        model.matrix.copy(m);
      }
      for (const [key, model] of this.models) {
        if (seen.has(key)) continue;
        this.scene.remove(model);
        s3dDisposeObject(model);
        this.models.delete(key);
      }
      this.camera.projectionMatrix.fromArray(matrix);
      this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
      this.renderer.resetState();
      this.renderer.render(this.scene, this.camera);
    },
    onRemove() {
      // setStyle({ diff: false }) tears this layer down and recreates it. The
      // tube geometries/materials live in the line groups, not in models, so
      // they must be disposed here or every style swap leaks GPU memory.
      for (const group of Object.values(this.lines || {})) {
        s3dDisposeObject(group);
        group.clear?.();
      }
      for (const model of this.models.values()) s3dDisposeObject(model);
      this.models.clear();
      this.scene?.clear?.();
      this.renderer?.dispose();
    }
  };
}

// One colour per fix, using the same climb buckets as the flat 2D track.
function s3dVarioTrackColors(points, fallbackColor) {
  const n = points?.length || 0;
  const colors = new Array(n).fill(fallbackColor);
  if (!varioTrackMode || n < 2) return colors;
  for (let i = 1; i < n; i++) {
    const p0 = points[i - 1], p1 = points[i];
    const t0 = Number(p0[3]), t1 = Number(p1[3]);
    const dt = t1 - t0;
    const climb = (Number.isFinite(p0[2]) && Number.isFinite(p1[2]) &&
      Number.isFinite(t0) && Number.isFinite(t1) && dt > 0 && dt < 300)
      ? (p1[2] - p0[2]) / dt : null;
    colors[i] = varioColor(climb);
  }
  colors[0] = colors[1];
  return colors;
}

function s3dApplyVarioVertexColors(geom, curve, steps, colors, fallbackColor, THREE) {
  if (!varioTrackMode || !colors || colors.length < 2) return false;
  const radial = geom.parameters?.radialSegments ?? 5;
  const count = geom.attributes.position.count;
  const expected = (steps + 1) * (radial + 1);
  if (count !== expected) return false;
  const palette = colors.map(c => new THREE.Color(s3dResolveColor(c, fallbackColor)));
  const attr = new Float32Array(count * 3);
  for (let i = 0; i <= steps; i++) {
    const f = (i / steps) * (colors.length - 1);
    const a = Math.min(colors.length - 1, Math.floor(f));
    const b = Math.min(colors.length - 1, a + 1);
    const c = palette[a].clone().lerp(palette[b], f - a);
    for (let j = 0; j <= radial; j++) {
      const k = (i * (radial + 1) + j) * 3;
      attr[k] = c.r;
      attr[k + 1] = c.g;
      attr[k + 2] = c.b;
    }
  }
  geom.setAttribute('color', new THREE.BufferAttribute(attr, 3));
  return true;
}

function s3dReplaceThreeLines(group, segments) {
  const THREE = s3dThree();
  if (!group || !THREE || map3dPaused) return;
  const lineOrder = s3dArrowLayer?.lines?.tracks === group ? -3
    : s3dArrowLayer?.lines?.replay === group ? -2 : -1;
  for (const child of [...group.children]) {
    group.remove(child);
    s3dDisposeObject(child);
  }
  for (const seg of segments || []) {
    const curve = s3dCurveFromPoints(seg.points);
    if (!curve) continue;
    const radius = s3dLineRadius(seg.points, seg.widthPx ?? S3D_TRACK_PX);
    if (!(radius > 0)) continue;
    const valid = s3dSimplifyPoints(seg.points, 160);
    const fallback = s3dResolveColor(seg.color, THEME.accent);
    const pointColors = s3dVarioTrackColors(valid, fallback);
    const steps = Math.min(420, Math.max(2, curve.points.length * 2));
    const geom = new THREE.TubeGeometry(curve, steps, radius, 5, false);
    const hasVario = s3dApplyVarioVertexColors(geom, curve, steps, pointColors, fallback, THREE);
    const mat = new THREE.MeshBasicMaterial({
      color: hasVario ? 0xffffff : new THREE.Color(fallback),
      vertexColors: hasVario,
      transparent: true,
      opacity: seg.opacity ?? 0.95,
      depthTest: true,
      depthWrite: false
    });
    const tube = new THREE.Mesh(geom, mat);
    // Lines render before every marker and cannot occlude one via the depth buffer.
    tube.renderOrder = lineOrder;
    const centers = new Float32Array((steps + 1) * 3);
    for (let i = 0; i <= steps; i++) {
      const c = curve.getPointAt(i / steps);
      centers[i * 3] = c.x;
      centers[i * 3 + 1] = c.y;
      centers[i * 3 + 2] = c.z;
    }
    tube.userData.lineGeom = {
      centers,
      basePositions: Float32Array.from(geom.attributes.position.array),
      baseRadius: radius,
      currentRadius: radius,
      baseZoom: map3d?.getZoom() ?? 14,
      ringStride: (geom.parameters.radialSegments + 1) * 3
    };
    tube.frustumCulled = false;
    group.add(tube);
  }
  const zoomNow = map3d?.getZoom?.();
  if (s3dArrowLayer && Number.isFinite(zoomNow)) s3dArrowLayer.lastLineZoom = zoomNow;
}

function s3dSyncThreeLines() {
  if (!s3dArrowLayer?.lines) return;
  if (!replayActive) {
    s3dReplaceThreeLines(s3dArrowLayer.lines.tracks,
      [...selectedTracks.values()].map(entry => ({
        points: entry.points, color: entry.color, opacity: 0.95, widthPx: S3D_TRACK_PX
      })));
    s3dReplaceThreeLines(s3dArrowLayer.lines.replay, []);
    s3dReplaceThreeLines(s3dArrowLayer.lines.progress, []);
  } else {
    s3dReplaceThreeLines(s3dArrowLayer.lines.tracks, []);
    const color = selectedTracks.get(replayFollowAddress)?.color || THEME.accent;
    s3dReplaceThreeLines(s3dArrowLayer.lines.replay,
      (replayRenderSegments || []).map(seg => ({
        points: seg.points, color, opacity: 0.55, widthPx: S3D_TRACK_PX
      })));
  }
}

function s3dSyncThreeProgress(perSegment) {
  if (!s3dArrowLayer?.lines) return;
  const color = selectedTracks.get(replayFollowAddress)?.color || THEME.accent;
  s3dReplaceThreeLines(s3dArrowLayer.lines.progress,
    (perSegment || []).map(pts => ({ points: pts, color, opacity: 1, widthPx: S3D_PROGRESS_PX })));
}

function s3dTrackPointCoords(p) {
  return [p[1], p[0], s3dRenderAltitude(p[1], p[0], p[2])];
}

function s3dTrackLineFeature(points, color) {
  const valid = s3dSimplifyPoints(points, 220);
  if (valid.length < 2) return null;
  return s3dLineFeature(valid.map(s3dTrackPointCoords), color);
}

// Fallback for browsers without the three.js custom layer. In vario mode each
// fix pair gets the same climb bucket colour used by the flat 2D track.
function s3dTrackLineFeatures(points, color) {
  const valid = s3dSimplifyPoints(points, 220);
  if (valid.length < 2) return [];
  if (!varioTrackMode) {
    const f = s3dTrackLineFeature(valid, color);
    return f ? [f] : [];
  }
  const colors = s3dVarioTrackColors(valid, color);
  const features = [];
  for (let i = 1; i < valid.length; i++) {
    const p0 = valid[i - 1], p1 = valid[i];
    const f = s3dLineFeature([
      s3dTrackPointCoords(p0),
      s3dTrackPointCoords(p1)
    ], colors[i]);
    if (f) features.push(f);
  }
  return features;
}

function s3dSetData(sourceId, data) {
  if (!map3dReady || !map3d.getSource(sourceId)) return;
  map3d.getSource(sourceId).setData(data);
}

function s3dUnbindPopupDetails(state) {
  if (!state) return;
  if (state.detailsEl && state.detailsHandler) {
    try { state.detailsEl.removeEventListener('toggle', state.detailsHandler); } catch (err) {}
  }
  state.detailsEl = null;
  state.detailsHandler = null;
}

function s3dBind2DPopupHandlers(popupEl, key, address) {
  if (!popupEl) return;
  const state = map3dDomPopupState.get(key) || { popup: null, detailsOpen: false };
  const detailsEl = popupEl.querySelector('[data-popup-details]');
  s3dUnbindPopupDetails(state);
  if (detailsEl) {
    detailsEl.open = !!state.detailsOpen;
    // <details> emits toggle, not change. Store the listener so a replaced
    // popup body can unbind it instead of accumulating detached handlers.
    const handler = () => {
      state.detailsOpen = detailsEl.open;
      map3dDomPopupState.set(key, state);
    };
    detailsEl.addEventListener('toggle', handler);
    state.detailsEl = detailsEl;
    state.detailsHandler = handler;
  }
  map3dDomPopupState.set(key, state);
  popupEl.querySelectorAll('.popup-actions button').forEach(btn => {
    btn.onclick = ev => {
      ev.preventDefault();
      ev.stopPropagation();
      const act = btn.dataset.act;
      const addr = (btn.dataset.addr || address || '').toLowerCase();
      if (act === 'alert-sar') {
        const txt = btn.dataset.sar || '';
        if (txt) copyTextToClipboard(txt, 'SAR copied');
        return;
      }
      if (act === 'replay') {
        if (!addr) return;
        replayFollowAddress = addr;
        clear3DReplayFollowMarkers();
        replayOnlyFocus = true;
        replayDirection = 1;
        followCenteringPaused = false;
        syncReplayDirectionButton();
        syncRecenterButton();
        $('replaySlider').value = '0';
        lastReplayScrubValue = null;
        if (state.popup) state.popup.remove();
        setReplayMode(true, { startAtTrackStart: true, play: true });
        syncReplayFollowLabel();
        return;
      }
      if (act === 'track') {
        if (!addr) return;
        toggleSelection(addr, false);
        const aa = findAircraftByAddress(addr);
        if (aa && state.popup && state.popup.isOpen()) {
          state.popup.setHTML(popup(aa));
          s3dBind2DPopupHandlers(state.popup.getElement(), key, addr);
        }
      } else if (act === 'share') {
        const base = getShareUrl();
        const url = addr ? `${base.replace(/#.*/, '')}#${map.getCenter().lat.toFixed(4)},${map.getCenter().lng.toFixed(4)},${map.getZoom()},${encodeURIComponent(addr)}` : base;
        copyTextToClipboard(url, 'Link copied');
      } else if (act === 'sar') {
        const aa = findAircraftByAddress(addr);
        if (aa) copyTextToClipboard(buildSarText(aa), 'SAR info copied');
      } else if (act === 'igc') {
        downloadIgc(addr);
      }
    };
  });
}

function s3dPopupPane() {
  let pane = $('mapWrap').querySelector('.ogn-3d-popup-pane');
  if (!pane) {
    // The Leaflet container class gives the close button its 2D styling. The
    // pane is a sibling of #map3d so the popup can sit above the 3D canvas.
    pane = document.createElement('div');
    pane.className = 'leaflet-container leaflet-popup-pane popup-pane-raised ogn-3d-popup-pane';
    $('mapWrap').appendChild(pane);
  }
  return pane;
}

function s3dPositionPopup(popupEl) {
  if (!popupEl?.isConnected) return;
  const wrap = $('mapWrap');
  const mapEl = map3dActive ? ($('map3d') || map3d?.getContainer()) : $('map');
  if (!wrap || !mapEl) return;
  const wrapRect = wrap.getBoundingClientRect();
  const mapRect = mapEl.getBoundingClientRect();
  const popupRect = popupEl.getBoundingClientRect();
  const safeBottom = popupSafeBottom(mapRect);
  const margin = 8;
  let targetY = mapRect.height / 2;
  if (safeBottom != null) targetY = Math.min(targetY, safeBottom / 2);
  targetY = Math.max(popupRect.height / 2 + margin, Math.min(targetY, mapRect.height - popupRect.height / 2 - margin));
  popupEl.style.left = `${mapRect.left - wrapRect.left + mapRect.width / 2}px`;
  popupEl.style.top = `${mapRect.top - wrapRect.top + targetY}px`;
}

function s3dRepositionOpenPopups() {
  if (!map3dActive) return;
  for (const st of map3dDomPopupState.values()) {
    if (st.popup?.isOpen()) s3dPositionPopup(st.popup.getElement());
  }
}

function s3dCreatePopupController(key) {
  const el = document.createElement('div');
  // Same markup as Leaflet's popup, so 2D and 3D share all .leaflet-popup styles.
  el.className = 'leaflet-popup ogn-2d-in-3d-popup ogn-3d-leaflet-popup';
  el.innerHTML = `
    <a class="leaflet-popup-close-button" href="#close" aria-label="Close popup">&times;</a>
    <div class="leaflet-popup-content-wrapper"><div class="leaflet-popup-content"></div></div>
    <div class="leaflet-popup-tip-container"><div class="leaflet-popup-tip"></div></div>
  `;
  const contentEl = el.querySelector('.leaflet-popup-content');
  el.querySelector('.leaflet-popup-close-button').addEventListener('click', ev => {
    ev.preventDefault();
    ev.stopPropagation();
    map3dDomPopupState.get(key)?.popup?.remove();
  });
  const controller = {
    el,
    isOpen: () => el.isConnected,
    getElement: () => el,
    addTo: () => {
      s3dPopupPane().appendChild(el);
      s3dPositionPopup(el);
      return controller;
    },
    setHTML: html => {
      const st = map3dDomPopupState.get(key);
      const detailsEl = el.querySelector('[data-popup-details]');
      if (detailsEl && st) st.detailsOpen = detailsEl.open;
      if (st) s3dUnbindPopupDetails(st);
      contentEl.innerHTML = html;
      s3dPositionPopup(el);
      return controller;
    },
    remove: () => {
      const st = map3dDomPopupState.get(key);
      const detailsEl = el.querySelector('[data-popup-details]');
      if (detailsEl && st) st.detailsOpen = detailsEl.open;
      if (st) s3dUnbindPopupDetails(st);
      el.remove();
    }
  };
  return controller;
}

function s3dOpenPopupForKey(key, dataObj) {
  if (!map3d || !dataObj) return;
  for (const [otherKey, st] of map3dDomPopupState.entries()) {
    if (otherKey !== key && st.popup && st.popup.isOpen()) {
      st.popup.remove();
    }
  }
  let st = map3dDomPopupState.get(key) || { popup: null, detailsOpen: false };
  if (!st.popup) st.popup = s3dCreatePopupController(key);
  st.popup.setHTML(popup(dataObj)).addTo(map3d);
  map3dDomPopupState.set(key, st);
  requestAnimationFrame(() => {
    s3dBind2DPopupHandlers(st.popup.getElement(), key, dataObj.address);
    s3dPositionPopup(st.popup.getElement());
  });
}

function s3dProject3DPoint(lng, lat, altMSL) {
  if (!map3d || !Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  const Mc = window.maplibregl?.MercatorCoordinate;
  const transform = map3d.transform;
  if (Mc && transform && typeof transform.coordinatePoint === 'function' && transform._pixelMatrix3D) {
    // Keep the DOM marker, name and HUD above the DEM surface at the same
    // screen position as the WebGL model. coordinatePoint() expects the
    // elevation in metres and the 3D pixel matrix when the camera is pitched;
    // the default pixel matrix puts labels far from elevated 3D markers.
    const elevation = s3dRenderAltitude(lng, lat, altMSL);
    try {
      const pt = transform.coordinatePoint(
        Mc.fromLngLat([lng, lat]),
        elevation,
        transform._pixelMatrix3D
      );
      if (pt && Number.isFinite(pt.x) && Number.isFinite(pt.y)) return pt;
    } catch (err) {
      // Fall through to the 2D projection if the internal matrix is unavailable.
    }
  }
  return map3d.project?.([lng, lat]) || null;
}

// The custom 3D layer already projects every marker for its WebGL transform.
// Store that screen point so the DOM marker pass can reuse it instead of
// running coordinatePoint() and s3dRenderAltitude() a second time per frame.
function s3dSetCachedScreenProjection(item, pt, matrix, frame) {
  if (!item || !pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return;
  item.s3dProjX = pt.x;
  item.s3dProjY = pt.y;
  item.s3dProjFrame = frame;
  item.s3dProjMatrix = matrix;
}

/** Inverse of s3dProject3DPoint for one fixed rendered altitude. */
function s3dUnprojectAtElevation(px, py, elevation) {
  if (!map3d) return null;
  const Mc = window.maplibregl?.MercatorCoordinate;
  const m = map3d.transform?._pixelMatrix3D;
  const worldSize = map3d.transform?.worldSize;
  if (!Mc || !m || m.length < 16 || !worldSize) return null;
  try {
    const a11 = m[0] - px * m[3];
    const a12 = m[4] - px * m[7];
    const a21 = m[1] - py * m[3];
    const a22 = m[5] - py * m[7];
    const b1 = px * (m[11] * elevation + m[15]) - (m[8] * elevation + m[12]);
    const b2 = py * (m[11] * elevation + m[15]) - (m[9] * elevation + m[13]);
    const det = a11 * a22 - a12 * a21;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return null;
    const x = (b1 * a22 - a12 * b2) / det / worldSize;
    const y = (a11 * b2 - b1 * a21) / det / worldSize;
    const ll = new Mc(x, y, 0).toLngLat();
    if (ll && Number.isFinite(ll.lat) && Number.isFinite(ll.lng)) {
      return L.latLng(ll.lat, s3dWrapLon(ll.lng));
    }
  } catch (err) {
    // Fall through; the flat unprojection is still usable as a fallback.
  }
  return null;
}

/**
 * Screen point to ground coordinate in the 3D view. MapLibre's plain unproject
 * lands on the sea-level plane, so refine against the DEM elevation at that
 * coordinate to hit the terrain the user actually clicked.
 */
function s3dUnproject3DPoint(px, py) {
  if (!map3d || !Number.isFinite(px) || !Number.isFinite(py)) return null;
  let ll = null;
  try { ll = map3d.unproject?.([px, py]); } catch (err) {}
  if (!ll || !Number.isFinite(ll.lat) || !Number.isFinite(ll.lng)) return null;
  ll = L.latLng(ll.lat, s3dWrapLon(ll.lng));
  if (!map3d.transform?._pixelMatrix3D) return ll;

  for (let iteration = 0; iteration < 4; iteration++) {
    const elevation = s3dQueryTerrainElevation(ll.lng, ll.lat) ?? 0;
    const next = s3dUnprojectAtElevation(px, py, elevation);
    if (!next) break;
    let dLon = next.lng - ll.lng;
    if (dLon > 180) dLon -= 360;
    else if (dLon < -180) dLon += 360;
    const metersPerLng = 111320 * Math.max(0.2, Math.cos(next.lat * Math.PI / 180));
    const shiftM = Math.hypot((next.lat - ll.lat) * 111320, dLon * metersPerLng);
    ll = next;
    if (shiftM < 0.5) break;
  }
  return ll;
}

/** Project a ground coordinate at its exact DEM elevation for overlay lines. */
function s3dProjectGroundPoint(lng, lat) {
  if (!map3d || !Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  const Mc = window.maplibregl?.MercatorCoordinate;
  const transform = map3d.transform;
  if (Mc && transform && typeof transform.coordinatePoint === 'function' && transform._pixelMatrix3D) {
    const elevation = s3dQueryTerrainElevation(lng, lat) ?? 0;
    try {
      const pt = transform.coordinatePoint(Mc.fromLngLat([lng, lat]), elevation, transform._pixelMatrix3D);
      if (pt && Number.isFinite(pt.x) && Number.isFinite(pt.y)) return pt;
    } catch (err) {
      // Fall through to the flat projection.
    }
  }
  return map3d.project?.([lng, lat]) || null;
}

// MapLibre's map center is the ground point under the middle of the viewport.
// A pitched camera puts an elevated aircraft above that point, so following the
// ground coordinate alone leaves the marker off-centre. Return the ground
// coordinate that places the aircraft's rendered altitude at the viewport
// centre; callers in 2D keep using the plain lat/lon.
function s3dCameraCenterForPoint(lng, lat, altMSL = null) {
  if (!map3dReady || !map3d || !Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  const Mc = window.maplibregl?.MercatorCoordinate;
  const transform = map3d.transform;
  const m = transform?._pixelMatrix3D;
  const worldSize = transform?.worldSize;
  const centerPoint = transform?.centerPoint;
  if (!Mc || !m || m.length < 16 || !worldSize || !centerPoint) return null;
  try {
    // Invert the *3D* pixel matrix at the aircraft's rendered elevation. The
    // 2D screenPointToMercatorCoordinateAtZ() helper takes a normalised
    // mercator z, while coordinatePoint() with _pixelMatrix3D takes metres, so
    // it cannot be used for this correction.
    const elevation = s3dRenderAltitude(lng, lat, altMSL);
    const cx = centerPoint.x, cy = centerPoint.y;
    const a11 = m[0] - cx * m[3];
    const a12 = m[4] - cx * m[7];
    const a21 = m[1] - cy * m[3];
    const a22 = m[5] - cy * m[7];
    const b1 = cx * (m[11] * elevation + m[15]) - (m[8] * elevation + m[12]);
    const b2 = cy * (m[11] * elevation + m[15]) - (m[9] * elevation + m[13]);
    const det = a11 * a22 - a12 * a21;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return null;
    const underX = (b1 * a22 - a12 * b2) / det / worldSize;
    const underY = (a11 * b2 - b1 * a21) / det / worldSize;
    const c = map3d.getCenter();
    const current = Mc.fromLngLat([c.lng, c.lat]);
    const aircraft = Mc.fromLngLat([lng, lat]);
    if (![current, aircraft].every(v => v && Number.isFinite(v.x) && Number.isFinite(v.y))) return null;
    const ll = new Mc(
      current.x + aircraft.x - underX,
      current.y + aircraft.y - underY,
      0
    ).toLngLat();
    if (ll && Number.isFinite(ll.lat) && Number.isFinite(ll.lng)) return L.latLng(ll.lat, ll.lng);
  } catch (err) {
    // Fall through to the plain ground centre if MapLibre internals change.
  }
  return null;
}

// Replay updates the camera several times per second. Calling the matrix-based
// correction on each update while MapLibre is still easing makes the target move
// with the animation and the view shakes. Cache the altitude-to-ground offset
// while the camera orientation is stable, then apply it to the smoothly
// interpolated replay position instead.
function s3dReplayCameraCenter(lng, lat, altMSL) {
  const ground = L.latLng(lat, lng);
  if (!map3dReady || !map3d || !Number.isFinite(lng) || !Number.isFinite(lat)) return ground;
  const renderAlt = s3dRenderAltitude(lng, lat, altMSL);
  if (!(renderAlt > 0)) return s3dCameraCenterForPoint(lng, lat, altMSL) || ground;
  const sig = [
    replayFollowAddress || '',
    map3d.getZoom?.(),
    map3d.getPitch?.(),
    map3d.getBearing?.()
  ].map(v => typeof v === 'string' ? v : Math.round((Number(v) || 0) * 100)).join(':');
  if (s3dReplayCenterSig !== sig || !s3dReplayCenterRatio) {
    const corrected = s3dCameraCenterForPoint(lng, lat, altMSL);
    if (!corrected || !Number.isFinite(corrected.lat) || !Number.isFinite(corrected.lng)) return ground;
    const metersPerLng = 111320 * Math.max(0.2, Math.cos(lat * Math.PI / 180));
    s3dReplayCenterRatio = {
      northPerM: (corrected.lat - lat) * 111320 / renderAlt,
      eastPerM: (corrected.lng - lng) * metersPerLng / renderAlt
    };
    s3dReplayCenterSig = sig;
  }
  // A DEM tile can finish loading mid-replay and change the rendered altitude
  // by tens of metres. Ease the correction instead of snapping the camera.
  if (s3dReplaySmoothSig !== sig || s3dReplaySmoothAlt == null) {
    s3dReplaySmoothAlt = renderAlt;
    s3dReplaySmoothSig = sig;
  } else {
    s3dReplaySmoothAlt += (renderAlt - s3dReplaySmoothAlt) * 0.25;
  }
  const metersPerLng = 111320 * Math.max(0.2, Math.cos(lat * Math.PI / 180));
  return L.latLng(
    lat + s3dReplayCenterRatio.northPerM * s3dReplaySmoothAlt / 111320,
    s3dWrapLon(lng + s3dReplayCenterRatio.eastPerM * s3dReplaySmoothAlt / metersPerLng)
  );
}

function s3dUpdateDomMarkerPosition(item) {
  if (!item || !item.el || !map3d) return;
  let px, py;
  const matrix = map3d.transform?._pixelMatrix3D;
  if (item.s3dProjFrame === s3dProjectionFrame && item.s3dProjMatrix === matrix &&
      Number.isFinite(item.s3dProjX) && Number.isFinite(item.s3dProjY)) {
    // Same render frame and same 3D matrix: the WebGL layer already projected it.
    px = item.s3dProjX;
    py = item.s3dProjY;
  } else {
    const pt = s3dProject3DPoint(item.lon, item.lat, item.alt);
    if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) {
      item.onScreen = false;
      if (item.s3dLastDisplay !== 'none') {
        item.el.style.display = 'none';
        item.s3dLastDisplay = 'none';
      }
      return;
    }
    px = pt.x;
    py = pt.y;
  }
  // Leaflet culls outside markers in 2D. The 3D custom layer positions DOM and
  // WebGL markers itself, so cull them by projected screen position here too.
  // The margin covers the marker plus its name/HUD before hiding it.
  const canvas = map3d.getCanvas?.();
  const width = map3d.transform?.width || canvas?.clientWidth || 0;
  const height = map3d.transform?.height || canvas?.clientHeight || 0;
  const margin = S3D_MARKER_CULL_MARGIN_PX;
  item.onScreen = !width || !height ||
    (px >= -margin && px <= width + margin && py >= -margin && py <= height + margin);
  const display = item.onScreen ? '' : 'none';
  if (item.s3dLastDisplay !== display) {
    item.el.style.display = display;
    item.s3dLastDisplay = display;
  }
  // The arrowhead itself is rotated in WebGL. Keep the DOM hit target and its
  // name screen-aligned so the label always reads below the marker, whatever
  // the map bearing or pitch.
  const css = `translate(-50%, -50%) translate(${px.toFixed(1)}px, ${py.toFixed(1)}px)`;
  if (item.s3dLastTransform !== css) {
    item.el.style.transform = css;
    item.s3dLastTransform = css;
  }
}

function s3dUpdateDomMarkerPositions() {
  if (!map3dActive || !map3dDomMarkers.size) return;
  for (const item of map3dDomMarkers.values()) s3dUpdateDomMarkerPosition(item);
}

function s3dMarkerColor(item) {
  // 3D markers use the same type colours as the aircraft-list stripes, not
  // the per-track colour used by the flat 2D icons.
  const typeColor = item?.popupData ? typeStripeColor(item.popupData) : null;
  const inline = item?.el?.querySelector('.glider-wrap')?.style.getPropertyValue('--marker-color');
  return s3dResolveColor(typeColor, s3dResolveColor(inline, THEME.accent));
}

function s3dRefreshMarkerStyle(item) {
  if (!item) return;
  const type = getResolvedType(item.popupData || {});
  const color = s3dResolveColor(s3dMarkerColor(item), THEME.accent);
  item.s3dType = type;
  item.s3dColor = color;
  item.s3dTemplateKey = s3dTemplateKey(type, color);
}

function s3dMarkerGeometry() {
  const features = [];
  if (!map3d || !map3dActive) return s3dFeatureCollection(features);
  // Only a small ground shadow is native MapLibre geometry. The aircraft model
  // itself is drawn in the three.js custom layer at its true 3D altitude.
  for (const [key, item] of map3dDomMarkers.entries()) {
    if (!Number.isFinite(item.lon) || !Number.isFinite(item.lat)) continue;
    if (item.onScreen === false) continue;
    const ground = s3dQueryTerrainElevation(item.lon, item.lat) ?? 0;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [item.lon, item.lat, ground] },
      properties: {
        id: key,
        color: s3dResolveColor(s3dMarkerColor(item), THEME.accent),
        label: item.el?.querySelector('.glider-label')?.textContent || '',
        role: 'ground'
      }
    });
  }
  return s3dFeatureCollection(features);
}

function s3dSyncMarkerGeometry() {
  if (!map3dReady || !map3dActive) return;
  const source = map3d.getSource(S3D_MARKERS);
  if (!source) return;
  const data = s3dMarkerGeometry();
  const sig = JSON.stringify(data.features.map(f => [f.geometry.type, f.geometry.coordinates, f.properties]));
  if (sig === s3dMarkerGeoJsonSig) return;
  s3dMarkerGeoJsonSig = sig;
  source.setData(data);
}

function s3dUpsertDomMarker(key, lat, lon, alt, iconHtml, popupData, opts = {}) {
  if (!map3d || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
  let item = map3dDomMarkers.get(key);
  if (!item) {
    const el = document.createElement('div');
    el.className = `ogn-3d-dom-marker${opts.focused ? ' focused' : ''}`;
    el.innerHTML = iconHtml;
    // Positioned directly from MapLibre's 3D projection each render. Using a
    // normal MapLibre Marker would clamp the icon to the terrain surface, not
    // to the aircraft's MSL altitude in the pitched 3D view.
    ($('map3d') || map3d.getContainer()).appendChild(el);
    el.addEventListener('click', ev => {
      ev.stopPropagation();
      const currentLat = item && Number.isFinite(item.lat) ? item.lat : lat;
      const currentLon = item && Number.isFinite(item.lon) ? item.lon : lon;
      if (measureMode) {
        addMeasurePoint(currentLat, currentLon);
        return;
      }
      if (item?.onClick) item.onClick();
      const currentPopup = item?.popupData || popupData;
      if (currentPopup) {
        s3dOpenPopupForKey(key, currentPopup);
      }
    });
    item = { el, lat, lon, alt, html: iconHtml, popupData, onClick: opts.onClick, s3dShowName: false };
    map3dDomMarkers.set(key, item);
  } else {
    item.popupData = popupData;
    // The callback captures the address/payload from the upsert that created the
    // marker. Refresh it on every update so a reused key cannot act on stale data.
    item.onClick = opts.onClick;
    if (item.html !== iconHtml) {
      item.html = iconHtml;
      item.el.innerHTML = iconHtml;
    }
    if (opts.focused != null) item.el.classList.toggle('focused', !!opts.focused);
  }
  item.lat = lat;
  item.lon = lon;
  item.alt = alt;
  s3dRefreshMarkerStyle(item);
  s3dUpdateDomMarkerPosition(item);
  const st = map3dDomPopupState.get(key);
  if (st && st.popup && st.popup.isOpen() && popupData) {
    st.popup.setHTML(popup(popupData));
    requestAnimationFrame(() => {
      s3dBind2DPopupHandlers(st.popup.getElement(), key, popupData.address);
      s3dPositionPopup(st.popup.getElement());
    });
  }
}

function s3dClearDomMarkers(prefix = '') {
  for (const [key, item] of [...map3dDomMarkers.entries()]) {
    if (!prefix || key.startsWith(prefix)) {
      item.el.remove();
      map3dDomMarkers.delete(key);
    }
  }
}

function clear3DReplayFollowMarkers() {
  // Replay point/focus markers are keyed independently of the followed address,
  // so switching follow target must drop both sets.
  s3dClearDomMarkers('rpts:');
  s3dClearDomMarkers('rfocus:');
}

const S3D_LABEL_GRID_PX = 120;
let s3dCollisionStamp = 0;

function s3dLabelGridCells(rect, pad) {
  const cells = [];
  const x0 = Math.floor((rect.left - pad) / S3D_LABEL_GRID_PX);
  const x1 = Math.floor((rect.right + pad) / S3D_LABEL_GRID_PX);
  const y0 = Math.floor((rect.top - pad) / S3D_LABEL_GRID_PX);
  const y1 = Math.floor((rect.bottom + pad) / S3D_LABEL_GRID_PX);
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) cells.push(`${x},${y}`);
  }
  return cells;
}

function s3dGridAdd(grid, rect, value, pad) {
  for (const cell of s3dLabelGridCells(rect, pad)) {
    if (!grid.has(cell)) grid.set(cell, []);
    grid.get(cell).push({ rect, value, stamp: 0 });
  }
}

function s3dGridQuery(grid, rect, pad, stamp) {
  const found = [];
  for (const cell of s3dLabelGridCells(rect, pad)) {
    for (const entry of grid.get(cell) || []) {
      if (entry.stamp === stamp) continue;
      entry.stamp = stamp;
      found.push(entry.value);
    }
  }
  return found;
}

function s3dUpdateDomLabelsCollision() {
  if (!map3dActive || !map3dDomMarkers.size) return;
  const mapRect = $('map3d')?.getBoundingClientRect();
  if (!mapRect) return;
  const candidates = [];
  // Read all rects before writing any show-name class. Visibility/opacity do
  // not affect layout, so the old clear-everything pass was only forcing style
  // recalculation; here classes change only when the desired state changes.
  for (const [key, item] of map3dDomMarkers.entries()) {
    const el = item.el;
    if (!el) continue;
    const iconRect = el.getBoundingClientRect();
    if (iconRect.width <= 0 || iconRect.height <= 0) continue;
    const label = el.querySelector('.glider-label');
    if (!label) continue;
    const labelRect = label.getBoundingClientRect();
    if (labelRect.width <= 0 || labelRect.height <= 0) continue;
    if (labelRect.left < mapRect.left + 2 || labelRect.right > mapRect.right - 2 ||
        labelRect.top < mapRect.top + 2 || labelRect.bottom > mapRect.bottom - 2) continue;
    const isTracked = selectedTracks.has(key.replace(/^live:/, ''));
    const isFocus = el.classList.contains('focused') || key.startsWith('rfocus:');
    const priority = (isFocus ? 5 : 0) + (isTracked ? 2 : 0);
    candidates.push({ el, iconRect, labelRect, priority });
  }
  candidates.sort((a, b) => b.priority - a.priority ||
    a.labelRect.left - b.labelRect.left || a.labelRect.top - b.labelRect.top);

  const iconGrid = new Map();
  const shownGrid = new Map();
  for (const c of candidates) s3dGridAdd(iconGrid, c.iconRect, c, 2);
  const showEls = new Set();
  for (const c of candidates) {
    const stamp = ++s3dCollisionStamp;
    let blocked = false;
    for (const other of s3dGridQuery(iconGrid, c.labelRect, 2, stamp)) {
      if (other !== c && markerRectsOverlap(c.labelRect, other.iconRect, 2)) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;
    for (const rect of s3dGridQuery(shownGrid, c.labelRect, 3, stamp)) {
      if (markerRectsOverlap(c.labelRect, rect, 3)) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;
    showEls.add(c.el);
    s3dGridAdd(shownGrid, c.labelRect, c.labelRect, 3);
  }
  for (const item of map3dDomMarkers.values()) {
    const el = item.el;
    if (!el) continue;
    const desired = showEls.has(el);
    if (!!item.s3dShowName !== desired) {
      el.classList.toggle('show-name', desired);
      item.s3dShowName = desired;
    }
  }
}

function s3dCloseOffscreenPopups() {
  if (!map3dActive) return;
  for (const [key, st] of map3dDomPopupState.entries()) {
    if (!st.popup?.isOpen()) continue;
    const item = map3dDomMarkers.get(key);
    // 3D popups are centred in the map instead of pinned to the marker, so an
    // open popup would otherwise keep showing an aircraft that has left (or
    // never entered) the visible viewport.
    if (!item || item.onScreen === false) st.popup.remove();
  }
}

// Motion frames only move markers. Collision detection, popup checks and GeoJSON
// signature work are layout-heavy, so they run on a trailing timer / moveend.
function s3dScheduleMarkerMotion() {
  if (map3dPaused || s3dDomMarkerSyncRaf !== null) return;
  s3dDomMarkerSyncRaf = requestAnimationFrame(() => {
    s3dDomMarkerSyncRaf = null;
    s3dUpdateDomMarkerPositions();
  });
}

function s3dRunDeferredLabelSync() {
  if (s3dDeferredSyncTimer !== null) {
    clearTimeout(s3dDeferredSyncTimer);
    s3dDeferredSyncTimer = null;
  }
  if (map3dPaused || !map3dActive) return;
  s3dCloseOffscreenPopups();
  s3dSyncMarkerGeometry();
  s3dUpdateDomLabelsCollision();
}

function s3dScheduleDeferredLabelSync() {
  if (map3dPaused || !map3dActive || s3dDeferredSyncTimer !== null) return;
  s3dDeferredSyncTimer = setTimeout(() => {
    s3dDeferredSyncTimer = null;
    s3dRunDeferredLabelSync();
  }, S3D_LABEL_DEFER_MS);
}

function s3dScheduleLabelUpdate() {
  s3dScheduleMarkerMotion();
  s3dScheduleDeferredLabelSync();
}

function setup3DLayers() {
  // The initial load handler and a base-style swap can both finish after the
  // first 3D activation; add the custom sources only once per style.
  try { map3d.setSky?.(S3D_SKY); } catch (err) {}
  s3dTerrainElevationCache.clear();
  if (s3dTerrainRetryTimer !== null) {
    clearTimeout(s3dTerrainRetryTimer);
    s3dTerrainRetryTimer = null;
  }
  if (map3d.getSource(S3D_DEM)) return;
  s3dArrowLayer = null;
  map3d.addSource(S3D_DEM, {
    type: 'raster-dem',
    tiles: [MAP3D_DEM_URL],
    encoding: 'terrarium',
    tileSize: 256,
    maxzoom: 15,
    attribution: 'Terrain &copy; <a href="https://registry.opendata.aws/terrain-tiles/">Mapzen / Tilezen / AWS Open Data</a>'
  });
  for (const id of [S3D_TRACKS, S3D_CURTAINS, S3D_AIRSPACE, S3D_THERMALS, S3D_REPLAY_TRACK, S3D_REPLAY_PROGRESS, S3D_MARKERS]) {
    map3d.addSource(id, { type: 'geojson', data: S3D_EMPTY_FC });
  }
  map3d.setTerrain({ source: S3D_DEM });

  map3d.addLayer({
    id: 'ogn-3d-thermals-heat', type: 'heatmap', source: S3D_THERMALS,
    paint: {
      'heatmap-weight': ['coalesce', ['get', 'intensity'], 0.5],
      'heatmap-intensity': 1.1,
      'heatmap-radius': 18,
      'heatmap-opacity': 0.65,
      'heatmap-color': [
        'interpolate', ['linear'], ['heatmap-density'],
        0, 'rgba(56,189,248,0)',
        0.2, '#38bdf8',
        0.5, THEME.yellow,
        0.8, '#f97316',
        1.0, '#ef4444'
      ]
    }
  });
  map3d.addLayer({
    id: 'ogn-3d-airspace-fill', type: 'fill', source: S3D_AIRSPACE,
    paint: { 'fill-color': THEME.yellow, 'fill-opacity': 0.14 }
  });
  map3d.addLayer({
    id: 'ogn-3d-airspace-line', type: 'line', source: S3D_AIRSPACE,
    paint: { 'line-color': THEME.yellow, 'line-width': 2 }
  });
  map3d.addLayer({
    id: 'ogn-3d-track-line', type: 'line', source: S3D_TRACKS,
    paint: {
      'line-color': ['coalesce', ['get', 'color'], THEME.accent],
      'line-width': S3D_TRACK_PX,
      'line-opacity': 0.95
    }
  });
  map3d.addLayer({
    id: 'ogn-3d-replay-track-line', type: 'line', source: S3D_REPLAY_TRACK,
    paint: {
      'line-color': ['coalesce', ['get', 'color'], THEME.accent],
      'line-width': S3D_TRACK_PX,
      'line-opacity': 0.5
    }
  });
  map3d.addLayer({
    id: 'ogn-3d-replay-progress-line', type: 'line', source: S3D_REPLAY_PROGRESS,
    paint: {
      'line-color': ['coalesce', ['get', 'color'], THEME.accent],
      'line-width': S3D_PROGRESS_PX,
      'line-opacity': 0.98
    }
  });
  map3d.addLayer({
    id: 'ogn-3d-marker-ground', type: 'circle', source: S3D_MARKERS,
    filter: ['==', ['get', 'role'], 'ground'],
    paint: {
      'circle-radius': 4,
      'circle-color': ['coalesce', ['get', 'color'], THEME.accent],
      'circle-opacity': 0.35,
      'circle-stroke-width': 1,
      'circle-stroke-color': '#0b121a',
      'circle-stroke-opacity': 0.8
    }
  });
  // Real 3D aircraft models and elevated track lines are drawn by a custom
  // WebGL layer; the plain circle above only marks the ground position.
  if (s3dThree()) {
    s3dArrowLayer = s3dCreateArrowLayer();
    if (s3dArrowLayer) map3d.addLayer(s3dArrowLayer);
  }
  s3dMarkerGeoJsonSig = '';
}

function ensure3DMap() {
  if (map3d) return true;
  if (!window.maplibregl) {
    showToast('3D map could not load.');
    return false;
  }
  const c = map.getCenter();
  try {
    map3d = new maplibregl.Map({
      container: 'map3d',
      style: MAP3D_BASE_STYLES[map3dBaseKey] || MAP3D_BASE_STYLES.liberty,
      center: [c.lng, c.lat],
      zoom: Math.max(2, Math.min(16, map.getZoom() + 1)),
      pitch: 58,
      bearing: 0,
      maxPitch: 85,
      minZoom: 2,
      maxZoom: 16,
      attributionControl: false,
      antialias: true
    });
  } catch (err) {
    console.warn('3D map init failed:', err);
    map3d = null;
    showToast('3D map could not start.');
    return false;
  }
  // Keep MapLibre's native compass, but host it in the Leaflet control stack so
  // it sits directly under the 2D/3D toggle instead of at the map's bottom-left.
  const compassControl = new maplibregl.NavigationControl({ visualizePitch: true, showCompass: true, showZoom: false });
  compass3DControl.getContainer().appendChild(compassControl.onAdd(map3d));
  map3d.on('load', () => {
    setup3DLayers();
    map3dReady = true;
    resize3D();
    syncAll3DData();
    sync3DFromLeaflet();
  });
  map.on('moveend', () => {
    if (consumeLeafletCameraStop()) return;
    if (map3dPaused || !map3dActive) return;
    sync3DFromLeaflet();
  });
  map3d.on('moveend', () => {
    if (consume3DCameraStop()) return;
    if (map3dPaused || !map3dActive) return;
    syncLeafletFrom3D();
  });
  // Always flush label/collision work at the end of a camera move, including
  // expected sync moves that the handler above deliberately ignores.
  map3d.on('moveend', s3dRunDeferredLabelSync);
  map3d.on('move', s3dScheduleLabelUpdate);
  map3d.on('sourcedata', e => {
    if (e.sourceId !== S3D_DEM) return;
    if (e.isSourceLoaded) s3dMarkTerrainRecovered();
    s3dScheduleTerrainRefresh();
  });
  map3d.on('error', e => {
    if (s3dIsDemErrorEvent(e)) s3dMarkTerrainDegraded();
  });
  map3d.on('click', e => {
    const hit = map3d.queryRenderedFeatures(e.point, {
      layers: ['ogn-3d-marker-ground']
    })[0];
    let key = hit?.properties?.id;
    let item = key ? map3dDomMarkers.get(key) : null;
    if (!measureMode && !item) {
      // The ground circle is small and sits below elevated 3D models. Fall back
      // to the nearest projected marker in screen space so clicks on the model
      // still select/open it. Measure mode keeps using the unprojected ground
      // point under the cursor.
      let bestDist2 = 18 * 18;
      for (const [markerKey, candidate] of map3dDomMarkers) {
        if (!Number.isFinite(candidate.lat) || !Number.isFinite(candidate.lon)) continue;
        const pt = s3dProject3DPoint(candidate.lon, candidate.lat, candidate.alt);
        if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) continue;
        const dx = pt.x - e.point.x, dy = pt.y - e.point.y;
        const dist2 = dx * dx + dy * dy;
        if (dist2 <= bestDist2) {
          bestDist2 = dist2;
          key = markerKey;
          item = candidate;
        }
      }
    }
    if (measureMode) {
      const ll = item && Number.isFinite(item.lat) && Number.isFinite(item.lon)
        ? L.latLng(item.lat, item.lon)
        : s3dUnproject3DPoint(e.point.x, e.point.y);
      if (ll) addMeasurePoint(ll.lat, ll.lng);
      return;
    }
    if (!item?.popupData) return;
    if (item.popupData.address && !selectedTracks.has(item.popupData.address)) {
      toggleSelection(item.popupData.address, false);
    }
    s3dOpenPopupForKey(key, item.popupData);
  });
  map3d.on('render', () => {
    if (map3dPaused) return;
    s3dScheduleLabelUpdate();
    positionMeasure3D();
  });
  map3d.on('dragstart', () => { pauseFollowCentering(); });
  // User input must win over follow centering. Stop the 3D alignment loop in
  // the capture phase, before MapLibre starts its own drag/zoom handlers;
  // otherwise a queued panBy() can cancel the pointer and the map feels dead.
  const pause3DFollow = () => { pauseFollowCentering(); };
  const map3dContainer = map3d.getContainer();
  for (const type of ['pointerdown', 'touchstart', 'wheel']) {
    map3dContainer.addEventListener(type, pause3DFollow, { capture: true, passive: true });
  }
  return true;
}

function set3DMapPaused(paused) {
  if (!map3d || map3dPaused === paused) return;
  map3dPaused = paused;
  if (paused) {
    stop3DFollowAlign();
    if (s3dDeferredSyncTimer !== null) {
      clearTimeout(s3dDeferredSyncTimer);
      s3dDeferredSyncTimer = null;
    }
    // Stop eases and any queued repaint before hiding the canvas.
    try { map3d.stop(); } catch (err) {}
    return;
  }
  // The container was hidden while paused; measure it again and repaint once.
  resize3D();
  syncAll3DData();
  try { map3d.triggerRepaint?.(); } catch (err) {}
}

function sync3DMapVisibility() {
  if (!map3d) return;
  const el3d = $('map3d');
  const running = map3dActive && !!el3d && !el3d.hidden &&
    !document.documentElement.classList.contains('list-mode');
  set3DMapPaused(!running);
}

function resize3D() {
  if (!map3dReady) return;
  requestAnimationFrame(() => {
    map3d.resize();
    s3dScheduleLabelUpdate();
    positionMeasure3D();
  });
}

function sync3DFromLeaflet() {
  if (map3dPaused || !map3dReady || !map3dActive) return;
  const c = map.getCenter();
  const zoom = Math.max(2, Math.min(16, map.getZoom() + 1));
  arm3DCameraStop(c.lng, c.lat, zoom);
  map3d.jumpTo({ center: [c.lng, c.lat], zoom });
  s3dScheduleLabelUpdate();
}

function syncLeafletFrom3D() {
  if (map3dPaused || !map3dReady || !map3dActive) return;
  const c = map3d.getCenter();
  const zoom = Math.max(1, Math.min(16, Math.round(map3d.getZoom() - 1)));
  armLeafletCameraStop(c.lat, c.lng, zoom);
  map.setView([c.lat, c.lng], zoom, { animate: false });
}

function sync3DLive(aircraftList) {
  if (map3dPaused || !map3d || !map3dActive) return;
  const seen = new Set();
  for (const a of aircraftList || []) {
    if (!Number.isFinite(a.lat) || !Number.isFinite(a.lon)) continue;
    const key = `live:${a.address}`;
    seen.add(key);
    const iconHtml = markerIcon(a).options.html;
    s3dUpsertDomMarker(key, a.lat, a.lon, a.altitude, iconHtml, a, {
      focused: !replayActive && activeMapFocusAddress() === a.address,
      onClick: () => {
        if (!selectedTracks.has(a.address)) toggleSelection(a.address, false);
      }
    });
  }
  for (const [key, item] of [...map3dDomMarkers.entries()]) {
    if (key.startsWith('live:') && !seen.has(key)) {
      item.el.remove();
      map3dDomMarkers.delete(key);
    }
  }
  s3dScheduleLabelUpdate();
}

function sync3DTracks() {
  if (map3dPaused || !map3dReady) return;
  s3dSyncThreeLines();
  const features = [];
  if (!s3dArrowLayer) {
    // Fallback for browsers without three.js.
    for (const entry of selectedTracks.values()) {
      features.push(...s3dTrackLineFeatures(entry.points, entry.color));
    }
  }
  s3dSetData(S3D_TRACKS, s3dFeatureCollection(features));
  s3dSetData(S3D_CURTAINS, S3D_EMPTY_FC);
}

function sync3DAirspace() {
  if (!map3dReady) return;
  const gj = airspaceLayer.toGeoJSON();
  s3dSetData(S3D_AIRSPACE, gj && Array.isArray(gj.features) ? gj : S3D_EMPTY_FC);
}

function sync3DThermals(points) {
  if (!map3dReady) return;
  if (!map.hasLayer(thermalLayer) || !Array.isArray(points) || !points.length) {
    s3dSetData(S3D_THERMALS, S3D_EMPTY_FC);
    return;
  }
  const features = points
    .filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .map(p => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p[1], p[0]] },
      properties: { intensity: Number.isFinite(p[2]) ? p[2] : 0.5 }
    }));
  s3dSetData(S3D_THERMALS, s3dFeatureCollection(features));
}

function sync3DReplayPoints() {
  if (map3dPaused || !map3d || !map3dActive || !replayActive) return;
  const seen = new Set();
  for (const p of replayPoints || []) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    if (replayFollowAddress && p.id === replayFollowAddress) continue;
    const key = `rpts:${p.id}`;
    seen.add(key);
    const name = esc(p.label);
    const iconHtml = `<div class="glider-wrap" style="--marker-color:${THEME.yellow}"><div class="replay-dot"></div><div class="glider-label" title="${name}">${name}</div></div>`;
    const popupObj = {
      lat: p.lat,
      lon: p.lon,
      id: p.id,
      liveLabel: p.label,
      address: String(p.id).toLowerCase(),
      altitude: p.alt ?? null,
      speed: null,
      course: null,
      climb: null,
      snr: null,
      weather: null,
      type: 0,
      receiver: '',
      aprsPacket: '',
      aprsReceivedAt: p.ts || '',
      receivedAtMs: (Number(p.ts) || 0) * 1000
    };
    s3dUpsertDomMarker(key, p.lat, p.lon, p.alt, iconHtml, popupObj, {
      onClick: () => {
        if (!selectedTracks.has(popupObj.address)) toggleSelection(popupObj.address, false);
      }
    });
  }
  for (const [key, item] of [...map3dDomMarkers.entries()]) {
    if (key.startsWith('rpts:') && !seen.has(key)) {
      item.el.remove();
      map3dDomMarkers.delete(key);
    }
  }
  s3dScheduleLabelUpdate();
}

function sync3DReplayFocus(pos) {
  if (map3dPaused || !map3d || !map3dActive) return;
  const key = 'rfocus:active';
  if (!pos || !replayActive || !replayFollowAddress) {
    const existing = map3dDomMarkers.get(key);
    if (existing) { existing.el.remove(); map3dDomMarkers.delete(key); }
    return;
  }
  const label = esc(replayFocusLabel());
  const metricsText = replayFocusHudText(pos);
  const iconHtml = `<div class="glider-wrap focused" style="--marker-color:#ec4899"><div class="replay-dot focused"></div><div class="glider-label" title="${label}">${label}</div>${focusHudHtml(metricsText)}</div>`;
  const baseAc = findAircraftByAddress(replayFollowAddress);
  const popupObj = {
    ...(baseAc || {}),
    lat: pos.lat,
    lon: pos.lon,
    id: replayFollowAddress,
    liveLabel: baseAc?.liveLabel || replayFocusLabel(),
    address: replayFollowAddress.toLowerCase(),
    altitude: pos.alt ?? baseAc?.altitude ?? null,
    speed: pos.speed != null ? pos.speed * 3.6 : (baseAc?.speed ?? null),
    climb: pos.climb != null ? Number(pos.climb.toFixed(1)) : (baseAc?.climb ?? null),
    receivedAtMs: (Number(pos.ts) || Math.floor(replayTsMs / 1000)) * 1000
  };
  s3dUpsertDomMarker(key, pos.lat, pos.lon, pos.alt, iconHtml, popupObj, {
    focused: true,
    onClick: () => {
      if (!selectedTracks.has(popupObj.address)) toggleSelection(popupObj.address, false);
    }
  });
  s3dScheduleLabelUpdate();
}

function sync3DReplayTrack() {
  if (map3dPaused || !map3dReady) return;
  s3dSyncThreeLines();
  const features = [];
  const color = selectedTracks.get(replayFollowAddress)?.color || THEME.accent;
  if (!s3dArrowLayer) {
    for (const seg of replayRenderSegments || []) {
      features.push(...s3dTrackLineFeatures(seg.points, color));
    }
  }
  s3dSetData(S3D_REPLAY_TRACK, s3dFeatureCollection(features));
  s3dSetData(S3D_CURTAINS, S3D_EMPTY_FC);
}

function sync3DReplayProgress(perSegment) {
  if (map3dPaused || !map3dReady) return;
  s3dSyncThreeProgress(perSegment);
  const features = [];
  if (!s3dArrowLayer) {
    const color = selectedTracks.get(replayFollowAddress)?.color || THEME.accent;
    for (const pts of perSegment || []) {
      features.push(...s3dTrackLineFeatures(pts, color));
    }
  }
  s3dSetData(S3D_REPLAY_PROGRESS, s3dFeatureCollection(features));
}

function sync3DReplayMode(on) {
  if (on) {
    s3dClearDomMarkers('live:');
    if (map3dReady) {
      s3dSetData(S3D_TRACKS, S3D_EMPTY_FC);
    }
  } else {
    s3dClearDomMarkers('rpts:');
    s3dClearDomMarkers('rfocus:');
    if (map3dReady) {
      for (const id of [S3D_REPLAY_TRACK, S3D_REPLAY_PROGRESS, S3D_CURTAINS]) {
        s3dSetData(id, S3D_EMPTY_FC);
      }
      sync3DLive(filtered());
      sync3DTracks();
    }
  }
}

function syncAll3DData() {
  if (map3dPaused || !map3d || !map3dActive) return;
  if (map3dReady) {
    sync3DAirspace();
    if (map.hasLayer(thermalLayer)) sync3DThermals(thermalLayer._latlngs || []);
  }
  if (replayActive) {
    s3dClearDomMarkers('live:');
    if (map3dReady) {
      sync3DTracks();
      sync3DReplayTrack();
      updateReplayProgressLine(performance.now(), true);
    }
    sync3DReplayPoints();
    updateReplayFocusMarker();
  } else {
    s3dClearDomMarkers('rpts:');
    s3dClearDomMarkers('rfocus:');
    if (map3dReady) {
      for (const id of [S3D_REPLAY_TRACK, S3D_REPLAY_PROGRESS, S3D_CURTAINS]) {
        s3dSetData(id, S3D_EMPTY_FC);
      }
      sync3DTracks();
    }
    sync3DLive(filtered());
  }
}

function set3DBaseStyle(key) {
  if (!MAP3D_BASE_STYLES[key] || map3dBaseKey === key) return;
  const seq = ++s3dStyleSwapSeq;
  const prevKey = map3dBaseKey;
  const prevStyle = MAP3D_BASE_STYLES[prevKey] || MAP3D_BASE_STYLES.liberty;
  map3dBaseKey = key;
  savedBaseLayer = VIEW3D_TO_BASE[key] || savedBaseLayer;
  updateMapAttribution();
  if (!map3d) return;
  map3dReady = false;
  // Clear terrain before swapping styles; MapLibre cannot recompile the DEM
  // shader while its source is being removed by setStyle().
  try { map3d.setTerrain(null); } catch (err) {}
  let recovering = false;
  const sourceFor = k => (k === 'topo' ? 'opentopo' : k === 'satellite' ? 'esri' : 'openmaptiles');

  const waitForStyle = (targetKey, allowRecovery) => {
    const expectedSource = sourceFor(targetKey);
    let attempts = 0;
    const finish = () => {
      if (seq !== s3dStyleSwapSeq || !map3d) return;
      let style = null;
      try { style = map3d.getStyle(); } catch (err) {
        if (allowRecovery && !recovering) recover('getStyle failed', err);
        return;
      }
      let loaded = false;
      try { loaded = !!map3d.isStyleLoaded?.(); } catch (err) {}
      if (!loaded || !style?.sources?.[expectedSource]) {
        // A stalled style must not leave map3dReady false forever.
        if (++attempts >= 60) {
          if (allowRecovery && !recovering) recover('style did not finish loading');
          else showToast('Could not switch 3D map style. Reload the page to restore 3D.');
          return;
        }
        setTimeout(finish, 100);
        return;
      }
      try {
        setup3DLayers();
      } catch (err) {
        if (allowRecovery && !recovering) recover('layer setup failed', err);
        else showToast('Could not set up 3D map layers. Reload the page to restore 3D.');
        return;
      }
      map3dReady = true;
      syncAll3DData();
    };
    setTimeout(finish, 100);
  };

  const recover = (reason, err) => {
    if (seq !== s3dStyleSwapSeq || !map3d || recovering) return;
    recovering = true;
    console.warn('3D base style swap failed:', reason, err || '');
    map3dBaseKey = prevKey;
    let retries = 0;
    const applyRecovery = () => {
      if (seq !== s3dStyleSwapSeq || !map3d) return;
      try { map3d.setTerrain(null); } catch (e) {}
      try {
        // Force a clean rebuild of the previous style, including custom layers.
        map3d.setStyle(prevStyle, { diff: false });
      } catch (restoreErr) {
        if (++retries < 5) {
          setTimeout(applyRecovery, 200);
          return;
        }
        console.warn('3D style recovery failed:', restoreErr);
        showToast('Could not restore the 3D map style. Reload the page to recover.');
        // Last chance: if the previous style is actually loaded, keep 3D usable.
        try {
          const style = map3d.getStyle();
          if (map3d.isStyleLoaded?.() && style?.sources?.[sourceFor(prevKey)]) {
            setup3DLayers();
            map3dReady = true;
            syncAll3DData();
          }
        } catch (e) {}
        return;
      }
      waitForStyle(prevKey, false);
    };
    applyRecovery();
  };

  // Force a clean rebuild instead of a diff: the old style still contains the
  // custom DEM/GeoJSON sources that would otherwise collide with setup3DLayers().
  try {
    map3d.setStyle(MAP3D_BASE_STYLES[key], { diff: false });
  } catch (err) {
    recover('setStyle threw', err);
    return;
  }
  waitForStyle(key, true);
}

const ViewModeControl = L.Control.extend({
  options: { position: 'topright' },
  onAdd: function () {
    const container = L.DomUtil.create('div', 'leaflet-control-view3d');
    const button = L.DomUtil.create('button', 'leaflet-control-view3d-btn', container);
    button.type = 'button';
    button.textContent = map3dActive ? '3D' : '2D';
    button.title = map3dActive ? '3D terrain view active' : '2D map active';
    button.setAttribute('aria-label', button.title);
    button.setAttribute('aria-pressed', 'false');
    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.disableScrollPropagation(container);
    L.DomEvent.on(button, 'click', event => {
      L.DomEvent.preventDefault(event);
      toggle3DView();
    });
    this._button = button;
    return container;
  }
});
const view3DModeControl = new ViewModeControl().addTo(map);

// The native MapLibre compass is appended here when the 3D map is created, so
// it stacks immediately below the 2D/3D toggle and is hidden in 2D mode.
const Compass3DControl = L.Control.extend({
  options: { position: 'topright' },
  onAdd: function () {
    const container = L.DomUtil.create('div', 'leaflet-control-compass3d');
    container.hidden = !map3dActive;
    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.disableScrollPropagation(container);
    return container;
  }
});
const compass3DControl = new Compass3DControl().addTo(map);

function syncViewModeControl() {
  const button = view3DModeControl?._button;
  if (!button) return;
  button.textContent = map3dActive ? '3D' : '2D';
  const title = map3dActive ? '3D terrain view active' : '2D map active';
  button.title = title;
  button.setAttribute('aria-label', title);
  button.setAttribute('aria-pressed', String(map3dActive));
  button.classList.toggle('active', map3dActive);
  const compass = compass3DControl.getContainer();
  if (compass) compass.hidden = !map3dActive;
}

function toggle3DView() {
  const turningOn = !map3dActive;
  const el3d = $('map3d');
  // MapLibre measures its container on init, so reveal it before creating the map.
  if (turningOn && !map3d) el3d.hidden = false;
  if (!ensure3DMap()) {
    if (turningOn && !map3d) el3d.hidden = true;
    return;
  }
  map3dActive = turningOn;
  savedView3d = map3dActive;
  saveMenuPrefs();
  el3d.hidden = !map3dActive;
  $('mapWrap').classList.toggle('view3d', map3dActive);
  sync3DMapVisibility();
  syncViewModeControl();
  syncMeasureCursor();
  renderMeasure();
  if (map3dActive) {
    // Leaflet's popup pane is reparented above the map, so hiding the map pane
    // alone would leave 2D popups floating over the 3D canvas.
    for (const popup of [...openPopups]) {
      try { map.closePopup(popup); } catch (err) {}
    }
    openPopups.clear();
    popupMoveSnapshot = null;
    set3DBaseStyle(BASE_TO_3D[currentLayerSelection().baseLayer] || 'liberty');
    resize3D();
    sync3DFromLeaflet();
    syncAll3DData();
  } else {
    for (const st of map3dDomPopupState.values()) {
      if (st.popup && st.popup.isOpen()) st.popup.remove();
    }
    requestAnimationFrame(() => map.invalidateSize({ pan: false, animate: false }));
  }
}

window.addEventListener('resize', resize3D);

let lastBottomBarSpace = -1;
let lastPopupMaxH = null;
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
  const popupMaxH = hasBar ? `${Math.max(0, Math.floor(mapRect.height - 44))}px` : null;
  if (popupMaxH !== lastPopupMaxH) {
    if (popupMaxH) wrap.style.setProperty('--popup-max-h', popupMaxH);
    else wrap.style.removeProperty('--popup-max-h');
    lastPopupMaxH = popupMaxH;
  }

  requestAnimationFrame(() => {
    // Replaying calls this every frame. Resizing MapLibre when the map size did
    // not actually change fires movestart continuously and blocks drag-pan.
    if (spaceChanged) {
      map.invalidateSize({ pan: false, animate: false });
      resize3D();
    }
    keepPopupAboveBottomBar();
    s3dRepositionOpenPopups();
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
  renderMeasure();
  renderSounding();
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

// MarkerCluster removes child markers on zoom/move, and Leaflet closes their popups on
// layer removal. Remember open popups across the move and reopen any that were only
// closed by that internal removal. A real close-button click removes it from the set.
const openPopups = new Set();
let mapMoving = false;
let popupMoveSnapshot = null;

// Eagerly forget popups whose source layer is gone. Checking only at moveend
// would let a detached marker be reopened after render() replaced it.
function forgetPopupForMarker(marker) {
  for (const popup of openPopups) if (popup._source === marker) openPopups.delete(popup);
  if (popupMoveSnapshot) {
    for (const popup of popupMoveSnapshot) if (popup._source === marker) popupMoveSnapshot.delete(popup);
  }
}

// A snapshot popup is only restored if its marker still exists and is visible
// (markercluster may have collapsed it into a parent cluster during the move).
function popupSourceStillAlive(popup) {
  const src = popup._source;
  if (!src) return true; // map-level popup, e.g. the shared-link message
  if (src._trackerMarker || src._isEmergency) {
    let found = false;
    for (const m of markers.values()) if (m === src) { found = true; break; }
    if (!found) return false;
    if (clusterGroup.hasLayer(src)) {
      try { return clusterGroup.getVisibleParent(src) === src; } catch (e) { return false; }
    }
    return true;
  }
  if (src._searchResult) {
    for (const m of searchResultMarkers.values()) if (m === src) return true;
    return false;
  }
  return true;
}

map.getContainer().addEventListener('click', event => {
  if (!event.target.closest?.('.leaflet-popup-close-button')) return;
  const popupEl = event.target.closest('.leaflet-popup');
  for (const popup of openPopups) {
    if (popup.getElement() === popupEl) openPopups.delete(popup);
  }
}, true);
map.on('movestart', () => {
  mapMoving = true;
  popupMoveSnapshot = new Set(openPopups);
});
map.on('zoomstart', () => {
  if (popupMoveSnapshot) return;
  mapMoving = true;
  popupMoveSnapshot = new Set(openPopups);
});
map.on('moveend', () => {
  mapMoving = false;
  if (popupMoveSnapshot) {
    for (const popup of popupMoveSnapshot) {
      if (!popup._map && popupSourceStillAlive(popup)) map.openPopup(popup);
    }
    popupMoveSnapshot = null;
  }
});

// Tracker markers center themselves via centerPopupInView(); keep all other popups clear of the bottom bar.
map.on('popupopen', e => {
  // Leaflet's autoClose removes the visible popup, but a popup that closes
  // during a map move is otherwise remembered and could be restored later.
  // Forget every other popup here so only the newest one survives.
  for (const other of [...openPopups]) {
    if (other === e.popup) continue;
    openPopups.delete(other);
    if (popupMoveSnapshot) popupMoveSnapshot.delete(other);
    if (other._map) map.closePopup(other);
  }
  openPopups.add(e.popup);
  bringToFront(map.getPane('popupPane'));
  if (e.popup?._source?._data) maybePrefetchSoundingForPopup(e.popup._source._data);
  if (e.popup?._source?._trackerMarker) return;
  requestAnimationFrame(() => keepPopupAboveBottomBar(e.popup.getElement()));
});
map.on('popupclose', e => {
  if (!mapMoving) openPopups.delete(e.popup);
});

const thermalLayer = L.heatLayer([], { radius: 18, blur: 14, maxZoom: 14, gradient: {0.2:'#38bdf8', 0.5:THEME.yellow, 0.8:'#f97316', 1.0:'#ef4444'} });
const coverageLayer = L.layerGroup();
const airspaceLayer = L.geoJSON(null, {
  style: { color: THEME.yellow, weight: 2, fillOpacity: 0.12 },
  onEachFeature: (f, l) => {
    if (f.properties && (f.properties.name || f.properties.title)) {
      l.bindPopup(`<b>${esc(f.properties.name || f.properties.title)}</b>`, { ...POPUP_OPTIONS });
    }
  }
});
// Restore a previously uploaded airspace/hazard file without asking the user again.
// Adding the layer programmatically does not fire Leaflet's overlayadd event, so
// also record it in the saved selection or applySavedLayers() would hide it again.
let restoredAirspace = false;
try {
  const savedAirspace = localStorage.getItem(AIRSPACE_STORAGE_KEY);
  if (savedAirspace) {
    airspaceLayer.addData(JSON.parse(savedAirspace));
    restoredAirspace = airspaceLayer.getLayers().length > 0;
  }
} catch (err) {
  localStorage.removeItem(AIRSPACE_STORAGE_KEY);
}
if (restoredAirspace) {
  if (!savedOverlays.includes('airspace')) savedOverlays.push('airspace');
  if (!map.hasLayer(airspaceLayer)) airspaceLayer.addTo(map);
}
syncClearAirspaceButton();

// A single choice replaces the old duplicated 2D/3D base-layer buttons.
const baseMaps = {
  "Standard": osmLayer,
  "Terrain": terrainLayer,
  "Satellite": satelliteLayer
};
const overlayMaps = { "Thermals(6h)": thermalLayer, "RF Coverage (SNR)": coverageLayer, "Airspace / Hazards": airspaceLayer };
const layersControl = L.control.layers(baseMaps, overlayMaps, { position: 'bottomright' }).addTo(map);
const layersToggle = layersControl.getContainer()?.querySelector('.leaflet-control-layers-toggle');
if (layersToggle) {
  layersToggle.innerHTML =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">' +
    '<path d="M12 3 2 8l10 5 10-5-10-5Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>' +
    '<path d="m2 13 10 5 10-5M2 17l10 5 10-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>' +
    '</svg>';
}

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

map.on('baselayerchange overlayadd overlayremove', e => {
  if (applyingSavedLayers) return;
  saveMenuPrefs();
  updateMapAttribution();
  const key = Object.keys(BASE_LAYER_KEYS).find(k => BASE_LAYER_KEYS[k] === e?.layer);
  if (key && map3dActive) set3DBaseStyle(BASE_TO_3D[key] || 'liberty');
});

const clusterGroup = L.markerClusterGroup({
  maxClusterRadius: 35, spiderfyOnMaxZoom: true, showCoverageOnHover: false, zoomToBoundsOnClick: true, spiderfyDistanceMultiplier: 1.5,
  iconCreateFunction: cluster => L.divIcon({ html: `<div>${cluster.getChildCount()}</div>`, className: 'ogn-cluster', iconSize: L.point(34, 34) })
}).addTo(map);
const emergencyGroup = L.layerGroup().addTo(map);
const searchResultGroup = L.layerGroup().addTo(map);
const searchResultMarkers = new Map();
const oneTimeSearchBypass = new Set();
const replayGroup = L.layerGroup();
const replayFocusGroup = L.layerGroup();
const replayTrackGroup = L.layerGroup();
const replayTrackBaseGroup = L.layerGroup();
const replayProgressGroup = L.layerGroup();
const measureLayer = L.layerGroup().addTo(map);
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
const knownIds = new Map(); // address -> last seen ms

let followedAddress = null;
// Aircraft selected by a list click. It gets the same focused marker/HUD as a
// followed aircraft, but it is a one-shot selection rather than a live follow.
let mapFocusAddress = null;
let varioTrackMode = savedVarioTrackMode;
let activeTrackAddress = null;
const lastPinnedStatus = new Map();
const alerts24hHistory = new Map();
let replayActive = false;
let replayRafId = null;
let replayFollowAddress = null;
let replayPoints = [];
let replayFocusMarker = null;
let replayTrackPoints = [];     // Every recorded fix, used for interpolation
let replayTrackSegments = [];   // Distinct flights: [{startTs, endTs, points}]
let replayRenderSegments = [];  // Thinned copy used only for drawing polylines
let replayTrackPromise = null;
const REPLAY_TRACK_GAP_S = 600; // No fixes for 10 minutes starts a new track
const REPLAY_MAX_INTERP_SPEED_MS = 100; // Ignore corrupt hops faster than 360 km/h
const REPLAY_MOVE_SPEED_MS = 3; // ~11 km/h: below this a parked aircraft is stationary
const REPLAY_MOVE_DISTANCE_M = 100; // Ignore position jitter while parked
const REPLAY_MOVE_MIN_LEGS = 3; // A single GPS jitter spike is not a launch
const compactReplayUi = () => window.matchMedia('(max-width:800px)').matches;
let replayOnlyFocus = false;
let replayDirection = 1;
let replaySpeedValue = 1;
const REPLAY_SPEED_STEPS = [1, 10, 20, 30, 50];
const REPLAY_RANGE_LABELS = ['15m', '1h', '6h', '12h', '24h'];
const REPLAY_RANGE_TITLES = ['15 minutes from slider', '1 hour from slider', '6 hours from slider', '12 hours from slider', '24 hours from slider'];
const REPLAY_RANGE_MINUTES = [15, 60, 360, 720, 1440];
function replayRangeIndexForActiveWindow(value) {
  const minutes = Number(value) / 60;
  const idx = REPLAY_RANGE_MINUTES.indexOf(minutes);
  return idx >= 0 ? idx : REPLAY_RANGE_MINUTES.length - 1;
}
let replayRangeIndex = replayRangeIndexForActiveWindow(savedMarkerWindow);
let replayWindowStartMs = null;
let replayTsMs = 0;
let replayLastTickMs = 0;
let replayLastPanAtMs = 0;
let replayTimeReadoutSig = '';
let replayTrackLineSig = '';
let replayProgressCutoff = -1;
let replayProgressKey = '';
let replayTrackLineAtMs = 0;
let replaySliceSeq = 0;
let replayTrackSeq = 0;
let replayScrubbing = false;
let lastReplaySliceMinute = null;
let lastReplayScrubValue = null;

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
            firstTsMs: Number.isFinite(Number(item.firstTsMs)) && Number(item.firstTsMs) > 0
              ? Number(item.firstTsMs) : Number(item.tsMs),
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
  if (pinnedAircraft.has(address)) {
    pinnedAircraft.delete(address);
    lastPinnedStatus.delete(address);
  } else pinnedAircraft.add(address);
  savePinnedAircraft();
  render();
  requestAnimationFrame(() => focusListRow(address));
}

const selectedTracks = new Map();
syncClearTracksButton();
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
  renderFeedStatusBanner();
}

// The sidebar status line stays compact; this banner explains degraded states
// and offers a direct retry. Per-second age text is outside the aria-live
// status line so screen readers are not interrupted on every tick.
function renderFeedStatusBanner() {
  const banner = $('feedStatusBanner');
  if (!banner) return;
  if (replayActive) { banner.hidden = true; return; }

  const now = Date.now();
  const fetchAgeSec = lastFetchOkAtMs
    ? Math.max(0, Math.floor((now - lastFetchOkAtMs) / 1000)) : null;
  const dataAgeSec = feedDataUpdatedMs
    ? Math.max(0, Math.floor((serverNow() - feedDataUpdatedMs) / 1000)) : null;

  let kind = 'warning', title = '', detail = '', age = '';
  if (!lastFetchOkAtMs && liveFailures > 0) {
    kind = 'error';
    title = 'Feed unavailable';
    detail = 'ogn-proxy.php has not returned data yet. Check the proxy service, then retry.';
  } else if (liveFailures > 0 && fetchAgeSec !== null && fetchAgeSec > 30) {
    title = 'Live updates delayed';
    detail = 'The browser cannot reach the proxy reliably; showing the last data received.';
    age = `last fetch ${fmtAge(fetchAgeSec)}`;
  } else if (dataAgeSec === null) {
    title = 'Feed status unknown';
    detail = 'Waiting for the first successful proxy response.';
  } else if (dataAgeSec > 120) {
    kind = 'error';
    title = 'Collector looks paused';
    detail = 'No new positions have been stored for over two minutes. Existing aircraft may be stale.';
    age = `newest packet ${fmtAge(dataAgeSec)}`;
  } else if (dataAgeSec > 60) {
    title = 'Feed running slow';
    detail = 'The newest stored position is older than usual; delayed packets will appear automatically.';
    age = `newest packet ${fmtAge(dataAgeSec)}`;
  } else {
    banner.hidden = true;
    return;
  }

  banner.hidden = false;
  banner.className = `feed-status-banner ${kind}`;
  const icon = $('feedStatusIcon'), titleEl = $('feedStatusTitle');
  const detailEl = $('feedStatusDetail'), ageEl = $('feedStatusAge');
  if (icon) icon.textContent = kind === 'error' ? '⚠' : '⏱';
  if (titleEl) titleEl.textContent = title;
  if (detailEl) detailEl.textContent = detail;
  if (ageEl) ageEl.textContent = age;
}

function showToast(msg, durationMs = 1800) {
  let t = document.getElementById('appToast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'appToast';
    t.className = 'app-toast';
    t.setAttribute('role', 'status');
    t.setAttribute('aria-live', 'polite');
  }
  const mapWrap = $('mapWrap');
  const host = document.fullscreenElement === mapWrap || mapWrap?.classList.contains('map-fullscreen')
    ? mapWrap
    : document.body;
  if (t.parentElement !== host) host.appendChild(t);
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

  hashMessagePopup = L.popup({ ...POPUP_OPTIONS, maxWidth: 320, autoPan: false, keepInView: false })
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

function buildSarText(a) {
  const ageSec = Math.max(0, Math.floor((serverNow() - a.receivedAtMs) / 1000));
  const shareUrl = `${location.href.replace(/#.*/, '')}#${a.lat.toFixed(4)},${a.lon.toFixed(4)},${Math.max(map.getZoom(), 12)},${encodeURIComponent(a.address)}`;
  return [
    `SAR Info: ${displayName(a)}`,
    `Status: ${getDisplayStatus(a) || 'Unknown'}`,
    `Coords: ${a.lat.toFixed(6)}, ${a.lon.toFixed(6)}`,
    `Alt: ${a.altitude != null ? fmtAlt(a.altitude) : 'N/A'}`,
    `Last heard: ${fmtAge(ageSec)}`,
    `Map: https://www.google.com/maps?q=${a.lat.toFixed(6)},${a.lon.toFixed(6)}`,
    `Tracker: ${shareUrl}`
  ].join('\n');
}

function pickTrackColor() {
  const used = new Set();
  for (const entry of selectedTracks.values()) used.add(entry.color);
  for (const c of TRACK_COLORS) if (!used.has(c)) return c;
  return TRACK_COLORS[colorSeq++ % TRACK_COLORS.length];
}

function varioColor(climb) {
  if (climb == null) return THEME.accent;
  if (climb >= 2.5) return '#ef4444';
  if (climb >= 1.0) return '#f97316';
  if (climb >= 0.2) return '#eab308';
  if (climb >= -0.5) return '#22c55e';
  if (climb >= -2.0) return '#38bdf8';
  return '#3b82f6';
}

// Keep every track line in its own pane below Leaflet's markerPane (600).
// This is independent of add order, so redraws or replay layers can never
// paint over aircraft, clusters, emergency icons or replay focus markers.
function trackPaneName() {
  const name = 'ognTrackPane';
  if (!map.getPane(name)) {
    const pane = map.createPane(name);
    pane.style.zIndex = '350';
    pane.style.pointerEvents = 'none';
  }
  return name;
}

function buildTrackLayer(points, flatColor) {
  if (!points || points.length < 2) return null;
  const pane = trackPaneName();
  if (!varioTrackMode) {
    return L.polyline(points.map(p => [p[0], p[1]]), { pane, color: flatColor, weight: 3, opacity: 0.9 });
  }
  const grp = L.layerGroup();
  for (let i = 1; i < points.length; i++) {
    const p0 = points[i - 1], p1 = points[i];
    const dt = p1[3] - p0[3];
    const climb = (p0[2] != null && p1[2] != null && dt > 0 && dt < 300) ? (p1[2] - p0[2]) / dt : null;
    L.polyline([[p0[0], p0[1]], [p1[0], p1[1]]], { pane, color: varioColor(climb), weight: 3.5, opacity: 0.92 }).addTo(grp);
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
  sync3DTracks();
  syncVarioLegend();
}

function isTrackVisible() {
  if (replayActive && (replayTrackBaseGroup.getLayers().length || replayProgressGroup.getLayers().length)) return true;
  for (const entry of selectedTracks.values()) {
    if (entry.layer) return true;
  }
  return false;
}

function syncVarioLegend() {
  const legend = $('varioLegend');
  if (!legend) return;
  const show = varioTrackMode && isTrackVisible();
  legend.hidden = !show;
  if (!show) return;
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
  stop3DFollowAlign();
  followedAddress = (followedAddress === address) ? null : address;
  // Follow and list-click selection share one focused marker/HUD.
  mapFocusAddress = followedAddress;
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
  if (followedAddress) {
    ensureFollowTrackSelected(followedAddress);
    focusFollowedOnMap(followedAddress);
  } else {
    // Re-sort immediately when follow is removed from the active aircraft.
    render();
  }
}

// --- Shared follow-centering control (live and replay) ---
// Leaflet zoom (MapLibre is +1). Starting follow zooms in once, but automatic
// centering has no zoom floor; it uses the screen-space edge rule below.
const FOLLOW_START_ZOOM = 13;
const FOLLOW_EDGE_MARGIN = 0.2;
let followCenteringPaused = false;

function activeFollowAddress() {
  return replayActive ? replayFollowAddress : followedAddress;
}

// The aircraft that should carry the pink halo + metric HUD. A list-click
// selection takes precedence over a stale follow address; replay has its own
// focused marker, so live focus never leaks into replay.
function activeMapFocusAddress() {
  if (replayActive) return replayFollowAddress;
  return mapFocusAddress || followedAddress;
}

let recenterBtnSig = '';

function focusLatLng() {
  if (replayActive) {
    if (replayFocusMarker?.getLatLng) {
      const ll = replayFocusMarker.getLatLng();
      if (ll && Number.isFinite(ll.lat) && Number.isFinite(ll.lng)) return ll;
    }
    const p = replayPoints.find(x => x.id === replayFollowAddress);
    if (p && Number.isFinite(p.lat) && Number.isFinite(p.lon)) return L.latLng(p.lat, p.lon);
    return null;
  }
  const a = aircraft.find(x => x.address === followedAddress);
  if (a && Number.isFinite(a.lat) && Number.isFinite(a.lon)) return L.latLng(a.lat, a.lon);
  return null;
}

function focusAltitude() {
  if (replayActive) {
    const p = replayPoints.find(x => x.id === replayFollowAddress);
    return Number.isFinite(p?.alt) ? p.alt : null;
  }
  const a = aircraft.find(x => x.address === followedAddress);
  return Number.isFinite(a?.altitude) ? a.altitude : null;
}

/**
 * True when a point sits in the outer FOLLOW_EDGE_MARGIN band of the viewport.
 * The check is screen-space so it behaves identically at every zoom level; in
 * 3D it follows the aircraft's rendered position on the terrain rather than
 * its ground shadow.
 */
function pointOutsideFollowBand(lat, lon, alt = null) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (map3dReady && map3dActive) {
    const canvas = map3d.getCanvas?.();
    const width = map3d.transform?.width || canvas?.clientWidth || 0;
    const height = map3d.transform?.height || canvas?.clientHeight || 0;
    if (width && height) {
      // Projected coordinates keep working after the marker element is hidden
      // off-screen, so Recenter and auto-recenter still see the edge crossing.
      const pt = s3dProject3DPoint(lon, lat, alt);
      if (pt && Number.isFinite(pt.x) && Number.isFinite(pt.y)) {
        return pt.x < width * FOLLOW_EDGE_MARGIN ||
          pt.x > width * (1 - FOLLOW_EDGE_MARGIN) ||
          pt.y < height * FOLLOW_EDGE_MARGIN ||
          pt.y > height * (1 - FOLLOW_EDGE_MARGIN);
      }
    }
  }
  const size = map.getSize?.();
  if (!size || !size.x || !size.y) return false;
  const p = map.latLngToContainerPoint(L.latLng(lat, lon));
  return p.x < size.x * FOLLOW_EDGE_MARGIN ||
    p.x > size.x * (1 - FOLLOW_EDGE_MARGIN) ||
    p.y < size.y * FOLLOW_EDGE_MARGIN ||
    p.y > size.y * (1 - FOLLOW_EDGE_MARGIN);
}

function focusNearMapEdge() {
  if (!activeFollowAddress()) return false;
  const ll = focusLatLng();
  return ll ? pointOutsideFollowBand(ll.lat, ll.lng, focusAltitude()) : false;
}

// Offer Recenter only while following is manually paused and the aircraft has
// reached the outer 20% band. Inside that band the view is left alone.
function syncRecenterButton() {
  const btn = $('recenterBtn');
  if (!btn) return;
  const addr = activeFollowAddress();
  const needsRecenter = !!addr && followCenteringPaused && focusNearMapEdge();
  const sig = `${needsRecenter}:${addr || ''}`;
  if (sig === recenterBtnSig) return;
  recenterBtnSig = sig;
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
  stop3DFollowAlign();
  syncRecenterButton();
}

// Terrain elevation under the MapLibre camera changes as the followed marker
// moves across DEM tiles. That shifts the pitched projection after the initial
// jump, so nudge the 3D camera until the rendered marker actually lands at the
// viewport centre. The loop follows the current marker position each tick and
// stops as soon as a user pan pauses following.
let follow3DAlignTimer = null;
let follow3DAlignAddress = null;
let follow3DAlignSteps = 0;

function stop3DFollowAlign() {
  if (follow3DAlignTimer !== null) clearTimeout(follow3DAlignTimer);
  follow3DAlignTimer = null;
  follow3DAlignAddress = null;
  follow3DAlignSteps = 0;
}

function align3DFollowedMarker(address) {
  follow3DAlignTimer = null;
  if (map3dPaused || !map3dReady || !map3dActive || activeFollowAddress() !== address || followCenteringPaused) {
    if (follow3DAlignAddress === address) stop3DFollowAlign();
    return;
  }
  const key = replayActive ? 'rfocus:active' : `live:${address}`;
  const item = map3dDomMarkers.get(key);
  if (!item || !Number.isFinite(item.lon) || !Number.isFinite(item.lat)) {
    stop3DFollowAlign();
    return;
  }
  const pt = s3dProject3DPoint(item.lon, item.lat, item.alt);
  const canvas = map3d.getCanvas?.();
  const width = map3d.transform?.width || canvas?.clientWidth || 0;
  const height = map3d.transform?.height || canvas?.clientHeight || 0;
  if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y) || !width || !height) {
    stop3DFollowAlign();
    return;
  }
  const dx = pt.x - width / 2;
  const dy = pt.y - height / 2;
  // Damped corrections with a small dead zone: a full pan on every tick can
  // oscillate by a few pixels as MapLibre recalculates terrain elevation, which
  // is visible as camera shake during replay.
  if (Math.abs(dx) <= 4 && Math.abs(dy) <= 4) {
    stop3DFollowAlign();
    syncLeafletFrom3D();
    return;
  }
  // Register the camera state this pan will reach so its moveend is ignored
  // without suppressing a real drag that ends during the same animation.
  let nextLng = null, nextLat = null;
  try {
    const c0 = map3d.getCenter();
    const p0 = map3d.project?.([c0.lng, c0.lat]);
    const ll = p0 && map3d.unproject?.([p0.x + dx * 0.65, p0.y + dy * 0.65]);
    if (ll && Number.isFinite(ll.lng) && Number.isFinite(ll.lat)) {
      nextLng = s3dWrapLon(ll.lng);
      nextLat = ll.lat;
    }
  } catch (err) {}
  arm3DCameraStop(nextLng, nextLat, map3d.getZoom(), nextLng === null);
  map3d.panBy([dx * 0.65, dy * 0.65], { duration: 0 });
  if (++follow3DAlignSteps >= 16) {
    stop3DFollowAlign();
    syncLeafletFrom3D();
    return;
  }
  follow3DAlignTimer = setTimeout(() => align3DFollowedMarker(address), 100);
}

function start3DFollowAlign(address, delay = 0) {
  if (map3dPaused || !map3dReady || !map3dActive || !address) return;
  if (follow3DAlignAddress === address && follow3DAlignTimer !== null) return;
  stop3DFollowAlign();
  follow3DAlignAddress = address;
  follow3DAlignTimer = setTimeout(() => align3DFollowedMarker(address), delay);
}

function unclusterFollowedMarker(address) {
  const m = markers.get(address);
  if (!m || !clusterGroup.hasLayer(m)) return;
  const parent = clusterGroup.getVisibleParent(m);
  if (parent && parent !== m && typeof parent.spiderfy === 'function') parent.spiderfy();
}

// Following should give the same visible feedback as clicking the aircraft row:
// the marker takes the track color and the track is loaded/drawn.
function ensureFollowTrackSelected(address) {
  if (!address) return;
  if (selectedTracks.has(address)) {
    if (activeTrackAddress !== address) {
      activeTrackAddress = address;
      updateUrlHash();
    }
    // Re-sort immediately so the followed aircraft moves to the top.
    render();
    return;
  }
  toggleSelection(address, false);
}

function focusFollowedOnMap(address) {
  const a = findAircraftByAddress(address);
  if (!a || !Number.isFinite(a.lat) || !Number.isFinite(a.lon)) return false;
  // Zoom without animation so markercluster has settled before unclustering.
  // This is only the one-time entry zoom; automatic centering has no zoom floor.
  map.setView([a.lat, a.lon], FOLLOW_START_ZOOM, { animate: false });
  unclusterFollowedMarker(address);
  // In 3D this also corrects the camera for the aircraft's rendered altitude.
  centerOnFollowed(true, false, 0);
  return true;
}

function centerOnFollowed(force = false, animate = true, panDuration = 0.2, align3D = true) {
  // A paused 3D map is hidden (2D mode or mobile list view); do not queue new
  // eases into it. Leaflet following still works when 3D is simply inactive.
  if (map3dActive && map3dPaused) return false;
  const addr = activeFollowAddress();
  if (!addr) {
    stop3DFollowAlign();
    return false;
  }
  let lat, lon, alt = null;
  if (replayActive) {
    const p = replayPoints.find(x => x.id === addr);
    if (!p) return false;
    lat = p.lat; lon = p.lon; alt = p.alt ?? null;
  } else {
    const a = aircraft.find(x => x.address === addr);
    if (!a) return false;
    lat = a.lat; lon = a.lon; alt = a.altitude ?? null;
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;

  // Screen-space dead zone: inside the middle 60% of the viewport the aircraft
  // is free to move and the camera stays still, at any zoom level. Only an edge
  // crossing triggers a pan. A manual pan pauses following until that crossing.
  if (!force && !pointOutsideFollowBand(lat, lon, alt)) {
    if (followCenteringPaused) stop3DFollowAlign();
    syncRecenterButton();
    return false;
  }
  followCenteringPaused = false;
  syncRecenterButton();
  const use3D = map3dReady && map3dActive;
  if (use3D && force) {
    s3dReplayCenterSig = '';
    s3dReplayCenterRatio = null;
    s3dReplaySmoothSig = '';
    s3dReplaySmoothAlt = null;
  }
  const ground = L.latLng(lat, lon);
  const dest = use3D
    ? ((replayActive && !force
        ? s3dReplayCameraCenter(lon, lat, alt)
        : s3dCameraCenterForPoint(lon, lat, alt)) || ground)
    : ground;
  if (use3D) {
    // Leaflet is hidden in 3D mode. Move its state instantly and tag both
    // moveends with their expected cameras; otherwise the two maps ping-pong
    // and replay visibly shakes.
    armLeafletCameraStop(dest.lat, dest.lng, map.getZoom());
    arm3DCameraStop(dest.lng, dest.lat, map3d.getZoom());
  }
  if (map.getCenter().distanceTo(dest) > 1) {
    map.setView(dest, map.getZoom(), { animate: use3D ? false : animate, duration: panDuration });
  }
  if (use3D) {
    // Edge corrections now ease exactly like explicit recenters; replay keeps a
    // shorter duration so the animation lands before the next 200 ms update.
    const ease3D = animate;
    const duration3D = force ? Math.round(panDuration * 1000) : Math.round(panDuration * 600);
    if (ease3D) map3d.easeTo({ center: [dest.lng, dest.lat], duration: duration3D });
    else map3d.jumpTo({ center: [dest.lng, dest.lat] });
    if (align3D) start3DFollowAlign(addr, ease3D ? Math.round(panDuration * 1000) + 60 : 60);
  }
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

  const sounding = soundingContextForAircraft(
    findAircraftByAddress(address) || markers.get(address)?._data || searchResultMarkers.get(address)?._data
  );
  const refs = [];
  if (sounding?.cloud != null) refs.push({ alt: sounding.cloud, label: 'Cloud base', color: THEME.accent, dash: '3 4' });
  if (sounding?.ceiling != null) refs.push({ alt: sounding.ceiling, label: 'Thermal top', color: THEME.yellow, dash: '6 3' });

  const coords = pts.map(p => {
    const x = ((p[3] - t0) / spanT) * 460;
    const y = 65 - (((p[2] - minAlt) / spanAlt) * 58);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  const refItems = [];
  for (const ref of refs) {
    if (!Number.isFinite(ref.alt) || ref.alt < minAlt || ref.alt > maxAlt) continue;
    refItems.push({ ...ref, y: 65 - (((ref.alt - minAlt) / spanAlt) * 58) });
  }
  refItems.sort((a, b) => a.y - b.y);
  let refSvg = '';
  let refSuffix = '';
  refItems.forEach((ref, i) => {
    const labelY = Math.max(9, Math.min(65, ref.y + (refItems.length > 1 && i === 0 ? -3 : 8)));
    refSvg += `<line x1="0" y1="${ref.y.toFixed(1)}" x2="460" y2="${ref.y.toFixed(1)}" stroke="${ref.color}" stroke-width="1" stroke-dasharray="${ref.dash}" opacity="0.55" />` +
      `<text x="456" y="${labelY.toFixed(1)}" fill="${ref.color}" font-size="8" text-anchor="end" stroke="${THEME.bg}" stroke-width="3" paint-order="stroke">${esc(ref.label)} ≈ ${esc(fmtAlt(ref.alt))}</text>`;
    refSuffix += ` · ${ref.label} ≈ ${fmtAlt(ref.alt)}`;
  });

  let scrubSvg = '';
  let scrubSuffix = '';
  if (scrubIdx != null && scrubIdx >= 0 && scrubIdx < pts.length) {
    const sp = pts[scrubIdx];
    const sx = (((sp[3] - t0) / spanT) * 460).toFixed(1);
    const sy = (65 - (((sp[2] - minAlt) / spanAlt) * 58)).toFixed(1);
    const timeStr = new Date(sp[3] * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    scrubSvg = `
      <line x1="${sx}" y1="4" x2="${sx}" y2="68" stroke="${THEME.text}" stroke-width="1" stroke-dasharray="2 2" opacity="0.75" />
      <circle cx="${sx}" cy="${sy}" r="3.5" fill="${entry.color}" stroke="${THEME.bg}" stroke-width="1.5" />
    `;
    scrubSuffix = ` · ${fmtAlt(sp[2])} @ ${timeStr}`;
  }

  const title = `Min ${fmtAlt(minAlt)} / Max ${fmtAlt(maxAlt)}${refSuffix}${scrubSuffix}`;
  const svg = `
    <polyline fill="none" stroke="${entry.color}" stroke-width="2" points="${coords}" />
    ${refSvg}
    ${scrubSvg}
    <text x="4" y="12" fill="${THEME.muted}" font-size="10">${esc(fmtAlt(maxAlt))}</text>
    <text x="4" y="66" fill="${THEME.muted}" font-size="10">${esc(fmtAlt(minAlt))}</text>
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
  syncClearTracksButton();
  sync3DTracks();
  syncVarioLegend();
}

function clearAllTracks() {
  for (const entry of selectedTracks.values()) {
    if (entry.layer) map.removeLayer(entry.layer);
  }
  selectedTracks.clear();
  activeTrackAddress = null;
  updateListHint();
  updateUrlHash();
  syncClearTracksButton();
  sync3DTracks();
  syncVarioLegend();
}

function trackWindowCutoffSec(nowMs = serverNow()) {
  const seconds = Number($('trackWindow')?.value || 900);
  return Math.floor(nowMs / 1000) - (Number.isFinite(seconds) && seconds > 0 ? seconds : 900);
}

function buildTrackQuery(address) {
  const val = $('trackWindow').value;
  return `ogn-proxy.php?track=1&id=${encodeURIComponent(address)}&window=${encodeURIComponent(val)}`;
}

async function loadTrack(address) {
  const entry = selectedTracks.get(address);
  if (!entry) return false;
  if (entry.layer) { map.removeLayer(entry.layer); entry.layer = null; syncVarioLegend(); }
  const reqId = ++trackReqSeq;
  entry.reqId = reqId;

  try {
    const res = await fetch(buildTrackQuery(address));
    if (!res.ok) return false;
    const data = await res.json();
    const current = selectedTracks.get(address);
    if (!current || current.reqId !== reqId) return false;

    current.points = Array.isArray(data.points) ? data.points : [];
    current.layer = buildTrackLayer(current.points, current.color);
    if (current.layer) current.layer.addTo(map);
    sync3DTracks();
    syncVarioLegend();
    refreshMarkerPopup(address);
    return true;
  } catch (err) {
    console.warn('Track fetch failed:', err);
    return false;
  }
}

const IGC_CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

const igcPad = (n, len = 2) => String(Math.floor(Math.abs(n))).padStart(len, '0');

function igcCrc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = IGC_CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function splitTrackSegments(points, gapSec = 600) {
  const segments = [];
  let current = [];
  for (const point of points) {
    if (!Array.isArray(point) || point.length < 4) continue;
    const ts = Number(point[3]);
    if (!Number.isFinite(ts)) continue;
    if (current.length && ts - Number(current[current.length - 1][3]) > gapSec) {
      if (current.length >= 2) segments.push(current);
      current = [];
    }
    current.push(point);
  }
  if (current.length >= 2) segments.push(current);
  return segments;
}

function buildIgcText(points, name) {
  const d0 = new Date(Number(points[0][3]) * 1000);
  const dateStr = `${igcPad(d0.getUTCDate())}${igcPad(d0.getUTCMonth() + 1)}${igcPad(d0.getUTCFullYear() % 100)}`;
  const lines = [
    'AOGN001',
    `HFDTE${dateStr}`,
    `HFPLTPILOTINCHARGE:${name}`,
    `HFGIDGLIDERID:${name}`
  ];
  for (const point of points) {
    const lat = Number(point[0]);
    const lon = Number(point[1]);
    const alt = point[2] === null || point[2] === undefined ? null : Number(point[2]);
    const ts = Number(point[3]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(ts)) continue;
    const dt = new Date(ts * 1000);
    const hms = `${igcPad(dt.getUTCHours())}${igcPad(dt.getUTCMinutes())}${igcPad(dt.getUTCSeconds())}`;
    const latDeg = Math.floor(Math.abs(lat)), latMin = Math.round((Math.abs(lat) - latDeg) * 60000);
    const lonDeg = Math.floor(Math.abs(lon)), lonMin = Math.round((Math.abs(lon) - lonDeg) * 60000);
    const latStr = `${igcPad(latDeg, 2)}${igcPad(latMin, 5)}${lat >= 0 ? 'N' : 'S'}`;
    const lonStr = `${igcPad(lonDeg, 3)}${igcPad(lonMin, 5)}${lon >= 0 ? 'E' : 'W'}`;
    const altVal = Math.max(0, Math.round(Number.isFinite(alt) ? alt : 0));
    lines.push(`B${hms}${latStr}${lonStr}A00000${igcPad(altVal, 5)}`);
  }
  return lines.join('\r\n') + '\r\n';
}

async function fetchFullTrackPoints(address) {
  const res = await fetch(`ogn-proxy.php?track=1&id=${encodeURIComponent(address)}&window=86400&full=1`, { cache: 'no-store' });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data.points) ? data.points : [];
}

function buildIgcZip(files) {
  const enc = new TextEncoder();
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const locals = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = enc.encode(file.name);
    const dataBytes = enc.encode(file.data);
    const crc = igcCrc32(dataBytes);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, dataBytes.length, true);
    lv.setUint32(22, dataBytes.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    locals.push(local, dataBytes);

    const dir = new Uint8Array(46 + nameBytes.length);
    const dv = new DataView(dir.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 20, true);
    dv.setUint16(8, 0x0800, true);
    dv.setUint16(10, 0, true);
    dv.setUint16(12, dosTime, true);
    dv.setUint16(14, dosDate, true);
    dv.setUint32(16, crc, true);
    dv.setUint32(20, dataBytes.length, true);
    dv.setUint32(24, dataBytes.length, true);
    dv.setUint16(28, nameBytes.length, true);
    dv.setUint16(30, 0, true);
    dv.setUint16(32, 0, true);
    dv.setUint16(34, 0, true);
    dv.setUint16(36, 0, true);
    dv.setUint32(38, 0, true);
    dv.setUint32(42, offset, true);
    dir.set(nameBytes, 46);
    central.push(dir);

    offset += local.length + dataBytes.length;
  }

  const centralSize = central.reduce((sum, chunk) => sum + chunk.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  return new Blob([...locals, ...central, eocd], { type: 'application/zip' });
}

async function downloadIgc(address) {
  showToast('Preparing IGC export…', 1200);
  const points = await fetchFullTrackPoints(address);
  if (points.length < 2) {
    showToast('No track points in the last 24 hours.', 3200);
    return;
  }
  const segments = splitTrackSegments(points);
  if (!segments.length) {
    showToast('No complete track in the last 24 hours.', 3200);
    return;
  }
  const a = aircraft.find(x => x.address === address);
  const name = a ? displayName(a) : String(address).toUpperCase();
  const safeName = name.replace(/[^a-z0-9_-]/gi, '_');
  const first = new Date(Number(points[0][3]) * 1000);
  const dateStr = `${igcPad(first.getUTCDate())}${igcPad(first.getUTCMonth() + 1)}${igcPad(first.getUTCFullYear() % 100)}`;

  if (segments.length === 1) {
    downloadBlob(new Blob([buildIgcText(segments[0], name)], { type: 'application/octet-stream' }), `${safeName}_${dateStr}.igc`);
    showToast('IGC downloaded');
    return;
  }

  const files = segments.map((segment, index) => {
    const start = new Date(Number(segment[0][3]) * 1000);
    const startHms = `${igcPad(start.getUTCHours())}${igcPad(start.getUTCMinutes())}${igcPad(start.getUTCSeconds())}`;
    return {
      name: `${safeName}_${dateStr}_T${igcPad(index + 1)}_${startHms}.igc`,
      data: buildIgcText(segment, name)
    };
  });
  downloadBlob(buildIgcZip(files), `${safeName}_${dateStr}_tracks.zip`);
  showToast(`${segments.length} IGC tracks downloaded`, 2400);
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
    const exactTime = formatClockAtZone(lastSeenMs);
    const lastSeenClock = lastSeenClockText(lastSeenMs, item.lat, item.lon, exactTime);
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
    L.popup({ ...POPUP_OPTIONS, maxWidth: 360 })
      .setLatLng([item.lat, item.lon])
      .setContent(`
        <div class="popup-title">${esc(item.name)}</div>
        <div class="popup-actions">
          <button type="button" data-act="alert-sar" data-sar="${esc(sarTxt)}">📋 SAR</button>
        </div>
        <div class="popup-grid">
          <div class="popup-value"><span>Alert</span><br><b style="color:var(--red)">${esc(item.status)}</b></div>
          <div class="popup-value"><span>Last status</span><br><b>${esc(lastStatus)}</b></div>
          <div class="popup-value popup-full popup-last-seen"><span>Last seen</span><b>${esc(`${lastSeenClock} (${lastSeenAge})`)}</b></div>
          ${outcome ? `<div class="popup-value popup-full"><span>State</span><br><b style="color:var(--yellow)">${esc(outcome)}</b></div>` : ''}
          <div class="popup-value popup-full"><span>Position</span><br><a href="${mapsUrl}" target="_blank" rel="noopener noreferrer" style="color:var(--accent);font-weight:700;text-decoration:underline">${esc(posText)}</a></div>
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

function showSearchResultPopup(a, recenterOnClose = false, center = null, zoom = null) {
  if (!a || !Number.isFinite(a.lat) || !Number.isFinite(a.lon)) return;
  map.setView(center || [a.lat, a.lon], zoom ?? Math.max(map.getZoom(), 12));
  const m = ensureSearchResultMarker(a);
  if (m) {
    if (recenterOnClose) m._recenterOnClose = true;
    requestAnimationFrame(() => m.openPopup());
  }
}

// A popup opened by a list click is centered in the map. When it is dismissed,
// put the focused aircraft back at the center so it stays easy to find.
function recenterFocusedMarkerOnClose(m) {
  if (!m) return;
  m.on('popupclose', e => {
    if (!m._recenterOnClose) return;
    m._recenterOnClose = false;
    if (replayActive) return;
    const closingPopupEl = e.popup?.getElement?.();
    if (closingPopupEl) closingPopupEl.style.translate = '';
    const recenter = () => {
      // Ignore the popup that is closing itself, but do not fight a newer popup.
      const otherPopupOpen = [...document.querySelectorAll('.leaflet-popup')]
        .some(el => el !== closingPopupEl && el.isConnected);
      if (otherPopupOpen) return;
      const a = m._data;
      if (!a || !Number.isFinite(a.lat) || !Number.isFinite(a.lon)) return;
      const ground = L.latLng(a.lat, a.lon);
      const dest = (map3dReady && map3dActive)
        ? (s3dCameraCenterForPoint(a.lon, a.lat, a.altitude) || ground)
        : ground;
      if (map3dReady && map3dActive) {
        arm3DCameraStop(dest.lng, dest.lat, map3d.getZoom());
        map3d.jumpTo({ center: [dest.lng, dest.lat] });
      }
      map.setView(dest, map.getZoom(), { animate: false });
    };
    if (mapMoving) map.once('moveend', recenter);
    else requestAnimationFrame(recenter);
  });
}

// Clear the one-shot list focus. When the same aircraft was also followed,
// use toggleFollow() so the follow buttons and live centering state stay in sync.
function clearMapFocus(address = null) {
  const st3D = address ? map3dDomPopupState.get(`live:${address}`) : null;
  if (st3D?.popup?.isOpen()) st3D.popup.remove();
  const m = address ? (markers.get(address) || searchResultMarkers.get(address)) : null;
  if (m) {
    // Do not let the popup-close handler recenter an aircraft we just unfocused.
    m._recenterOnClose = false;
    if (m.isPopupOpen?.()) map.closePopup(m.getPopup());
  }
  if (followedAddress && (!address || followedAddress === address)) {
    toggleFollow(followedAddress);
    return;
  }
  mapFocusAddress = null;
  followCenteringPaused = false;
  syncRecenterButton();
}

// A list click is a one-shot focus: open its popup centered, then leave the
// aircraft highlighted with the shared HUD and centered after the popup closes.
function focusAircraftOnMap(address, fallbackAircraft = null) {
  if (!address) return false;
  if (followedAddress && followedAddress !== address) {
    // Clearing follow prevents the live follow loop from fighting this selection.
    toggleFollow(followedAddress);
  }
  mapFocusAddress = address;
  const a = findAircraftByAddress(address) || fallbackAircraft;
  if (!a || !Number.isFinite(a.lat) || !Number.isFinite(a.lon)) return false;
  const m = markers.get(address);
  const use3D = map3dReady && map3dActive;
  const key3D = `live:${address}`;
  const has3DMarker = use3D && map3dDomMarkers.has(key3D);
  const ground = L.latLng(a.lat, a.lon);
  const centerAndOpen = () => {
    let dest = ground;
    if (use3D) {
      // Match MapLibre to the 2D zoom before computing the altitude correction,
      // then center on the rendered aircraft rather than its ground shadow.
      const zoom3D = Math.max(2, Math.min(16, map.getZoom() + 1));
      const before = map3d.getCenter();
      // The zoom-only jump is a separate moveend; tag it so it does not look
      // like user input before the final centred camera lands.
      arm3DCameraStop(before.lng, before.lat, zoom3D);
      map3d.jumpTo({ zoom: zoom3D });
      dest = s3dCameraCenterForPoint(a.lon, a.lat, a.altitude) || ground;
      armLeafletCameraStop(dest.lat, dest.lng, map.getZoom());
      arm3DCameraStop(dest.lng, dest.lat, zoom3D);
      map.setView(dest, map.getZoom(), { animate: false });
      map3d.jumpTo({ center: [dest.lng, dest.lat] });
    } else {
      map.setView(ground, map.getZoom(), { animate: false });
    }
    if (has3DMarker) {
      // 3D popups are centered by s3dPositionPopup(), so open that popup
      // directly instead of waiting for Leaflet's clustered 2D marker to
      // uncluster and then nudging its popup into place.
      const leafletMarker = m || searchResultMarkers.get(address);
      if (leafletMarker) {
        leafletMarker._recenterOnClose = false;
        if (leafletMarker.isPopupOpen?.()) map.closePopup(leafletMarker.getPopup());
      }
      s3dOpenPopupForKey(key3D, a);
      return;
    }
    if (m) {
      m._recenterOnClose = true;
      m.openPopup();
    } else {
      showSearchResultPopup(a, true, use3D ? dest : null, use3D ? map.getZoom() : null);
    }
    if (use3D) {
      // Search-only aircraft have no 3D marker; keep their 2D popup centered
      // through the camera and cluster changes.
      const focusMarker = markers.get(address) || searchResultMarkers.get(address);
      const centerPopup = () => requestAnimationFrame(() => {
        if (focusMarker?.isPopupOpen?.() && isFocusedMapMarker(focusMarker)) {
          centerFocusedPopupInView(focusMarker);
        }
      });
      let frames = 12;
      const settlePopup = () => {
        if (frames-- <= 0) return;
        centerPopup();
        requestAnimationFrame(settlePopup);
      };
      settlePopup();
      map.once('moveend', centerPopup);
      map3d.once('moveend', centerPopup);
    }
  };
  // 3D markers are DOM overlays independent of Leaflet clustering, so there is
  // no need to uncluster the hidden 2D marker before opening the 3D popup.
  if (m && clusterGroup.hasLayer(m) && !has3DMarker) clusterGroup.zoomToShowLayer(m, centerAndOpen);
  else centerAndOpen();
  return true;
}

function toggleSelection(address, openOnMap = false) {
  const target = findAircraftByAddress(address);
  // A second list click on the same aircraft clears focus instead of re-focusing.
  const wasFocused = openOnMap && !replayActive && activeMapFocusAddress() === address;
  // A searched aircraft gets one render free of the type preference filters.
  if (target?.search24h) oneTimeSearchBypass.add(address);
  if (selectedTracks.has(address)) {
    removeTrack(address);
    if (openOnMap && !wasFocused) focusAircraftOnMap(address, target);
  } else {
    selectedTracks.set(address, { color: pickTrackColor(), layer: null, points: [], reqId: 0 });
    activeTrackAddress = address;
    updateUrlHash();
    syncClearTracksButton();
    loadTrack(address);
    if (openOnMap && !wasFocused) {
      if (window.innerWidth <= 800) revealMapForListAction();
      focusAircraftOnMap(address, target);
    }
  }
  if (wasFocused) clearMapFocus(address);
  updateListHint();
  render();
  requestAnimationFrame(() => focusListRow(address));
}

const MEASURE_CLEAR_HTML =
  `<button type="button" class="measure-clear icon-close" data-measure-clear title="Clear measurement" aria-label="Clear measurement">×</button>`;

function measureIcon() {
  return L.divIcon({
    className: 'measure-dot',
    html: '<span></span>',
    iconSize: [18, 18],
    iconAnchor: [9, 9]
  });
}

function ensureMeasure3DElements() {
  if (!map3d) return false;
  if (measure3dLayer && measure3dLayer.isConnected) return true;
  const host = $('map3d') || map3d.getContainer?.();
  if (!host) return false;
  const layer = document.createElement('div');
  layer.className = 'measure-3d-layer';
  layer.hidden = !map3dActive;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'measure-3d-svg');
  measure3dLine = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  measure3dLine.setAttribute('class', 'measure-3d-line');
  svg.appendChild(measure3dLine);
  layer.appendChild(svg);
  host.appendChild(layer);
  measure3dLayer = layer;
  measure3dDots = [];
  return true;
}

function syncMeasureCursor() {
  map.getContainer().style.cursor = measureMode ? 'crosshair' : '';
  const canvas = map3d?.getCanvas?.();
  if (canvas) canvas.style.cursor = measureMode ? 'crosshair' : '';
  const container = map3d?.getContainer?.();
  if (container) container.style.cursor = measureMode ? 'crosshair' : '';
}

/**
 * Leaflet binds its own click handler when a popup is attached. Detach it while
 * measuring so an aircraft click only places the point and never opens a popup.
 */
function setMeasurePopupDetached(marker, detached) {
  if (!marker || typeof marker._openPopup !== 'function') return;
  if (!!marker._measurePopupDetached === !!detached) return;
  if (detached) {
    marker.off('click', marker._openPopup, marker);
    if (typeof marker._openPopupOnKeypress === 'function') {
      marker.off('keypress', marker._openPopupOnKeypress, marker);
    }
  } else {
    marker.on('click', marker._openPopup, marker);
    if (typeof marker._openPopupOnKeypress === 'function') {
      marker.on('keypress', marker._openPopupOnKeypress, marker);
    }
  }
  marker._measurePopupDetached = !!detached;
}

function syncMarkerPopupHandlersForMeasure() {
  for (const marker of markers.values()) setMeasurePopupDetached(marker, measureMode);
  for (const marker of searchResultMarkers.values()) setMeasurePopupDetached(marker, measureMode);
}

function positionMeasure3D() {
  if (!measure3dLayer || !map3dActive || !map3d) return;
  measure3dLayer.hidden = false;
  const width = map3d.transform?.width || map3d.getContainer?.()?.clientWidth || 0;
  const height = map3d.transform?.height || map3d.getContainer?.()?.clientHeight || 0;
  const svg = measure3dLayer.querySelector('svg');
  if (svg && width && height) svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const projected = [];
  measurePoints.forEach(([lat, lon], index) => {
    const point = s3dProjectGroundPoint(lon, lat);
    projected.push(point);
    const el = measure3dDots[index];
    if (!el) return;
    if (!point) {
      el.style.display = 'none';
      return;
    }
    el.style.display = '';
    el.style.transform = `translate(-50%, -50%) translate(${point.x.toFixed(1)}px, ${point.y.toFixed(1)}px)`;
  });
  if (measure3dLine) {
    const ready = projected.length >= 2 && projected.every(Boolean);
    measure3dLine.setAttribute(
      'points',
      ready ? projected.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ') : ''
    );
  }
}

function startMeasure3DDrag(event, index) {
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  selectMeasurePoint(index);
  const el = event.currentTarget;
  el.classList.add('dragging');
  try { el.setPointerCapture(event.pointerId); } catch (_) {}
  try { map3d?.dragPan?.disable(); } catch (_) {}
  measure3dDrag = { index, pointerId: event.pointerId, el };

  const move = ev => {
    if (!measure3dDrag || ev.pointerId !== measure3dDrag.pointerId) return;
    ev.preventDefault();
    ev.stopPropagation();
    const host = map3d?.getContainer?.() || $('map3d');
    const rect = host?.getBoundingClientRect();
    if (!rect) return;
    const ll = s3dUnproject3DPoint(ev.clientX - rect.left, ev.clientY - rect.top);
    if (!ll) return;
    measurePoints[index] = [ll.lat, ll.lng];
    updateMeasureReadout();
    positionMeasure3D();
  };
  const stop = ev => {
    if (ev && ev.pointerId !== undefined && ev.pointerId !== measure3dDrag?.pointerId) return;
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', stop);
    el.removeEventListener('pointercancel', stop);
    el.removeEventListener('lostpointercapture', stop);
    el.classList.remove('dragging');
    try { map3d?.dragPan?.enable(); } catch (_) {}
    measure3dDrag = null;
    syncMeasureSelection();
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', stop);
  el.addEventListener('pointercancel', stop);
  el.addEventListener('lostpointercapture', stop);
}

function syncMeasure3DDots() {
  if (!map3d) return;
  if (!ensureMeasure3DElements()) return;
  measure3dLayer.hidden = !map3dActive;
  while (measure3dDots.length > measurePoints.length) measure3dDots.pop().remove();
  while (measure3dDots.length < measurePoints.length) {
    const index = measure3dDots.length;
    const el = document.createElement('div');
    el.className = 'measure-dot measure-3d-dot';
    el.innerHTML = '<span></span>';
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.title = `Measurement point ${index + 1}`;
    el.addEventListener('click', ev => {
      ev.preventDefault();
      ev.stopPropagation();
      selectMeasurePoint(index);
    });
    el.addEventListener('pointerdown', ev => startMeasure3DDrag(ev, index));
    el.addEventListener('keydown', ev => nudgeMeasurePoint(index, ev, null));
    measure3dLayer.appendChild(el);
    measure3dDots.push(el);
  }
  measure3dDots.forEach((el, index) => el.classList.toggle('selected', index === selectedMeasureIndex));
  positionMeasure3D();
}

function clearMeasure() {
  measurePoints = [];
  selectedMeasureIndex = -1;
  measureLine = null;
  measureMarkers = [];
  measureLayer.clearLayers();
  syncMeasure3DDots();
  const readout = $('measureReadout');
  if (readout) readout.hidden = true;
}

function syncMeasureSelection() {
  if (selectedMeasureIndex >= measurePoints.length) {
    selectedMeasureIndex = measurePoints.length ? measurePoints.length - 1 : -1;
  }
  measureMarkers.forEach((marker, index) => {
    const el = marker.getElement();
    if (el) el.classList.toggle('selected', index === selectedMeasureIndex);
    marker.setZIndexOffset(index === selectedMeasureIndex ? 1100 : 1000);
  });
  measure3dDots.forEach((el, index) => el.classList.toggle('selected', index === selectedMeasureIndex));
}

function selectMeasurePoint(index) {
  if (!Number.isInteger(index) || index < 0 || index >= measurePoints.length) return;
  selectedMeasureIndex = index;
  syncMeasureSelection();
  updateMeasureReadout();
}

function updateMeasureReadout() {
  const readout = $('measureReadout');
  if (!readout) return;
  const wasHidden = readout.hidden;
  if (!measurePoints.length) {
    readout.hidden = true;
    return;
  }
  if (measurePoints.length === 1) {
    readout.innerHTML = `<span>Point 1 set · tap second point</span>${MEASURE_CLEAR_HTML}`;
    if (wasHidden) bringToFront(readout);
    readout.hidden = false;
    return;
  }
  const [p1, p2] = measurePoints;
  const km = haversineKm(p1[0], p1[1], p2[0], p2[1]);
  const brg = bearingDeg(p1[0], p1[1], p2[0], p2[1]);
  readout.innerHTML =
    `<span>${esc(fmtDistanceKm(km))} · ${Math.round(brg)}°</span>${MEASURE_CLEAR_HTML}`;
  if (wasHidden) bringToFront(readout);
  readout.hidden = false;
}

function nudgeMeasurePoint(index, event, marker) {
  const vert = event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0;
  const horiz = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
  if (!vert && !horiz) return;
  event.preventDefault();
  event.stopPropagation();
  selectMeasurePoint(index);
  const point = measurePoints[index];
  if (!point) return;
  const meters = event.shiftKey ? 100 : 10;
  const lat = Math.max(-85, Math.min(85, point[0] + vert * meters / 111320));
  const cosLat = Math.max(Math.cos(lat * Math.PI / 180), 0.01);
  let lon = point[1] + horiz * meters / (111320 * cosLat);
  if (lon > 180) lon -= 360;
  else if (lon < -180) lon += 360;
  measurePoints[index] = [lat, lon];
  if (marker) marker.setLatLng([lat, lon]);
  else positionMeasure3D();
  if (measureLine) measureLine.setLatLngs(measurePoints);
  updateMeasureReadout();
}

function renderMeasure() {
  measureLayer.clearLayers();
  measureLine = null;
  measureMarkers = [];
  if (selectedMeasureIndex >= measurePoints.length) {
    selectedMeasureIndex = measurePoints.length ? measurePoints.length - 1 : -1;
  }
  if (measurePoints.length >= 2) {
    measureLine = L.polyline(measurePoints, { color: '#38bdf8', weight: 2, dashArray: '6 4', interactive: false }).addTo(measureLayer);
  }
  measurePoints.forEach((point, index) => {
    const marker = L.marker(point, {
      icon: measureIcon(),
      draggable: true,
      autoPan: true,
      keyboard: true,
      zIndexOffset: index === selectedMeasureIndex ? 1100 : 1000,
      title: `Measurement point ${index + 1}`
    }).addTo(measureLayer);
    marker.on('click', e => {
      if (e && e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent);
      selectMeasurePoint(index);
    });
    marker.on('dragstart', () => {
      selectMeasurePoint(index);
      const el = marker.getElement();
      if (el) el.classList.add('dragging');
    });
    marker.on('drag', e => {
      const latlng = e.target.getLatLng();
      measurePoints[index] = [latlng.lat, latlng.lng];
      if (measureLine) measureLine.setLatLngs(measurePoints);
      updateMeasureReadout();
    });
    marker.on('dragend', () => {
      const el = marker.getElement();
      if (el) el.classList.remove('dragging');
      renderMeasure();
    });
    const el = marker.getElement();
    if (el) {
      el.addEventListener('keydown', event => nudgeMeasurePoint(index, event, marker));
    }
    measureMarkers.push(marker);
  });
  syncMeasureSelection();
  syncMeasure3DDots();
  updateMeasureReadout();
}

function addMeasurePoint(lat, lon) {
  if (!measureMode || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
  if (measurePoints.length >= 2) measurePoints = [];
  measurePoints.push([lat, lon]);
  selectedMeasureIndex = measurePoints.length - 1;
  renderMeasure();
}

function setMeasureMode(on) {
  measureMode = !!on;
  const btn = $('btnMeasure');
  if (btn) {
    btn.classList.toggle('active', measureMode);
    btn.setAttribute('aria-pressed', String(measureMode));
  }
  syncMeasureCursor();
  syncMarkerPopupHandlersForMeasure();
  // The measurement stays visible after exiting so it can still be inspected
  // and edited; the readout's × button is the explicit clear action.
}

map.on('click', e => {
  if (measureMode) addMeasurePoint(e.latlng.lat, e.latlng.lng);
  // Plain map taps must not wipe selected tracks; Escape and the popup
  // Track toggle are the deliberate clear actions.
});

map.on('dragstart', () => { pauseFollowCentering(); });
map.on('move zoom resize', () => { syncRecenterButton(); });
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
    altitude, speed, course, climb: climb != null ? Number(climb.toFixed(1)) : null,
    snr, weather, type, receiver, address: liveLabel.toLowerCase(), ognId, ddbId, receivedAtMs: timestampMs
  };
}

const OGN_TYPES = {
  1:'Glider', 2:'Towplane', 3:'Helicopter', 4:'Parachutist', 5:'Drop plane', 6:'Hang glider',
  7:'Paraglider', 8:'Powered', 9:'Jet', 10:'UFO', 11:'Balloon', 12:'Airship', 13:'Drone', 15:'Ground Station', 16:'Ultralight'
};

// A distinct stripe colour per resolved OGN type; unknown/unresolved types use
// the muted slate. Emergency rows keep their red stripe via typeStripeColor().
const TYPE_COLORS = {
  0: 'var(--type-unknown)',
  1: 'var(--type-glider)',
  2: 'var(--type-tow)',
  3: 'var(--type-heli)',
  4: 'var(--type-para)',
  5: 'var(--type-drop)',
  6: 'var(--type-hang)',
  7: 'var(--type-paraglider)',
  8: 'var(--type-powered)',
  9: 'var(--type-jet)',
  10: 'var(--type-ufo)',
  11: 'var(--type-balloon)',
  12: 'var(--type-airship)',
  13: 'var(--type-drone)',
  15: 'var(--type-station)',
  16: 'var(--type-ultralight)'
};

const ICONS = {
  default: "M12 1.5C12.7 1.5 13 3.2 13 7.5L23.2 9.4V10.9L13 10.6L12.7 19.2L15.8 20.6V21.8L12 21L8.2 21.8V20.6L11.3 19.2L11 10.6L0.8 10.9V9.4L11 7.5C11 3.2 11.3 1.5 12 1.5Z",
  airplane: "M12 2l2 6h8v2l-8 3v6l3 2v2l-5-1-5 1v-2l3-2v-6l-8-3V8h8l2-6z",
  heli: "M12 3.5C14.1 3.5 15.3 5.5 15.3 8.5C15.3 11 14 12.6 12.8 13.3L12.7 19.5L15 20.5V21.7L12 21.1L9 21.7V20.5L11.3 19.5L11.2 13.3C10 12.6 8.7 11 8.7 8.5C8.7 5.5 9.9 3.5 12 3.5ZM4.2 3.2L19.8 14.8L19 15.8L3.4 4.2ZM19.8 3.2L4.2 14.8L5 15.8L20.6 4.2Z",
  para: "M12 2C4 2 1 7 1 9C3 7 7 6 12 6C17 6 21 7 23 9C23 7 20 2 12 2ZM2 9L11 18M22 9L13 18M10 20A2 2 0 1 0 14 20A2 2 0 1 0 10 20Z",
  hang: "M12 2L24 16L12 12L0 16ZM12 12L12 20M10 20h4",
  drone: "M5.5 3.2a2.3 2.3 0 1 0 0 4.6a2.3 2.3 0 1 0 0-4.6zM18.5 3.2a2.3 2.3 0 1 0 0 4.6a2.3 2.3 0 1 0 0-4.6zM5.5 16.2a2.3 2.3 0 1 0 0 4.6a2.3 2.3 0 1 0 0-4.6zM18.5 16.2a2.3 2.3 0 1 0 0 4.6a2.3 2.3 0 1 0 0-4.6zM12 9.3L14.7 12 12 14.7 9.3 12zM10.4 10.4L7.2 7.2M13.6 10.4L16.8 7.2M10.4 13.6L7.2 16.8M13.6 13.6L16.8 16.8",
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
function typeStripeColor(a) {
  if (isEmergency(a)) return 'var(--red)';
  return TYPE_COLORS[getResolvedType(a)] || TYPE_COLORS[0];
}

function currentBounds() {
  try { return map.getBounds(); } catch (e) { return null; }
}

// In 3D the Leaflet bounds mirror can be much wider than MapLibre's pitched
// camera view. Use the same projected-screen test as the 3D marker culling so
// the list matches the aircraft markers that are actually on screen.
// Returns null when 3D projection is unavailable, so callers fall back to bounds.
function s3dProjectedPointVisible(lng, lat, altMSL = null) {
  if (!map3dActive || !map3dReady || !map3d) return null;
  const pt = s3dProject3DPoint(lng, lat, altMSL);
  if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return false;
  const canvas = map3d.getCanvas?.();
  const width = map3d.transform?.width || canvas?.clientWidth || 0;
  const height = map3d.transform?.height || canvas?.clientHeight || 0;
  if (!width || !height) return true;
  const margin = S3D_MARKER_CULL_MARGIN_PX;
  return pt.x >= -margin && pt.x <= width + margin && pt.y >= -margin && pt.y <= height + margin;
}

// Callers doing a whole-list pass fetch bounds once and pass them in.
function isInCurrentViewport(lat, lon, bounds = null, altitude = null) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  const projected = s3dProjectedPointVisible(lon, lat, altitude);
  if (projected !== null) return projected;
  const b = bounds || currentBounds();
  if (!b) return false;
  try { return b.contains([lat, lon]); } catch (e) { return false; }
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
    if (!prev || prev.status !== emergText || prev.tsMs !== nextTs || prev.latestTsMs !== nextLatestTs || !prev.firstTsMs) {
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
        firstTsMs: prev ? (prev.firstTsMs || nextTs) : nextTs,
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
  // Show when the alert was first received; the age below stays "last seen",
  // matching the age shown for aircraft in the main list.
  const alertTimeMs = it.firstTsMs || it.tsMs;
  const alertTime = new Date(alertTimeMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const label = `${it.name} - ${statusText}`;
  return `<div class="aircraft emergency" data-alert-addr="${esc(it.address)}" data-key="${esc(it.address)}" tabindex="0" role="option" aria-selected="false" aria-label="${esc(label)}">
    <div class="stripe" style="background:var(--red)"></div>
    <div>
      <div class="callsign">${esc(it.name)}</div>
      <div class="meta"><span style="color:var(--red);font-weight:600">${esc(statusText)}</span>${lastStatusHtml}${outcomeHtml}</div>
    </div>
    <div class="alt station-alt" title="Alert first received"><span data-ts="${alertTimeMs}">${esc(alertTime)}</span><div class="age-row"><span class="age" data-ts="${lastSeenMs}" title="Last seen">${fmtAge(ageSec)}</span></div></div>
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
  for (const id of lastPinnedStatus.keys()) {
    if (!pinnedAircraft.has(id)) lastPinnedStatus.delete(id);
  }
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
  const activeCacheIds = new Set();

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
    activeCacheIds.add(a.address);

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
    if (now - cached.timestamp > LAST_KNOWN_TTL_MS) { lastKnownCache.delete(id); continue; }
    // Once live data for this aircraft arrives, the live packet supersedes it.
    if (aprsCache.has(id) || activeCacheIds.has(id)) continue;
    const a = parseAprsLineCached(cached.raw, cached.timestamp);
    if (!a) continue;
    a.id = id;
    a.address = id;
    activeCacheIds.add(id);
    a.aprsPacket = cached.raw;
    a.aprsReceivedAt = cached.received_at;
    a.__lastKnown = true;
    applyCachedAircraftMeta(a);
    aircraft.push(a);
  }

  for (const cache of [lastAltCache, lastClimbCache]) {
    for (const id of cache.keys()) {
      if (!activeCacheIds.has(id)) cache.delete(id);
    }
  }

  for (const [id, cached] of telemetryCache.entries()) {
    if (now - cached.timestamp > wxTtlMs) { telemetryCache.delete(id); continue; }
    const tel = parseAprsLineCached(cached.raw, cached.timestamp);
    if (tel && tel.__telemetryOnly) telemetryOnly.push(tel);
  }

  const stationKeyToAircraft = new Map();
  for (const a of aircraft) {
    for (const k of getStationKeys(a)) {
      if (!stationKeyToAircraft.has(k)) stationKeyToAircraft.set(k, a);
    }
  }

  for (const tel of telemetryOnly) {
    if (tel.weather) {
      updateWeatherCache([tel.id, tel.address, tel.liveLabel], tel.weather, tel.receivedAtMs);
    }
    const target = stationKeyToAircraft.get(tel.address);
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

function isFocusedMapMarker(marker) {
  if (!marker || replayActive) return false;
  const addr = marker._data?.address;
  return !!addr && activeMapFocusAddress() === addr;
}

// A focused aircraft stays at the map center. Shift only the popup element so
// it can open centered (and cover the marker) without panning the map away.
function centerFocusedPopupInView(marker) {
  if (!marker?.isPopupOpen?.()) return;
  const popupEl = marker.getPopup()?.getElement?.();
  if (!popupEl) return;
  const previousTranslate = popupEl.style.translate;
  // Measure the Leaflet-placed position, then offset only enough to centre the
  // popup. Keep any existing offset when the popup is already centred so a
  // later correction cannot accidentally clear it.
  popupEl.style.translate = '';
  const mapRect = $('map').getBoundingClientRect();
  const popupRect = popupEl.getBoundingClientRect();
  const safeBottom = popupSafeBottom(mapRect);
  const margin = 8;
  const targetX = mapRect.width / 2;
  const targetY = safeBottom == null ? mapRect.height / 2
    : Math.max(popupRect.height / 2 + margin, Math.min(safeBottom / 2, safeBottom - popupRect.height / 2 - margin));
  const dx = popupRect.left + popupRect.width / 2 - (mapRect.left + targetX);
  const dy = popupRect.top + popupRect.height / 2 - (mapRect.top + targetY);
  if (Math.abs(dx) < 4 && Math.abs(dy) < 4) {
    popupEl.style.translate = previousTranslate;
    return;
  }
  popupEl.style.translate = `${-dx}px ${-dy}px`;
}

function keepPopupAboveBottomBar(popupEl = $('map').querySelector('.leaflet-popup')) {
  panPopupInView(popupEl, false);
}

function keepOpenPopupAboveBar(marker) {
  if (!marker?.isPopupOpen()) return;
  requestAnimationFrame(() => {
    if (!marker.isPopupOpen()) return;
    if (isFocusedMapMarker(marker)) centerFocusedPopupInView(marker);
    else keepPopupAboveBottomBar(marker.getPopup()?.getElement());
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
  const focused = !replayActive && activeMapFocusAddress() === a.address;
  const trackColor = selectedTracks.get(a.address)?.color || THEME.accent;
  const name = esc(displayName(a));
  let svgPath = ICONS.default;
  switch(type) {
    case 2: case 5: case 8: case 9: case 16: svgPath = ICONS.airplane; break;
    case 3: svgPath = ICONS.heli; break;
    case 4: case 7: svgPath = ICONS.para; break;
    case 6: svgPath = ICONS.hang; break;
    case 13: svgPath = ICONS.drone; break;
    case 11: case 12: svgPath = ICONS.balloon; break;
    case 15: svgPath = ICONS.tower; break;
  }
  return L.divIcon({
    className: `glider-icon${focused ? ' focused' : ''}`, iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -24],
    html: `<div class="glider-wrap${emergClass}${focused ? ' focused' : ''}" style="--marker-color:${trackColor}"><svg viewBox="0 0 24 24" style="transform:rotate(${angle}deg)" aria-hidden="true"><path d="${svgPath}"/></svg><div class="glider-label" title="${name}">${name}</div>${focused ? focusHudHtml(liveFocusHudText(a)) : ''}</div>`
  });
}

function markerRectsOverlap(a, b, pad = 0) {
  return !(a.right + pad < b.left || b.right + pad < a.left ||
           a.bottom + pad < b.top || b.bottom + pad < a.top);
}

function updateMarkerLabels() {
  // Names are no longer gated by zoom: show them whenever they fit without
  // colliding with other markers/labels, including at zoomed-out levels.
  const mapRect = $('map').getBoundingClientRect();
  const barRect = visibleBottomBarEl()?.getBoundingClientRect();
  const candidates = [];

  const collect = (m, priority) => {
    const el = m.getElement?.();
    if (!el) return;
    el.classList.remove('show-name');
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
    if (replayFocusMarker) collect(replayFocusMarker, 5);
  } else {
    const focusAddr = activeMapFocusAddress();
    for (const m of markers.values()) {
      const a = m._data;
      if (!a) continue;
      const priority = (isEmergency(a) ? 4 : 0) + (selectedTracks.has(a.address) ? 2 : 0) +
        (pinnedAircraft.has(a.address) ? 1 : 0) + (focusAddr === a.address ? 8 : 0);
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
  const positionRow = `<div class="popup-value popup-full"><span>Position</span><br><a href="${mapsUrl}" target="_blank" rel="noopener noreferrer" style="color:var(--accent);font-weight:700;text-decoration:underline">${esc(posText)}</a></div>`;
  const statusText = getDisplayStatus(a);
  const wxText = formatWeatherHtml(a.weather, false);
  const weatherRow = wxText
    ? `<div class="popup-value popup-full"><span>Weather</span><br><b>${wxText}</b></div>`
    : '';
  const ageSec = Math.max(0, Math.floor((serverNow() - a.receivedAtMs) / 1000));
  const lastSeenMs = Number.isFinite(a.receivedAtMs) && a.receivedAtMs > 0
    ? a.receivedAtMs
    : (Number.isFinite(Number(a.aprsReceivedAt)) ? Number(a.aprsReceivedAt) * 1000 : 0);
  const localClock = lastSeenMs ? formatClockAtZone(lastSeenMs)
    : (typeof a.aprsReceivedAt === 'string' ? a.aprsReceivedAt : '');
  const lastSeenClock = lastSeenClockText(lastSeenMs, a.lat, a.lon, localClock);
  const lastSeenText = lastSeenClock ? `${lastSeenClock} (${fmtAge(ageSec)})` : fmtAge(ageSec);
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
    ? `<details class="popup-details" data-popup-details="1"><summary>Details & raw packet</summary><div class="popup-grid">${detailRows}</div>${rawSection}</details>`
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
    `<div class="popup-value popup-full popup-last-seen"><span>Last seen</span><b>${esc(lastSeenText)}</b></div>`,
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

function refreshOpenPopupForAddress(address) {
  const m = markers.get(address) || searchResultMarkers.get(address);
  if (!m || !m.isPopupOpen()) return;
  const html = popup(m._data);
  if (m._popupSig === html) return;
  m._popupSig = html;
  m.setPopupContent(html);
  if (m._trackerMarker) keepOpenPopupAboveBar(m);
  else if (isFocusedMapMarker(m)) requestAnimationFrame(() => centerFocusedPopupInView(m));
  else requestAnimationFrame(() => centerPopupInView(m));
}

function refreshOpenSoundingPopups() {
  for (const p of openPopups) {
    const address = p?._source?._data?.address;
    if (address && selectedTracks.has(address)) refreshOpenPopupForAddress(address);
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
    const color = a.snr >= 25 ? THEME.accent : a.snr >= 12 ? THEME.yellow : THEME.red;
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

function matchesSelectedTypes(a, selectedTypes) {
  if (!selectedTypes) return true;
  const rType = getResolvedType(a);
  return (selectedTypes.has('glider') && rType === 1) ||
    (selectedTypes.has('hang') && rType === 6) ||
    (selectedTypes.has('para') && rType === 7) ||
    (selectedTypes.has('fanet') && isFanet(a) && rType !== 15) ||
    (selectedTypes.has('other') && rType !== 1 && rType !== 6 && rType !== 7 && rType !== 15) ||
    (selectedTypes.has('station') && rType === 15) ||
    (selectedTypes.has('wx') && Boolean(a.weather));
}

function aircraftSearchTokens(q) {
  return String(q || '').trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 12);
}

function aircraftSearchText(a) {
  const values = [displayName(a), a.streamName, a.callsign, a.registration,
    a.model, typeName(a), a.id, a.ognId, a.ddbId, a.address, a.liveLabel];
  for (const key of [a.address, a.ddbId, a.id, a.ognId]) {
    const cached = nameCache.get(String(key || '').trim().toLowerCase());
    if (cached) values.push(cached);
  }
  return values.filter(Boolean).map(v => String(v).toLowerCase()).join(' ');
}

function matchesAircraftSearch(a, q) {
  const tokens = aircraftSearchTokens(q);
  if (!tokens.length) return true;
  const text = aircraftSearchText(a);
  return tokens.every(token => text.includes(token));
}

function clearHashSelectionBypass() {
  // A shared/bookmarked aircraft is honored only until the user changes the
  // search or type filters. After that it must obey the same rules as everything
  // else, including last-known cache entries.
  pendingHashSelect = null;
  hashSelectAddress = null;
}

function filtered() {
  const q = $('search').value.trim().toLowerCase();
  const selectedTypes = getSelectedTypes();
  const hashBypass = pendingHashSelect && !q ? pendingHashSelect : null;
  const searchBypass = q ? null : oneTimeSearchBypass;
  return aircraft.filter(a => {
    if (a.address === hashBypass || searchBypass?.has(a.address)) return true;
    if (!matchesAircraftSearch(a, q)) return false;
    // An explicit search should find the aircraft even when its type is
    // unchecked in the preference filter; emergencies always stay visible.
    if (isEmergency(a) || q) return true;
    return matchesSelectedTypes(a, selectedTypes);
  });
}

function hasViewportSearchMatches(visible = null, bounds = null) {
  const rows = visible || filtered();
  const b = bounds || currentBounds();
  return rows.some(a => isInCurrentViewport(a.lat, a.lon, b, a.altitude));
}

function clearSearch24h() {
  search24hSeq++;
  search24hResults = [];
  for (const m of searchResultMarkers.values()) {
    forgetPopupForMarker(m);
    searchResultGroup.removeLayer(m);
  }
  searchResultMarkers.clear();
}

async function fetchSearch24h(q) {
  const key = q.trim().toLowerCase();
  const seq = ++search24hSeq;
  if (!key) { search24hResults = []; render(); return; }
  try {
    const res = await fetch(`ogn-proxy.php?search=1&q=${encodeURIComponent(key)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error('24h search failed');
    const data = await res.json();
    if (seq !== search24hSeq || $('search').value.trim().toLowerCase() !== key) return;
    search24hResults = (Array.isArray(data.results) ? data.results : []).map(r => {
      const a = parseAprsLine(String(r.raw || ''), (Number(r.timestamp) || 0) * 1000);
      if (!a || a.__telemetryOnly || !Number.isFinite(a.lat) || !Number.isFinite(a.lon)) return null;
      a.aprsPacket = String(r.raw || '');
      a.aprsReceivedAt = Number(r.timestamp) || 0;
      if (r.name) a.streamName = cleanName(r.name);
      if (r.callsign) a.callsign = String(r.callsign);
      if (r.registration) a.registration = String(r.registration);
      if (r.model) a.model = String(r.model);
      if (r.aircraft_type !== '') a.ddbAircraftType = String(r.aircraft_type);
      a.search24h = true;
      applyCachedAircraftMeta(a);
      return a;
    }).filter(Boolean);
    render();
  } catch (e) {
    if (seq === search24hSeq) { search24hResults = []; render(); }
  }
}

// Live packets and the 24h search can describe the same device under different
// relay IDs (FNT<hex> vs the callsign). Group by 24-bit hex when available so
// the list and marker layer show one aircraft per device.
function deviceGroupKey(a) {
  if (a.ddbId && /^[0-9a-f]{6}$/i.test(a.ddbId)) return 'hex:' + a.ddbId.toLowerCase();
  if (a.address && /^[0-9a-f]{6}$/i.test(a.address)) return 'hex:' + a.address.toLowerCase();
  return 'id:' + String(a.address || '').toLowerCase();
}

function effectiveSearch24hResults() {
  const liveByKey = new Map();
  for (const a of aircraft) {
    const key = deviceGroupKey(a);
    const prev = liveByKey.get(key);
    if (!prev || (a.receivedAtMs || 0) >= (prev.receivedAtMs || 0)) liveByKey.set(key, a);
  }
  return search24hResults.filter(r => {
    const live = liveByKey.get(deviceGroupKey(r));
    return !live || (Number(r.receivedAtMs) || 0) > (Number(live.receivedAtMs) || 0);
  });
}

function findAircraftByAddress(address) {
  return aircraft.find(x => x.address === address) ||
    effectiveSearch24hResults().find(x => x.address === address) || null;
}

function ensureSearchResultMarker(a) {
  if (!a || !Number.isFinite(a.lat) || !Number.isFinite(a.lon)) return null;
  let m = searchResultMarkers.get(a.address);
  if (!m) {
    m = L.marker([a.lat, a.lon], { icon: markerIcon(a), zIndexOffset: 1000 });
    m._searchResult = true;
    m._data = a;
    m._detailsOpen = false;
    m._popupSig = '';
    m.on('click', e => {
      if (measureMode) {
        if (e && typeof e.originalEvent !== 'undefined') L.DomEvent.stopPropagation(e.originalEvent);
        const data = m._data || a;
        const lat = Number.isFinite(data.lat) ? data.lat : m.getLatLng().lat;
        const lon = Number.isFinite(data.lon) ? data.lon : m.getLatLng().lng;
        addMeasurePoint(lat, lon);
        return;
      }
      toggleSelection(a.address, false);
    });
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
      requestAnimationFrame(() => {
        if (isFocusedMapMarker(m)) centerFocusedPopupInView(m);
        else centerPopupInView(m);
      });
    });
    recenterFocusedMarkerOnClose(m);
    m.bindPopup(() => popup(m._data), { ...POPUP_OPTIONS, maxWidth: 360, autoPan: false, keepInView: false });
    setMeasurePopupDetached(m, measureMode);
    searchResultGroup.addLayer(m);
    searchResultMarkers.set(a.address, m);
  } else {
    m._data = a;
    if (m.getLatLng().lat !== a.lat || m.getLatLng().lng !== a.lon) m.setLatLng([a.lat, a.lon]);
    m.setIcon(markerIcon(a));
  }
  return m;
}

// Age text is refreshed by the 1s ticker, so it is deliberately not part of
// this signature. Including wall-clock age would rebuild every row on each
// render even when the underlying aircraft data has not changed.
function rowSignature(a) {
  const track = selectedTracks.get(a.address);
  const rType = getResolvedType(a);
  const statusText = getDisplayStatus(a);
  const rxStats = rType === 15 ? getStationReceptionStats(a) : null;
  return [
    a.address, displayName(a), displayRegistration(a), displayModel(a), typeName(a),
    rType, isEmergency(a) ? 1 : 0, a.altitude ?? '', a.speed ?? '', a.climb ?? '', a.snr ?? '',
    statusText, statusColor(a, statusText),
    track ? track.color : '', pinnedAircraft.has(a.address) ? 1 : 0,
    followedAddress === a.address ? 1 : 0,
    !replayActive && activeMapFocusAddress() === a.address ? 1 : 0,
    rxStats ? rxStats.count : '',
    a.weather ? JSON.stringify(a.weather) : '',
    a.receivedAtMs,
  ].join('\u0001');
}

function buildRowHtml(a, now) {
  const ageSec = Math.max(0, Math.floor((now - a.receivedAtMs) / 1000));
  const trackEntry = selectedTracks.get(a.address);
  const isSelected = trackEntry ? ' selected' : '';
  const isFocused = !replayActive && activeMapFocusAddress() === a.address;
  const focusedClass = isFocused ? ' focused' : '';
  const isPinned = pinnedAircraft.has(a.address);
  const pinnedClass = isPinned ? ' pinned' : '';
  const emergClass = isEmergency(a) ? ' emergency' : '';
  const rType = getResolvedType(a);
  const statusText = getDisplayStatus(a);
  const statusColorValue = statusColor(a, statusText);
  const stripeColor = typeStripeColor(a);

  const wxCompactHtml = a.weather ? formatWeatherHtml(a.weather, true) : '';
  const metrics = rType === 15
    ? []
    : [a.speed != null ? fmtWindSpeed(a.speed) : '', a.climb != null ? fmtClimb(a.climb) : ''].filter(Boolean);
  const wxListHtml = wxCompactHtml ? `<span class="wx-line">💨 ${wxCompactHtml}</span>` : '';
  const metricsHtml = metrics.length ? `<br>${metrics.join(' · ')}` : '';
  const statusHtml = statusText ? `<br><span style="color:${statusColorValue};font-weight:600">${esc(statusText)}</span>` : '';
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
    const name = esc(displayName(a));
    rightColHtml += `<button type="button" class="follow-btn${isFollowed ? ' active' : ''}" data-follow="${esc(a.address)}" title="${isFollowed ? 'Unfollow' : 'Follow'} ${name}" aria-pressed="${isFollowed}">${isFollowed ? '◎ Unfollow' : '◎ Follow'}</button>`;
  }

  const label = `${displayName(a)} ${statusText ? '- ' + statusText : ''}`.trim();
  return `<div class="aircraft${emergClass}${pinnedClass}${isSelected}${focusedClass}" data-key="${esc(a.address)}" tabindex="0" role="option" aria-selected="${trackEntry ? 'true' : 'false'}" aria-label="${esc(label)}">
    <div class="stripe" style="background:${stripeColor}" title="${esc(typeName(a))}"></div><div><div class="callsign">${trackDotHtml}${esc(displayName(a))}<button type="button" class="pin-btn${pinnedClass}" data-pin="${esc(a.address)}" title="${isPinned ? 'Unpin' : 'Pin to top'}" aria-label="${isPinned ? 'Unpin' : 'Pin to top'} ${esc(displayName(a))}" aria-pressed="${isPinned ? 'true' : 'false'}">📌</button></div>
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

function updateListHint(visible = null, bounds = null) {
  const hint = $('listHint');
  const q = $('search').value.trim();
  const rows = visible || filtered();
  const b = bounds || currentBounds();
  const visibleKeys = new Set(rows.map(a => a.address));
  const hiddenTracks = [...selectedTracks.keys()].filter(k => !visibleKeys.has(k));
  const outsideCount = rows.reduce((n, a) => n + (isInCurrentViewport(a.lat, a.lon, b, a.altitude) ? 0 : 1), 0);
  const parts = [];
  if (q) parts.push(`Filtering by "${q}". Tracks are kept; hidden tracks may not be in list.`);
  const search24hCount = q ? effectiveSearch24hResults().length : 0;
  if (q && !hasViewportSearchMatches(rows, b) && search24hCount) {
    parts.push(`No matches in the current view; showing ${search24hCount} aircraft seen in the last 24 hours.`);
  }
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
  const consumedSearchBypass = new Set(oneTimeSearchBypass);
  const visible = filtered();
  const bounds = currentBounds();
  const viewportList = visible.filter(a => isInCurrentViewport(a.lat, a.lon, bounds, a.altitude));
  const searchQ = $('search').value.trim();
  const search24h = searchQ ? effectiveSearch24hResults() : [];
  const useSearch24h = viewportList.length === 0 && search24h.length > 0;
  // The 24h fallback is already driven by the search term, so do not hide its
  // results because of the type preference filter.
  const listVisible = useSearch24h ? search24h.slice() : viewportList;
  const keep = new Set(visible.map(a => a.address));
  const now = serverNow();

  render24hAlertsSummary(now);
  updateListHint(visible, bounds);

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
        forgetPopupForMarker(m);
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
    const focusedLive = !replayActive && activeMapFocusAddress() === key;
    const iconSig = `${getResolvedType(a)}_${a.course ?? ''}_${emerg ? 1 : 0}_${trackColor}_${displayName(a)}` +
      (focusedLive ? `_focus_${liveFocusHudText(a)}` : '');
    let m = markers.get(key);

    if (!m) {
      if (isSpiderfied && !emerg) return;
      m = L.marker([a.lat, a.lon], { icon: markerIcon(a), zIndexOffset: emerg ? 1000 : (focusedLive ? 900 : 0) });
      m._iconSig = iconSig; m._isEmergency = emerg; m._trueLat = a.lat; m._trueLon = a.lon; m._data = a; m._trackerMarker = true;
      m.on('click', e => {
        if (measureMode) {
          if (e && typeof e.originalEvent !== 'undefined') L.DomEvent.stopPropagation(e.originalEvent);
          const data = m._data || a;
          const lat = Number.isFinite(data.lat) ? data.lat : m.getLatLng().lat;
          const lon = Number.isFinite(data.lon) ? data.lon : m.getLatLng().lng;
          addMeasurePoint(lat, lon);
          return;
        }
        toggleSelection(key, false);
      });
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
        requestAnimationFrame(() => {
        if (isFocusedMapMarker(m)) centerFocusedPopupInView(m);
        else centerPopupInView(m);
      });
      });
      recenterFocusedMarkerOnClose(m);
      m.bindPopup(() => popup(m._data), { ...POPUP_OPTIONS, maxWidth: 360, autoPan: false, keepInView: false });
      setMeasurePopupDetached(m, measureMode);
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
          const cutoffSec = trackWindowCutoffSec(now);
          while (trackEntry.points.length > LIVE_TRACK_MAX_POINTS ||
                 (trackEntry.points.length > 1 && Number(trackEntry.points[0][3] || 0) < cutoffSec)) {
            trackEntry.points.shift();
          }
          if (trackEntry.layer) map.removeLayer(trackEntry.layer);
          trackEntry.layer = buildTrackLayer(trackEntry.points, trackEntry.color);
          if (trackEntry.layer) trackEntry.layer.addTo(map);
          sync3DTracks();
          syncVarioLegend();
        }
      }
      if (!isSpiderfied && m._isEmergency !== emerg) {
        if (m._isEmergency) { emergencyGroup.removeLayer(m); clusterGroup.addLayer(m); }
        else { clusterGroup.removeLayer(m); emergencyGroup.addLayer(m); }
        m._isEmergency = emerg;
      }
      if ((!isSpiderfied || m._isEmergency) && m._iconSig !== iconSig) {
        m.setIcon(markerIcon(a)); m.setZIndexOffset(emerg ? 1000 : (focusedLive ? 900 : 0)); m._iconSig = iconSig;
      }
      refreshMarkerPopup(key, a);
    }

    if (followedAddress === key) centerOnFollowed();
  });

  updateCoverageLayer();
  sync3DLive(visible);
  $('listCount').textContent = listVisible.length;

  const byName = (a, b) =>
    displayName(a).localeCompare(displayName(b), undefined, { sensitivity: 'base', numeric: true });
  const sorted = listVisible.slice().sort((a, b) => {
    // Emergency rows stay first. The focused/followed aircraft comes next,
    // followed by aircraft with an active track; pinned rows and the selected
    // sort only order the remaining rows (and rows within each group).
    const ea = isEmergency(a) ? 1 : 0, eb = isEmergency(b) ? 1 : 0;
    if (ea !== eb) return eb - ea;
    const focusAddr = activeMapFocusAddress();
    const fa = focusAddr === a.address ? 1 : 0, fb = focusAddr === b.address ? 1 : 0;
    if (fa !== fb) return fb - fa;
    const ta = selectedTracks.has(a.address) ? 1 : 0, tb = selectedTracks.has(b.address) ? 1 : 0;
    if (ta !== tb) return tb - ta;
    const pa = pinnedAircraft.has(a.address) ? 1 : 0, pb = pinnedAircraft.has(b.address) ? 1 : 0;
    if (pa !== pb) return pb - pa;
    if (listSort === 'type') {
      const typeCmp = typeName(a).localeCompare(typeName(b), undefined, { sensitivity: 'base', numeric: true });
      if (typeCmp) return typeCmp;
      return byName(a, b);
    }
    if (listSort === 'climb') {
      const climbValue = x => {
        if (x.climb == null) return null;
        const v = Number(x.climb);
        return Number.isFinite(v) ? v : null;
      };
      const ca = climbValue(a), cb = climbValue(b);
      if (ca === null && cb !== null) return 1;
      if (cb === null && ca !== null) return -1;
      if (ca !== null && cb !== null && ca !== cb) return cb - ca;
      return byName(a, b);
    }
    if (listSort === 'latest') {
      const byLatest = (Number(b.receivedAtMs) || 0) - (Number(a.receivedAtMs) || 0);
      return byLatest || byName(a, b);
    }
    return byName(a, b);
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
      const sig = rowSignature(a);
      let row = existingMap.get(key);
      if (row) {
        // Age is refreshed in place by the 1s ticker, so an unchanged signature
        // means we can skip both HTML serialization and DOM replacement here.
        if (row.dataset.rowSig !== sig) {
          const tmp = document.createElement('div');
          tmp.innerHTML = buildRowHtml(a, now);
          const fresh = tmp.firstElementChild;
          fresh.dataset.rowSig = sig;
          row.replaceWith(fresh);
          row = fresh;
        }
        existingMap.delete(key);
      } else {
        const tmp = document.createElement('div');
        tmp.innerHTML = buildRowHtml(a, now);
        row = tmp.firstElementChild;
        row.dataset.rowSig = sig;
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

  for (const [addr, m] of searchResultMarkers) {
    if (markers.has(addr)) {
      searchResultGroup.removeLayer(m);
      searchResultMarkers.delete(addr);
    }
  }

  if (pendingHashSelect && markers.has(pendingHashSelect)) {
    const target = pendingHashSelect;
    pendingHashSelect = null;
    toggleSelection(target, true);
  }
  for (const addr of consumedSearchBypass) oneTimeSearchBypass.delete(addr);
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
    else if (act === 'clear-search') { $('search').value = ''; updateSearchUi(); clearSearch24h(); render(); }
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
    revealMapForListAction();
    return;
  }
  const row = e.target.closest('.aircraft');
  if (row) {
    if ($('search').value.trim()) oneTimeSearchBypass.add(row.dataset.key);
    toggleSelection(row.dataset.key, true);
  }
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
      revealMapForListAction();
      return;
    }
    e.preventDefault();
    if ($('search').value.trim()) oneTimeSearchBypass.add(row.dataset.key);
    toggleSelection(row.dataset.key, true);
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const rows = [...$('aircraftList').querySelectorAll('.aircraft[data-key]')];
    const idx = rows.indexOf(row);
    if (idx === -1) return;
    const next = rows[e.key === 'ArrowDown' ? idx + 1 : idx - 1];
    if (next) next.focus();
  } else if (row.contains(e.target) && (e.key === 'f' || e.key === 'F')) {
    e.preventDefault();
    e.stopPropagation();
    toggleFollow(row.dataset.key);
    revealMapForListAction();
  } else if (row.contains(e.target) && (e.key === 'c' || e.key === 'C')) {
    e.preventDefault();
    e.stopPropagation();
    const a = findAircraftByAddress(row.dataset.key);
    if (!a || !Number.isFinite(a.lat) || !Number.isFinite(a.lon)) return;
    copyTextToClipboard(
      e.shiftKey ? buildSarText(a) : `${a.lat.toFixed(6)}, ${a.lon.toFixed(6)}`,
      e.shiftKey ? 'SAR info copied' : 'Coordinates copied'
    );
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
    clear3DReplayFollowMarkers();
    replayOnlyFocus = true;
    replayDirection = 1;
    followCenteringPaused = false;
    syncReplayDirectionButton();
    syncRecenterButton();
    $('replaySlider').value = '0';
    lastReplayScrubValue = null;
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
    const txt = buildSarText(a);
    navigator.clipboard.writeText(txt).then(() => { btn.textContent = '✓ Copied'; setTimeout(() => { btn.textContent = '📋 SAR'; }, 1500); }).catch(() => copyTextToClipboard(txt, 'SAR copied'));
  } else if (act === 'igc') {
    // Export always uses the full 24h fix history, independent of the map's
    // current track window and thinning.
    downloadIgc(addr);
  }
});

let lastThermalBoundsKey = '';

function thermalNormLon(lon) {
  let v = lon % 360;
  if (v < -180) v += 360;
  if (v > 180) v -= 360;
  return v;
}

// Mirror ogn-proxy.php parse_bounds() so panning inside the same 0.1° cell
// doesn't trigger another request.
function thermalParamsForBounds(b) {
  const south = Math.max(-90, Math.min(90, Math.floor(b.getSouth() * 10) / 10));
  const north = Math.max(-90, Math.min(90, Math.ceil(b.getNorth() * 10) / 10));
  const rawWest = b.getWest(), rawEast = b.getEast();
  const wRaw = Math.floor(rawWest * 10) / 10;
  const eRaw = Math.ceil(rawEast * 10) / 10;
  const fullWorld = (rawEast - rawWest) >= 360 || (eRaw - wRaw) >= 360;
  let west, east;
  if (fullWorld) {
    west = -180; east = 180;
  } else if (eRaw < wRaw) {
    const viaEast = (eRaw + 360) - wRaw;
    const viaWest = wRaw - eRaw;
    if (viaWest < viaEast) {
      west = thermalNormLon(eRaw); east = thermalNormLon(wRaw);
    } else {
      west = thermalNormLon(wRaw); east = thermalNormLon(eRaw + 360);
    }
  } else {
    west = thermalNormLon(wRaw); east = thermalNormLon(eRaw);
  }
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
      const pts = Array.isArray(data.points) ? data.points : [];
      thermalLayer.setLatLngs(pts);
      sync3DThermals(pts);
    }
  } catch (e) {}
}

map.on('overlayadd', e => {
  if (e.layer === thermalLayer) fetchThermals(true);
  if (e.layer === coverageLayer) updateCoverageLayer();
  if (e.layer === airspaceLayer) sync3DAirspace();
});

map.on('overlayremove', e => {
  if (e.layer === thermalLayer) { lastThermalBoundsKey = ''; sync3DThermals([]); }
  if (e.layer === airspaceLayer) sync3DAirspace();
});

setInterval(() => fetchThermals(true), 600000);

// Wind aloft sounding: 0.2° snapped bounds mirror ogn-proxy.php's cache key so
// small pans reuse the same payload instead of starting another query.
function soundingParamsForBounds(b) {
  const step = 5;
  const south = Math.max(-90, Math.min(90, Math.floor(b.getSouth() * step) / step));
  const north = Math.max(-90, Math.min(90, Math.ceil(b.getNorth() * step) / step));
  const rawWest = b.getWest(), rawEast = b.getEast();
  const wRaw = Math.floor(rawWest * step) / step;
  const eRaw = Math.ceil(rawEast * step) / step;
  const fullWorld = (rawEast - rawWest) >= 360 || (eRaw - wRaw) >= 360;
  let west, east;
  if (fullWorld) {
    west = -180; east = 180;
  } else if (eRaw < wRaw) {
    const viaEast = (eRaw + 360) - wRaw;
    const viaWest = wRaw - eRaw;
    if (viaWest < viaEast) {
      west = thermalNormLon(eRaw); east = thermalNormLon(wRaw);
    } else {
      west = thermalNormLon(wRaw); east = thermalNormLon(eRaw + 360);
    }
  } else {
    west = thermalNormLon(wRaw); east = thermalNormLon(eRaw);
  }
  return new URLSearchParams({
    sounding: '1',
    south: south.toFixed(1), north: north.toFixed(1),
    west: west.toFixed(1), east: east.toFixed(1)
  });
}

function soundingIsOpen() {
  const panel = $('soundingPanel');
  return !!panel && !panel.hidden;
}

function soundingDataIsFresh(data, key = null) {
  if (!data || data.available === false || data.error) return false;
  const generatedMs = Number(data.generated_at) * 1000;
  if (!Number.isFinite(generatedMs) || Date.now() - generatedMs > 15 * 60 * 1000) return false;
  return key === null || data._key === key;
}

function soundingContextForAircraft(a) {
  if (!a || !Number.isFinite(a.lat) || !Number.isFinite(a.lon)) return null;
  if (!map.getBounds().contains([a.lat, a.lon])) return null;
  const key = soundingParamsForBounds(map.getBounds()).toString();
  if (!soundingDataIsFresh(lastSoundingData, key)) return null;
  const ceiling = Number.isFinite(lastSoundingData.thermal_ceiling_m) ? lastSoundingData.thermal_ceiling_m : null;
  const surface = lastSoundingData.surface || null;
  const cloud = surface && Number.isFinite(surface.lcl_msl_m) ? surface.lcl_msl_m : null;
  if (ceiling === null && cloud === null) return null;
  return { ceiling, cloud };
}

async function maybePrefetchSoundingForPopup(a) {
  if (soundingIsOpen() || !baroEnabled || !selectedTracks.has(a?.address)) return;
  if (!Number.isFinite(a.lat) || !Number.isFinite(a.lon)) return;
  const bounds = map.getBounds();
  if (!bounds.contains([a.lat, a.lon])) return;
  const params = soundingParamsForBounds(bounds);
  const key = params.toString();
  if (soundingDataIsFresh(lastSoundingData, key) || soundingPopupPendingKey === key) return;

  soundingPopupPendingKey = key;
  const seq = ++soundingPopupFetchSeq;
  try {
    const res = await fetch(`ogn-proxy.php?${params}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (seq !== soundingPopupFetchSeq || key !== soundingParamsForBounds(map.getBounds()).toString()) return;
    lastSoundingData = { ...data, _key: key };
    lastSoundingBoundsKey = key;
    soundingRefreshFailed = false;
    lastSoundingSuccessAtMs = Date.now();
    refreshOpenSoundingPopups();
  } catch (e) {
    // Sounding is optional context for the barogram; keep any previous payload.
  } finally {
    if (seq === soundingPopupFetchSeq) soundingPopupPendingKey = '';
  }
}

function updateSoundingUpdated() {
  const el = $('soundingUpdated');
  if (!el) return;
  if (!soundingIsOpen()) { el.textContent = ''; return; }
  if (soundingRefreshFailed && Date.now() - lastSoundingAttemptAtMs < 60000) {
    el.textContent = 'refresh failed · ↻ to retry';
    return;
  }
  if (!lastSoundingSuccessAtMs) { el.textContent = ''; return; }
  const sec = Math.max(0, Math.floor((Date.now() - lastSoundingSuccessAtMs) / 1000));
  el.textContent = `updated ${sec < 60 ? `${sec}s` : fmtAge(sec).replace(' ago', '')} ago`;
}

// Reuse the existing 1s ticker instead of a second interval: opening/closing the
// panel and switching tabs automatically controls when this runs.
function maybeRefreshSounding() {
  if (!soundingIsOpen() || document.hidden || replayActive) { updateSoundingUpdated(); return; }
  if (!lastSoundingAttemptAtMs || Date.now() - lastSoundingAttemptAtMs >= 60000) fetchSounding(true);
  else updateSoundingUpdated();
}

function setSoundingOpen(open) {
  const panel = $('soundingPanel');
  if (!panel) return;
  if (open && mapFilterPanel && !mapFilterPanel.hidden) closeFilterPanel(false);
  panel.hidden = !open;
  if (open) bringToFront(panel);
  if (!open) hideSoundingTip();
  const btn = $('btnSounding');
  if (btn) {
    btn.classList.toggle('active', open);
    btn.setAttribute('aria-pressed', String(open));
  }
  if (open) {
    if (!lastSoundingData) {
      $('soundingBody').innerHTML = '<div class="sounding-empty">Loading sounding…</div>';
    }
    updateSoundingUpdated();
    fetchSounding(true);
  } else {
    updateSoundingUpdated();
  }
}

function soundingWindArrow(deg) {
  if (!Number.isFinite(deg)) return '·';
  const dirs = ['↑','↗','→','↘','↓','↙','←','↖'];
  return dirs[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

function soundingSpeedClass(kmh) {
  if (!Number.isFinite(kmh)) return '';
  return kmh < 20 ? 'weak' : kmh < 40 ? 'mid' : 'strong';
}

// Tooltips are rendered inside the sounding panel instead of as absolutely
// positioned pseudo-elements, so they cannot be clipped by the panel scroll
// area or the map edge on narrow screens.
function showSoundingTip(el) {
  const tip = $('soundingTip');
  if (!tip || !el) return;
  const text = el.getAttribute('data-tip') || '';
  if (!text) {
    tip.hidden = true;
    return;
  }
  tip.textContent = text;
  tip.hidden = false;
}

function hideSoundingTip() {
  const tip = $('soundingTip');
  if (tip) tip.hidden = true;
}

async function fetchSounding(force = false) {
  if (!soundingIsOpen()) return;
  const params = soundingParamsForBounds(map.getBounds());
  const key = params.toString();
  // Do not show the previous valley's profile while a new viewport loads.
  if (lastSoundingData && lastSoundingData._key !== key) lastSoundingData = null;
  if (!force && key === lastSoundingBoundsKey) return;
  lastSoundingBoundsKey = key;

  const seq = (fetchSounding._seq = (fetchSounding._seq || 0) + 1);
  lastSoundingAttemptAtMs = Date.now();
  const refreshBtn = $('soundingRefresh');
  if (refreshBtn) { refreshBtn.classList.add('loading'); refreshBtn.disabled = true; }
  if (!lastSoundingData) {
    $('soundingBody').innerHTML = '<div class="sounding-empty">Loading sounding…</div>';
  }
  try {
    const res = await fetch(`ogn-proxy.php?${params}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (seq !== fetchSounding._seq || !soundingIsOpen()) return;
    lastSoundingData = { ...data, _key: key };
    soundingRefreshFailed = false;
    lastSoundingSuccessAtMs = lastSoundingAttemptAtMs;
    renderSounding();
    refreshOpenSoundingPopups();
  } catch (e) {
    if (seq !== fetchSounding._seq || !soundingIsOpen()) return;
    lastSoundingData = {
      available: false,
      reason: 'Could not load wind aloft right now.',
      layers: []
    };
    soundingRefreshFailed = true;
    renderSounding();
  } finally {
    // A newer refresh may have started while this one was in flight; leave its
    // loading state alone.
    if (seq === fetchSounding._seq && refreshBtn) {
      refreshBtn.classList.remove('loading');
      refreshBtn.disabled = false;
    }
    updateSoundingUpdated();
  }
}

function renderSounding() {
  const body = $('soundingBody');
  if (!body || !soundingIsOpen()) return;
  const data = lastSoundingData;
  if (!data) {
    body.innerHTML = '<div class="sounding-empty">Loading sounding…</div>';
    return;
  }
  if (data.available === false || data.error) {
    body.innerHTML = `<div class="sounding-empty">${esc(data.reason || data.error || 'Wind aloft is unavailable.')}</div>`;
    return;
  }

  const layers = Array.isArray(data.layers) ? data.layers : [];
  const surface = data.surface || null;
  const ceiling = Number.isFinite(data.thermal_ceiling_m) ? data.thermal_ceiling_m : null;
  const pills = [];
  if (ceiling !== null) {
    pills.push(
      `<span class="sounding-pill ceiling has-tip" tabindex="0" ` +
      `data-tip="${esc(SOUNDING_CEILING_TIP)}" ` +
      `aria-label="Thermal top. ${esc(SOUNDING_CEILING_TIP)}">` +
      `Thermal top ≈ ${esc(fmtAltValue(ceiling))}</span>`
    );
  }
  if (surface && Number.isFinite(surface.lcl_agl_m)) {
    const msl = Number.isFinite(surface.lcl_msl_m)
      ? ` / ${esc(fmtAltValue(surface.lcl_msl_m))} MSL` : '';
    pills.push(
      `<span class="sounding-pill cloud has-tip" tabindex="0" ` +
      `data-tip="${esc(SOUNDING_CLOUD_TIP)}" ` +
      `aria-label="Cu base. ${esc(SOUNDING_CLOUD_TIP)}">` +
      `Cu base ≈ ${esc(fmtAltValue(surface.lcl_agl_m))} AGL${msl}</span>`
    );
  }

  const surfaceBits = [];
  if (surface) {
    if (surface.station) surfaceBits.push(esc(surface.station));
    if (Number.isFinite(surface.distance_km)) {
      const d = fmtDistanceKm(surface.distance_km);
      if (d) surfaceBits.push(d);
    }
    const temp = fmtTemp(surface.temp_c);
    if (temp) surfaceBits.push(temp);
    if (Number.isFinite(surface.humidity_pct)) surfaceBits.push(`${Math.round(surface.humidity_pct)}% RH`);
    if (Number.isFinite(surface.wind_dir) && Number.isFinite(surface.wind_kmh)) {
      const spd = fmtWindSpeed(surface.wind_kmh);
      if (spd) surfaceBits.push(`${soundingWindArrow(surface.wind_dir)} ${Math.round(surface.wind_dir)}° from ${spd}`);
    }
  }

  const notes = [];
  if (Number.isFinite(data.generated_at)) {
    const stamp = new Date(data.generated_at * 1000);
    if (!Number.isNaN(stamp.getTime())) {
      notes.push(`Updated ${stamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
    }
  }
  notes.push('From completed circles in the last hour; estimates only.');
  if (!surface) notes.push('No recent station weather in view for cloud base.');

  const layerHtml = layers.length ? layers.map(l => {
    const alt = fmtAltCompact(l.alt_m);
    const dir = Number.isFinite(l.dir_deg) ? Math.round(l.dir_deg) : null;
    const spd = Number.isFinite(l.spd_kmh) ? l.spd_kmh : null;
    const spdText = spd === null ? '—' : fmtWindSpeed(spd);
    const arrow = dir === null ? '·' : soundingWindArrow(dir);
    const dirText = dir === null ? 'Variable' : `${dir}° from`;
    const ac = Math.max(0, Math.round(l.aircraft || 0));
    const samples = Math.max(0, Math.round(l.samples || 0));
    return `<div class="sounding-layer">` +
      `<span class="sounding-alt">${esc(alt)}</span>` +
      `<span class="sounding-arrow">${esc(arrow)}</span>` +
      `<span class="sounding-dir">${esc(dirText)}</span>` +
      `<span class="sounding-spd ${soundingSpeedClass(spd)}">${esc(spdText)}</span>` +
      `<span class="sounding-count">${ac} aircraft · ${samples} turn${samples === 1 ? '' : 's'}</span>` +
      `</div>`;
  }).join('') : `<div class="sounding-empty">${esc(SOUNDING_NO_DATA_MSG)}</div>`;

  body.innerHTML =
    (pills.length ? `<div class="sounding-pills">${pills.join('')}</div>` : '') +
    `<div class="sounding-tip" id="soundingTip" hidden></div>` +
    (surfaceBits.length ? `<div class="sounding-surface">${surfaceBits.join(' · ')}</div>` : '') +
    layerHtml +
    `<div class="sounding-note">${esc(notes.join(' '))}</div>`;
}

const WIDE_VIEW_AREA = 100;
const LIVE_BBOX_PAD_FRACTION = 0.15;
const LIVE_BBOX_PAD_MIN_DEG = 0.08;
const LIVE_BBOX_PAD_MAX_LAT_DEG = 2;
const LIVE_BBOX_PAD_MAX_LON_DEG = 4;
let nextLivePollAtMs = 0;

// Small plain bounds object with the Leaflet getters used by the live fetch.
// Keeping west/east raw preserves the backend's antimeridian convention.
function makeViewBounds(south, north, west, east, source) {
  if (![south, north, west, east].every(Number.isFinite)) return null;
  if (north < south) [south, north] = [north, south];
  south = Math.max(-85, Math.min(85, south));
  north = Math.max(-85, Math.min(85, north));
  let spanLon = east - west;
  if (spanLon < 0) spanLon += 360;
  let centerLng = west + spanLon / 2;
  if (centerLng > 180) centerLng -= 360;
  else if (centerLng < -180) centerLng += 360;
  return {
    source,
    spanLat: Math.max(0, north - south),
    spanLon,
    getSouth: () => south,
    getNorth: () => north,
    getWest: () => west,
    getEast: () => east,
    getCenter: () => ({ lat: (south + north) / 2, lng: centerLng })
  };
}

function padViewBounds(b, source) {
  if (!b) return null;
  let south, north, west, east;
  try {
    south = b.getSouth(); north = b.getNorth();
    west = b.getWest(); east = b.getEast();
  } catch (err) {
    return null;
  }
  if (![south, north, west, east].every(Number.isFinite)) return null;
  const spanLat = Math.max(0, north - south);
  let spanLon = east - west;
  if (spanLon < 0) spanLon += 360;
  const padLat = Math.min(LIVE_BBOX_PAD_MAX_LAT_DEG,
    Math.max(LIVE_BBOX_PAD_MIN_DEG, spanLat * LIVE_BBOX_PAD_FRACTION));
  const padLon = Math.min(LIVE_BBOX_PAD_MAX_LON_DEG,
    Math.max(LIVE_BBOX_PAD_MIN_DEG, spanLon * LIVE_BBOX_PAD_FRACTION));
  return makeViewBounds(south - padLat, north + padLat, west - padLon, east + padLon, source);
}

// In 3D the Leaflet mirror can cover a much larger ground area than the pitched
// MapLibre camera. Poll the padded MapLibre bbox instead, and fall back to the
// Leaflet bbox whenever 3D is inactive, paused, or not ready.
function liveFetchBounds() {
  if (map3d && map3dActive && map3dReady && !map3dPaused) {
    let b = null;
    try { b = map3d.getBounds?.(); } catch (err) {}
    const padded = padViewBounds(b, 'maplibre');
    if (padded) return padded;
  }
  let b = null;
  try { b = map.getBounds(); } catch (err) {}
  if (!b) return null;
  return makeViewBounds(b.getSouth(), b.getNorth(), b.getWest(), b.getEast(), 'leaflet');
}

function currentViewArea() {
  const b = liveFetchBounds();
  if (!b) return WIDE_VIEW_AREA;
  return Math.max(0, b.spanLat) * Math.min(Math.max(0, b.spanLon), 360);
}

function livePollIntervalMs(area) {
  if (area >= 2000) return 20000;
  if (area >= 500) return 10000;
  if (area >= WIDE_VIEW_AREA) return 7000;
  return 5000;
}

function boundsMovedSignificantly(b) {
  if (!b || !lastMetaBounds) return true;
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
    const b = liveFetchBounds();
    if (!b) throw new Error('No view bounds available');
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
            firstTsMs: Number.isFinite(Number(al.first_ts)) && Number(al.first_ts) > 0
              ? Number(al.first_ts) * 1000 : Number(al.ts) * 1000,
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
      if (!knownIds.has(id)) sawUnknown = true;
      knownIds.set(id, nowAttemptMs);
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

    for (const [id, seenMs] of knownIds) {
      if (nowAttemptMs - seenMs > LAST_KNOWN_TTL_MS) knownIds.delete(id);
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
    feedDataUpdatedMs = updatedMs || 0;
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
    out.title = `Replay speed: ${speed}× — tap to cycle 1× / 10× / 20× / 30× / 50×`;
    out.setAttribute('aria-label', `Replay speed: ${speed}×, tap to cycle speeds`);
  }
  for (const id of ['replaySpeedDown', 'replaySpeedUp']) {
    $(id)?.setAttribute('aria-valuetext', `${speed} times normal speed`);
  }
}

function replaySpanMs() {
  return REPLAY_RANGE_MINUTES[replayRangeIndex] * 60000;
}

/** Drop fixes before the first real movement; parked GPS jitter is not a track. */
function trimReplayStationaryStart(points) {
  if (!Array.isArray(points) || points.length < 2) return points || [];
  let streak = 0;
  let streakMeters = 0;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1], cur = points[i];
    const dt = cur[3] - prev[3];
    if (!(dt > 0) || dt > REPLAY_TRACK_GAP_S) break;
    const meters = distMeters(prev[0], prev[1], cur[0], cur[1]);
    const speed = meters / dt;
    if (!Number.isFinite(meters) || speed > REPLAY_MAX_INTERP_SPEED_MS) {
      streak = 0; streakMeters = 0;
      continue;
    }
    if (speed < REPLAY_MOVE_SPEED_MS) {
      streak = 0; streakMeters = 0;
      continue;
    }
    streak++;
    streakMeters += meters;
    if (streak >= REPLAY_MOVE_MIN_LEGS && streakMeters >= REPLAY_MOVE_DISTANCE_M) {
      // Keep the last fix before the sustained moving leg as the launch point.
      return points.slice(i - streak);
    }
  }
  return points;
}

/** Split an aircraft's 24h fixes into distinct tracks on reception gaps. */
function computeReplayTrackSegments(points, trimStationaryStart = false) {
  const valid = (Array.isArray(points) ? points : [])
    .filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[3]))
    .slice()
    .sort((a, b) => a[3] - b[3]);
  const segments = [];
  let current = [];
  const pushSegment = () => {
    if (!current.length) return;
    const pts = trimStationaryStart ? trimReplayStationaryStart(current) : current;
    if (!pts.length) return;
    segments.push({ startTs: pts[0][3], endTs: pts[pts.length - 1][3], points: pts });
  };
  for (const p of valid) {
    if (current.length && p[3] - current[current.length - 1][3] > REPLAY_TRACK_GAP_S) {
      pushSegment();
      current = [];
    }
    current.push(p);
  }
  pushSegment();
  return segments;
}

/** Effective replay bounds: a fixed duration starting at the replay slider's anchor time. */
function replayWindow() {
  const span = replaySpanMs();
  const start = Number.isFinite(replayWindowStartMs) ? replayWindowStartMs : serverNow() - span;
  return { start, end: start + span };
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
  if (replayActive) {
    updateReplayTimeReadout();
    syncBottomBarOffset();
  }
}

/** Move to an adjacent track's first fix, wrapping at either end. */
function jumpToReplayTrack(delta) {
  if (replayTrackSegments.length < 2) return;
  const idx = (currentReplayTrackIndex() + delta + replayTrackSegments.length) % replayTrackSegments.length;
  replayTsMs = replayTrackSegments[idx].startTs * 1000;
  replayWindowStartMs = replayTsMs;
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

function syncReplayTimeToggle() {
  const btn = $('replayTime');
  if (!btn) return;
  btn.disabled = !replayFollowAddress;
  replayTimeReadoutSig = '';
  if (replayActive) updateReplayTimeReadout();
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
  syncReplayTimeToggle();
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
  // Keep the duplicate-event guard armed for the next real user input.
  lastReplayScrubValue = slider.value;
}

function wrapReplayLon(lon) {
  let v = lon % 360;
  if (v < -180) v += 360;
  else if (v > 180) v -= 360;
  return v;
}

/**
 * Interpolate the focused replay aircraft between recorded fixes. The result
 * stays on the segment, never crosses a recording gap or an implausible hop,
 * and takes the short way around the antimeridian.
 */
function interpolateReplayFocusPosition(tsMs) {
  if (!replayFollowAddress || !Number.isFinite(tsMs)) return null;
  const pts = replayTrackPoints;
  const n = pts.length;
  if (!n) return null;
  const metrics = (a, b) => {
    const dt = b[3] - a[3];
    if (!(dt > 0)) return { speed: null, climb: null };
    const meters = distMeters(a[0], a[1], b[0], b[1]);
    return {
      speed: Number.isFinite(meters) ? meters / dt : null,
      climb: (a[2] != null && b[2] != null) ? (b[2] - a[2]) / dt : null
    };
  };
  const at = (p, m) => ({ lat: p[0], lon: p[1], alt: p[2] ?? null, ts: p[3], ...m });
  const endpointMetrics = (a, b) => {
    const m = metrics(a, b);
    if ((b[3] - a[3]) > REPLAY_TRACK_GAP_S || (m.speed != null && m.speed > REPLAY_MAX_INTERP_SPEED_MS)) {
      return { speed: null, climb: null };
    }
    return m;
  };
  const t = tsMs / 1000;
  if (t <= pts[0][3]) return at(pts[0], endpointMetrics(pts[0], pts[1] || pts[0]));
  if (t >= pts[n - 1][3]) return at(pts[n - 1], endpointMetrics(pts[n - 2] || pts[n - 1], pts[n - 1]));

  let lo = 0, hi = n - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1;
    if (pts[mid][3] <= t) lo = mid;
    else hi = mid;
  }
  const p0 = pts[lo], p1 = pts[hi];
  const dt = p1[3] - p0[3];
  const m = metrics(p0, p1);
  if (!(dt > 0) || dt > REPLAY_TRACK_GAP_S) return at(p0, { speed: null, climb: null });
  if (m.speed != null && m.speed > REPLAY_MAX_INTERP_SPEED_MS) return at(p0, { speed: null, climb: null });

  const alpha = (t - p0[3]) / dt;
  const alt = (p0[2] != null && p1[2] != null)
    ? p0[2] + (p1[2] - p0[2]) * alpha
    : (p0[2] ?? p1[2] ?? null);
  return {
    lat: p0[0] + (p1[0] - p0[0]) * alpha,
    lon: wrapReplayLon(p0[1] + wrapReplayLon(p1[1] - p0[1]) * alpha),
    alt,
    ts: t,
    ...m
  };
}

function replayFocusLabel() {
  const a = findAircraftByAddress(replayFollowAddress);
  return a ? displayName(a) : String(replayFollowAddress || '').toUpperCase();
}

function formatReplayClock(sec, compact, tz = null) {
  return new Date(sec * 1000).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: !compact,
    ...(tz ? { timeZone: tz } : {})
  });
}

/** IANA timezone at a lat/lon, cached by rounded position. */
function locationTimeZone(lat, lon) {
  if (typeof tzlookup !== 'function' || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  if (locationTzCache.has(key)) return locationTzCache.get(key) || null;
  let tz = null;
  try { tz = tzlookup(lat, lon) || null; } catch (e) {}
  if (locationTzCache.size > 200) locationTzCache.clear();
  locationTzCache.set(key, tz);
  return tz;
}

function formatClockAtZone(ms, tz = null) {
  return new Date(ms).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    ...(tz ? { timeZone: tz } : {})
  });
}

/** Canonical IANA zone name so aliases (Asia/Kolkata vs Asia/Calcutta) compare equal. */
function canonicalTimeZone(tz) {
  if (!tz) return '';
  try {
    const name = Intl.DateTimeFormat([], { timeZone: tz }).resolvedOptions().timeZone || tz;
    return /^(UTC|Etc\/GMT|Etc\/UTC|GMT)$/i.test(name) ? 'UTC' : name;
  } catch (e) { return tz; }
}

/** Append the regional clock only when the aircraft's zone differs from the browser's. */
function lastSeenClockText(ms, lat, lon, localClock) {
  if (!localClock || !Number.isFinite(ms) || ms <= 0) return localClock || '';
  const tz = locationTimeZone(lat, lon);
  if (!tz) return localClock;
  let browserTz = '';
  try { browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}
  if (canonicalTimeZone(tz) === canonicalTimeZone(browserTz)) return localClock;
  return `${localClock} Local · ${formatClockAtZone(ms, tz)} ${tzShortLabel(tz, ms)}`;
}

/** Position used for the replay clock's regional timezone. */
function replayTimeZonePosition() {
  const pos = interpolateReplayFocusPosition(replayTsMs) || replayFocusFallbackPosition();
  if (pos && Number.isFinite(pos.lat) && Number.isFinite(pos.lon)) return pos;
  const slice = replayPoints.find(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  if (slice) return slice;
  const c = map.getCenter();
  return Number.isFinite(c.lat) && Number.isFinite(c.lng) ? { lat: c.lat, lon: c.lng } : null;
}

function replayTimeZone() {
  // Without a focused aircraft there is no meaningful "trackpoint" position;
  // the whole replay bar then stays on browser local time.
  if (replayTimeMode !== 'track' || !replayFollowAddress) return null;
  const pos = replayTimeZonePosition();
  if (!pos) return null;
  return locationTimeZone(pos.lat, pos.lon);
}

function tzShortLabel(tz, ms = Date.now()) {
  if (!tz) return 'UTC';
  try {
    const parts = new Intl.DateTimeFormat([], { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date(ms));
    const name = parts.find(p => p.type === 'timeZoneName');
    if (name && name.value && name.value.length <= 8) return name.value;
  } catch (e) {}
  return String(tz).split('/').pop().replace(/_/g, ' ');
}

function focusMetricText(speedKmh, climbMps, altM) {
  const parts = [];
  if (Number.isFinite(speedKmh)) parts.push(fmtWindSpeed(speedKmh));
  if (Number.isFinite(climbMps)) parts.push(fmtClimb(climbMps));
  if (Number.isFinite(altM)) parts.push(fmtAltCompact(altM));
  return parts.join(' · ');
}

// Live aircraft already carry km/h; replay trackpoints carry m/s.
function liveFocusHudText(a) {
  if (!a) return '';
  return focusMetricText(
    Number.isFinite(a.speed) ? a.speed : NaN,
    Number.isFinite(a.climb) ? a.climb : NaN,
    Number.isFinite(a.altitude) ? a.altitude : NaN
  );
}

function replayFocusHudText(pos) {
  if (!pos) return '';
  return focusMetricText(
    Number.isFinite(pos.speed) ? pos.speed * 3.6 : NaN,
    Number.isFinite(pos.climb) ? pos.climb : NaN,
    Number.isFinite(pos.alt) ? pos.alt : NaN
  );
}

function focusHudHtml(text) {
  return `<div class="replay-hud focus-hud"><div class="hud-line">${esc(text || '—')}</div></div>`;
}

function replayFocusMetrics(pos) {
  const speed = (pos && pos.speed != null && Number.isFinite(pos.speed))
    ? fmtWindSpeed(pos.speed * 3.6) : '';
  const climb = (pos && pos.climb != null && Number.isFinite(pos.climb))
    ? fmtClimb(pos.climb) : '';
  const alt = (pos && pos.alt != null && Number.isFinite(pos.alt))
    ? fmtAltCompact(pos.alt) : '';
  const ts = pos && Number.isFinite(pos.ts) ? Math.floor(pos.ts) : 0;
  const time = ts ? formatReplayClock(ts, compactReplayUi(), replayTimeZone()) : '';
  return { speed, climb, alt, time };
}

function replayFocusMetricsText(pos) {
  return replayFocusHudText(pos);
}

function applyReplayHud(marker, text) {
  const line = marker.getElement?.()?.querySelector('.hud-line');
  if (line && line.textContent !== text) line.textContent = text || '—';
}

function updateReplayTimeReadout(tsMs = replayTsMs) {
  const sec = Math.floor((tsMs || replayTsFromSlider()) / 1000);
  const compact = compactReplayUi();
  const tz = replayTimeZone();
  const hasFocus = !!replayFollowAddress;
  const track = replayTimeMode === 'track' && hasFocus && !!tz;
  const sig = `${sec}:${compact}:${replayTimeMode}:${hasFocus ? 'focus' : 'nofocus'}:${tz || ''}`;
  if (sig === replayTimeReadoutSig) return;
  replayTimeReadoutSig = sig;
  const label = formatReplayClock(sec, compact, tz);
  $('replayTimeValue').textContent = label;
  $('replayTimeTag').textContent = track
    ? (compact ? 'T' : tzShortLabel(tz, sec * 1000))
    : (compact ? 'L' : 'Local');
  const btn = $('replayTime');
  btn.disabled = !hasFocus;
  btn.classList.toggle('track-time', track);
  if (!hasFocus) {
    const why = 'Trackpoint time needs a focused aircraft';
    btn.setAttribute('aria-label', `Replay time ${label} (browser local). ${why}.`);
    btn.title = `Replay time: ${label} (browser local). ${why}.`;
    return;
  }
  const where = track ? `at ${tz}` : 'browser local';
  const next = track ? 'browser local time' : 'time at the trackpoint location';
  btn.setAttribute('aria-label', `Replay time ${label} (${where}). Click to show ${next}.`);
  btn.title = `Replay time: ${label} (${where}). Click to show ${next}.`;
}

// The replay slice query returns the newest fix in a ±60 s window, which can
// be the *next* trackpoint. Before the full track loads, use that as a fallback
// so the focused aircraft is still represented; once track data exists the
// interpolated position is authoritative.
function replayFocusFallbackPosition() {
  const p = replayPoints.find(x => x.id === replayFollowAddress &&
    Number.isFinite(x.lat) && Number.isFinite(x.lon));
  if (!p) return null;
  return {
    lat: p.lat,
    lon: p.lon,
    alt: p.alt ?? null,
    ts: Number.isFinite(p.ts) ? p.ts : replayTsMs / 1000
  };
}

// The focused aircraft gets its own marker so it can move smoothly even when
// the 1-minute slice has no fix for it yet. replayPoints still carries one
// synthetic entry so centerOnFollowed() can track it.
function updateReplayFocusMarker() {
  if (!replayActive || !replayFollowAddress || !replayTsMs) {
    if (replayFocusMarker) {
      replayFocusGroup.clearLayers();
      replayFocusMarker = null;
    }
    sync3DReplayFocus(null);
    return;
  }
  const pos = interpolateReplayFocusPosition(replayTsMs) || replayFocusFallbackPosition();
  if (!pos) { sync3DReplayFocus(null); return; }
  sync3DReplayFocus(pos);
  const alt = pos.alt != null ? Math.round(pos.alt) : null;
  const ts = Math.floor(pos.ts);
  let entry = replayPoints.find(p => p.id === replayFollowAddress);
  if (entry) {
    entry.lat = pos.lat;
    entry.lon = pos.lon;
    if (alt != null) entry.alt = alt;
    entry.ts = ts;
  } else {
    entry = { id: replayFollowAddress, label: replayFocusLabel(), lat: pos.lat, lon: pos.lon, alt, ts };
    replayPoints.push(entry);
  }

  const label = entry.label || replayFocusLabel();
  const metrics = replayFocusMetrics(pos);
  const metricsText = replayFocusMetricsText(pos);
  const tooltip = `${label}${metricsText ? ' · ' + metricsText : ''}` +
    (metrics.time ? ` · ${metrics.time}` : '');
  const hudSig = metricsText;
  const isNew = !replayFocusMarker;
  if (isNew) {
    replayFocusMarker = L.marker([pos.lat, pos.lon], {
      icon: L.divIcon({
        className: 'glider-icon replay-icon focused',
        html: `<div class="replay-dot focused"></div><div class="glider-label" title="${esc(label)}">` +
          `${esc(label)}</div>${focusHudHtml(metricsText)}`,
        iconSize: [16, 16], iconAnchor: [8, 8]
      }),
      zIndexOffset: 1000
    }).bindTooltip(tooltip);
    replayFocusMarker._replayId = replayFollowAddress;
    replayFocusMarker._tooltipSig = tooltip;
    replayFocusMarker._hudSig = '';
    replayFocusGroup.addLayer(replayFocusMarker);
    applyReplayHud(replayFocusMarker, metricsText);
    replayFocusMarker._hudSig = hudSig;
  } else {
    replayFocusMarker.setLatLng([pos.lat, pos.lon]);
    if (replayFocusMarker._tooltipSig !== tooltip) {
      replayFocusMarker.setTooltipContent(tooltip);
      replayFocusMarker._tooltipSig = tooltip;
    }
    if (replayFocusMarker._hudSig !== hudSig) {
      applyReplayHud(replayFocusMarker, metricsText);
      replayFocusMarker._hudSig = hudSig;
    }
  }
  if (isNew) updateMarkerLabels();
}

function stopReplayPlayback() {
  if (replayRafId !== null) {
    cancelAnimationFrame(replayRafId);
    replayRafId = null;
  }
  replayLastTickMs = 0;
  replayLastPanAtMs = 0;
  $('replayPlay').textContent = '▶';
  $('replayPlay').setAttribute('aria-label', 'Play replay');
}

function startReplayPlayback() {
  if (replayRafId !== null) return;
  replayScrubbing = false;
  if (!replayTsMs) replayTsMs = replayTsFromSlider();
  replayLastTickMs = performance.now();
  $('replayPlay').textContent = '⏸';
  $('replayPlay').setAttribute('aria-label', 'Pause replay');
  const step = wallNow => {
    if (!replayActive || replayRafId === null) return;
    // Clamp so a backgrounded tab does not jump forward by its whole hidden time.
    const elapsedMs = Math.min(250, Math.max(0, wallNow - replayLastTickMs));
    replayLastTickMs = wallNow;
    replayTsMs += elapsedMs * replaySpeed() * replayDirection;
    const { start, end } = replayWindow();
    if (replayTsMs > end) replayTsMs = start;
    else if (replayTsMs < start) replayTsMs = end;
    updateReplaySliderFromTs();
    updateReplayTimeReadout(replayTsMs);
    maybeUpdateReplayTrackLine(wallNow);
    updateReplayFocusMarker();
    syncRecenterButton();
    // Short animated pans keep edge-triggered follow smooth at any zoom; the
    // 200ms throttle avoids a moveend storm on every animation frame.
    if (wallNow - replayLastPanAtMs >= 200) {
      // Replay updates the focus marker every frame. Re-running the terrain
      // alignment loop on every throttled camera update makes the view jitter,
      // so automated replay pans use the already-corrected camera center only.
      centerOnFollowed(false, true, 0.2, false);
      replayLastPanAtMs = wallNow;
    }
    syncReplayTrackUi();
    const minute = Math.floor(replayTsMs / 60000);
    if (minute !== lastReplaySliceMinute) loadReplaySlice();
    replayRafId = requestAnimationFrame(step);
  };
  replayRafId = requestAnimationFrame(step);
}

function replayTrackLayers(points, weight, opacity, dashed = false) {
  if (points.length < 2) return [];
  const pane = trackPaneName();
  if (!varioTrackMode) {
    const color = selectedTracks.get(replayFollowAddress)?.color || THEME.accent;
    return [L.polyline(points.map(p => [p[0], p[1]]), { pane, color, weight, opacity, dashArray: dashed ? '3 6' : null })];
  }
  const layers = [];
  for (let i = 1; i < points.length; i++) {
    const p0 = points[i - 1], p1 = points[i];
    const dt = p1[3] - p0[3];
    const climb = (p0[2] != null && p1[2] != null && dt > 0 && dt < 300) ? (p1[2] - p0[2]) / dt : null;
    layers.push(L.polyline([[p0[0], p0[1]], [p1[0], p1[1]]], {
      pane, color: varioColor(climb), weight, opacity, dashArray: dashed ? '3 6' : null
    }));
  }
  return layers;
}

// Full-resolution fixes drive interpolation; drawing stays capped so vario
// mode does not create one polyline per fix for a 24h track.
function thinReplayPoints(points, max = 1500) {
  if (points.length <= max) return points;
  const step = Math.ceil(points.length / max);
  const out = [];
  for (let i = 0; i < points.length; i += step) out.push(points[i]);
  const last = points[points.length - 1];
  if (out[out.length - 1][3] !== last[3]) out.push(last);
  return out;
}

function replayTrackLineSignature() {
  const color = selectedTracks.get(replayFollowAddress)?.color || THEME.accent;
  const pts = replayTrackPoints;
  const first = pts.length ? pts[0][3] : '';
  const last = pts.length ? pts[pts.length - 1][3] : '';
  return `${varioTrackMode ? 1 : 0}|${color}|${pts.length}|${replayTrackSegments.length}|` +
    `${replayRenderSegments.length}|${first}|${last}`;
}

function clearReplayTrackLayers() {
  replayTrackBaseGroup.clearLayers();
  replayProgressGroup.clearLayers();
  replayTrackLineSig = '';
  replayProgressCutoff = -1;
  replayProgressKey = '';
  sync3DReplayTrack();
  sync3DReplayProgress([]);
  syncVarioLegend();
}

function rebuildReplayTrackBase() {
  replayTrackBaseGroup.clearLayers();
  replayProgressGroup.clearLayers();
  replayProgressCutoff = -1;
  replayProgressKey = '';
  replayTrackLineSig = replayTrackLineSignature();
  if (!replayFollowAddress || !replayTrackPoints.length) {
    syncVarioLegend();
    return;
  }
  const segments = replayRenderSegments;
  for (const seg of segments) {
    const valid = (seg.points || []).filter(p =>
      Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[3]));
    replayTrackLayers(valid, 2, 0.25, true).forEach(l => l.addTo(replayTrackBaseGroup));
  }
  sync3DReplayTrack();
  syncVarioLegend();
}

function replayProgressPoints(valid, focus) {
  const pts = valid.map(p => [p[0], p[1], p[2], p[3]]);
  if (focus && pts.length) {
    const segStart = valid[0][3] * 1000, segEnd = valid[valid.length - 1][3] * 1000;
    if (replayTsMs >= segStart && replayTsMs <= segEnd) {
      pts.push([focus.lat, focus.lon, focus.alt, focus.ts]);
    }
  }
  return pts;
}

function updateReplayProgressLine(wallNow, force = false) {
  if (!replayFollowAddress || !replayTsMs) {
    if (replayProgressCutoff !== -1) {
      replayProgressGroup.clearLayers();
      replayProgressCutoff = -1;
      replayProgressKey = '';
    }
    sync3DReplayProgress([]);
    return;
  }
  // The rAF loop calls this often; geometry is cached and the head is capped at ~10 Hz.
  if (!force && wallNow - replayTrackLineAtMs < 100) return;
  replayTrackLineAtMs = wallNow;
  const segments = replayRenderSegments;
  const focus = interpolateReplayFocusPosition(replayTsMs);
  let cutoffTotal = 0;
  const perSegment = [];
  for (const seg of segments) {
    const valid = (seg.points || []).filter(p =>
      Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[3]));
    let lo = 0, hi = valid.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (valid[mid][3] * 1000 <= replayTsMs) lo = mid + 1;
      else hi = mid;
    }
    cutoffTotal += lo;
    perSegment.push(replayProgressPoints(valid.slice(0, lo), focus));
  }
  const focusKey = focus ? `${focus.lat.toFixed(5)},${focus.lon.toFixed(5)}` : '';
  const key = `${replayTrackLineSig}|${cutoffTotal}|${focusKey}`;
  if (key === replayProgressKey) return;
  replayProgressKey = key;
  replayProgressCutoff = cutoffTotal;
  sync3DReplayProgress(perSegment);
  replayProgressGroup.clearLayers();
  for (const pts of perSegment) {
    replayTrackLayers(pts, 3, 0.9).forEach(l => l.addTo(replayProgressGroup));
  }
}

/** Full rebuild for non-animated callers. The rAF loop uses updateReplayTrackLine(false). */
function updateReplayTrackLine(force = true) {
  const sig = replayTrackLineSignature();
  if (sig !== replayTrackLineSig) rebuildReplayTrackBase();
  updateReplayProgressLine(performance.now(), force);
}

function maybeUpdateReplayTrackLine(wallNow) {
  const sig = replayTrackLineSignature();
  if (sig !== replayTrackLineSig) {
    rebuildReplayTrackBase();
    updateReplayProgressLine(wallNow, true);
    return;
  }
  updateReplayProgressLine(wallNow);
}

async function loadReplayTrack() {
  replayTrackPoints = [];
  replayTrackSegments = [];
  replayRenderSegments = [];
  clearReplayTrackLayers();
  syncReplayTrackUi();
  if (!replayFollowAddress) return;
  // Always load the full 24h so every distinct track is available, regardless
  // of the replay window selected with the range button.
  const since = Math.floor(serverNow() / 1000) - 86400;
  const params = new URLSearchParams({ track: '1', id: replayFollowAddress, since: String(since), full: '1' });
  const seq = ++replayTrackSeq;
  try {
    const res = await fetch(`ogn-proxy.php?${params}`);
    if (!res.ok || seq !== replayTrackSeq) return;
    const data = await res.json();
    if (seq !== replayTrackSeq) return;
    const fixes = (Array.isArray(data.points) ? data.points : [])
      .filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[3]))
      .slice()
      .sort((a, b) => a[3] - b[3]);
    replayTrackSegments = computeReplayTrackSegments(fixes, true);
    replayTrackPoints = replayTrackSegments.flatMap(s => s.points);
    replayRenderSegments = computeReplayTrackSegments(thinReplayPoints(replayTrackPoints));
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
  updateReplayTimeReadout(ts * 1000);
  updateReplayProgressLine(performance.now(), true);
  const seq = ++replaySliceSeq;
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
    if (!res.ok || seq !== replaySliceSeq || !replayActive) return;
    const data = await res.json();
    if (seq !== replaySliceSeq || !replayActive) return;
    replayGroup.clearLayers();
    const points = data.aircraft || [];
    replayPoints = points;
    points.forEach(p => {
      // The slice can contain a future fix (query window is ts ±60 s). The
      // focused aircraft is drawn only by the interpolated focus marker.
      if (hasFocus && p.id === replayFollowAddress) return;
      const name = esc(p.label);
      const marker = L.marker([p.lat, p.lon], {
        icon: L.divIcon({
          className: 'glider-icon replay-icon',
          html: `<div class="replay-dot"></div><div class="glider-label" title="${name}">${name}</div>`,
          iconSize: [16, 16], iconAnchor: [8, 8]
        })
      }).bindTooltip(`${p.label}${p.alt != null ? ' · ' + fmtAlt(p.alt) : ''}${p.ts ? ' · ' + new Date(p.ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}`);
      marker._replayId = p.id;
      marker.addTo(replayGroup);
    });
    updateMarkerLabels();
    updateReplayFocusMarker();
    sync3DReplayPoints();
    if (hasFocus) centerOnFollowed(false, true, 0.2, false);
  } catch (e) {}
}

function setReplayMode(on, opts = {}) {
  replayActive = on;
  // Replay owns its own focused marker; do not restore a stale list selection.
  mapFocusAddress = null;
  renderFeedStatusBanner();
  $('btnReplay').classList.toggle('active', on);
  $('btnReplay').setAttribute('aria-pressed', String(on));
  $('replayBar').classList.toggle('show', on);
  if (on) bringToFront($('replayBar'));
  syncBottomBarOffset();
  if (on) {
    // Start each replay session at the currently selected Active window.
    replayRangeIndex = replayRangeIndexForActiveWindow($('markerWindow').value);
    syncReplayRangeButton();
    map.removeLayer(clusterGroup); map.removeLayer(emergencyGroup);
    replayTrackGroup.addLayer(replayTrackBaseGroup).addLayer(replayProgressGroup);
    replayTrackGroup.addTo(map);
    replayGroup.addTo(map);
    replayFocusGroup.addTo(map);
    replayTsMs = replayTsFromSlider();
    syncReplayFollowLabel();
    replayTrackPromise = loadReplayTrack();
    if (opts.startAtTrackStart && replayFollowAddress) {
      // Wait for the 24h track so playback begins at the aircraft's first fix
      // (earliest point of its first track), not at the window boundary.
      replayTrackPromise.then(() => {
        if (replayTrackSegments.length) {
          replayTsMs = replayTrackSegments[0].startTs * 1000;
          replayWindowStartMs = replayTsMs;
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
    replayWindowStartMs = null;
    lastReplaySliceMinute = null;
    replayFollowAddress = null;
    clear3DReplayFollowMarkers();
    replayPoints = [];
    replayOnlyFocus = false;
    replayDirection = 1;
    followCenteringPaused = false;
    syncReplayDirectionButton();
    syncReplayFollowLabel();
    syncRecenterButton();
    replayTrackGroup.clearLayers();
    clearReplayTrackLayers();
    map.removeLayer(replayGroup); replayGroup.clearLayers();
    map.removeLayer(replayFocusGroup); replayFocusGroup.clearLayers(); replayFocusMarker = null;
    map.removeLayer(replayTrackGroup);
    replayTrackPoints = [];
    replayTrackSegments = [];
    replayRenderSegments = [];
    replayTrackPromise = null;
    syncReplayTrackUi();
    clusterGroup.addTo(map); emergencyGroup.addTo(map);
    fetchLive(true);
  }
  sync3DReplayMode(on);
  syncVarioLegend();
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
    else { fetchLive(true); fetchThermals(); fetchSounding(); }
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
    const q = $('search').value.trim();
    clearHashSelectionBypass();
    render();
    if (!q) {
      clearSearch24h();
      render();
      return;
    }
    if (hasViewportSearchMatches()) {
      if (search24hResults.length) { clearSearch24h(); render(); }
    } else {
      fetchSearch24h(q);
    }
  }, 120);
});
$('btnClearSearch').addEventListener('click', () => {
  $('search').value = '';
  clearHashSelectionBypass();
  updateSearchUi();
  clearSearch24h();
  $('listHint').textContent = '';
  render();
  $('search').focus();
});
$('listSort').addEventListener('change', () => {
  listSort = $('listSort').value;
  saveMenuPrefs();
  render();
});

$('type').addEventListener('change', e => {
  const cb = e.target.closest('input[type="checkbox"]');
  if (!cb) return;
  clearHashSelectionBypass();
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
  // Keep tracks for aircraft still visible under the new type selection.
  const visible = new Set(filtered().map(a => a.address));
  for (const addr of [...selectedTracks.keys()]) {
    if (!visible.has(addr) && !oneTimeSearchBypass.has(addr)) {
      removeTrack(addr);
    }
  }
  render();
});

applySavedLayers();
updateMapAttribution();
bringToFront($('mapFilterControl'));
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

/**
 * Open the mobile aircraft list as a full-height panel. A short list cannot
 * scroll the document far enough to reach the sidebar top, so entering list
 * mode directly is required to keep any part of the map from showing.
 */
function revealAircraftList(target) {
  Promise.resolve(exitMapFullscreen()).catch(() => {}).finally(() => {
    requestAnimationFrame(() => {
      if (compactMenuQuery.matches) {
        enterListMode();
        return;
      }
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

$('scrollToListBtn')?.addEventListener('click', () => {
  revealAircraftList($('aircraftSidebar'));
});

const appRoot = document.querySelector('.app');
const siteHeader = $('siteHeader');
let headerAutoCloseTimer = null;
function syncHeaderUi() {
  if (!siteHeader) return;
  const collapsed = appRoot?.classList.contains('header-collapsed') ?? true;
  siteHeader.setAttribute('aria-expanded', String(!collapsed));
  const label = collapsed ? 'Expand header' : 'Collapse header';
  siteHeader.setAttribute('aria-label', label);
  siteHeader.title = label;
}
function syncStickyTop() {
  if (!siteHeader) return;
  document.documentElement.style.setProperty(
    '--header-h',
    `${siteHeader.getBoundingClientRect().height}px`
  );
}
function setHeaderCollapsed(collapsed) {
  if (!appRoot) return;
  appRoot.classList.toggle('header-collapsed', collapsed);
  if (headerAutoCloseTimer !== null) {
    clearTimeout(headerAutoCloseTimer);
    headerAutoCloseTimer = null;
  }
  if (!collapsed) {
    headerAutoCloseTimer = setTimeout(() => {
      headerAutoCloseTimer = null;
      setHeaderCollapsed(true);
    }, 5000);
  }
  syncHeaderUi();
  syncStickyTop();
  requestAnimationFrame(() => {
    syncStickyTop();
    map.invalidateSize({ pan: false, animate: false });
    resize3D();
  });
}
siteHeader?.addEventListener('click', () => {
  setHeaderCollapsed(!appRoot?.classList.contains('header-collapsed'));
});
siteHeader?.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  setHeaderCollapsed(!appRoot?.classList.contains('header-collapsed'));
});
syncHeaderUi();
syncStickyTop();
window.addEventListener('resize', syncStickyTop);

const mapFilterControl = $('mapFilterControl');
const mapFilterToggle = $('mapFilterToggle');
const mapFilterPanel = $('mapFilterPanel');
const compactMenuQuery = window.matchMedia('(max-width:800px)');
let menuDefaultsApplied = false;

function applyMenuDefaults() {
  if (menuDefaultsApplied) return;
  menuDefaultsApplied = true;
  for (const section of mapFilterPanel.querySelectorAll('.collapsible-section')) section.open = false;
}

if (typeof compactMenuQuery.addEventListener === 'function') {
  compactMenuQuery.addEventListener('change', event => {
    menuDefaultsApplied = false;
    if (event.matches) applyMenuDefaults();
    syncScrollListTopBtn();
  });
} else if (typeof compactMenuQuery.addListener === 'function') {
  compactMenuQuery.addListener(event => {
    menuDefaultsApplied = false;
    if (event.matches) applyMenuDefaults();
    syncScrollListTopBtn();
  });
}
applyMenuDefaults();

const scrollListTopBtn = $('scrollListTopBtn');
const listForTopBtn = $('aircraftList');
const LIST_TOP_SHOW_PX = 140;

function aircraftListDocTop() {
  if (!listForTopBtn) return 0;
  return listForTopBtn.getBoundingClientRect().top + (window.scrollY || window.pageYOffset || 0);
}

function syncScrollListTopBtn() {
  if (!scrollListTopBtn || !listForTopBtn) return;
  const listScrolled = listForTopBtn.scrollTop > LIST_TOP_SHOW_PX;
  const pageScrolled = compactMenuQuery.matches
    && (window.scrollY || window.pageYOffset || 0) > aircraftListDocTop() + LIST_TOP_SHOW_PX;
  scrollListTopBtn.hidden = !(listScrolled || pageScrolled);
}

function scrollAircraftListToTop() {
  if (!listForTopBtn) return;
  if (compactMenuQuery.matches && !listMode) {
    // Mirror the map's down arrow: open the pinned full-viewport list directly.
    revealAircraftList($('aircraftSidebar'));
  } else {
    // In list mode the sidebar is pinned and only this element scrolls.
    listForTopBtn.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

scrollListTopBtn?.addEventListener('click', scrollAircraftListToTop);
listForTopBtn?.addEventListener('scroll', syncScrollListTopBtn, { passive: true });
window.addEventListener('scroll', syncScrollListTopBtn, { passive: true });
window.addEventListener('resize', syncScrollListTopBtn);
syncScrollListTopBtn();

// Once the page reaches the sidebar top on mobile, lock the document and let
// only #aircraftList scroll. The pinned chrome keeps the status/filters/section
// head visible; returning to the map is possible only from a downward swipe
// that starts on the pinned header/chrome.
const rootEl = document.documentElement;
let listMode = false;
let listModeDocTop = 0;
let listModeExitGuard = false;

function enterListMode() {
  if (listMode || !compactMenuQuery.matches) return;
  const sidebar = $('aircraftSidebar');
  if (!sidebar) return;
  const scrollTop = window.scrollY || window.pageYOffset || 0;
  listModeDocTop = sidebar.getBoundingClientRect().top + scrollTop;
  listMode = true;
  window.scrollTo(0, listModeDocTop);
  rootEl.classList.add('list-mode');
  sync3DMapVisibility();
  if (listForTopBtn) listForTopBtn.scrollTop = 0;
  syncStickyTop();
  syncScrollListTopBtn();
}

function exitListMode(returnToMap) {
  if (!listMode) return;
  listMode = false;
  rootEl.classList.remove('list-mode');
  sync3DMapVisibility();
  listModeExitGuard = true;
  if (returnToMap) {
    // Scroll all the way up so the map sits below the header, not under it.
    requestAnimationFrame(() => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      map.invalidateSize({ pan: false, animate: false });
      resize3D();
    });
  }
}

/** Return to the visible map after a list action that targets an aircraft. */
function revealMapForListAction() {
  if (!compactMenuQuery.matches) return;
  if (listMode) {
    exitListMode(true);
  } else {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

function syncListMode() {
  if (!compactMenuQuery.matches) {
    if (listMode) exitListMode(false);
    listModeExitGuard = false;
    return;
  }
  const scrollTop = window.scrollY || window.pageYOffset || 0;
  if (listModeExitGuard) {
    if (scrollTop < listModeDocTop - 40) listModeExitGuard = false;
    return;
  }
  if (listMode) return;
  const sidebar = $('aircraftSidebar');
  if (!sidebar) return;
  const sidebarTop = sidebar.getBoundingClientRect().top + scrollTop;
  if (scrollTop >= sidebarTop - 8) enterListMode();
}
window.addEventListener('scroll', syncListMode, { passive: true });
window.addEventListener('resize', syncListMode);
syncListMode();

// Mobile-only: ANY upward swipe starting outside the map (Leaflet #map or the
// MapLibre #map3d overlay) opens the same full-height list panel as the map's
// down arrow, but only while the map is still on screen. Once it has scrolled
// away, normal (desktop-like) scrolling resumes.
let outsideSwipe = null;
let suppressOutsideClick = false;
const OUTSIDE_SWIPE_PX = 40;

function triggerOutsideSwipe() {
  suppressOutsideClick = true;
  setTimeout(() => { suppressOutsideClick = false; }, 400);
  revealAircraftList($('aircraftSidebar'));
}

document.addEventListener('touchstart', (e) => {
  outsideSwipe = null;
  if (!compactMenuQuery.matches || e.touches.length !== 1) return;
  const t = e.touches[0];
  const el = t.target instanceof Element ? t.target : null;
  if (!el || el.closest('#map') || el.closest('#map3d') || el.closest('#mapAttribution')) return;
  // In list mode the document is locked and only the list scrolls. Before
  // that, stop arming once the sidebar top is reached (8px tolerance).
  if (listMode) return;
  const sidebar = $('aircraftSidebar');
  if (!sidebar) return;
  const scrollTop = window.scrollY || window.pageYOffset || 0;
  const sidebarTop = sidebar.getBoundingClientRect().top + scrollTop;
  if (scrollTop >= sidebarTop - 8) return;
  outsideSwipe = { x: t.clientX, y: t.clientY, lastX: t.clientX, lastY: t.clientY, fired: false };
}, { passive: true, capture: true });

document.addEventListener('touchmove', (e) => {
  if (!outsideSwipe || outsideSwipe.fired || e.touches.length !== 1) return;
  const t = e.touches[0];
  outsideSwipe.lastX = t.clientX;
  outsideSwipe.lastY = t.clientY;
  if (t.clientY - outsideSwipe.y > -4) return;
  // Block the UA from claiming this as a native scroll (which would send
  // touchcancel instead of touchend) before it has a chance to start.
  if (e.cancelable) e.preventDefault();
}, { passive: false, capture: true });

function finishOutsideSwipe(e) {
  const swipe = outsideSwipe;
  outsideSwipe = null;
  if (!swipe || !compactMenuQuery.matches || swipe.fired) return;
  const changed = e.changedTouches && e.changedTouches[0];
  const y = changed ? changed.clientY : swipe.lastY;
  if (y - swipe.y > -OUTSIDE_SWIPE_PX) return;
  swipe.fired = true;
  triggerOutsideSwipe();
}
document.addEventListener('touchend', finishOutsideSwipe, { passive: true, capture: true });
document.addEventListener('touchcancel', finishOutsideSwipe, { passive: true, capture: true });

// A swipe must not also activate the element it started on (header tap, button).
document.addEventListener('click', (e) => {
  if (!suppressOutsideClick) return;
  suppressOutsideClick = false;
  e.preventDefault();
  e.stopPropagation();
}, true);

// Returning to the map is deliberately limited to the pinned area. A downward
// swipe inside the aircraft list only scrolls/bounces that list; it never
// unlocks the page. Start the same gesture on the header or chrome to go back.
function inPinnedChrome(el) {
  return !!el && !!(el.closest('#siteHeader') || el.closest('.sidebar-chrome'));
}

let chromeBackSwipe = null;

document.addEventListener('touchstart', (e) => {
  chromeBackSwipe = null;
  if (!listMode || e.touches.length !== 1) return;
  const t = e.touches[0];
  const el = t.target instanceof Element ? t.target : null;
  if (!inPinnedChrome(el)) return;
  chromeBackSwipe = { y: t.clientY, lastY: t.clientY, fired: false };
}, { passive: true, capture: true });

document.addEventListener('touchmove', (e) => {
  if (!chromeBackSwipe || chromeBackSwipe.fired || e.touches.length !== 1) return;
  const t = e.touches[0];
  chromeBackSwipe.lastY = t.clientY;
  if (t.clientY - chromeBackSwipe.y < 4) return;
  if (e.cancelable) e.preventDefault();
}, { passive: false, capture: true });

function finishChromeBackSwipe(e) {
  const swipe = chromeBackSwipe;
  chromeBackSwipe = null;
  if (!swipe || !listMode || swipe.fired) return;
  const changed = e.changedTouches && e.changedTouches[0];
  const y = changed ? changed.clientY : swipe.lastY;
  if (y - swipe.y < OUTSIDE_SWIPE_PX) return;
  swipe.fired = true;
  suppressOutsideClick = true;
  setTimeout(() => { suppressOutsideClick = false; }, 400);
  exitListMode(true);
}
document.addEventListener('touchend', finishChromeBackSwipe, { passive: true, capture: true });
document.addEventListener('touchcancel', finishChromeBackSwipe, { passive: true, capture: true });

// Once the aircraft list has been scrolled back to its top, the next downward
// swipe is an overscroll and returns to the map exactly like the chrome swipe.
const aircraftListEl = $('aircraftList');
let listBackSwipe = null;

aircraftListEl?.addEventListener('touchstart', e => {
  listBackSwipe = null;
  if (!listMode || e.touches.length !== 1) return;
  if (aircraftListEl.scrollTop > 1) return;
  const t = e.touches[0];
  listBackSwipe = { y: t.clientY, lastY: t.clientY, fired: false };
}, { passive: true, capture: true });

document.addEventListener('touchmove', e => {
  if (!listBackSwipe || listBackSwipe.fired || e.touches.length !== 1) return;
  const t = e.touches[0];
  listBackSwipe.lastY = t.clientY;
  if (t.clientY - listBackSwipe.y < 4) return;
  if (e.cancelable) e.preventDefault();
}, { passive: false, capture: true });

function finishListBackSwipe(e) {
  const swipe = listBackSwipe;
  listBackSwipe = null;
  if (!swipe || !listMode || swipe.fired) return;
  const changed = e.changedTouches && e.changedTouches[0];
  const y = changed ? changed.clientY : swipe.lastY;
  if (y - swipe.y < OUTSIDE_SWIPE_PX) return;
  swipe.fired = true;
  suppressOutsideClick = true;
  setTimeout(() => { suppressOutsideClick = false; }, 400);
  exitListMode(true);
}
document.addEventListener('touchend', finishListBackSwipe, { passive: true, capture: true });
document.addEventListener('touchcancel', finishListBackSwipe, { passive: true, capture: true });

function openFilterPanel(focusFirst = true) {
  closeToolbarMenu(false);
  if (soundingIsOpen()) setSoundingOpen(false);
  mapFilterPanel.hidden = false;
  bringToFront(mapFilterControl);
  mapFilterToggle.setAttribute('aria-expanded', 'true');
  if (focusFirst) {
    const first = [...mapFilterPanel.querySelectorAll('summary,input,select,button')]
      .find(el => el.getClientRects().length > 0);
    if (first) first.focus();
  }
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

const toolbarMenuControl = $('toolbarMenuControl');
const toolbarMenuToggle = $('btnToolbarMenu');
const toolbarMenuPanel = $('toolbarMenuPanel');

function openToolbarMenu() {
  if (!toolbarMenuPanel || !toolbarMenuPanel.hidden) return;
  closeFilterPanel(false);
  toolbarMenuPanel.hidden = false;
  bringToFront(toolbarMenuControl);
  toolbarMenuToggle?.setAttribute('aria-expanded', 'true');
}
function closeToolbarMenu(restoreFocus = false) {
  if (!toolbarMenuPanel || toolbarMenuPanel.hidden) return;
  toolbarMenuPanel.hidden = true;
  toolbarMenuToggle?.setAttribute('aria-expanded', 'false');
  if (restoreFocus) toolbarMenuToggle?.focus();
}
function toggleToolbarMenu(restoreFocus = false) {
  if (!toolbarMenuPanel) return;
  if (toolbarMenuPanel.hidden) openToolbarMenu();
  else closeToolbarMenu(restoreFocus);
}
toolbarMenuToggle?.addEventListener('click', event => {
  event.stopPropagation();
  toggleToolbarMenu(true);
});
toolbarMenuPanel?.addEventListener('click', event => {
  event.stopPropagation();
  const button = event.target.closest && event.target.closest('button');
  if (button && !button.closest('#shortcutsControl')) closeToolbarMenu(false);
});

// On desktop the two floating menus open while hovering the control or its panel.
// Touch/mobile keeps the original click-only behavior.
const desktopMenuHover = window.matchMedia('(min-width: 801px) and (hover: hover)');
function bindDesktopMenuHover(control, open, close) {
  if (!control) return;
  control.addEventListener('mouseenter', () => {
    if (desktopMenuHover.matches) open();
  });
  control.addEventListener('mouseleave', () => {
    if (!desktopMenuHover.matches || control.contains(document.activeElement)) return;
    close(false);
  });
}
bindDesktopMenuHover(mapFilterControl, () => openFilterPanel(false), closeFilterPanel);
bindDesktopMenuHover(toolbarMenuControl, openToolbarMenu, closeToolbarMenu);

const shortcutsControl = $('shortcutsControl');
const shortcutsModal = $('shortcutsModal');
const btnShortcuts = $('btnShortcuts');
function openShortcuts(restoreFocus = false) {
  if (!shortcutsModal.hidden) return;
  openToolbarMenu();
  shortcutsModal.hidden = false;
  btnShortcuts.setAttribute('aria-expanded', 'true');
  if (restoreFocus) {
    const close = $('shortcutsClose');
    if (close) close.focus();
  }
}
function closeShortcuts(restoreFocus = false) {
  if (shortcutsModal.hidden) return;
  shortcutsModal.hidden = true;
  btnShortcuts.setAttribute('aria-expanded', 'false');
  if (restoreFocus) btnShortcuts.focus();
}
function toggleShortcuts(restoreFocus = false) {
  if (shortcutsModal.hidden) openShortcuts(restoreFocus);
  else closeShortcuts(restoreFocus);
}
btnShortcuts.addEventListener('click', event => {
  event.stopPropagation();
  toggleShortcuts(true);
});
$('shortcutsClose').addEventListener('click', event => {
  event.stopPropagation();
  closeShortcuts(true);
});
shortcutsModal.addEventListener('click', event => event.stopPropagation());

function saveBookmarks() {
  try {
    localStorage.setItem(BOOKMARKS_STORAGE_KEY, JSON.stringify(bookmarks));
  } catch (e) {}
}

function bookmarkItems() {
  return [
    { id: 'bir', name: 'Bir Billing (Default)', lat: BIR[0], lon: BIR[1], zoom: 11, builtin: true },
    ...bookmarks.map(b => ({ ...b, builtin: false }))
  ];
}

function renderBookmarks() {
  const list = $('bookmarkList');
  if (!list) return;
  list.innerHTML = bookmarkItems().map(b =>
    `<span class="bookmark-item">` +
    `<button type="button" class="bookmark-pill" data-bookmark="${esc(b.id)}" title="Go to ${esc(b.name)}">${esc(b.name)}</button>` +
    (b.builtin ? '' : `<button type="button" class="bookmark-delete icon-close" data-bookmark-delete="${esc(b.id)}" title="Delete ${esc(b.name)}" aria-label="Delete ${esc(b.name)}">×</button>`) +
    `</span>`
  ).join('');
}

$('bookmarkList').addEventListener('click', e => {
  const del = e.target.closest('[data-bookmark-delete]');
  if (del) {
    e.stopPropagation();
    bookmarks = bookmarks.filter(b => b.id !== del.dataset.bookmarkDelete);
    saveBookmarks();
    renderBookmarks();
    return;
  }
  const pill = e.target.closest('[data-bookmark]');
  if (!pill) return;
  const b = bookmarkItems().find(x => x.id === pill.dataset.bookmark);
  if (!b) return;
  e.stopPropagation();
  map.setView([b.lat, b.lon], b.zoom);
  closeFilterPanel(false);
  fetchLive(true);
});

$('btnSaveBookmark').addEventListener('click', () => {
  const row = $('bookmarkSaveRow');
  row.hidden = !row.hidden;
  if (!row.hidden) {
    $('bookmarkName').value = '';
    $('bookmarkName').focus();
  }
});
$('bookmarkSaveCancel').addEventListener('click', () => { $('bookmarkSaveRow').hidden = true; });
$('bookmarkName').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); $('bookmarkSaveConfirm').click(); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); $('bookmarkSaveRow').hidden = true; }
});
$('bookmarkSaveConfirm').addEventListener('click', () => {
  if (bookmarks.length >= 4) {
    showToast('Maximum of 4 saved locations reached.', 2800);
    $('bookmarkSaveRow').hidden = true;
    return;
  }
  const input = $('bookmarkName');
  const name = cleanName(input.value).slice(0, 24) || `Site ${bookmarks.length + 1}`;
  const center = map.getCenter();
  bookmarks.push({
    id: (globalThis.crypto && typeof crypto.randomUUID === 'function') ? crypto.randomUUID() : `bm${Date.now()}`,
    name,
    lat: center.lat,
    lon: center.lng,
    zoom: map.getZoom()
  });
  saveBookmarks();
  renderBookmarks();
  input.value = '';
  $('bookmarkSaveRow').hidden = true;
  showToast(`Saved "${name}"`);
});

document.addEventListener('click', e => {
  if (!mapFilterControl.contains(e.target)) closeFilterPanel(false);
  if (!toolbarMenuControl.contains(e.target)) closeToolbarMenu(false);
  if (!shortcutsControl.contains(e.target)) closeShortcuts(false);
});
function aircraftForCopyShortcut() {
  const list = $('aircraftList');
  const active = document.activeElement;
  if (list && active && list.contains(active)) {
    const row = active.closest('.aircraft[data-key]');
    if (row) return findAircraftByAddress(row.dataset.key);
  }
  return activeTrackAddress ? findAircraftByAddress(activeTrackAddress) : null;
}

document.addEventListener('keydown', event => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target;
  const tag = target && target.tagName ? String(target.tagName).toUpperCase() : '';
  const editable = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!(target && target.isContentEditable);

  if (event.key === 'Escape') {
    event.preventDefault();
    if (!shortcutsModal.hidden) { closeShortcuts(true); return; }
    if (editable && target && typeof target.blur === 'function') { target.blur(); return; }
    if (!toolbarMenuPanel.hidden) { closeToolbarMenu(true); return; }
    if (measureMode) setMeasureMode(false);
    else if (!mapFilterPanel.hidden) closeFilterPanel(true);
    else if (soundingIsOpen()) setSoundingOpen(false);
    else if ($('mapWrap').classList.contains('map-fullscreen')) toggleMapFullscreen();
    else if (selectedTracks.size > 0) { clearAllTracks(); render(); }
    return;
  }

  if (editable) return;

  const key = event.key.toLowerCase();
  if (event.key === '?') {
    event.preventDefault();
    toggleShortcuts(true);
  } else if (event.key === '/') {
    event.preventDefault();
    $('search').focus();
    $('search').select();
  } else if (key === 'r') {
    event.preventDefault();
    setReplayMode(!replayActive);
  } else if (key === 'm') {
    event.preventDefault();
    setMeasureMode(!measureMode);
  } else if (key === 'f') {
    event.preventDefault();
    if (!replayActive && activeTrackAddress) toggleFollow(activeTrackAddress);
  } else if (key === 'c') {
    // Row-focused C is handled (and stops propagation) by #aircraftList above.
    // This fallback covers map/toolbar focus while a track is active.
    const a = aircraftForCopyShortcut();
    if (a && Number.isFinite(a.lat) && Number.isFinite(a.lon)) {
      event.preventDefault();
      copyTextToClipboard(
        event.shiftKey ? buildSarText(a) : `${a.lat.toFixed(6)}, ${a.lon.toFixed(6)}`,
        event.shiftKey ? 'SAR info copied' : 'Coordinates copied'
      );
    }
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
$('replayTime').addEventListener('click', () => {
  if ($('replayTime').disabled) return;
  replayTimeMode = replayTimeMode === 'browser' ? 'track' : 'browser';
  saveMenuPrefs();
  replayTimeReadoutSig = '';
  updateReplayTimeReadout();
  if (replayFocusMarker) {
    replayFocusMarker._tooltipSig = '';
    updateReplayFocusMarker();
  }
});
$('btnMeasure').addEventListener('click', () => setMeasureMode(!measureMode));
$('measureReadout').addEventListener('click', e => {
  if (!e.target.closest('[data-measure-clear]')) return;
  e.stopPropagation();
  clearMeasure();
});
function handleReplayScrub() {
  const slider = $('replaySlider');
  // Some mobile browsers only fire change at the end of a drag; input fires
  // continuously. Ignore the duplicate event for the same slider position.
  if (slider.value === lastReplayScrubValue) return;
  lastReplayScrubValue = slider.value;
  replayTsMs = replayTsFromSlider();
  lastReplaySliceMinute = null;
  updateReplayTimeReadout(replayTsMs);
  updateReplayFocusMarker();
  updateReplayTrackLine();
  syncReplayTrackUi();
  loadReplaySlice();
}
$('replaySlider').addEventListener('input', handleReplayScrub);
$('replaySlider').addEventListener('change', () => {
  replayScrubbing = false;
  handleReplayScrub();
});
// A drag is a user taking control; stop playback so the clock cannot fight it.
for (const evt of ['pointerdown', 'touchstart']) {
  $('replaySlider').addEventListener(evt, () => {
    replayScrubbing = true;
    stopReplayPlayback();
  }, { passive: true });
}
$('replayPlay').addEventListener('click', () => {
  if (replayRafId !== null) stopReplayPlayback();
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
$('replaySpeedValue').addEventListener('click', () => {
  const current = replaySpeed();
  const nextIndex = REPLAY_SPEED_STEPS.findIndex(step => step > current);
  replaySpeedValue = REPLAY_SPEED_STEPS[nextIndex === -1 ? 0 : nextIndex];
  syncReplaySpeedUi();
});
$('replayReverse').addEventListener('click', () => {
  replayDirection = -replayDirection;
  syncReplayDirectionButton();
});
$('replayRange').addEventListener('click', () => {
  const anchorMs = replayTsMs || replayTsFromSlider();
  replayRangeIndex = (replayRangeIndex + 1) % REPLAY_RANGE_LABELS.length;
  replayWindowStartMs = anchorMs;
  syncReplayRangeButton();
  $('replaySlider').value = '0';
  lastReplayScrubValue = null;
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

function syncClearAirspaceButton() {
  const btn = $('btnClearAirspace');
  if (btn) btn.hidden = airspaceLayer.getLayers().length === 0;
}

$('btnSounding').addEventListener('click', () => setSoundingOpen($('soundingPanel').hidden));
$('soundingRefresh').addEventListener('click', () => fetchSounding(true));
$('soundingClose').addEventListener('click', () => setSoundingOpen(false));

const soundingPanel = $('soundingPanel');
soundingPanel.addEventListener('pointerover', e => {
  const pill = e.target.closest?.('.sounding-pill.has-tip');
  if (pill && soundingPanel.contains(pill)) showSoundingTip(pill);
});
soundingPanel.addEventListener('pointerout', e => {
  const pill = e.target.closest?.('.sounding-pill.has-tip');
  if (!pill || pill.contains(e.relatedTarget)) return;
  const next = e.relatedTarget?.closest?.('.sounding-pill.has-tip');
  if (next && soundingPanel.contains(next)) {
    showSoundingTip(next);
    return;
  }
  if (document.activeElement === pill) return;
  hideSoundingTip();
});
soundingPanel.addEventListener('focusin', e => {
  const pill = e.target.closest?.('.sounding-pill.has-tip');
  if (pill) showSoundingTip(pill);
});
soundingPanel.addEventListener('focusout', e => {
  const pill = e.target.closest?.('.sounding-pill.has-tip');
  if (!pill) return;
  const next = e.relatedTarget?.closest?.('.sounding-pill.has-tip');
  if (next && soundingPanel.contains(next)) showSoundingTip(next);
  else hideSoundingTip();
});
soundingPanel.addEventListener('scroll', hideSoundingTip, { passive: true });
document.addEventListener('click', e => {
  const pill = e.target.closest?.('.sounding-pill.has-tip');
  if (pill && soundingPanel.contains(pill)) showSoundingTip(pill);
  else hideSoundingTip();
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
    sync3DAirspace();
    if (!map.hasLayer(airspaceLayer)) airspaceLayer.addTo(map);
    let saved = false;
    try {
      const json = JSON.stringify(gj);
      if (json.length < 1_500_000) {
        localStorage.setItem(AIRSPACE_STORAGE_KEY, json);
        saved = true;
      }
    } catch (err) {
      saved = false;
    }
    if (!saved) showToast('Airspace loaded (too large to save across reloads)', 3200);
    syncClearAirspaceButton();
  } catch (err) {
    showToast('Could not parse airspace file. Please use valid GeoJSON or OpenAir (.txt).', 3200);
  }
  e.target.value = '';
});
$('btnClearAirspace').addEventListener('click', () => {
  airspaceLayer.clearLayers();
  localStorage.removeItem(AIRSPACE_STORAGE_KEY);
  sync3DAirspace();
  syncClearAirspaceButton();
  showToast('Airspace cleared');
});

$('locate').addEventListener('click', () => {
  const btn = $('locate');
  btn.disabled = true;
  btn.title = 'Locating…';
  btn.setAttribute('aria-label', 'Locating…');
  const resetBtn = () => {
    btn.disabled = false;
    btn.title = 'Locate me';
    btn.setAttribute('aria-label', 'Locate me');
  };
  const showLocation = (lat, lon, zoom, label) => {
    resetBtn();
    const pos = [lat, lon];
    map.setView(pos, Math.max(map.getZoom(), zoom));
    if (userLocationMarker) userLocationMarker.setLatLng(pos).setPopupContent(label);
    else userLocationMarker = L.circleMarker(pos, { radius: 7, color: '#ffffff', weight: 2, fillColor: '#38bdf8', fillOpacity: 1 }).bindPopup(label, { ...POPUP_OPTIONS }).addTo(map);
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
      showToast('Could not determine your location.', 3200);
    }
  };
  if (!window.isSecureContext || !navigator.geolocation) { fallbackToIp(); return; }
  const onSuccess = p => showLocation(p.coords.latitude, p.coords.longitude, 12, 'Your location');
  navigator.geolocation.getCurrentPosition(
    onSuccess,
    err => {
      if (err.code === 1) { resetBtn(); showToast('Location permission denied.', 3200); return; }
      navigator.geolocation.getCurrentPosition(onSuccess, fallbackToIp, { enableHighAccuracy: false, timeout: 6000, maximumAge: 300000 });
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
  );
});

render24hAlertsSummary(serverNow());
syncUnitButtons();
updateSearchUi();
renderBookmarks();
renderFeedStatusBanner();
$('feedStatusRetry')?.addEventListener('click', () => { fetchLive(true); });
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
  renderFeedStatusBanner();
  maybeRefreshSounding();
}, 1000);
})();
