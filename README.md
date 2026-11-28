# OGN Tracker

A fast, self-hosted live radar and flight-history viewer for the [Open Glider Network](https://www.glidernet.org/) (OGN) APRS-IS feed. It tracks aircraft, paragliders and ground stations on a map, keeps 24 hours of tracks and replay, and adds a genuinely useful **free 3D terrain view** — without API keys, paid tiles or a build step.

- **Live demo:** [paratracker.in/ogn/](https://paratracker.in/ogn/)
- **Source:** [github.com/cyberorg/ogn-tracker](https://github.com/cyberorg/ogn-tracker)
- **Insights dashboard:** [paratracker.in/ogn/insights.php](https://paratracker.in/ogn/insights.php)

This codebase is **fully vibe-coded using Gemini and opencode Big Pickle**.

---

## Why it is useful

- **Live OGN tracking, refreshed every 5 seconds.** Viewport-filtered positions, telemetry, weather, signal strength, FANET statuses and emergency alerts, with aircraft names resolved from the OGN Devices Database, PureTrack labels and over-the-air names.
- **2D/3D at the flip of a button.** The toggle label shows the current mode (`2D` or `3D`). The 3D view uses real terrain, pitched camera, elevated aircraft markers, coloured tracks and arrowheads — not a decorative globe.
- **Replay in both modes.** Scrub or animate the last 24 hours of flights, with tracks, focused aircraft and popups working in 2D and 3D.
- **Flight analysis built in.** Select tracks, inspect altitude profiles, colour tracks by climb/sink, export `.igc` flight logs, view thermals and load local airspace or hazard files.
- **Safety-aware UI.** Emergency aircraft pulse above other markers with a global alert banner; focus styling keeps the selected aircraft, name and metrics readable above the crowd.
- **Mobile-first controls.** Large touch targets, a map-height layout that keeps the status line visible, swipe-to-list and swipe-back-to-map gestures, and metric/aviation/US unit presets.
- **Shareable state.** Map centre, zoom, selected aircraft and mode persist in the URL hash and local preferences.

---

## 3D implementation

The 3D view is additive: Leaflet remains the source of truth for data, selection, replay and camera intent; [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/docs/) renders the pitched 3D scene on top. Camera moves are sync-guarded in both directions (`MapLibre zoom = Leaflet zoom + 1`, clamped to the same usable range).

The stack is deliberately free:

| Component | Purpose |
|---|---|
| [MapLibre GL JS 5.6.1](https://maplibre.org/maplibre-gl-js/docs/) | 3D map, terrain, camera and sky |
| [OpenFreeMap Liberty](https://openfreemap.org/) | Vector basemap styles, no API key |
| [AWS Terrarium Tiles](https://registry.opendata.aws/terrain-tiles/) | Elevation data for real terrain and hillshade |
| [three.js 0.160.0](https://threejs.org/) | Custom layer for elevated markers, tube tracks and fixed-size arrowheads |

3D reuses the existing UI rather than forking it: aircraft list, filters, popups, focused HUD, replay timeline, attribution, airspace and thermal overlays all work in both modes. Tracks are drawn from true MSL altitudes with no exaggeration. A clear daytime sky is applied after every style load/swap. The result is a lightweight viewer that runs on ordinary shared hosting.

---

## Quick start

Requirements: PHP 8.0+ with `pdo_sqlite` and `sqlite3`, cron access, outbound TCP to `aprs.glidernet.org:14580`, HTTPS to the metadata sources, and a writable directory for the SQLite database and cache.

1. Upload `ogn-collector.php`, `ogn-proxy.php`, `insights.php`, `index.html`, `style.css`, `app.js`, `tz-lookup.js` and `.htaccess` to a web directory such as `public_html/ogn/`.
2. Start the collector every minute:

   ```cron
   * * * * * /usr/bin/php /path/to/public_html/ogn/ogn-collector.php >/dev/null 2>&1
   ```

3. Open `index.html`. Tables, indexes and migrations are created automatically.
4. For the insights dashboard, generate snapshots every four hours as the web-server user:

   ```cron
   0 */4 * * * /usr/bin/php /path/to/public_html/ogn/insights.php --generate >/dev/null 2>&1
   ```

   Run `php insights.php --generate` once manually as that user to create the first snapshot.

   Browser-triggered regeneration with `insights.php?fresh=1` is **disabled by default**. It is only intended for testing on a private instance: set `INSIGHTS_ALLOW_WEB_REFRESH` to `true` near the top of `insights.php` to enable it. Leave it `false` in production and use the cron job above. When disabled, `?fresh=1` is ignored and the cached snapshot is served as usual. A forced browser refresh snapshots the database and can scan 24 hours of tracks, so an unauthenticated public refresh endpoint would be an availability risk.

---

## Proxy API

All endpoints are read-only `GET` requests to `ogn-proxy.php` and return JSON. Select one action parameter per request; unknown actions return HTTP 400 with `{"error": "..."}`.

Common parameters for viewport endpoints are `north`, `south`, `east`, `west` (decimal degrees). Longitude wrapping and antimeridian crossings are handled server-side. Aircraft IDs are lowercase hex/FLARM/FANET IDs; OGN and FLR/FNT aliases are merged into one device where relevant.

| Endpoint | Required | Optional | Returns |
|---|---|---|---|
| `?live=1` | bounds | `window` (seconds, default `900`, clamped `60`–`86400`), `meta=0` to omit name/DDB maps, `nc=1` to bypass cache | `server_time`, `updated`, `names_updated`, `packets`, `telemetry`, `station_weather`, `station_stats`, `alerts_24h`, plus `names`/`ddb` unless `meta=0` |
| `?info=1` | `id` (1–20 chars: `a-z0-9_-`) | — | Last known 24-hour position as `{id, found, raw, timestamp, lat, lon, name, ddb_id, callsign, registration, model, aircraft_type}` |
| `?track=1` | `id` | `since` (Unix seconds, overrides `window`, limited to last 24h), `window`, `full=1` (all fixes, up to 100000; otherwise thinned to ~1500 points) | `{id, window, merged_ids, points}` where each point is `[lat, lon, alt_msl_or_null, unix_ts]` |
| `?thermals=1` | bounds | — | Last 6 hours of thermal heatmap points: `{points: [[lat, lon, intensity], ...]}`, max 3000 |
| `?sounding=1` | bounds | — | Local wind/thermal sounding from the last hour: `{available, generated_at, window_sec, thermal_ceiling_m, surface, layers}`. Regional views only; wide views return `available:false` with a reason |
| `?replay=1` | bounds, `ts` (Unix seconds) | `id` to follow one aircraft/device | Snapshot bucket for `ts` floored to the minute, using fixes ±60 seconds: `{ts, aircraft: [{id, label, lat, lon, alt, ts, merged_ids}, ...]}` |
| `?search=1` | `q` (case-insensitive text, max 80 chars) | — | Up to 200 aircraft seen in the last 24 hours matching tokens in ID, name, callsign, registration, model, type or raw APRS data: `{results: [...]}` |

Examples:

```text
ogn-proxy.php?live=1&north=47.4&south=46.8&east=11.5&west=10.8&window=900
ogn-proxy.php?info=1&id=abc123
ogn-proxy.php?track=1&id=abc123&window=3600
ogn-proxy.php?track=1&id=abc123&full=1
ogn-proxy.php?thermals=1&north=47.4&south=46.8&east=11.5&west=10.8
ogn-proxy.php?sounding=1&north=47.4&south=46.8&east=11.5&west=10.8
ogn-proxy.php?replay=1&ts=1764201600&north=47.4&south=46.8&east=11.5&west=10.8
ogn-proxy.php?search=1&q=paraglider%20oberstdorf
```

Responses are cached by endpoint and viewport size (a few seconds up to 10 minutes). `X-OGN-Stale: 1` indicates a stale cache response served during a database read failure.

---

## Data sources

| Source | Used for |
|---|---|
| [OGN APRS-IS](https://www.glidernet.org/) | Live positions, telemetry, weather, alerts, FANET status and station reception |
| [OGN Devices Database](https://ddb.glidernet.org/) | Callsigns, registrations, models and aircraft types |
| [PureTrack](https://puretrack.io/) | User-assigned pilot/device labels |
| [OpenStreetMap / OpenFreeMap / Esri / OpenTopoMap](https://www.openstreetmap.org/copyright) | 2D and 3D basemap layers |
| [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) | 3D elevation and hillshade |

All OGN data is stored locally in `ogn-live.sqlite`; normal page loads do not query upstream services.

---

## Repository layout

| File | Role |
|---|---|
| `ogn-collector.php` | Streams OGN APRS-IS, syncs metadata, writes SQLite with WAL and batch commits |
| `ogn-proxy.php` | Read-only JSON API for live data, tracks, thermals and 24-hour replay |
| `insights.php` | Cached rolling 24-hour statistics dashboard and CLI generator |
| `index.html` | Responsive app shell; loads Leaflet, MapLibre and three.js from CDNs |
| `app.js` | Parsing, filters, units, map/3D rendering, replay, popups, follow/focus and export |
| `style.css` | Dark responsive styling for the map, controls, list, popups and insights page |
| `.htaccess` | Blocks direct access to the database and lock files |

---

## Disclaimer

This tracker is for **situational awareness, flight analysis and ground tracking only**. It is **not for collision avoidance, in-flight separation, primary navigation or any safety-critical decision**. APRS coverage, receiver density, network delays and data errors can make positions, altitudes and statuses incomplete, delayed or wrong. Always rely on official aeronautical information, cockpit instruments, visual observation and applicable regulations.
