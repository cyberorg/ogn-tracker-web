# OGN Tracker

A lightweight, self-hosted live aircraft and paraglider radar powered by the **Open Glider Network (OGN)** APRS-IS feed. Built to run reliably on standard shared PHP web hosting using **SQLite (WAL mode)** and a zero-build **Leaflet** frontend.

* **Live Demo:** [paratracker.in/ogn/](https://paratracker.in/ogn/)
* **Source:** [github.com/cyberorg/ogn-tracker-web](https://github.com/cyberorg/ogn-tracker-web)

---

## Features

### Live Tracking & Map
* **Real-Time OGN & FANET Feed:** Polls viewport-filtered aircraft, paragliders, and ground stations every 5 seconds with automatic OGN DDB, PureTrack device-label, and over-the-air `Name="..."` resolution.
* **Custom Map Layers & Live Scale:** Switch between **Terrain (OpenTopoMap)**, **Satellite (Esri)**, and **Standard (OSM)**, with bottom-left zoom controls, bottom-right layer controls, and a dynamic metric/imperial distance scale centered at the bottom of the map.
* **Filtering, Units & Persistent Preferences:** Filter by callsign/registration, aircraft type (*All*, *Gliders/Motorgliders*, *Paragliders*, *FANET*, *Other aircrafts*, *Stations*), active time window (`15 min`, `1 hour`, `6 hours`, `24 hours`), and track duration (`15 min`, `1 hour`, `6 hours`, `Today`). Toggle one-click **Metric** (`km/h, m, °C, m/s`) / **Imperial** (`kt, ft, °F, fps`) presets or individual **Alt**, **Wind**, **Temp**, and **Climb** units, and pin favorite aircraft/stations to the top of the list. All menu preferences and pinned items persist across reloads and reconnects via `localStorage`.
* **Signal Strength & Persistent Station Weather:** 4-bar SNR signal indicators in the sidebar, color-coded SNR badges in popups, and payload-scoped APRS/GXAirCom weather parsing (wind direction, speed, gusts, ambient temperature `-50°C` to `55°C`, relative humidity `% RH`, and barometric pressure `hPa`). Merged weather readings persist in SQLite (`station_weather`) across multi-minute reporting intervals and page reloads, and share data across co-located station beacons (`< 0.2 km`) without leaking upstream server telemetry.
* **Geolocation with IP Fallback:** One-click **Locate** button uses browser GPS with automatic IP-geolocation fallback when GPS is unavailable.
* **URL Hash Deep-Linking:** Syncs map center, zoom level, and selected aircraft (`#lat,lon,zoom,id`) to the URL for direct sharing.
* **Mobile-Friendly UI:** Responsive layout with scrollable filter menus and `16px` mobile inputs to prevent iOS Safari auto-zoom.

### Flight Analysis & Overlays
* **Multi-Track Selection & Barogram:** Click any aircraft in the list or on the map to plot its track and open an SVG altitude profile at the bottom of the map.
* **Vario vs. Flat Track Coloring:** Toggle flight tracks between flat per-aircraft colors and vario-colored segments based on climb/sink rate.
* **IGC Flight Log Export:** Download any selected aircraft's 3D track directly as a standard `.igc` file.
* **Today's Thermal Heatmap:** Toggleable `Leaflet.heat` overlay highlighting active climbs (`1.5–15.0 m/s`) from the last 6 hours.
* **RF Coverage (SNR) Overlay:** Draws color-coded reception links from on-screen ground stations to heard aircraft (with hover tooltips showing receiver, aircraft, SNR, and distance) and `radius: 20` SNR halos when the receiver is off-screen.
* **24-Hour Ground Station Reception & Range:** Ground station popups display **Aircraft heard** (cumulative unique aircraft heard in the last 24 hours from `station_heard`) and **Farthest heard (24h)** (distance in km, aircraft name, and age), matching stations across both OGN receiver callsigns and FANET names.
* **24-Hour Time-Lapse Replay:** Scrub or animate the last 24 hours of flight activity in 1-minute slices.
* **Local Airspace & Hazard Loader:** Load `.geojson` or OpenAir (`.txt`) airspace/obstacle files directly in the browser without uploading them to a server.

### Safety & SAR Tools
* **Unclustered Emergency Markers:** Aircraft broadcasting FANET distress/medical statuses, emergency squawks (`7700`, `7600`, `7500`), or APRS emergency keywords (`MAYDAY`, `SOS`, `EMERGENCY`) pulse in red, bypass marker clustering, and remain visible globally.
* **Global Emergency Banner:** Displays a red alert bar across the top of the map whenever an emergency is active, with a one-click **Jump to Alert** button.
* **One-Click SAR Copy:** Copies callsign, status, coordinates, altitude, last-heard age, and a Google Maps link to the clipboard from any popup.
* **Follow Mode:** Lock the map onto a moving aircraft (automatically disengages when you drag the map).
* **Pinned Pilot Alerts:** Toggleable in the map menu (`🔔 Alerts`) for optional browser notifications + audio tone when a pinned pilot switches status to *Distress call*, *Need medical help*, *Need a ride*, or *Landed well*.

### Insights Dashboard
* **Rolling 24-Hour Snapshot:** `insights.php` summarises the last 24 hours — unique aircraft, track points, ground stations, thermals, aircraft types, packet sources, FANET statuses, weather, reception records, alerts, and data-quality gaps — in grouped, mobile-friendly cards with a scrollable hourly chart.
* **Scheduled Regeneration:** Normal web requests never generate the page; a 4-hourly cron job writes it into the shared `ogn_tracker_cache` directory. Until the first snapshot exists, the page returns `503 Waiting for the scheduled refresh`.
* **On-Demand Refresh:** `insights.php?fresh=1` forces a full regeneration in the browser; `php insights.php --generate` is the CLI/cron path. Both write the same cached page atomically.
* **Live Freshness:** Data/snapshot ages, relative "last heard" times, and hourly chart labels are recomputed client-side from `data-ts` values, so a cached page never shows stale server-rendered ages.
* **Live-DB Safe:** Generation copies the live database to a temporary SQLite snapshot in `/tmp` before running the heavy 24-hour aggregation, so viewer requests and the collector are not stalled by multi-million-row scans.

### Performance Optimizations
* **Feed Filtering:** `OGADSB` gateway packets are dropped at ingestion (`DROP_PACKET_SOURCES`), keeping commercial ADS-B traffic out of the database and insights counts.
* **Gzip Compression:** Built-in `ob_gzhandler` compression in `ogn-proxy.php` (no `.htaccess` required).
* **Micro-Caching:** File-based response caching in `sys_get_temp_dir()/ogn_tracker_cache` protects SQLite from concurrent viewer spikes.
* **Zero-Rebuild 1s Updates:** The 1-second timer updates only `.age[data-ts]` text nodes instead of re-parsing APRS packets or rebuilding the DOM, paired with delegated click listeners.
* **Smart Metadata Polling:** Routine 5-second polls send `meta=0` once DDB/names are cached client-side, requesting `meta=1` only on map moves or when new unknown aircraft appear.
* **Server-Side Track Decimation:** Long tracks (>1,500 points) are thinned before transmission to keep mobile Leaflet rendering smooth.

---

## Data Sources

| Source | Used for |
|---|---|
| OGN APRS-IS (`aprs.glidernet.org:14580`) | Live positions, telemetry, weather, alerts, FANET status, and station reception |
| OGN Devices Database (`ddb.glidernet.org`) | Callsigns, registrations, models, and aircraft types (6-hourly sync) |
| PureTrack label export (`puretrack.io/api/labels.json`) | User-assigned pilot/device names keyed by 6-digit hex ID (6-hourly sync) |

All data is stored locally in `ogn-live.sqlite`; the tracker does not query any upstream service on page load.

---

## Requirements

* **PHP 8.0+** (CLI + Web) with `pdo_sqlite` and the `sqlite3` extension enabled (the latter is used for the insights database snapshot)
* **Cron** access: 1-minute job for the collector and a 4-hourly job for insights
* Outbound TCP access to `aprs.glidernet.org:14580` and HTTPS access to `ddb.glidernet.org` and `puretrack.io`
* Write permissions in the application directory (for `ogn-live.sqlite`, `-wal`, `-shm`, and `ogn-collector.lock`)
* A writable shared cache directory (`sys_get_temp_dir()/ogn_tracker_cache`, normally created by `ogn-proxy.php` as `www-data`); the insights cron must run as a user that can write there

---

## Repository Structure

| File | Role |
|---|---|
| `ogn-collector.php` | CLI daemon/cron script that streams global OGN APRS-IS packets, drops `OGADSB` traffic, syncs the OGN DDB and PureTrack device labels every 6 hours, persists station weather and 24h reception stats, and batch-writes to SQLite. |
| `ogn-proxy.php` | Read-only SQLite JSON API serving live viewports, station weather, 24h station stats, tracks, thermal heatmaps, and 24-hour replay slices with Gzip compression and micro-caching. |
| `insights.php` | Standalone rolling 24-hour statistics page. Web requests serve a cached snapshot; `?fresh=1` or `--generate` rebuilds it from a temporary SQLite snapshot. |
| `index.html` | Responsive HTML shell loading Leaflet, MarkerCluster, and Leaflet.heat from jsDelivr CDN along with `style.css` and `app.js`; links to `insights.php`. |
| `style.css` | Dark-mode responsive stylesheet for the map, distance scale, filter menu, popups, sidebar list, and insights page. |
| `app.js` | Client-side APRS/weather parser, persistent menu/unit preferences, map rendering, barogram, and IGC exporter. |
| `.htaccess` | Denies direct HTTP access to SQLite database, WAL/SHM, and collector lock files. |
| `README.md` | This documentation. |

---

## Installation & Configuration

1. **Upload files** (`ogn-collector.php`, `ogn-proxy.php`, `insights.php`, `index.html`, `style.css`, `app.js`, `.htaccess`) to your web directory (e.g., `/public_html/ogn/`).
2. **Set up the 1-minute collector cron** (each run streams for 55 seconds and uses `ogn-collector.lock` to prevent overlapping processes):
   ```cron
   * * * * * /usr/bin/php /path/to/public_html/ogn/ogn-collector.php >/dev/null 2>&1
   ```
3. **Verify the collector:** Run it once manually from SSH to confirm `ogn-live.sqlite` is created and populated:
   ```bash
   php /path/to/public_html/ogn/ogn-collector.php
   ```
4. **Open `index.html`** in your browser. Database tables and indexes are created and migrated automatically.
5. **Set up the 4-hourly insights cron as the web server user** (`www-data` on Debian/Ubuntu). It writes the generated page to the same `ogn_tracker_cache` directory used by `ogn-proxy.php`, so it must run as a user that can write there:
   ```cron
   0 */4 * * * /usr/bin/php /path/to/public_html/ogn/insights.php --generate >/dev/null 2>&1
   ```
   Install it with `sudo crontab -u www-data -e` (or the equivalent for your web user).
6. **Generate the first snapshot manually** as that same user, otherwise `insights.php` returns `503 Waiting for the scheduled refresh` until the first cron run:
   ```bash
   sudo -u www-data /usr/bin/php /path/to/public_html/ogn/insights.php --generate
   ```
7. **Open `insights.php`** in your browser. Append `?fresh=1` to force an immediate regeneration (this does the full aggregation on page load, so it takes a few seconds).

### Customization
* **Default Map Center:** Edit `const BIR = [32.037, 76.708];` near the top of `app.js`.
* **Collector Tuning (`ogn-collector.php`):**
  * `RUN_SECONDS` (`55`) — Duration per cron execution.
  * `EXPIRE_SECONDS` / `TRACK_EXPIRE_SECONDS` (`86400`) — 24-hour retention for aircraft, telemetry, station weather, tracks, and station range/heard records.
  * `TRACK_MIN_INTERVAL` (`15`) — Minimum seconds between logged track points for non-paragliders (paragliders log every point).
  * `FLUSH_INTERVAL` (`3.0`) — SQLite batch-commit interval in seconds.
  * `DDB_SYNC_INTERVAL` (`21600`) — OGN Devices Database and PureTrack label refresh interval (6 hours).
  * `PURETRACK_LABELS_URL` — PureTrack label export endpoint (`https://puretrack.io/api/labels.json`).
  * `DROP_PACKET_SOURCES` (`['OGADSB']`) — Packet source names discarded at ingestion.
  * `MAX_RX_RANGE_KM` (`500.0`) — Upper bound to filter corrupted RF distance spikes.
  * `MIN_VALID_TEMP_C` (`-50.0`) / `MAX_VALID_TEMP_C` (`55.0`) — Bounds used to filter out invalid ambient temperature readings.
* **Insights Tuning (`insights.php`):**
  * `$cacheTtl` (`14400`) — Snapshot lifetime; keep it in sync with the 4-hour cron interval if changed.
  * `$cacheDir` — Shared cache directory (`sys_get_temp_dir() . '/ogn_tracker_cache'`); both the web server and the insights cron need write access.
  * `$dbFile` — Source database (`__DIR__ . '/ogn-live.sqlite'`).
  * `set_time_limit(180)` — Maximum generation time; the heavy query runs against a temporary SQLite snapshot in `/tmp`.

---

## SQLite Database Schema (`ogn-live.sqlite`)

| Table | Columns | Purpose & Retention |
|---|---|---|
| `aircraft` | `id`, `ddb_id`, `lat`, `lon`, `raw`, `timestamp`, `is_emergency` | Latest position packet per aircraft/station; indexed by `(lat, lon)`, `timestamp`, and partial index `WHERE is_emergency = 1`. Retained for **24 hours**. |
| `telemetry` | `id`, `raw`, `timestamp` | Latest coordinate-less status/telemetry packet per station/device. Retained for **24 hours**. |
| `station_weather` | `id`, `wx_json`, `updated` | Merged, sanitized weather fields (`dir`, `spdKmh`, `gustKmh`, `tempC`, `pressureHpa`, `humidityPct`) per station across multi-minute intervals. Retained for **24 hours**. |
| `tracks` | `id`, `ts`, `lat`, `lon`, `alt` (`WITHOUT ROWID`) | Timestamped 3D track history. Retained for **24 hours**. |
| `stations` | `id`, `lat`, `lon`, `max_km`, `farthest_id`, `farthest_ts`, `updated` | Ground station coordinates (including FANET name aliases) and 24-hour farthest-heard records. Retained for **24 hours**. |
| `station_heard` | `station_id`, `aircraft_id`, `last_ts` (`WITHOUT ROWID`) | Unique aircraft heard per ground station over a rolling 24-hour window. Retained for **24 hours**. |
| `names` | `id`, `name`, `updated` | Over-the-air FANET/OGN station names (`Name="..."`) keyed by callsign, plus PureTrack device labels keyed by 6-digit hex ID. Persistent. |
| `ddb` | `id`, `callsign`, `registration`, `model`, `aircraft_type`, `raw_json` | Local mirror of the OGN Devices Database. Refreshed every **6 hours**. |
| `meta` | `key`, `value` | Collector metadata (`updated`, `ddb_updated`, `puretrack_labels_updated`). Persistent. |

---

## `ogn-proxy.php` API Reference

All endpoints return `application/json; charset=utf-8` (Gzip-compressed when supported by the client).

### 1. Live Viewport (`live=1`)
Returns active aircraft, global emergencies, coordinate-less telemetry, persisted station weather, and 24-hour station reception stats (`heard_24h` and `max_km`) for the requested bounding box.
```text
GET ogn-proxy.php?live=1&north=32.5&south=31.5&east=77.2&west=76.2&window=900&meta=1
```
* `north`, `south`, `east`, `west` — Map bounds (snapped to `0.1°` for cache efficiency).
* `window` — Lookback window in seconds (`60`–`86400`, default `900`).
* `meta` — `1` to include `names` and `ddb`; `0` to omit them when cached client-side.

### 2. Flight Track (`track=1`)
Returns `[lat, lon, alt, ts]` points for a single aircraft (thinned to ~1,500 points if longer).
```text
GET ogn-proxy.php?track=1&id=fnt8318d3&window=3600
GET ogn-proxy.php?track=1&id=fnt8318d3&since=1763596800
```
* `id` — Lowercase aircraft address/callsign.
* `window` — Lookback duration in seconds (`60`–`86400`), **or** `since` — Unix timestamp.

### 3. Thermal Heatmap (`thermals=1`)
Returns `[lat, lon, intensity]` points where climb rate is between `1.5` and `15.0 m/s` over the last 6 hours.
```text
GET ogn-proxy.php?thermals=1&north=32.5&south=31.5&east=77.2&west=76.2
```

### 4. 24-Hour Time-Lapse Replay (`replay=1`)
Returns deduplicated aircraft positions within a `±60s` window around the given Unix timestamp.
```text
GET ogn-proxy.php?replay=1&ts=1763625600&north=32.5&south=31.5&east=77.2&west=76.2
```

### 5. Insights Page (`insights.php`)
Serves HTML (not JSON) from the shared cache; it performs no aggregation on normal requests.
```text
GET insights.php                       # cached snapshot, or 503 if none exists yet
GET insights.php?fresh=1               # force a full regeneration and return the new page
php insights.php --generate            # CLI/cron regeneration; prints duration or an error on stderr
```
Cached files are `insights_page.html` and `insights_page.meta.json` in `sys_get_temp_dir()/ogn_tracker_cache`. The metadata records `data_updated`, `generated_at`, `next_at`, and generation `duration`.

---

## Troubleshooting

* **"Collector paused (>2m old)":** Verify the cron job is running and that `ogn-collector.php` has write permission to create/update `ogn-live.sqlite` and `ogn-collector.lock`.
* **Ground station shows no 24h reception or weather record yet:** Records begin accumulating after a ground station broadcasts its position/weather beacon and receives aircraft packets.
* **Insights returns `503 Waiting for the scheduled refresh`:** No snapshot has been generated yet. Install the 4-hourly cron and run `php insights.php --generate` once as the web server user; also confirm `ogn_tracker_cache` is writable by that user.
* **Insights data looks stale:** Check `generated_at` / `next_at` in `insights_page.meta.json`, confirm the cron is running, or request `insights.php?fresh=1` for an immediate rebuild.
* **Insights generation fails with `database disk image is malformed`:** The source `ogn-live.sqlite` is corrupt. The snapshot copy cannot repair that; restore or recreate the database.
* **PureTrack names not showing:** Labels sync every 6 hours (`puretrack_labels_updated` in `meta`), apply only to devices with a valid 6-digit ID, and can take up to 5 minutes to appear because of proxy micro-caching.

---

## Disclaimer

Data is collected from the Open Glider Network (OGN) APRS-IS feed and is intended for situational awareness, flight analysis, and ground tracking only. **Not for collision avoidance or in-flight separation.**