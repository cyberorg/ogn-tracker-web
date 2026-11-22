<?php
/*
 * Global OGN APRS-IS + DDB Cron Collector -> SQLite (Shared Hosting)
 * Run via 1-minute cron:
 *   * * * * * /usr/bin/php /path/to/public_html/ogn-collector.php >/dev/null 2>&1
 */
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('CLI only.');
}

const RUN_SECONDS          = 55;
const EXPIRE_SECONDS       = 86400; // 24 hours for last-known aircraft positions, alerts & station stats
const TRACK_EXPIRE_SECONDS = 86400; // 24 hours for flight tracks
const TRACK_MIN_INTERVAL   = 15;    // Min seconds between track points for non-paragliders
const FLUSH_INTERVAL       = 3.0;   // Batch-write to SQLite every 3 seconds
const DDB_SYNC_INTERVAL    = 21600; // Refresh full DDB every 6 hours
const MAX_RX_RANGE_KM      = 500.0; // Reject impossible RF glitch distances
const MIN_VALID_TEMP_C     = -50.0;
const MAX_VALID_TEMP_C     = 55.0;

$lockFile = __DIR__ . '/ogn-collector.lock';
$dbFile   = __DIR__ . '/ogn-live.sqlite';

$lockFp = fopen($lockFile, 'c');
if (!$lockFp || !flock($lockFp, LOCK_EX | LOCK_NB)) {
    exit(0);
}

$pdo = new PDO('sqlite:' . $dbFile, null, null, [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
]);
$pdo->exec('PRAGMA auto_vacuum=INCREMENTAL;');
$pdo->exec('PRAGMA journal_mode=WAL;');
$pdo->exec('PRAGMA synchronous=NORMAL;');
$pdo->exec('PRAGMA busy_timeout=3000;');

$pdo->exec('
    CREATE TABLE IF NOT EXISTS aircraft (
        id TEXT PRIMARY KEY,
        ddb_id TEXT NOT NULL DEFAULT "",
        lat REAL NOT NULL,
        lon REAL NOT NULL,
        raw TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        is_emergency INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_aircraft_coords ON aircraft (lat, lon);
    CREATE INDEX IF NOT EXISTS idx_aircraft_ts ON aircraft (timestamp);

    CREATE TABLE IF NOT EXISTS alerts (
        id TEXT NOT NULL,
        status TEXT NOT NULL,
        lat REAL,
        lon REAL,
        alt REAL,
        raw TEXT NOT NULL,
        last_ts INTEGER NOT NULL,
        PRIMARY KEY (id, status)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts (last_ts);

    CREATE TABLE IF NOT EXISTS telemetry (
        id TEXT PRIMARY KEY,
        raw TEXT NOT NULL,
        timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_telemetry_ts ON telemetry (timestamp);

    CREATE TABLE IF NOT EXISTS station_weather (
        id TEXT PRIMARY KEY,
        wx_json TEXT NOT NULL,
        updated INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_station_weather_updated ON station_weather (updated);

    CREATE TABLE IF NOT EXISTS tracks (
        id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        lat REAL NOT NULL,
        lon REAL NOT NULL,
        alt REAL,
        PRIMARY KEY (id, ts)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_tracks_ts ON tracks (ts);

    CREATE TABLE IF NOT EXISTS thermals (
        id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        lat REAL NOT NULL,
        lon REAL NOT NULL,
        intensity REAL NOT NULL,
        PRIMARY KEY (id, ts)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_thermals_ts ON thermals (ts);

    CREATE TABLE IF NOT EXISTS stations (
        id TEXT PRIMARY KEY,
        lat REAL NOT NULL,
        lon REAL NOT NULL,
        max_km REAL NOT NULL DEFAULT 0,
        farthest_id TEXT NOT NULL DEFAULT "",
        farthest_ts INTEGER NOT NULL DEFAULT 0,
        heard_24h INTEGER NOT NULL DEFAULT 0,
        updated INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_stations_coords ON stations (lat, lon);

    CREATE TABLE IF NOT EXISTS station_heard (
        station_id TEXT NOT NULL,
        aircraft_id TEXT NOT NULL,
        last_ts INTEGER NOT NULL,
        PRIMARY KEY (station_id, aircraft_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_station_heard_ts ON station_heard (station_id, last_ts);

    CREATE TABLE IF NOT EXISTS names (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        updated INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ddb (
        id TEXT PRIMARY KEY,
        callsign TEXT NOT NULL,
        registration TEXT NOT NULL,
        model TEXT NOT NULL,
        aircraft_type TEXT NOT NULL,
        raw_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
');

$cols = array_column($pdo->query('PRAGMA table_info(aircraft)')->fetchAll(PDO::FETCH_ASSOC), 'name');
if (!in_array('is_emergency', $cols, true)) {
    $pdo->exec('ALTER TABLE aircraft ADD COLUMN is_emergency INTEGER NOT NULL DEFAULT 0;');
}
$pdo->exec('CREATE INDEX IF NOT EXISTS idx_aircraft_emerg ON aircraft (timestamp) WHERE is_emergency = 1;');

$stationCols = array_column($pdo->query('PRAGMA table_info(stations)')->fetchAll(PDO::FETCH_ASSOC), 'name');
if (!in_array('heard_24h', $stationCols, true)) {
    $pdo->exec('ALTER TABLE stations ADD COLUMN heard_24h INTEGER NOT NULL DEFAULT 0;');
}

$alertCols = array_column($pdo->query('PRAGMA table_info(alerts)')->fetchAll(PDO::FETCH_ASSOC), 'name');
if (!in_array('alt', $alertCols, true)) {
    $pdo->exec('ALTER TABLE alerts ADD COLUMN alt REAL;');
}

function normalize_ogn_name_encoding($value): string {
    $raw = (string)$value;
    if ($raw === '' || preg_match('//u', $raw)) return $raw;

    $out = '';
    $len = strlen($raw);
    for ($i = 0; $i < $len;) {
        $b = ord($raw[$i]);
        if ($b < 0x80) {
            $out .= $raw[$i++];
            continue;
        }

        $seq = null;
        if ($b >= 0xC2 && $b <= 0xDF && $i + 1 < $len) {
            $b1 = ord($raw[$i + 1]);
            if ($b1 >= 0x80 && $b1 <= 0xBF) $seq = substr($raw, $i, 2);
        } elseif ($b >= 0xE0 && $b <= 0xEF && $i + 2 < $len) {
            $b1 = ord($raw[$i + 1]);
            $b2 = ord($raw[$i + 2]);
            if ($b1 >= 0x80 && $b1 <= 0xBF && $b2 >= 0x80 && $b2 <= 0xBF &&
                !($b === 0xE0 && $b1 < 0xA0) && !($b === 0xED && $b1 > 0x9F)) {
                $seq = substr($raw, $i, 3);
            }
        } elseif ($b >= 0xF0 && $b <= 0xF4 && $i + 3 < $len) {
            $b1 = ord($raw[$i + 1]);
            $b2 = ord($raw[$i + 2]);
            $b3 = ord($raw[$i + 3]);
            if ($b1 >= 0x80 && $b1 <= 0xBF && $b2 >= 0x80 && $b2 <= 0xBF && $b3 >= 0x80 && $b3 <= 0xBF &&
                !($b === 0xF0 && $b1 < 0x90) && !($b === 0xF4 && $b1 > 0x8F)) {
                $seq = substr($raw, $i, 4);
            }
        }

        if ($seq !== null) {
            $out .= $seq;
            $i += strlen($seq);
            continue;
        }

        $byte = $raw[$i];
        if (function_exists('iconv')) {
            $converted = @iconv('Windows-1252', 'UTF-8//IGNORE', $byte);
            $out .= ($converted !== false && $converted !== '') ? $converted : '?';
        } elseif (function_exists('mb_convert_encoding')) {
            $converted = @mb_convert_encoding($byte, 'UTF-8', 'Windows-1252');
            $out .= (is_string($converted) && $converted !== '') ? $converted : '?';
        } else {
            $out .= '?';
        }
        $i++;
    }
    return $out;
}

function clean_ogn_name($value): string {
    $raw = normalize_ogn_name_encoding($value);
    if ($raw === '' || !preg_match('//u', $raw)) return '';
    if (preg_match('/[\x00-\x1F\x7F\x{80}-\x{9F}]/u', $raw) || preg_match('/[\x{2400}-\x{243F}\x{FFFD}]/u', $raw)) return '';
    return trim(preg_replace('/\s+/u', ' ', $raw) ?? $raw);
}

function extract_ogn_stream_name(string $line): string {
    if (!preg_match('/Name="([^"]*)"/', $line, $m)) return '';
    return clean_ogn_name($m[1]);
}

function haversine_km(float $lat1, float $lon1, float $lat2, float $lon2): float {
    $dLat = deg2rad($lat2 - $lat1);
    $dLon = deg2rad($lon2 - $lon1);
    $a = sin($dLat / 2.0) ** 2 + cos(deg2rad($lat1)) * cos(deg2rad($lat2)) * sin($dLon / 2.0) ** 2;
    return 6371.0 * 2.0 * atan2(sqrt($a), sqrt(1.0 - $a));
}

function is_emergency_packet(string $line): int {
    if (preg_match('/\bFNT7[def]\b/i', $line)) return 1;
    if (preg_match('/\bsq(7700|7600|7500)\b/i', $line)) return 1;
    if (preg_match('/^[^>]+>EMERGENCY[,:]/i', $line)) return 1;
    $colonPos = strpos($line, ':');
    if ($colonPos !== false && preg_match('/\b(MAYDAY|SOS|EMERGENCY)\b/i', substr($line, $colonPos + 1))) {
        return 1;
    }
    return 0;
}

function detect_alert_status(string $line): ?string {
    static $fanetLabels = [
        '8' => 'Need a ride',
        'c' => 'Need technical support',
        'd' => 'Need medical help',
        'e' => 'Distress call',
        'f' => 'Distress call automatically',
    ];
    if (preg_match('/\bFNT7([0-9a-f])\b/i', $line, $fm)) {
        $hex = strtolower($fm[1]);
        if (isset($fanetLabels[$hex])) {
            return $fanetLabels[$hex];
        }
    }
    if (preg_match('/\bsq(7700|7600|7500)\b/i', $line, $sm)) {
        $map = [
            '7700' => 'Squawk 7700 (Emergency)',
            '7600' => 'Squawk 7600 (Radio Failure)',
            '7500' => 'Squawk 7500 (Hijack)',
        ];
        return $map[$sm[1]];
    }
    if (preg_match('/^[^>]+>EMERGENCY[,:]/i', $line)) {
        return 'APRS Emergency';
    }
    $colonPos = strpos($line, ':');
    if ($colonPos !== false) {
        $payload = trim(substr($line, $colonPos + 1));
        if (preg_match('/\b(MAYDAY|SOS|EMERGENCY)\b/i', $payload, $km)) {
            return 'Alert (' . strtoupper($km[1]) . ')';
        }
    }
    return null;
}

function sanitize_weather_array(array $wx): ?array {
    $dir      = isset($wx['dir']) && is_numeric($wx['dir']) ? (int)$wx['dir'] : null;
    $spdKmh   = isset($wx['spdKmh']) && is_numeric($wx['spdKmh']) ? (int)$wx['spdKmh'] : null;
    $gustKmh  = isset($wx['gustKmh']) && is_numeric($wx['gustKmh']) ? (int)$wx['gustKmh'] : null;
    $tempC    = isset($wx['tempC']) && is_numeric($wx['tempC']) ? (int)$wx['tempC'] : null;
    $pressure = isset($wx['pressureHpa']) && is_numeric($wx['pressureHpa']) ? round((float)$wx['pressureHpa'], 1) : null;
    $humidity = isset($wx['humidityPct']) && is_numeric($wx['humidityPct']) ? (int)$wx['humidityPct'] : null;

    if ($tempC !== null && ($tempC < MIN_VALID_TEMP_C || $tempC > MAX_VALID_TEMP_C)) {
        $tempC = null;
    }
    if ($pressure !== null && ($pressure < 850.0 || $pressure > 1085.0)) {
        $pressure = null;
    }
    if ($humidity !== null && ($humidity < 0 || $humidity > 100)) {
        $humidity = null;
    }

    $hasNonTempWx = ($dir !== null || $spdKmh !== null || $gustKmh !== null || $pressure !== null || $humidity !== null);
    if (!$hasNonTempWx) {
        return null;
    }

    return [
        'dir'         => $dir,
        'spdKmh'      => $spdKmh,
        'gustKmh'     => $gustKmh,
        'tempC'       => $tempC,
        'pressureHpa' => $pressure,
        'humidityPct' => $humidity,
    ];
}

function parse_aprs_weather_fields(string $line): ?array {
    $colonPos = strpos($line, ':');
    $payload  = ($colonPos !== false) ? substr($line, $colonPos + 1) : $line;

    $dir      = null;
    $spdKmh   = null;
    $gustKmh  = null;
    $tempC    = null;
    $pressure = null;
    $humidity = null;

    if (preg_match('/_(\d{3})\/(\d{3})(?:g(\d{3}))?(?:t(-?\d{3}))?(?:h(\d{2,3}))?(?:b(\d{4,5}))?/', $payload, $wm)) {
        $dir    = (int)$wm[1];
        $spdKmh = (int)round((int)$wm[2] * 1.60934);
        if (isset($wm[3]) && $wm[3] !== '') {
            $gustKmh = (int)round((int)$wm[3] * 1.60934);
        }
        if (isset($wm[4]) && $wm[4] !== '') {
            $tempC = (int)round(((int)$wm[4] - 32) * 5.0 / 9.0);
        }
        if (isset($wm[5]) && $wm[5] !== '') {
            $rawH = (int)$wm[5];
            $humidity = ($rawH === 0) ? 100 : min(100, max(0, $rawH));
        }
        if (isset($wm[6]) && $wm[6] !== '') {
            $pressure = round((int)$wm[6] / 10.0, 1);
        }
    }

    if ($tempC === null && preg_match('/(?:^|[\s,(])([+-]?\d{1,2}(?:\.\d+)?)\s*°?C(?=$|[\s,;)\/])/u', $payload, $cm)) {
        $tempC = (int)round((float)$cm[1]);
    }

    if ($humidity === null && preg_match('/(?:^|[\s,(])(?:rh\s*[:=]?\s*|hum(?:idity)?\s*[:=]?\s*)?(\d{1,3})\s*%(?=$|[\s,;)\/])/i', $payload, $pm)) {
        $rawPct = (int)$pm[1];
        if ($rawPct >= 0 && $rawPct <= 100) {
            $humidity = $rawPct;
        }
    }

    if ($pressure === null) {
        if (preg_match('/(?:^|[\s,(])(\d{3,4}(?:\.\d+)?)\s*(?:hpa|mbar)(?=$|[\s,;)\/])/i', $payload, $hpm)) {
            $pressure = round((float)$hpm[1], 1);
        } elseif (!preg_match('/_\d{3}\/\d{3}/', $payload) && preg_match('/(?:^|[\s,(])b(\d{4,5})(?=$|[\s,;)\/])/', $payload, $bm)) {
            $pressure = round((int)$bm[1] / 10.0, 1);
        }
    }

    return sanitize_weather_array([
        'dir'         => $dir,
        'spdKmh'      => $spdKmh,
        'gustKmh'     => $gustKmh,
        'tempC'       => $tempC,
        'pressureHpa' => $pressure,
        'humidityPct' => $humidity,
    ]);
}

function register_station_alias(array &$stationAliases, string $a, string $b): void {
    $ka = strtolower(trim($a));
    $kb = strtolower(trim($b));
    if ($ka === '' || $kb === '' || $ka === $kb) return;
    if (!isset($stationAliases[$ka])) $stationAliases[$ka] = [];
    if (!isset($stationAliases[$kb])) $stationAliases[$kb] = [];
    $stationAliases[$ka][$kb] = true;
    $stationAliases[$kb][$ka] = true;
}

function count_station_heard_24h(PDO $pdo, array $stationAliases, string $key, int $cutoff24h): int {
    $keys = expand_station_keys($stationAliases, $key);
    if (!$keys) return 0;
    $placeholders = implode(',', array_fill(0, count($keys), '?'));
    $sql = "SELECT COUNT(DISTINCT aircraft_id) FROM station_heard WHERE last_ts >= ? AND station_id IN ($placeholders)";
    $stmt = $pdo->prepare($sql);
    $stmt->execute(array_merge([$cutoff24h], $keys));
    return (int)$stmt->fetchColumn();
}

function refresh_station_heard_count(PDO $pdo, array &$stationState, array $stationAliases, array &$stationStatsDirty, string $key, int $cutoff24h): void {
    $k = strtolower(trim($key));
    if ($k === '' || !isset($stationState[$k])) return;
    $stationState[$k]['heard_24h'] = count_station_heard_24h($pdo, $stationAliases, $k, $cutoff24h);
    $stationStatsDirty[$k] = true;
}

function expand_station_keys(array $stationAliases, string $key): array {
    $root = strtolower(trim($key));
    if ($root === '') return [];
    $visited = [$root => true];
    $queue   = [$root];
    while ($queue) {
        $curr = array_shift($queue);
        foreach ($stationAliases[$curr] ?? [] as $alias => $_) {
            if (!isset($visited[$alias])) {
                $visited[$alias] = true;
                $queue[] = $alias;
            }
        }
    }
    return array_keys($visited);
}

$stationState = [];
$stationAliases = [];
$stationStatsDirty = [];
$cutoff24h = time() - EXPIRE_SECONDS;
foreach ($pdo->query('SELECT id, lat, lon, max_km, farthest_id, farthest_ts, heard_24h FROM stations') as $row) {
    $validRecord = ((int)$row['farthest_ts'] >= $cutoff24h);
    $sid = (string)$row['id'];
    $stationState[$sid] = [
        'lat'         => (float)$row['lat'],
        'lon'         => (float)$row['lon'],
        'max_km'      => $validRecord ? (float)$row['max_km'] : 0.0,
        'farthest_id' => $validRecord ? (string)$row['farthest_id'] : '',
        'farthest_ts' => $validRecord ? (int)$row['farthest_ts'] : 0,
        'heard_24h'   => max(0, (int)($row['heard_24h'] ?? 0)),
    ];
}

foreach ($pdo->query('SELECT s.id, n.name FROM stations s INNER JOIN names n ON s.id = n.id WHERE n.name != ""') as $nrow) {
    register_station_alias($stationAliases, (string)$nrow['id'], (string)$nrow['name']);
}

// Precompute heard_24h for existing stations so proxy can avoid heavy aggregation.
foreach (array_keys($stationState) as $sid) {
    refresh_station_heard_count($pdo, $stationState, $stationAliases, $stationStatsDirty, $sid, $cutoff24h);
}

try {
    $stmtSeed = $pdo->prepare('SELECT id, lat, lon, raw, timestamp FROM aircraft WHERE timestamp >= :cutoff AND is_emergency = 1');
    $stmtSeed->execute([':cutoff' => $cutoff24h]);
    $stmtSeedInsert = $pdo->prepare('
        INSERT OR IGNORE INTO alerts (id, status, lat, lon, raw, last_ts)
        VALUES (:id, :status, :lat, :lon, :raw, :ts)
    ');
    while ($sr = $stmtSeed->fetch(PDO::FETCH_ASSOC)) {
        $decodedStatus = detect_alert_status((string)$sr['raw']) ?? 'Emergency alert';
        $stmtSeedInsert->execute([
            ':id'     => (string)$sr['id'],
            ':status' => $decodedStatus,
            ':lat'    => (float)$sr['lat'],
            ':lon'    => (float)$sr['lon'],
            ':raw'    => (string)$sr['raw'],
            ':ts'     => (int)$sr['timestamp'],
        ]);
    }
} catch (Throwable $e) {
}

$stationWeatherState = [];
$stmtLoadWx = $pdo->prepare('SELECT id, wx_json, updated FROM station_weather WHERE updated >= :cutoff');
$stmtLoadWx->execute([':cutoff' => $cutoff24h]);
while ($wrow = $stmtLoadWx->fetch(PDO::FETCH_ASSOC)) {
    $decoded = json_decode((string)$wrow['wx_json'], true);
    if (is_array($decoded)) {
        $clean = sanitize_weather_array($decoded);
        if ($clean !== null) {
            $stationWeatherState[$wrow['id']] = [
                'wx'      => $clean,
                'updated' => (int)$wrow['updated'],
            ];
        }
    }
}

// --- Sync full OGN DDB once every 6 hours ---
$ddbUpdated = (int)$pdo->query('SELECT value FROM meta WHERE key = "ddb_updated"')->fetchColumn();
if ((time() - $ddbUpdated) >= DDB_SYNC_INTERVAL) {
    try {
        $ctx  = stream_context_create(['http' => ['timeout' => 15, 'user_agent' => 'OGN-Global-Collector/1.14']]);
        $body = @file_get_contents('https://ddb.glidernet.org/download/?j=1&t=1', false, $ctx);
        if ($body !== false) {
            $data = json_decode($body, true);
            unset($body);
            if (isset($data['devices']) && is_array($data['devices'])) {
                $stmtDdb = $pdo->prepare('
                    INSERT INTO ddb (id, callsign, registration, model, aircraft_type, raw_json)
                    VALUES (:id, :cn, :reg, :model, :type, :raw)
                    ON CONFLICT(id) DO UPDATE SET
                        callsign = excluded.callsign,
                        registration = excluded.registration,
                        model = excluded.model,
                        aircraft_type = excluded.aircraft_type,
                        raw_json = excluded.raw_json
                ');
                $stmtDdbMeta = $pdo->prepare('
                    INSERT INTO meta (key, value) VALUES ("ddb_updated", :ts)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value
                ');

                $pdo->beginTransaction();
                foreach ($data['devices'] as $rec) {
                    $rawId = (string)($rec['device_id'] ?? $rec['deviceId'] ?? $rec['id'] ?? '');
                    $id    = strtolower(substr(preg_replace('/[^0-9a-f]/i', '', $rawId), -6));
                    if (strlen($id) !== 6) continue;

                    $stmtDdb->execute([
                        ':id'    => $id,
                        ':cn'    => trim((string)($rec['cn'] ?? $rec['callsign'] ?? '')),
                        ':reg'   => trim((string)($rec['registration'] ?? '')),
                        ':model' => trim((string)($rec['aircraft_model'] ?? $rec['aircraftModel'] ?? $rec['model'] ?? '')),
                        ':type'  => (string)($rec['aircraft_type'] ?? $rec['aircraftType'] ?? ''),
                        ':raw'   => json_encode($rec, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE) ?: '{}',
                    ]);
                }
                $stmtDdbMeta->execute([':ts' => (string)time()]);
                $pdo->commit();
            }
            unset($data);
        }
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
    }
}

$stmtUpsertPos = $pdo->prepare('
    INSERT INTO aircraft (id, ddb_id, lat, lon, raw, timestamp, is_emergency)
    VALUES (:id, :ddb_id, :lat, :lon, :raw, :ts, :emerg)
    ON CONFLICT(id) DO UPDATE SET
        ddb_id = excluded.ddb_id,
        lat = excluded.lat,
        lon = excluded.lon,
        raw = excluded.raw,
        timestamp = excluded.timestamp,
        is_emergency = excluded.is_emergency
');
$stmtUpsertAlert = $pdo->prepare('
    INSERT INTO alerts (id, status, lat, lon, alt, raw, last_ts)
    VALUES (:id, :status, :lat, :lon, :alt, :raw, :ts)
    ON CONFLICT(id, status) DO UPDATE SET
        lat = COALESCE(excluded.lat, alerts.lat),
        lon = COALESCE(excluded.lon, alerts.lon),
        alt = COALESCE(excluded.alt, alerts.alt),
        raw = excluded.raw,
        last_ts = excluded.last_ts
');
$stmtUpsertTelemetry = $pdo->prepare('
    INSERT INTO telemetry (id, raw, timestamp)
    VALUES (:id, :raw, :ts)
    ON CONFLICT(id) DO UPDATE SET
        raw = excluded.raw,
        timestamp = excluded.timestamp
');
$stmtUpsertStationWx = $pdo->prepare('
    INSERT INTO station_weather (id, wx_json, updated)
    VALUES (:id, :wx_json, :updated)
    ON CONFLICT(id) DO UPDATE SET
        wx_json = excluded.wx_json,
        updated = excluded.updated
');
$stmtUpsertHeard = $pdo->prepare('
    INSERT INTO station_heard (station_id, aircraft_id, last_ts)
    VALUES (:sid, :aid, :ts)
    ON CONFLICT(station_id, aircraft_id) DO UPDATE SET
        last_ts = excluded.last_ts
');
$stmtInsertTrack = $pdo->prepare('
    INSERT OR IGNORE INTO tracks (id, ts, lat, lon, alt)
    VALUES (:id, :ts, :lat, :lon, :alt)
');
$stmtInsertThermal = $pdo->prepare('
    INSERT OR REPLACE INTO thermals (id, ts, lat, lon, intensity)
    VALUES (:id, :ts, :lat, :lon, :intensity)
');
$stmtThermalAllowed = $pdo->prepare("
    SELECT 1
    FROM aircraft a
    INNER JOIN ddb d ON a.ddb_id != '' AND a.ddb_id = d.id
    WHERE a.id = :id
      AND CAST(COALESCE(NULLIF(d.aircraft_type, ''), '0') AS INTEGER) IN (1, 7)
    LIMIT 1
");
$stmtTouchPos = $pdo->prepare('UPDATE aircraft SET timestamp = :ts WHERE id = :id');
$stmtUpsertName = $pdo->prepare('
    INSERT INTO names (id, name, updated)
    VALUES (:id, :name, :ts)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated = excluded.updated
');
$stmtUpsertStation = $pdo->prepare('
    INSERT INTO stations (id, lat, lon, max_km, farthest_id, farthest_ts, heard_24h, updated)
    VALUES (:id, :lat, :lon, :max_km, :fid, :fts, :heard_24h, :ts)
    ON CONFLICT(id) DO UPDATE SET
        lat = excluded.lat,
        lon = excluded.lon,
        max_km = CASE
            WHEN stations.farthest_ts < :cutoff OR excluded.max_km > stations.max_km THEN excluded.max_km
            ELSE stations.max_km
        END,
        farthest_id = CASE
            WHEN stations.farthest_ts < :cutoff OR excluded.max_km > stations.max_km THEN excluded.farthest_id
            ELSE stations.farthest_id
        END,
        farthest_ts = CASE
            WHEN stations.farthest_ts < :cutoff OR excluded.max_km > stations.max_km THEN excluded.farthest_ts
            ELSE stations.farthest_ts
        END,
        heard_24h = excluded.heard_24h,
        updated = excluded.updated
');
$stmtMeta = $pdo->prepare('
    INSERT INTO meta (key, value) VALUES ("updated", :ts)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
');

function record_station_weather(array &$stationWeatherState, array &$stationWxBatch, array $keys, array $incomingWx, int $ts): void {
    foreach ($keys as $rawKey) {
        $k = strtolower(trim((string)$rawKey));
        if ($k === '') continue;
        $existing = $stationWeatherState[$k]['wx'] ?? [];
        $merged = $existing;
        foreach ($incomingWx as $field => $val) {
            if ($val !== null) {
                $merged[$field] = $val;
            }
        }
        $clean = sanitize_weather_array($merged);
        if ($clean === null) continue;
        $prevTs = $stationWeatherState[$k]['updated'] ?? 0;
        $updatedTs = max($ts, $prevTs);
        $stationWeatherState[$k] = ['wx' => $clean, 'updated' => $updatedTs];
        $stationWxBatch[$k] = ['wx' => $clean, 'updated' => $updatedTs];
    }
}

function flush_batch(
    PDO $pdo,
    PDOStatement $stmtUpsertPos,
    PDOStatement $stmtUpsertAlert,
    PDOStatement $stmtUpsertTelemetry,
    PDOStatement $stmtUpsertStationWx,
    PDOStatement $stmtUpsertHeard,
    PDOStatement $stmtInsertTrack,
    PDOStatement $stmtInsertThermal,
    PDOStatement $stmtThermalAllowed,
    PDOStatement $stmtTouchPos,
    PDOStatement $stmtUpsertName,
    PDOStatement $stmtUpsertStation,
    PDOStatement $stmtMeta,
    array &$posBatch,
    array &$alertBatch,
    array &$telemetryBatch,
    array &$stationWxBatch,
    array &$heardBatch,
    array &$trackBatch,
    array &$thermalBatch,
    array &$touchBatch,
    array &$nameBatch,
    array &$stationBatch,
    array &$stationState,
    array $stationAliases,
    array &$stationStatsDirty,
    bool $prune = false
): array {
    $now = time();
    $cutoff = $now - EXPIRE_SECONDS;
    $heardByStation = [];
    $pruneStats = ['deleted_rows' => 0];
    $pdo->beginTransaction();
    try {
        foreach ($posBatch as $id => $p) {
            $stmtUpsertPos->execute([
                ':id'     => $id,
                ':ddb_id' => $p['ddb_id'],
                ':lat'    => $p['lat'],
                ':lon'    => $p['lon'],
                ':raw'    => $p['raw'],
                ':ts'     => $p['ts'],
                ':emerg'  => $p['is_emergency'],
            ]);
        }
        foreach ($alertBatch as $al) {
            $stmtUpsertAlert->execute([
                ':id'     => $al['id'],
                ':status' => $al['status'],
                ':lat'    => $al['lat'],
                ':lon'    => $al['lon'],
                ':alt'    => $al['alt'],
                ':raw'    => $al['raw'],
                ':ts'     => $al['ts'],
            ]);
        }
        foreach ($telemetryBatch as $id => $tel) {
            $stmtUpsertTelemetry->execute([
                ':id'  => $id,
                ':raw' => $tel['raw'],
                ':ts'  => $tel['ts'],
            ]);
        }
        foreach ($stationWxBatch as $sid => $w) {
            $encoded = json_encode($w['wx'], JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
            if ($encoded !== false) {
                $stmtUpsertStationWx->execute([
                    ':id'      => $sid,
                    ':wx_json' => $encoded,
                    ':updated' => $w['updated'],
                ]);
            }
        }
        foreach ($heardBatch as $hKey => $h) {
            $stmtUpsertHeard->execute([
                ':sid' => $h['sid'],
                ':aid' => $h['aid'],
                ':ts'  => $h['ts'],
            ]);
            $sidH = strtolower((string)$h['sid']);
            if ($sidH !== '') $heardByStation[$sidH] = true;
        }
        foreach ($trackBatch as $t) {
            $stmtInsertTrack->execute([
                ':id'  => $t['id'],
                ':ts'  => $t['ts'],
                ':lat' => $t['lat'],
                ':lon' => $t['lon'],
                ':alt' => $t['alt'],
            ]);
        }
        foreach ($thermalBatch as $th) {
            $allowed = $th['typeKnown'] ? in_array($th['type'], [1, 7], true) : null;
            if ($allowed === null) {
                $stmtThermalAllowed->execute([':id' => $th['id']]);
                $allowed = (bool)$stmtThermalAllowed->fetchColumn();
            }
            if (!$allowed) continue;
            $stmtInsertThermal->execute([
                ':id'        => $th['id'],
                ':ts'        => $th['ts'],
                ':lat'       => $th['lat'],
                ':lon'       => $th['lon'],
                ':intensity' => $th['intensity'],
            ]);
        }
        foreach ($touchBatch as $id => $ts) {
            if (!isset($posBatch[$id])) {
                $stmtTouchPos->execute([':id' => $id, ':ts' => $ts]);
            }
        }
        foreach ($nameBatch as $id => $name) {
            $stmtUpsertName->execute([':id' => $id, ':name' => $name, ':ts' => $now]);
        }
        if ($prune) {
            $pruneSql = [
                'DELETE FROM aircraft WHERE timestamp < ' . $cutoff,
                'DELETE FROM alerts WHERE last_ts < ' . $cutoff,
                'DELETE FROM telemetry WHERE timestamp < ' . $cutoff,
                'DELETE FROM station_weather WHERE updated < ' . $cutoff,
                'DELETE FROM station_heard WHERE last_ts < ' . $cutoff,
                'DELETE FROM tracks WHERE ts < ' . ($now - TRACK_EXPIRE_SECONDS),
                'DELETE FROM thermals WHERE ts < ' . ($now - TRACK_EXPIRE_SECONDS),
                'UPDATE stations SET max_km = 0, farthest_id = "", farthest_ts = 0 WHERE farthest_ts > 0 AND farthest_ts < ' . $cutoff,
                'DELETE FROM stations WHERE updated < ' . $cutoff,
            ];
            foreach ($pruneSql as $sql) {
                $stmtPr = $pdo->prepare($sql);
                $stmtPr->execute();
                $pruneStats['deleted_rows'] += (int)$stmtPr->rowCount();
            }
        }

        // Precompute 24h station heard counts so live proxy avoids expensive aggregation.
        if (!empty($heardByStation) || $prune) {
            $recomputeKeys = [];
            if ($prune) {
                foreach (array_keys($stationState) as $sidAll) $recomputeKeys[$sidAll] = true;
            } else {
                foreach (array_keys($heardByStation) as $sidTouched) {
                    foreach (expand_station_keys($stationAliases, $sidTouched) as $aliasKey) {
                        if (isset($stationState[$aliasKey])) $recomputeKeys[$aliasKey] = true;
                    }
                }
            }
            foreach (array_keys($recomputeKeys) as $sidRecompute) {
                refresh_station_heard_count($pdo, $stationState, $stationAliases, $stationStatsDirty, $sidRecompute, $cutoff);
            }
        }

        foreach ($stationStatsDirty as $sidDirty => $_) {
            if (!isset($stationState[$sidDirty])) continue;
            $s = $stationState[$sidDirty];
            $stmtUpsertStation->execute([
                ':id'       => $sidDirty,
                ':lat'      => $s['lat'],
                ':lon'      => $s['lon'],
                ':max_km'   => $s['max_km'],
                ':fid'      => $s['farthest_id'],
                ':fts'      => $s['farthest_ts'],
                ':heard_24h' => max(0, (int)($s['heard_24h'] ?? 0)),
                ':ts'       => $now,
                ':cutoff'   => $cutoff,
            ]);
        }

        $stmtMeta->execute([':ts' => (string)$now]);
        $pdo->commit();
        $stationStatsDirty = [];
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
    }

    $posBatch       = [];
    $alertBatch     = [];
    $telemetryBatch = [];
    $stationWxBatch = [];
    $heardBatch     = [];
    $trackBatch     = [];
    $thermalBatch   = [];
    $touchBatch     = [];
    $nameBatch      = [];
    $stationBatch   = [];

    return $pruneStats;
}

$errno = 0;
$errstr = '';
$socket = @stream_socket_client('tcp://aprs.glidernet.org:14580', $errno, $errstr, 5, STREAM_CLIENT_CONNECT);
if (!$socket) {
    flock($lockFp, LOCK_UN);
    fclose($lockFp);
    exit(1);
}

stream_set_timeout($socket, 2);
fwrite($socket, "user PARAGUIDE pass -1 vers OGN-Global-Collector 1.14 filter a/90/-180/-90/180\r\n");

$deadline  = microtime(true) + RUN_SECONDS;
$lastFlush = microtime(true);

$posBatch       = [];
$alertBatch     = [];
$telemetryBatch = [];
$stationWxBatch = [];
$heardBatch     = [];
$trackBatch     = [];
$thermalBatch   = [];
$touchBatch     = [];
$nameBatch      = [];
$stationBatch   = [];
$lastTrackPoint = [];
$lastThermalPoint = [];
$lastKnownPos   = [];
$lastPruneTs    = (int)$pdo->query('SELECT value FROM meta WHERE key = "last_prune_ts"')->fetchColumn();
$lastVacuumTs   = (int)$pdo->query('SELECT value FROM meta WHERE key = "last_vacuum_ts"')->fetchColumn();

while (microtime(true) < $deadline && !feof($socket)) {
    $line = fgets($socket, 1024);

    if ($line !== false) {
        $line = trim($line);
        if ($line !== '' && $line[0] !== '#' && strpos($line, '>') !== false) {
            if (!preg_match('/^([^>]+)>/', $line, $cm)) {
                continue;
            }
            $callsign = trim($cm[1]);
            if ($callsign === '') {
                continue;
            }
            $id = strtolower($callsign);

            $ddbId = '';
            if (preg_match('/\bid[0-9a-fA-F]{8,10}\b/i', $line, $m)) {
                $ddbId = strtolower(substr($m[0], -6));
            } elseif (preg_match('/([0-9A-F]{6})$/i', $callsign, $hm)) {
                $ddbId = strtolower($hm[1]);
            }

            $now = time();

            $streamName = extract_ogn_stream_name($line);
            if ($streamName !== '') {
                $nameBatch[$id] = $streamName;
                if ($ddbId !== '') {
                    register_station_alias($stationAliases, $id, $ddbId);
                    register_station_alias($stationAliases, $ddbId, $streamName);
                }
                register_station_alias($stationAliases, $id, $streamName);
            }

            $wxFields = parse_aprs_weather_fields($line);
            $alertStatus = detect_alert_status($line);

            if (preg_match('/(\d{6})h(\d{2})(\d{2}\.\d+)([NS])(.)(\d{3})(\d{2}\.\d+)([EW])(.)/', $line, $bm, PREG_OFFSET_CAPTURE)) {
                $lat = (int)$bm[2][0] + ((float)$bm[3][0] / 60.0);
                if ($bm[4][0] === 'S') $lat = -$lat;

                $lon = (int)$bm[6][0] + ((float)$bm[7][0] / 60.0);
                if ($bm[8][0] === 'W') $lon = -$lon;

                if (abs($lat) > 90.0 || abs($lon) > 180.0 || ($lat == 0.0 && $lon == 0.0)) {
                    continue;
                }

                $sym = $bm[9][0];
                $isStation = ($sym === '_' || $sym === '&' || $sym === '#' || $sym === 'r');
                $type = $isStation ? 15 : 0;

                if (preg_match('/\bid([0-9a-fA-F]{2})[0-9a-fA-F]{6,8}\b/i', $line, $idm)) {
                    $parsedType = (hexdec($idm[1]) >> 2) & 0x0F;
                    if (!$isStation && $parsedType > 0) {
                        if ($parsedType === 15 && (preg_match('/\bFNT7[0-9a-f]\b/i', $line) || preg_match('/^FNT[0-9a-f]{6}>/i', $line))) {
                            $type = 7;
                        } elseif ($parsedType === 7 && preg_match('/^[^>]+>OGADSB\b/i', $line)) {
                            $type = 16;
                        } else {
                            $type = $parsedType;
                        }
                    }
                } elseif ($type === 0) {
                    if ($sym === 'g') $type = 7;
                    elseif ($sym === "'") $type = 1;
                    elseif ($sym === '^') $type = 8;
                    elseif ($sym === 'X') $type = 3;
                    elseif ($sym === 'O') $type = 11;
                }

                $remainder = substr($line, $bm[0][1] + strlen($bm[0][0]));
                $speed = null;
                if (preg_match('/^(\d{3})\/(\d{3})/', $remainder, $csm) && $sym !== '_') {
                    $speed = (int)$csm[2] * 1.852;
                }
                $alt = null;
                if (preg_match('/\/A=(-?\d{6})/', $remainder, $am)) {
                    $alt = round((int)$am[1] * 0.3048, 1);
                }

                if ($alt !== null && ($alt < -500.0 || ($type !== 11 && $alt > 18000.0))) {
                    continue;
                }
                if ($speed !== null && $speed > 1300.0) {
                    continue;
                }
                if (in_array($type, [4, 6, 7, 13], true) && (($alt !== null && $alt > 10000.0) || ($speed !== null && $speed > 250.0))) {
                    continue;
                }
                if ($type === 1 && (($alt !== null && $alt > 16000.0) || ($speed !== null && $speed > 400.0))) {
                    continue;
                }

                $prevKnown = $lastKnownPos[$id] ?? null;
                $alertAlt = $alt;
                if ($alertAlt === null && is_array($prevKnown) && array_key_exists('alt', $prevKnown) && $prevKnown['alt'] !== null) {
                    $prevLat = (float)($prevKnown['lat'] ?? 0.0);
                    $prevLon = (float)($prevKnown['lon'] ?? 0.0);
                    $distM = haversine_km($prevLat, $prevLon, $lat, $lon) * 1000.0;
                    if ($distM <= 20.0) $alertAlt = (float)$prevKnown['alt'];
                }

                $lastKnownPos[$id] = ['lat' => $lat, 'lon' => $lon, 'alt' => ($alt !== null ? $alt : ($prevKnown['alt'] ?? null))];
                $posBatch[$id] = [
                    'ddb_id'       => $ddbId,
                    'lat'          => $lat,
                    'lon'          => $lon,
                    'raw'          => $line,
                    'ts'           => $now,
                    'is_emergency' => is_emergency_packet($line),
                ];

                if ($alertStatus !== null) {
                    $alertBatch[$id . '|' . $alertStatus] = [
                        'id'     => $id,
                        'status' => $alertStatus,
                        'lat'    => $lat,
                        'lon'    => $lon,
                        'alt'    => $alertAlt,
                        'raw'    => $line,
                        'ts'     => $now,
                    ];
                }

                if ($wxFields !== null) {
                    $wxKeys = [$id];
                    if ($streamName !== '') $wxKeys[] = $streamName;
                    record_station_weather($stationWeatherState, $stationWxBatch, $wxKeys, $wxFields, $now);
                }

                if ($isStation) {
                    $stationKeys = [$id];
                    if ($streamName !== '') {
                        $stationKeys[] = strtolower($streamName);
                        register_station_alias($stationAliases, $id, $streamName);
                    }
                    foreach ($stationKeys as $sk) {
                        $existing = $stationState[$sk] ?? ['max_km' => 0.0, 'farthest_id' => '', 'farthest_ts' => 0];
                        $stationState[$sk] = [
                            'lat'         => $lat,
                            'lon'         => $lon,
                            'max_km'      => $existing['max_km'],
                            'farthest_id' => $existing['farthest_id'],
                            'farthest_ts' => $existing['farthest_ts'],
                        ];
                        $stationBatch[$sk] = $stationState[$sk];
                    }
                } else {
                    if (preg_match('/q[A-Z]{2},([^:,]+)[:,]/', $line, $rxm)) {
                        $rxKey = strtolower(trim($rxm[1]));
                        if ($rxKey !== '') {
                            foreach (expand_station_keys($stationAliases, $rxKey) as $aliasKey) {
                                $heardBatch[$aliasKey . '|' . $id] = ['sid' => $aliasKey, 'aid' => $id, 'ts' => $now];
                            }
                        }
                        if (isset($stationState[$rxKey])) {
                            $st = $stationState[$rxKey];
                            $km = haversine_km($st['lat'], $st['lon'], $lat, $lon);
                            if ($km <= MAX_RX_RANGE_KM) {
                                $expired = ($st['farthest_ts'] < ($now - EXPIRE_SECONDS));
                                if ($expired || $km > $st['max_km']) {
                                    $stationState[$rxKey]['max_km']      = round($km, 1);
                                    $stationState[$rxKey]['farthest_id'] = $id;
                                    $stationState[$rxKey]['farthest_ts'] = $now;
                                    $stationBatch[$rxKey] = $stationState[$rxKey];
                                }
                            }
                        }
                    }

                    if ($type === 7) {
                        $logPoint = true;
                    } else {
                        $prev = $lastTrackPoint[$id] ?? null;
                        $moved = ($prev === null)
                            || (abs($lat - $prev['lat']) > 0.0002)
                            || (abs($lon - $prev['lon']) > 0.0002);
                        $elapsed = ($prev === null) || (($now - $prev['ts']) >= TRACK_MIN_INTERVAL);
                        $logPoint = ($moved && $elapsed);
                    }

                    if ($logPoint) {
                        $trackBatch[] = [
                            'id'  => $id,
                            'ts'  => $now,
                            'lat' => $lat,
                            'lon' => $lon,
                            'alt' => $alt,
                        ];
                        $lastTrackPoint[$id] = ['lat' => $lat, 'lon' => $lon, 'ts' => $now];
                    }

                    // Precompute thermal climbs so the heatmap never scans the tracks table.
                    // Packet type wins; DDB is only consulted when the packet has no type.
                    if ($alt !== null) {
                        $thermalPrev = $lastThermalPoint[$id] ?? null;
                        if ($thermalPrev !== null) {
                            $dt = $now - $thermalPrev['ts'];
                            if ($dt >= 3 && $dt <= 120) {
                                $climb = ($alt - $thermalPrev['alt']) / $dt;
                                if ($climb >= 1.5 && $climb <= 15.0) {
                                    $thermalBatch[$id . '|' . $now] = [
                                        'id'        => $id,
                                        'ts'        => $now,
                                        'lat'       => $lat,
                                        'lon'       => $lon,
                                        'intensity' => round(min(1.0, $climb / 5.0), 2),
                                        'type'      => (int)$type,
                                        'typeKnown' => $type > 0,
                                    ];
                                }
                            }
                        }
                        $lastThermalPoint[$id] = ['ts' => $now, 'alt' => $alt];
                    }
                }
            } else {
                $touchBatch[$id] = $now;
                if ($alertStatus !== null) {
                    $pos = $lastKnownPos[$id] ?? ['lat' => null, 'lon' => null];
                    $alertBatch[$id . '|' . $alertStatus] = [
                        'id'     => $id,
                        'status' => $alertStatus,
                        'lat'    => $pos['lat'],
                        'lon'    => $pos['lon'],
                        'raw'    => $line,
                        'ts'     => $now,
                    ];
                }
                if ($wxFields !== null || preg_match('/(?:hPa|mbar|%|\b[+-]?\d+(?:\.\d+)?C\b)/i', $line)) {
                    $telemetryBatch[$id] = [
                        'raw' => $line,
                        'ts'  => $now,
                    ];
                }
                if ($wxFields !== null) {
                    $wxKeys = [$id];
                    if ($streamName !== '') $wxKeys[] = $streamName;
                    record_station_weather($stationWeatherState, $stationWxBatch, $wxKeys, $wxFields, $now);
                }
            }
        }
    }

    if ((microtime(true) - $lastFlush) >= FLUSH_INTERVAL) {
        $nowTs = time();
        $doPrune = ($nowTs - $lastPruneTs) >= 3600;
        $flushStats = flush_batch($pdo, $stmtUpsertPos, $stmtUpsertAlert, $stmtUpsertTelemetry, $stmtUpsertStationWx, $stmtUpsertHeard, $stmtInsertTrack, $stmtInsertThermal, $stmtThermalAllowed, $stmtTouchPos, $stmtUpsertName, $stmtUpsertStation, $stmtMeta, $posBatch, $alertBatch, $telemetryBatch, $stationWxBatch, $heardBatch, $trackBatch, $thermalBatch, $touchBatch, $nameBatch, $stationBatch, $stationState, $stationAliases, $stationStatsDirty, $doPrune);
        if ($doPrune) {
            $lastPruneTs = $nowTs;
            $stmtMetaKey = $pdo->prepare('INSERT INTO meta (key, value) VALUES (:k, :v) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
            $stmtMetaKey->execute([':k' => 'last_prune_ts', ':v' => (string)$nowTs]);
            $deletedRows = (int)($flushStats['deleted_rows'] ?? 0);
            if ($deletedRows > 0 && ($nowTs - $lastVacuumTs) >= 21600) {
                try {
                    $pdo->exec('PRAGMA incremental_vacuum(500);');
                    $pdo->exec('PRAGMA wal_checkpoint(TRUNCATE);');
                    $lastVacuumTs = $nowTs;
                    $stmtMetaKey->execute([':k' => 'last_vacuum_ts', ':v' => (string)$nowTs]);
                } catch (Throwable $e) {
                }
            }
        }
        $lastFlush = microtime(true);
    }
}

fclose($socket);
$nowTs = time();
$doFinalPrune = ($nowTs - $lastPruneTs) >= 3600;
$finalStats = flush_batch($pdo, $stmtUpsertPos, $stmtUpsertAlert, $stmtUpsertTelemetry, $stmtUpsertStationWx, $stmtUpsertHeard, $stmtInsertTrack, $stmtInsertThermal, $stmtThermalAllowed, $stmtTouchPos, $stmtUpsertName, $stmtUpsertStation, $stmtMeta, $posBatch, $alertBatch, $telemetryBatch, $stationWxBatch, $heardBatch, $trackBatch, $thermalBatch, $touchBatch, $nameBatch, $stationBatch, $stationState, $stationAliases, $stationStatsDirty, $doFinalPrune);
if ($doFinalPrune) {
    $stmtMetaKey = $pdo->prepare('INSERT INTO meta (key, value) VALUES (:k, :v) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    $stmtMetaKey->execute([':k' => 'last_prune_ts', ':v' => (string)$nowTs]);
    $lastPruneTs = $nowTs;
    $deletedRows = (int)($finalStats['deleted_rows'] ?? 0);
    if ($deletedRows > 0 && ($nowTs - $lastVacuumTs) >= 21600) {
        try {
            $pdo->exec('PRAGMA incremental_vacuum(500);');
            $pdo->exec('PRAGMA wal_checkpoint(TRUNCATE);');
            $stmtMetaKey->execute([':k' => 'last_vacuum_ts', ':v' => (string)$nowTs]);
            $lastVacuumTs = $nowTs;
        } catch (Throwable $e) {
        }
    }
}

flock($lockFp, LOCK_UN);
fclose($lockFp);
