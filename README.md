# OGN Glider Tracker

A lightweight, self-hosted web tracker for live **Open Glider Network (OGN)** and **FANET** traffic. Designed to run cleanly on standard shared hosting using a PHP + SQLite backend and a single-file Leaflet frontend.

## Features

- **Live APRS-IS Feed:** Connects to `aprs.glidernet.org:14580` via a background PHP cron collector and stores active traffic in a local SQLite database (WAL mode) with automatic 15-minute expiry.
- **Viewport-Filtered API:** Fetches only aircraft currently visible within the map bounds (`north`, `south`, `east`, `west`), keeping payloads small and fast.
- **OGN DDB & Over-the-Air Identification:** Syncs the official OGN Device Database every 6 hours and merges callsigns, registrations, models, and over-the-air `Name="..."` tags.
- **Accurate Aircraft Type Decoding:** Properly decodes OGN `id` type bytes (including 32-bit Naviter/SeeYou `OGNAVI` IDs), APRS symbol fallbacks, and FANET ground-tracking packets (`FNT7x`) so landed paragliders aren't misclassified as ground stations.
- **FANET Status & Distress Highlighting:** Parses FANET airborne (`FNT1x`) and ground (`FNT7x`) status codes and color-codes both the sidebar indicator bar and status text:
  - **Red:** Distress call, Distress call automatically, Need medical help
  - **Yellow:** Need a ride, Need technical support
  - **Green:** Airborne, Landed well, Walking, Vehicle, etc.
- **Signal Quality (SNR):** Extracts receiver SNR (`dB`) from packets and displays color-coded badges (`Strong` ≥ 25 dB, `Good` 12–24.9 dB, `Weak` less than 12 dB).
- **Interactive Map:** Leaflet map with OpenTopoMap (default), Esri World Imagery, and OpenStreetMap layers, marker clustering with spiderfy support, search, aircraft type filters, browser local time conversion, and one-click Google Maps coordinate links.

## Architecture

| File | Role |
|---|---|
| `ogn-collector.php` | CLI script run via 1-minute cron. Streams APRS-IS packets for 55 seconds, batch-writes positions and names to `ogn-live.sqlite` every 3 seconds, prunes stale entries (older than 15 min), and syncs the OGN DDB every 6 hours. |
| `ogn-proxy.php` | JSON API endpoint (`?live=1&north=...&south=...&east=...&west=...`) that queries `ogn-live.sqlite` for aircraft inside the requested map bounds and joins DDB + name records. |
| `index.html` | Self-contained frontend (HTML/CSS/JS) using Leaflet and Leaflet.markercluster. Polls `ogn-proxy.php` every 3 seconds and updates packet ages every second. |

## Requirements

- **PHP 7.4+** (or PHP 8.x) with `pdo_sqlite` and `sqlite3` extensions enabled
- **Cron** access (1-minute interval)
- Outbound TCP access to `aprs.glidernet.org:14580` and HTTPS access to `ddb.glidernet.org`

## Installation

1. **Upload the files** (`index.html`, `ogn-proxy.php`, `ogn-collector.php`) to your web directory (e.g., `public_html/tracker/`).

2. **Configure the 1-minute cron job** to run the collector continuously:
   ```cron
   * * * * * /usr/bin/php /path/to/public_html/tracker/ogn-collector.php >/dev/null 2>&1
   ```
   The script uses a file lock (`ogn-collector.lock`) to prevent overlapping instances and runs for 55 seconds per invocation.

3. **Protect internal database and lock files** from direct web access. If you are using Apache, add this to `.htaccess` in the same folder:
   ```apache
   <FilesMatch "\.(sqlite|sqlite-wal|sqlite-shm|lock)$">
     Require all denied
   </FilesMatch>
   ```

4. **Open `index.html`** in your browser. Once the first cron cycle starts, live aircraft will appear within a few seconds.

## Configuration

- **Default Map Center:** Edit `const BIR = [32.037, 76.708];` near the top of the `<script>` in `index.html` to set your preferred default `[latitude, longitude]` and initial zoom level.
- **Retention & Intervals:** Adjust `RUN_SECONDS`, `EXPIRE_SECONDS`, `FLUSH_INTERVAL`, and `DDB_SYNC_INTERVAL` at the top of `ogn-collector.php`.
- **APRS-IS Callsign:** Update the `user PARAGUIDE ...` login line in `ogn-collector.php` if you want to identify your collector with your own callsign.

## Disclaimer

Data is collected from the Open Glider Network APRS-IS feed and is intended for situational awareness and ground tracking only. **Not for collision avoidance or in-flight separation.**