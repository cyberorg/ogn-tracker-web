<?php
/*
 * OGN Viewport, Track, Thermal & Replay API (SQLite + local DDB + Gzip + Cache)
 *   Live viewport: ogn-proxy.php?live=1&north=...&south=...&east=...&west=...&window=<sec>&meta=<0|1>
 *   Last known:    ogn-proxy.php?info=1&id=<aircraft_id> (24-hour last-known position for shared links)
 *   Track:         ogn-proxy.php?track=1&id=<aircraft_id>&window=<sec> (or &since=<unix_ts>, &full=1)
 *   Thermals:      ogn-proxy.php?thermals=1&north=...&south=...&east=...&west=...
 *   Replay:        ogn-proxy.php?replay=1&ts=<unix_ts>&north=...&south=...&east=...&west=...
 */
declare(strict_types=1);

const THERMAL_CACHE_TTL = 600;
const SOUNDING_CACHE_TTL = 60;
const SOUNDING_MAX_TRACK_ROWS = 24000;
const SOUNDING_MAX_POINTS_PER_AC = 200;
const STALE_CACHE_MAX_AGE = 300;

if (!ob_start('ob_gzhandler')) {
    ob_start();
}

header('Content-Type: application/json; charset=utf-8');

$dbFile   = __DIR__ . '/ogn-live.sqlite';
$cacheDir = rtrim(sys_get_temp_dir(), '/\\') . '/ogn_tracker_cache';

function cache_get(string $cacheDir, string $key, int $ttl): ?string {
    $file = $cacheDir . '/' . $key . '.json';
    if (is_file($file) && (time() - (int)@filemtime($file)) < $ttl) {
        $data = @file_get_contents($file);
        if ($data !== false) return $data;
    }
    return null;
}

function cache_set(string $cacheDir, string $key, string $payload): void {
    if (!is_dir($cacheDir)) {
        @mkdir($cacheDir, 0755, true);
    }
    $file = $cacheDir . '/' . $key . '.json';
    $tmp  = $file . '.' . getmypid() . '.tmp';
    if (@file_put_contents($tmp, $payload, LOCK_EX) !== false) {
        @rename($tmp, $file);
    }
    // Expired cache files are pruned by the collector's hourly maintenance
    // (prune_proxy_cache()); do not scan the directory on viewer requests.
}

function clean_ogn_name($value): string {
    $raw = (string)$value;
    // APRS name fields can carry bytes from legacy or corrupted encodings. Reject
    // anything that is not valid UTF-8 instead of converting it: the previous
    // Windows-1252 fallback produced visible mojibake such as "Aˆ".
    if ($raw === '' || !preg_match('//u', $raw)) return '';
    if (preg_match('/[\x00-\x1F\x7F\x{80}-\x{9F}]/u', $raw) || preg_match('/[\x{2400}-\x{243F}\x{FFFD}]/u', $raw)) return '';
    return trim(preg_replace('/\s+/u', ' ', $raw) ?? $raw);
}

function extract_ogn_stream_name(string $line): string {
    if (!preg_match('/Name="([^"]*)"/', $line, $m)) return '';
    return clean_ogn_name($m[1]);
}

function open_db(string $dbFile): PDO {
    $pdo = new PDO('sqlite:' . $dbFile, null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    ]);
    $pdo->exec('PRAGMA query_only=ON;');
    $pdo->exec('PRAGMA busy_timeout=10000;');
    return $pdo;
}

function normalize_lon_value(float $lon): float {
    $lon = fmod($lon, 360.0);
    if ($lon < -180.0) $lon += 360.0;
    if ($lon > 180.0) $lon -= 360.0;
    return $lon;
}

function parse_bounds(): ?array {
    $north = filter_input(INPUT_GET, 'north', FILTER_VALIDATE_FLOAT);
    $south = filter_input(INPUT_GET, 'south', FILTER_VALIDATE_FLOAT);
    $east  = filter_input(INPUT_GET, 'east', FILTER_VALIDATE_FLOAT);
    $west  = filter_input(INPUT_GET, 'west', FILTER_VALIDATE_FLOAT);

    if ($north === false || $south === false || $east === false || $west === false ||
        $north === null  || $south === null  || $east === null  || $west === null) {
        return null;
    }

    $south = max(-90.0, min(90.0, floor($south * 10.0) / 10.0));
    $north = max(-90.0, min(90.0, ceil($north * 10.0) / 10.0));
    $wRaw  = floor($west * 10.0) / 10.0;
    $eRaw  = ceil($east * 10.0) / 10.0;
    $fullWorld = (($east - $west) >= 360.0) || (($eRaw - $wRaw) >= 360.0);

    if ($fullWorld) {
        return [$south, $north, -180.0, 180.0, true];
    }

    if ($eRaw < $wRaw) {
        // The client can send either 179.9,-180.0 (a short step east) or
        // -179.5,-180.5 (a short step west across the antimeridian). Pick the
        // shorter world-copy interval before normalizing so a normal viewport
        // is not turned into a near-world span or a wrong-hemisphere sliver.
        $viaEast = ($eRaw + 360.0) - $wRaw;
        $viaWest = $wRaw - $eRaw;
        if ($viaWest < $viaEast) {
            $w = normalize_lon_value($eRaw);
            $e = normalize_lon_value($wRaw);
        } else {
            $w = normalize_lon_value($wRaw);
            $e = normalize_lon_value($eRaw + 360.0);
        }
    } else {
        $w = normalize_lon_value($wRaw);
        $e = normalize_lon_value($eRaw);
    }

    // $w > $e is the existing convention for an antimeridian-crossing viewport.
    return [$south, $north, $w, $e, false];
}

function sounding_haversine_km(float $lat1, float $lon1, float $lat2, float $lon2): float {
    $dLat = deg2rad($lat2 - $lat1);
    $dLon = deg2rad($lon2 - $lon1);
    $a = sin($dLat / 2.0) ** 2 + cos(deg2rad($lat1)) * cos(deg2rad($lat2)) * sin($dLon / 2.0) ** 2;
    return 6371.0 * 2.0 * atan2(sqrt($a), sqrt(1.0 - $a));
}

function sounding_bearing_deg(float $lat1, float $lon1, float $lat2, float $lon2): float {
    $phi1 = deg2rad($lat1);
    $phi2 = deg2rad($lat2);
    $dLon = deg2rad($lon2 - $lon1);
    $y = sin($dLon) * cos($phi2);
    $x = cos($phi1) * sin($phi2) - sin($phi1) * cos($phi2) * cos($dLon);
    return (rad2deg(atan2($y, $x)) + 360.0) % 360.0;
}

function sounding_angle_delta(float $from, float $to): float {
    $delta = ($to - $from + 540.0) % 360.0 - 180.0;
    return $delta;
}

/** Circular median direction: the observed direction with the lowest total angular distance. */
function sounding_circular_median_dir(array $dirs): ?float {
    if (!$dirs) return null;
    $bestDir = (float)$dirs[0];
    $bestScore = INF;
    foreach ($dirs as $candidate) {
        $score = 0.0;
        foreach ($dirs as $dir) {
            $score += abs(sounding_angle_delta((float)$candidate, (float)$dir));
        }
        if ($score < $bestScore) {
            $bestScore = $score;
            $bestDir = (float)$candidate;
        }
    }
    return $bestDir;
}

/** Resolved type: packet-derived type first, DDB only when the packet has none. */
function sounding_aircraft_type(string $raw, $ddbType): int {
    if (preg_match('/\bid([0-9a-fA-F]{2})[0-9a-fA-F]{6,8}\b/', $raw, $m)) {
        $parsed = (hexdec($m[1]) >> 2) & 0x0F;
        if ($parsed > 0) return $parsed === 15 ? 7 : $parsed; // FANET ground beacons use type 15 in the packet
    }
    if (preg_match('/[NS][\\\\\/][0-9]{5}\.[0-9]{2}[EW]([_&#r])/', $raw)) return 15;
    $ddb = (int)$ddbType;
    return ($ddb >= 1 && $ddb <= 16) ? $ddb : 0;
}

/** Bolton convective LCL above ground, in metres. Null for unusable humidity. */
function sounding_lcl_agl(?float $tempC, ?float $humidityPct): ?float {
    if ($tempC === null || $humidityPct === null) return null;
    if ($tempC < -50.0 || $tempC > 55.0 || $humidityPct < 10.0 || $humidityPct > 100.0) return null;
    $t = $tempC;
    $rh = max(1.0, $humidityPct) / 100.0;
    $a = 17.625;
    $b = 243.04;
    $gamma = log($rh) + ($a * $t) / ($b + $t);
    $td = $b * $gamma / ($a - $gamma);
    $tk = $t + 273.15;
    $tdk = $td + 273.15;
    $lclK = 1.0 / (1.0 / ($tdk - 56.0) + log($tk / $tdk) / 800.0) + 56.0;
    // Bolton gives the LCL temperature; convert the temperature deficit to
    // height with the dry adiabatic lapse rate (9.8 K/km).
    $agl = ($tk - $lclK) / 0.0098;
    return is_finite($agl) ? max(0.0, $agl) : null;
}

function sounding_percentile(array $values, float $pct): ?float {
    if (!$values) return null;
    sort($values, SORT_NUMERIC);
    $idx = (int)ceil(count($values) * $pct / 100.0) - 1;
    return $values[max(0, min(count($values) - 1, $idx))];
}

function link_station_alias(array &$aliasGraph, string $a, string $b): void {
    $ka = strtolower(trim($a));
    $kb = strtolower(trim($b));
    if ($ka === '' || $kb === '' || $ka === $kb) return;
    if (!isset($aliasGraph[$ka])) $aliasGraph[$ka] = [];
    if (!isset($aliasGraph[$kb])) $aliasGraph[$kb] = [];
    $aliasGraph[$ka][$kb] = true;
    $aliasGraph[$kb][$ka] = true;
}

function expand_station_alias_set(array $aliasGraph, string $key): array {
    $root = strtolower(trim($key));
    if ($root === '') return [];
    $visited = [$root => true];
    $queue   = [$root];
    while ($queue) {
        $curr = array_shift($queue);
        foreach ($aliasGraph[$curr] ?? [] as $alias => $_) {
            if (!isset($visited[$alias])) {
                $visited[$alias] = true;
                $queue[] = $alias;
            }
        }
    }
    return array_keys($visited);
}

function clean_alert_status($value): string {
    $status = trim((string)$value);
    $colon = strpos($status, ':');
    return $colon === false ? $status : rtrim(substr($status, 0, $colon));
}

function format_packet_status(string $line, string $fallback = 'Normal'): string {
    static $fanetMap = [
        '0' => 'Other',
        '1' => 'Airborne',
        '2' => 'Vehicle',
        '3' => 'Bike',
        '4' => 'Boot',
        '8' => 'Need a ride',
        '9' => 'Landed well',
        'c' => 'Need technical support',
        'd' => 'Need medical help',
        'e' => 'Distress call',
        'f' => 'Distress call automatically',
    ];
    if (preg_match('/\bFNT([17])([0-9a-f])\b/i', $line, $fm)) {
        if ($fm[1] === '1') return 'Airborne';
        $hex = strtolower($fm[2]);
        if (isset($fanetMap[$hex])) return $fanetMap[$hex];
    }
    if (preg_match('/\bsq(7700|7600|7500)\b/i', $line, $sm)) {
        $sqMap = [
            '7700' => 'Squawk 7700 (Emergency)',
            '7600' => 'Squawk 7600 (Radio Failure)',
            '7500' => 'Squawk 7500 (Hijack)',
        ];
        return $sqMap[$sm[1]];
    }
    if (preg_match('/^[^>]+>EMERGENCY[,:]/i', $line)) return 'APRS Emergency';
    $colonPos = strpos($line, ':');
    if ($colonPos !== false) {
        $payload = trim(substr($line, $colonPos + 1));
        if (preg_match('/\b(MAYDAY|SOS|EMERGENCY)\b/i', $payload, $km)) {
            return 'Alert (' . strtoupper($km[1]) . ')';
        }
    }
    return clean_alert_status($fallback);
}

function extract_altitude_from_raw(string $raw): ?float
{
    if (preg_match('/\/A=(-?\d{6})/', $raw, $m)) {
        return round((int)$m[1] * 0.3048, 1);
    }
    return null;
}

// --- 1. Last-known aircraft info (for shared links) ---
if (isset($_GET['info']) && $_GET['info'] === '1') {
    $id = strtolower(trim((string)($_GET['id'] ?? '')));
    if ($id === '' || !preg_match('/^[a-z0-9_-]{1,20}$/', $id)) {
        http_response_code(400);
        header('Cache-Control: no-store');
        echo json_encode(['id' => $id, 'found' => false, 'error' => 'Invalid aircraft id']);
        exit;
    }

    header('Cache-Control: public, max-age=5');
    $cacheKey = 'info_' . md5($id);
    if (($cached = cache_get($cacheDir, $cacheKey, 5)) !== null) {
        echo $cached;
        exit;
    }

    if (!is_file($dbFile)) {
        echo json_encode(['id' => $id, 'found' => false]);
        exit;
    }

    try {
        $pdo = open_db($dbFile);
        $stmt = $pdo->prepare('
            SELECT a.id, a.ddb_id, a.raw, a.timestamp, a.lat, a.lon,
                   COALESCE(n.name, pn.name) AS name,
                   d.callsign, d.registration, d.model, d.aircraft_type
            FROM aircraft a
            LEFT JOIN names n ON a.id = n.id
            LEFT JOIN names pn ON a.ddb_id != \'\' AND a.ddb_id = pn.id
            LEFT JOIN ddb d ON a.ddb_id != \'\' AND a.ddb_id = d.id
            WHERE a.id = :id AND a.timestamp >= :cutoff
            LIMIT 1
        ');
        $stmt->execute([':id' => $id, ':cutoff' => time() - 86400]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        if (!$row) {
            $json = json_encode(['id' => $id, 'found' => false]);
            if ($json !== false) cache_set($cacheDir, $cacheKey, $json);
            echo $json !== false ? $json : '{"id":"' . $id . '","found":false}';
            exit;
        }

        $raw = (string)$row['raw'];
        $name = extract_ogn_stream_name($raw) ?: clean_ogn_name($row['name'] ?? '');
        $ddbId = strtolower((string)($row['ddb_id'] ?? ''));
        $json = json_encode([
            'id'          => $id,
            'found'       => true,
            'raw'         => $raw,
            'timestamp'   => (int)$row['timestamp'],
            'lat'         => (float)$row['lat'],
            'lon'         => (float)$row['lon'],
            'name'        => $name,
            'ddb_id'      => $ddbId,
            'callsign'    => (string)($row['callsign'] ?? ''),
            'registration'=> (string)($row['registration'] ?? ''),
            'model'       => (string)($row['model'] ?? ''),
            'aircraft_type'=> (string)($row['aircraft_type'] ?? ''),
        ], JSON_INVALID_UTF8_SUBSTITUTE);
        if ($json !== false) {
            cache_set($cacheDir, $cacheKey, $json);
            echo $json;
        } else {
            echo json_encode(['id' => $id, 'found' => false]);
        }
    } catch (Throwable $e) {
        http_response_code(500);
        header('Cache-Control: no-store');
        echo json_encode(['id' => $id, 'found' => false, 'error' => 'Last-known read error']);
    }
    exit;
}

// --- 2. Track Endpoint ---
if (isset($_GET['track']) && $_GET['track'] === '1') {
    $id = strtolower(trim((string)($_GET['id'] ?? '')));
    if ($id === '' || !preg_match('/^[a-z0-9_-]{1,20}$/', $id)) {
        http_response_code(400);
        header('Cache-Control: no-store');
        echo json_encode(['error' => 'Invalid aircraft id']);
        exit;
    }

    $now   = time();
    $since = filter_input(INPUT_GET, 'since', FILTER_VALIDATE_INT);
    // Exports need every recorded fix; normal map display keeps the 1500-point
    // thinning below to stay light on the client.
    $full = isset($_GET['full']) && $_GET['full'] === '1';

    if ($since !== false && $since !== null) {
        $cutoff     = max($now - 86400, min($now, $since));
        $cacheKey   = 'trk_' . md5($id . '_since_' . $cutoff . ($full ? '_full' : ''));
        $metaWindow = max(0, $now - $cutoff);
    } else {
        $window = filter_input(INPUT_GET, 'window', FILTER_VALIDATE_INT);
        if ($window === false || $window === null) $window = 900;
        $window     = max(60, min(86400, $window));
        $cutoff     = $now - $window;
        $cacheKey   = 'trk_' . md5($id . '_win_' . $window . ($full ? '_full' : ''));
        $metaWindow = $window;
    }

    header('Cache-Control: public, max-age=5');
    if (($cached = cache_get($cacheDir, $cacheKey, 4)) !== null) {
        echo $cached;
        exit;
    }

    if (!is_file($dbFile)) {
        echo json_encode(['id' => $id, 'window' => $metaWindow, 'points' => []]);
        exit;
    }

    try {
        $pdo = open_db($dbFile);
        $stmt = $pdo->prepare('
            SELECT lat, lon, alt, ts
            FROM tracks
            WHERE id = :id AND ts >= :cutoff
            ORDER BY ts ASC
            LIMIT ' . ($full ? 100000 : 20000) . '
        ');
        $stmt->execute([':id' => $id, ':cutoff' => $cutoff]);

        $points = [];
        while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
            $points[] = [
                (float)$row['lat'],
                (float)$row['lon'],
                $row['alt'] !== null ? (float)$row['alt'] : null,
                (int)$row['ts'],
            ];
        }

        $total = count($points);
        if (!$full && $total > 1500) {
            $step = (int)ceil($total / 1500);
            $thinned = [];
            for ($i = 0; $i < $total; $i += $step) {
                $thinned[] = $points[$i];
            }
            if ($thinned[count($thinned) - 1][3] !== $points[$total - 1][3]) {
                $thinned[] = $points[$total - 1];
            }
            $points = $thinned;
        }

        $json = json_encode(['id' => $id, 'window' => $metaWindow, 'points' => $points]);
        if ($json !== false) {
            cache_set($cacheDir, $cacheKey, $json);
            echo $json;
        }
    } catch (Throwable $e) {
        http_response_code(500);
        header('Cache-Control: no-store');
        echo json_encode(['error' => 'Track read error']);
    }
    exit;
}

// --- 3. Today's Thermal Heatmap Endpoint ---
if (isset($_GET['thermals']) && $_GET['thermals'] === '1') {
    $bounds = parse_bounds();
    if (!$bounds) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid map bounds']);
        exit;
    }
    [$south, $north, $w, $e, $fullWorld] = $bounds;

    header('Cache-Control: public, max-age=' . THERMAL_CACHE_TTL);
    $cacheKey = 'thm_' . md5(sprintf('%.1f_%.1f_%.1f_%.1f_%d', $south, $north, $w, $e, $fullWorld ? 1 : 0));
    if (($cached = cache_get($cacheDir, $cacheKey, THERMAL_CACHE_TTL)) !== null) {
        echo $cached;
        exit;
    }

    if (!is_file($dbFile)) {
        echo json_encode(['points' => []]);
        exit;
    }

    try {
        $pdo = open_db($dbFile);
        $cutoff = time() - 21600;
        $params = [':south' => $south, ':north' => $north, ':cutoff' => $cutoff];
        if ($fullWorld) {
            $lonClause = '1=1';
        } else {
            $lonClause = ($w <= $e) ? 'lon BETWEEN :west AND :east' : '(lon >= :west OR lon <= :east)';
            $params[':west'] = $w;
            $params[':east'] = $e;
        }

        $hasThermals = (bool)$pdo->query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='thermals'")->fetchColumn();
        if (!$hasThermals) {
            echo json_encode(['points' => []]);
            exit;
        }

        $stmt = $pdo->prepare("
            SELECT lat, lon, intensity
            FROM thermals
            WHERE ts >= :cutoff
              AND lat BETWEEN :south AND :north
              AND {$lonClause}
            ORDER BY ts DESC
            LIMIT 3000
        ");
        $stmt->execute($params);

        $heat = [];
        while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
            $heat[] = [
                round((float)$row['lat'], 4),
                round((float)$row['lon'], 4),
                round((float)$row['intensity'], 2),
            ];
        }

        $json = json_encode(['points' => $heat]);
        if ($json !== false) {
            cache_set($cacheDir, $cacheKey, $json);
            echo $json;
        }
    } catch (Throwable $e) {
        error_log('ogn-proxy thermal error: ' . $e->getMessage() . ' at ' . basename($e->getFile()) . ':' . $e->getLine());
        $stale = cache_get($cacheDir, $cacheKey, THERMAL_CACHE_TTL);
        if ($stale !== null) {
            header('X-OGN-Stale: 1');
            header('Cache-Control: public, max-age=60');
            echo $stale;
            exit;
        }
        http_response_code(500);
        echo json_encode(['error' => 'Thermal query error']);
    }
    exit;
}

// --- 3b. Live Wind Aloft & Thermal Ceiling Sounding Endpoint ---
if (isset($_GET['sounding']) && $_GET['sounding'] === '1') {
    $bounds = parse_bounds();
    if (!$bounds) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid map bounds']);
        exit;
    }
    [$south, $north, $w, $e, $fullWorld] = $bounds;

    header('Cache-Control: public, max-age=' . SOUNDING_CACHE_TTL);
    $spanLat = max(0.0, $north - $south);
    $spanLon = $fullWorld ? 360.0 : fmod(($e - $w) + 360.0, 360.0);
    if ($fullWorld || ($spanLat * $spanLon) > 25.0) {
        echo json_encode([
            'available' => false,
            'reason' => 'Zoom in to a regional/valley view for local wind sounding.',
            'layers' => [],
        ]);
        exit;
    }

    // Coarse 0.2° snapping so small pans reuse the same sounding payload.
    $s02 = floor($south * 5.0) / 5.0;
    $n02 = ceil($north * 5.0) / 5.0;
    $w02 = floor($w * 5.0) / 5.0;
    $e02 = ceil($e * 5.0) / 5.0;
    $cacheKey = 'snd_' . md5(sprintf('%.1f_%.1f_%.1f_%.1f', $s02, $n02, $w02, $e02));
    if (($cached = cache_get($cacheDir, $cacheKey, SOUNDING_CACHE_TTL)) !== null) {
        echo $cached;
        exit;
    }

    if (!is_file($dbFile)) {
        echo json_encode(['available' => false, 'reason' => 'Sounding data is not available yet.', 'layers' => []]);
        exit;
    }

    try {
        $pdo = open_db($dbFile);
        $cutoff = time() - 3600;
        $params = [':south' => $south, ':north' => $north, ':cutoff' => $cutoff];
        if ($fullWorld) {
            $lonClause = '1=1';
            $stationLonClause = '1=1';
        } else {
            $lonClause = ($w <= $e) ? 't.lon BETWEEN :west AND :east' : '(t.lon >= :west OR t.lon <= :east)';
            $stationLonClause = ($w <= $e) ? 's.lon BETWEEN :west AND :east' : '(s.lon >= :west OR s.lon <= :east)';
            $params[':west'] = $w;
            $params[':east'] = $e;
        }

        $stmt = $pdo->prepare("
            SELECT t.id, t.ts, t.lat, t.lon, t.alt,
                   COALESCE(a.raw, '') AS aircraft_raw,
                   COALESCE(d.aircraft_type, '') AS ddb_type
            FROM tracks t
            LEFT JOIN aircraft a ON a.id = t.id
            LEFT JOIN ddb d ON a.ddb_id != '' AND a.ddb_id = d.id
            WHERE t.ts >= :cutoff
              AND t.lat BETWEEN :south AND :north
              AND {$lonClause}
              AND t.alt IS NOT NULL
            ORDER BY t.ts DESC
            LIMIT " . SOUNDING_MAX_TRACK_ROWS . "
        ");
        $stmt->execute($params);
        $byAircraft = [];
        while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
            $id = (string)$row['id'];
            if (!isset($byAircraft[$id])) {
                $byAircraft[$id] = [
                    'raw' => (string)$row['aircraft_raw'],
                    'ddb' => (string)$row['ddb_type'],
                    'pts' => [],
                ];
            }
            $byAircraft[$id]['pts'][] = [
                'ts' => (int)$row['ts'],
                'lat' => (float)$row['lat'],
                'lon' => (float)$row['lon'],
                'alt' => (float)$row['alt'],
            ];
        }

        // Only densely logged sailplanes/paragliders are useful soundings. Keep
        // at most the newest 200 fixes per aircraft so one busy ID cannot fill
        // the whole global budget.
        foreach ($byAircraft as $id => &$entry) {
            $type = sounding_aircraft_type($entry['raw'], $entry['ddb']);
            if ($type !== 1 && $type !== 7) {
                unset($byAircraft[$id]);
                continue;
            }
            usort($entry['pts'], fn($a, $b) => $a['ts'] <=> $b['ts']);
            if (count($entry['pts']) > SOUNDING_MAX_POINTS_PER_AC) {
                $entry['pts'] = array_slice($entry['pts'], -SOUNDING_MAX_POINTS_PER_AC);
            }
        }
        unset($entry);

        $turnSamples = [];
        $climbAlts = [];
        $climbIds = [];
        foreach ($byAircraft as $id => $entry) {
            $pts = $entry['pts'];
            $n = count($pts);

            // Complete-turn drift: a full circle cancels airspeed and leaves
            // the wind vector. Require dense fixes and reject straight tow legs.
            $turnStart = null;
            $cumTurn = 0.0;
            $turnDuration = 0;
            $prevBearing = null;
            for ($i = 1; $i < $n; $i++) {
                $p0 = $pts[$i - 1];
                $p1 = $pts[$i];
                $dt = $p1['ts'] - $p0['ts'];
                if ($dt < 1 || $dt > 6) {
                    $turnStart = null; $cumTurn = 0.0; $turnDuration = 0; $prevBearing = null;
                    continue;
                }
                $segSpeedMps = sounding_haversine_km($p0['lat'], $p0['lon'], $p1['lat'], $p1['lon']) * 1000.0 / $dt;
                if ($segSpeedMps > 200.0 / 3.6) {
                    $turnStart = null; $cumTurn = 0.0; $turnDuration = 0; $prevBearing = null;
                    continue;
                }
                $bearing = sounding_bearing_deg($p0['lat'], $p0['lon'], $p1['lat'], $p1['lon']);
                if ($turnStart === null) {
                    $turnStart = $i - 1;
                    $cumTurn = 0.0;
                    $turnDuration = 0;
                    $prevBearing = $bearing;
                    continue;
                }
                $cumTurn += sounding_angle_delta($prevBearing, $bearing);
                $turnDuration += $dt;
                $prevBearing = $bearing;

                // Prefer a complete 360° turn: at only 300° the aircraft's
                // airspeed still leaks into the displacement vector and tilts
                // the derived wind direction. Accept 300° only as a late fallback.
                $complete = ($turnDuration >= 20 && abs($cumTurn) >= 340.0)
                    || ($turnDuration > 120 && abs($cumTurn) >= 300.0);
                if (!$complete) {
                    if ($turnDuration > 120) {
                        $turnStart = $i - 1;
                        $cumTurn = 0.0;
                        $turnDuration = 0;
                    }
                    continue;
                }
                $start = $pts[$turnStart];
                if (($p1['alt'] - $start['alt']) >= -15.0) {
                    $dLon = $p1['lon'] - $start['lon'];
                    if ($dLon > 180.0) $dLon -= 360.0;
                    if ($dLon < -180.0) $dLon += 360.0;
                    $dNorth = ($p1['lat'] - $start['lat']) * 111320.0;
                    $dEast = $dLon * 111320.0 * cos(deg2rad(($start['lat'] + $p1['lat']) / 2.0));
                    $windKmh = hypot($dNorth, $dEast) / $turnDuration * 3.6;
                    if ($windKmh <= 110.0) {
                        $meanAlt = ($start['alt'] + $p1['alt']) / 2.0;
                        $band = (int)(floor($meanAlt / 250.0) * 250.0);
                        $dir = fmod(rad2deg(atan2(-$dEast, -$dNorth)) + 360.0, 360.0);
                        $turnSamples[$band][] = ['dir' => $dir, 'spd' => $windKmh, 'id' => $id];
                    }
                }
                $turnStart = $i;
                $cumTurn = 0.0;
                $turnDuration = 0;
            }

            // Empirical thermal ceiling support: climbing segments only.
            for ($i = 1; $i < $n; $i++) {
                $dt = $pts[$i]['ts'] - $pts[$i - 1]['ts'];
                // Dense fixes can be 1–2 s apart; allow those as climb support.
                if ($dt < 2 || $dt > 60) continue;
                if (($pts[$i]['alt'] - $pts[$i - 1]['alt']) / $dt >= 0.5) {
                    $climbAlts[] = $pts[$i]['alt'];
                    $climbIds[$id] = true;
                }
            }
        }

        $layers = [];
        foreach ($turnSamples as $band => $samples) {
            $allIds = [];
            foreach ($samples as $s) $allIds[$s['id']] = true;
            if (count($allIds) < 2) continue; // one aircraft must not define a layer

            // Reject wind vectors >60° from the layer's circular median before
            // averaging, so one bad turn cannot drag the reference direction.
            $medianDir = sounding_circular_median_dir(array_column($samples, 'dir'));
            $kept = [];
            foreach ($samples as $s) {
                if (abs(sounding_angle_delta($medianDir, $s['dir'])) <= 60.0) $kept[] = $s;
            }
            $keptIds = [];
            foreach ($kept as $s) $keptIds[$s['id']] = true;
            if (count($kept) < 2 || count($keptIds) < 2) continue;

            $sx = 0.0; $sy = 0.0; $sumSpd = 0.0;
            foreach ($kept as $s) {
                $r = deg2rad($s['dir']);
                $sx += cos($r); $sy += sin($r);
                $sumSpd += $s['spd'];
            }
            $layers[] = [
                'alt_m' => (int)$band,
                'dir_deg' => (int)round(fmod(rad2deg(atan2($sy, $sx)) + 360.0, 360.0)),
                'spd_kmh' => (int)round($sumSpd / count($kept)),
                'samples' => count($kept),
                'aircraft' => count($keptIds),
            ];
        }
        usort($layers, fn($a, $b) => $b['alt_m'] <=> $a['alt_m']);

        $thermalCeiling = null;
        if (count($climbAlts) >= 5 && count($climbIds) >= 2) {
            $p90 = sounding_percentile($climbAlts, 90.0);
            if ($p90 !== null) $thermalCeiling = (int)round($p90 / 10.0) * 10;
        }

        // Surface reference: nearest active weather station to the map centre.
        $centerLat = ($south + $north) / 2.0;
        $midLon = ($e < $w) ? $w + (($e + 360.0 - $w) / 2.0) : ($w + $e) / 2.0;
        $centerLon = fmod($midLon + 540.0, 360.0) - 180.0;
        $wxStmt = $pdo->prepare("
            SELECT sw.id, sw.wx_json, sw.updated, s.lat, s.lon,
                   COALESCE(n.name, '') AS station_name,
                   COALESCE(a2.raw, '') AS station_raw
            FROM station_weather sw
            INNER JOIN stations s ON s.id = sw.id
            LEFT JOIN names n ON n.id = sw.id
            LEFT JOIN aircraft a2 ON a2.id = sw.id
            WHERE sw.updated >= :wxCutoff
              AND s.lat BETWEEN :south AND :north
              AND {$stationLonClause}
            ORDER BY sw.updated DESC
            LIMIT 300
        ");
        $wxParams = [
            ':wxCutoff' => time() - 1800,
            ':south' => $south, ':north' => $north,
        ];
        if (!$fullWorld) {
            $wxParams[':west'] = $w;
            $wxParams[':east'] = $e;
        }
        $wxStmt->execute($wxParams);
        $best = null;
        while ($wr = $wxStmt->fetch(PDO::FETCH_ASSOC)) {
            $wx = json_decode((string)$wr['wx_json'], true);
            if (!is_array($wx)) continue;
            $tempC = isset($wx['tempC']) && is_numeric($wx['tempC']) ? (float)$wx['tempC'] : null;
            $humidity = isset($wx['humidityPct']) && is_numeric($wx['humidityPct']) ? (float)$wx['humidityPct'] : null;
            $lclAgl = sounding_lcl_agl($tempC, $humidity);
            if ($tempC === null || $lclAgl === null) continue;
            $dir = isset($wx['dir']) && is_numeric($wx['dir']) ? (int)round((float)$wx['dir']) % 360 : null;
            $spd = isset($wx['spdKmh']) && is_numeric($wx['spdKmh']) ? (float)$wx['spdKmh'] : null;
            if ($spd !== null && ($spd < 0.0 || $spd > 200.0)) $spd = null;
            $distance = sounding_haversine_km($centerLat, $centerLon, (float)$wr['lat'], (float)$wr['lon']);
            if ($best === null || $distance < $best['distance']) {
                $elevM = null;
                if (preg_match('/\/A=(-?\d{6})/', (string)$wr['station_raw'], $am)) {
                    $elevM = round((int)$am[1] * 0.3048, 1);
                }
                $best = [
                    'distance' => $distance,
                    'surface' => [
                        'station' => (string)$wr['station_name'] !== '' ? (string)$wr['station_name'] : strtoupper((string)$wr['id']),
                        'temp_c' => round($tempC, 1),
                        'humidity_pct' => (int)round((float)$humidity),
                        'wind_dir' => $dir,
                        'wind_kmh' => $spd === null ? null : (int)round($spd),
                        'lcl_agl_m' => (int)round($lclAgl),
                        'lcl_msl_m' => $elevM === null ? null : (int)round($lclAgl + $elevM),
                        'elevation_m' => $elevM === null ? null : (int)round($elevM),
                        'distance_km' => round($distance, 1),
                    ],
                ];
            }
        }

        $json = json_encode([
            'available' => true,
            'generated_at' => time(),
            'window_sec' => 3600,
            'thermal_ceiling_m' => $thermalCeiling,
            'surface' => $best === null ? null : $best['surface'],
            'layers' => $layers,
        ], JSON_INVALID_UTF8_SUBSTITUTE);
        if ($json !== false) {
            cache_set($cacheDir, $cacheKey, $json);
            echo $json;
        } else {
            echo json_encode(['available' => false, 'reason' => 'Sounding response could not be encoded.', 'layers' => []]);
        }
    } catch (Throwable $e) {
        error_log('ogn-proxy sounding error: ' . $e->getMessage() . ' at ' . basename($e->getFile()) . ':' . $e->getLine());
        $stale = cache_get($cacheDir, $cacheKey, SOUNDING_CACHE_TTL);
        if ($stale !== null) {
            header('X-OGN-Stale: 1');
            header('Cache-Control: public, max-age=60');
            echo $stale;
            exit;
        }
        http_response_code(500);
        echo json_encode(['error' => 'Sounding query error']);
    }
    exit;
}

// --- 4. 24-Hour Time-Lapse Replay Endpoint ---
if (isset($_GET['replay']) && $_GET['replay'] === '1') {
    $bounds = parse_bounds();
    $ts = filter_input(INPUT_GET, 'ts', FILTER_VALIDATE_INT);
    if (!$bounds || $ts === false || $ts === null) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid replay parameters']);
        exit;
    }
    [$south, $north, $w, $e, $fullWorld] = $bounds;
    $tsBucket = (int)(floor($ts / 60) * 60);
    $followId = '';
    if (isset($_GET['id'])) {
        $candidate = strtolower(trim((string)$_GET['id']));
        if (preg_match('/^[a-z0-9_-]{1,64}$/', $candidate)) $followId = $candidate;
    }

    header('Cache-Control: public, max-age=30');
    $cacheKey = 'rpl_' . md5(sprintf('%.1f_%.1f_%.1f_%.1f_%d_%d_%s', $south, $north, $w, $e, $fullWorld ? 1 : 0, $tsBucket, $followId));
    if (($cached = cache_get($cacheDir, $cacheKey, 30)) !== null) {
        echo $cached;
        exit;
    }

    if (!is_file($dbFile)) {
        echo json_encode(['ts' => $tsBucket, 'aircraft' => []]);
        exit;
    }

    try {
        $pdo = open_db($dbFile);
        $params = [
            ':south' => $south,
            ':north' => $north,
            ':t1'    => $tsBucket - 60,
            ':t2'    => $tsBucket + 60,
        ];
        $idClause = '';
        if ($followId !== '') {
            $idClause = ' AND id = :id';
            $params[':id'] = $followId;
        }
        if ($fullWorld) {
            $lonClause = '1=1';
        } else {
            $lonClause = ($w <= $e) ? 'lon BETWEEN :west AND :east' : '(lon >= :west OR lon <= :east)';
            $params[':west'] = $w;
            $params[':east'] = $e;
        }

        $stmt = $pdo->prepare("
            SELECT latest.id, latest.lat, latest.lon, latest.alt, latest.ts,
                   COALESCE(n.name, pn.name) AS name, d.callsign, d.registration
            FROM (
                SELECT id, lat, lon, alt, MAX(ts) AS ts
                FROM tracks
                WHERE ts BETWEEN :t1 AND :t2
                  AND lat BETWEEN :south AND :north
                  AND {$lonClause}{$idClause}
                GROUP BY id
                LIMIT 2000
            ) latest
            LEFT JOIN aircraft a ON latest.id = a.id
            LEFT JOIN names n ON latest.id = n.id
            LEFT JOIN names pn ON a.ddb_id != '' AND a.ddb_id = pn.id
            LEFT JOIN ddb d ON a.ddb_id != '' AND a.ddb_id = d.id
        ");
        $stmt->execute($params);

        $out = [];
        while ($r = $stmt->fetch(PDO::FETCH_ASSOC)) {
            $label = clean_ogn_name($r['name']) ?: (clean_ogn_name($r['callsign']) ?: (clean_ogn_name($r['registration']) ?: strtoupper((string)$r['id'])));
            $out[] = [
                'id'    => $r['id'],
                'label' => $label,
                'lat'   => (float)$r['lat'],
                'lon'   => (float)$r['lon'],
                'alt'   => $r['alt'] !== null ? round((float)$r['alt']) : null,
                'ts'    => (int)$r['ts'],
            ];
        }

        $json = json_encode(['ts' => $tsBucket, 'aircraft' => $out], JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
        if ($json !== false) {
            cache_set($cacheDir, $cacheKey, $json);
            echo $json;
        }
    } catch (Throwable $e) {
        http_response_code(500);
        echo json_encode(['error' => 'Replay query error']);
    }
    exit;
}

// --- 5. 24-hour aircraft search (fallback when the current view has no matches) ---
if (isset($_GET['search']) && $_GET['search'] === '1') {
    $q = strtolower(trim((string)($_GET['q'] ?? '')));
    header('Cache-Control: public, max-age=30');
    if ($q === '' || strlen($q) > 80) {
        echo json_encode(['results' => []]);
        exit;
    }
    $cacheKey = 'search24_' . md5($q);
    if (!is_file($dbFile)) {
        echo json_encode(['results' => []]);
        exit;
    }
    $cached = cache_get($cacheDir, $cacheKey, 30);
    if ($cached !== null) {
        echo $cached;
        exit;
    }
    try {
        $pdo = open_db($dbFile);
        $stmt = $pdo->prepare("
            SELECT a.id, a.ddb_id, a.raw, a.timestamp, a.lat, a.lon,
                   COALESCE(n.name, pn.name) AS name,
                   d.callsign, d.registration, d.model, d.aircraft_type
            FROM aircraft a
            LEFT JOIN names n ON a.id = n.id
            LEFT JOIN names pn ON a.ddb_id != '' AND a.ddb_id = pn.id
            LEFT JOIN ddb d ON a.ddb_id != '' AND a.ddb_id = d.id
            WHERE a.timestamp >= :cutoff
              AND (instr(lower(a.id), :needle) > 0
                OR instr(lower(a.ddb_id), :needle) > 0
                OR instr(lower(a.raw), :needle) > 0
                OR instr(lower(COALESCE(n.name, '')), :needle) > 0
                OR instr(lower(COALESCE(pn.name, '')), :needle) > 0
                OR instr(lower(COALESCE(d.callsign, '')), :needle) > 0
                OR instr(lower(COALESCE(d.registration, '')), :needle) > 0
                OR instr(lower(COALESCE(d.model, '')), :needle) > 0)
            ORDER BY a.timestamp DESC
            LIMIT 200
        ");
        $stmt->execute([':cutoff' => time() - 86400, ':needle' => $q]);
        $results = [];
        while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
            $results[] = [
                'id'            => (string)$row['id'],
                'ddb_id'        => (string)($row['ddb_id'] ?? ''),
                'raw'           => (string)$row['raw'],
                'timestamp'     => (int)$row['timestamp'],
                'lat'           => (float)$row['lat'],
                'lon'           => (float)$row['lon'],
                'name'          => clean_ogn_name((string)($row['name'] ?? '')),
                'callsign'      => (string)($row['callsign'] ?? ''),
                'registration'  => (string)($row['registration'] ?? ''),
                'model'         => (string)($row['model'] ?? ''),
                'aircraft_type' => (string)($row['aircraft_type'] ?? ''),
            ];
        }
        $json = json_encode(['results' => $results], JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
        if ($json !== false) {
            cache_set($cacheDir, $cacheKey, $json);
            echo $json;
        } else {
            echo json_encode(['results' => []]);
        }
    } catch (Throwable $e) {
        http_response_code(500);
        echo json_encode(['results' => []]);
    }
    exit;
}

// --- 6. Live Viewport Endpoint ---
if (!isset($_GET['live']) || $_GET['live'] !== '1') {
    http_response_code(400);
    header('Cache-Control: no-store');
    echo json_encode(['error' => 'Missing live=1, track=1, thermals=1, or replay=1 parameter']);
    exit;
}

$bounds = parse_bounds();
if (!$bounds) {
    http_response_code(400);
    header('Cache-Control: no-store');
    echo json_encode(['error' => 'Invalid map bounds']);
    exit;
}
[$south, $north, $w, $e, $fullWorld] = $bounds;

$window = filter_input(INPUT_GET, 'window', FILTER_VALIDATE_INT);
if ($window === false || $window === null) $window = 900;
$window = max(60, min(86400, $window));

$includeMeta = (!isset($_GET['meta']) || $_GET['meta'] !== '0');

// Large views are expensive and change slowly; cache them longer so a browser
// left zoomed out cannot force a fresh DB query on every 5s poll.
$spanLat = max(0.0, $north - $south);
$spanLon = $fullWorld ? 360.0 : fmod($e - $w + 360.0, 360.0);
$viewArea = $spanLat * $spanLon;
if ($fullWorld || $viewArea >= 2000) {
    $liveTtl = 30;
} elseif ($viewArea >= 500) {
    $liveTtl = 15;
} else {
    $liveTtl = 7;
}

$noCache = isset($_GET['nc']) && $_GET['nc'] !== '';
header($noCache ? 'Cache-Control: no-store' : 'Cache-Control: public, max-age=' . $liveTtl);

if (!is_file($dbFile)) {
    echo json_encode([
        'server_time'     => time(),
        'updated'         => 0,
        'names_updated'   => 0,
        'packets'         => new stdClass(),
        'telemetry'       => new stdClass(),
        'station_weather' => new stdClass(),
        'names'           => new stdClass(),
        'ddb'             => new stdClass(),
        'station_stats'   => new stdClass(),
        'alerts_24h'      => [],
    ]);
    exit;
}

try {
    $pdo = open_db($dbFile);
    $now = time();
    $cutoff = $now - $window;
    $cutoff24 = $now - 86400;
    $wxCutoff = $now - max($window, 1800);

    // The name version invalidates cached payloads only when names actually change.
    $metaRows = $pdo->query('SELECT key, value FROM meta WHERE key IN ("updated", "names_updated")')->fetchAll(PDO::FETCH_KEY_PAIR);
    $updated = (int)($metaRows['updated'] ?? 0);
    $namesUpdated = (int)($metaRows['names_updated'] ?? 0);

    $cacheKey = 'live_' . md5(sprintf('%.1f_%.1f_%.1f_%.1f_%d_%d_%d_%d', $south, $north, $w, $e, $fullWorld ? 1 : 0, $window, $includeMeta ? 1 : 0, $namesUpdated));
    if (!$noCache && ($cached = cache_get($cacheDir, $cacheKey, $liveTtl)) !== null) {
        echo $cached;
        exit;
    }

    $params = [':south' => $south, ':north' => $north, ':cutoff' => $cutoff];
    $aircraftIndex = '';
    if ($pdo->query("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_aircraft_ts_lat_lon'")->fetchColumn()) {
        $aircraftIndex = 'INDEXED BY idx_aircraft_ts_lat_lon';
    }

    if ($fullWorld) {
        $lonClauseA = '1=1';
        $lonClauseS = '1=1';
    } else {
        $lonClauseA = ($w <= $e) ? 'a.lon BETWEEN :west AND :east' : '(a.lon >= :west OR a.lon <= :east)';
        $lonClauseS = ($w <= $e) ? 's.lon BETWEEN :west AND :east' : '(s.lon >= :west OR s.lon <= :east)';
        $params[':west'] = $w;
        $params[':east'] = $e;
    }

    $packets = [];
    $names   = [];
    $ddb     = [];

    $collectRow = static function (array $row) use (&$packets, &$names, &$ddb, $includeMeta): void {
        $id = $row['id'];
        $packets[$id] = [
            'raw'       => $row['raw'],
            'timestamp' => (int)$row['timestamp'],
        ];
        if ($includeMeta) {
            $ddbId = $row['ddb_id'] ?? '';
            $rawName = extract_ogn_stream_name((string)($row['raw'] ?? ''));
            $storedName = clean_ogn_name($row['name'] ?? '');
            if ($rawName !== '') $names[$id] = $rawName;
            elseif ($storedName !== '') $names[$id] = $storedName;
            // PureTrack labels are keyed by device hex; expose them under the
            // DDB ID too so the client can resolve devices with prefixed callsigns.
            $hexName = clean_ogn_name($row['hex_name'] ?? '');
            if ($ddbId !== '' && $hexName !== '') $names[strtolower((string)$ddbId)] = $hexName;
            if ($ddbId !== '' && (isset($row['callsign']) || isset($row['registration']) || isset($row['model']) || isset($row['aircraft_type']))) {
                $ddb[$ddbId] = [
                    'callsign'        => (string)($row['callsign'] ?? ''),
                    'registration'    => (string)($row['registration'] ?? ''),
                    'model'           => (string)($row['model'] ?? ''),
                    'ddbAircraftType' => (string)($row['aircraft_type'] ?? ''),
                ];
            }
        }
    };

    if ($includeMeta) {
        $sql = "
            SELECT a.id, a.ddb_id, a.raw, a.timestamp,
                   COALESCE(n.name, pn.name) AS name, pn.name AS hex_name,
                   d.callsign, d.registration, d.model, d.aircraft_type
            FROM aircraft a {$aircraftIndex}
            LEFT JOIN names n ON a.id = n.id
            LEFT JOIN names pn ON a.ddb_id != '' AND a.ddb_id = pn.id
            LEFT JOIN ddb d ON a.ddb_id != '' AND a.ddb_id = d.id
            WHERE a.lat BETWEEN :south AND :north
              AND {$lonClauseA}
              AND a.timestamp >= :cutoff
            ORDER BY a.timestamp DESC
            LIMIT 3000
        ";
    } else {
        $sql = "
            SELECT a.id, a.raw, a.timestamp
            FROM aircraft a {$aircraftIndex}
            WHERE a.lat BETWEEN :south AND :north
              AND {$lonClauseA}
              AND a.timestamp >= :cutoff
            ORDER BY a.timestamp DESC
            LIMIT 3000
        ";
    }

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
        $collectRow($row);
    }

    // Global emergency aircraft
    $emergCacheKey = 'emerg_' . $window;
    $emergCached   = cache_get($cacheDir, $emergCacheKey, 3);
    if ($emergCached !== null) {
        $emergRows = json_decode($emergCached, true);
        if (is_array($emergRows)) {
            foreach ($emergRows as $row) {
                $collectRow($row);
            }
        }
    } else {
        $stmtEmerg = $pdo->prepare("
            SELECT a.id, a.ddb_id, a.raw, a.timestamp,
                   COALESCE(n.name, pn.name) AS name, pn.name AS hex_name,
                   d.callsign, d.registration, d.model, d.aircraft_type
            FROM aircraft a
            LEFT JOIN names n ON a.id = n.id
            LEFT JOIN names pn ON a.ddb_id != '' AND a.ddb_id = pn.id
            LEFT JOIN ddb d ON a.ddb_id != '' AND a.ddb_id = d.id
            WHERE a.is_emergency = 1
              AND a.timestamp >= :cutoff
            ORDER BY a.timestamp DESC
            LIMIT 100
        ");
        $stmtEmerg->execute([':cutoff' => $cutoff]);
        $emergRows = $stmtEmerg->fetchAll(PDO::FETCH_ASSOC);
        foreach ($emergRows as $row) {
            $collectRow($row);
        }
        $emergJson = json_encode($emergRows, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
        if ($emergJson !== false) {
            cache_set($cacheDir, $emergCacheKey, $emergJson);
        }
    }

    // 24-hour alerts (excluding routine 'Need a ride' / FNT78) with alert reason, last-seen coords/time, and post-alert state
    $alerts24h = [];
    $alertsCacheKey = 'alerts24h_v10';
    $alertsCached = cache_get($cacheDir, $alertsCacheKey, 10);
    if ($alertsCached !== null) {
        $decodedAlerts = json_decode($alertsCached, true);
        if (is_array($decodedAlerts)) {
            foreach ($decodedAlerts as &$cachedAlert) {
                if (!is_array($cachedAlert)) continue;
                $cachedAlert['status'] = clean_alert_status($cachedAlert['status'] ?? '');
                $cachedAlert['last_status'] = clean_alert_status($cachedAlert['last_status'] ?? ($cachedAlert['status'] ?? ''));
            }
            unset($cachedAlert);
            $alerts24h = $decodedAlerts;
        }
    } else {
        try {
            $byAddr = [];
            $hasAlertsTable = (bool)$pdo->query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='alerts'")->fetchColumn();
            if ($hasAlertsTable) {
                $stmtAl = $pdo->prepare("
                    SELECT al.id, al.status, al.lat, al.lon, al.alt, al.raw, al.last_ts, al.first_ts,
                           a.lat AS latest_lat, a.lon AS latest_lon,
                           a.timestamp AS latest_ts, a.is_emergency AS latest_emerg, a.raw AS latest_raw,
                           COALESCE(n.name, pn.name) AS name, d.callsign, d.registration
                    FROM alerts al
                    LEFT JOIN aircraft a ON al.id = a.id
                    LEFT JOIN names n ON al.id = n.id
                    LEFT JOIN names pn ON a.ddb_id != '' AND a.ddb_id = pn.id
                    LEFT JOIN ddb d ON a.ddb_id != '' AND a.ddb_id = d.id
                    WHERE al.last_ts >= :cutoff24
                      AND lower(al.status) NOT LIKE 'need a ride%'
                    ORDER BY al.last_ts DESC
                    LIMIT 100
                ");
                $stmtAl->execute([':cutoff24' => $cutoff24]);
                while ($ar = $stmtAl->fetch(PDO::FETCH_ASSOC)) {
                    $addr = strtolower((string)$ar['id']);
                    $alertTs = (int)$ar['last_ts'];
                    $firstTs = (int)($ar['first_ts'] ?? 0) > 0 ? (int)$ar['first_ts'] : $alertTs;
                    $alertRaw = (string)$ar['raw'];
                    $latestTs = $ar['latest_ts'] !== null ? (int)$ar['latest_ts'] : $alertTs;
                    $latestRaw = (string)($ar['latest_raw'] ?? $alertRaw);
                    $latestEmerg = (int)($ar['latest_emerg'] ?? 0) === 1;
                    $latestHasAlert = $latestEmerg
                        || (bool)preg_match('/\bFNT7[cdef]\b/i', $latestRaw)
                        || (bool)preg_match('/\bsq(7700|7600|7500)\b/i', $latestRaw)
                        || (bool)preg_match('/\b(MAYDAY|SOS|EMERGENCY)\b/i', $latestRaw);
                    $subsequentNormal = ($latestTs > $alertTs) && !$latestHasAlert;
                    $stillAlertOnLast = !$subsequentNormal && $latestHasAlert;

                    $storedStatus = clean_alert_status($ar['status'] ?? '');
                    $decodedAlertStatus = format_packet_status($alertRaw, $storedStatus !== '' ? $storedStatus : 'Alert');
                    if ($decodedAlertStatus !== 'Alert') {
                        $storedStatus = clean_alert_status($decodedAlertStatus);
                    }
                    $lastStatus = $subsequentNormal
                        ? format_packet_status($latestRaw, 'Normal packet')
                        : format_packet_status($latestRaw, $storedStatus);

                    $lastLat = $ar['latest_lat'] !== null ? (float)$ar['latest_lat'] : ($ar['lat'] !== null ? (float)$ar['lat'] : null);
                    $lastLon = $ar['latest_lon'] !== null ? (float)$ar['latest_lon'] : ($ar['lon'] !== null ? (float)$ar['lon'] : null);
                    $alertAlt = isset($ar['alt']) && $ar['alt'] !== null ? (float)$ar['alt'] : null;
                    $rawForAlt = $latestRaw !== '' ? $latestRaw : $alertRaw;
                    if ($alertAlt === null) $alertAlt = extract_altitude_from_raw($rawForAlt);
                    if ($alertAlt === null) $alertAlt = extract_altitude_from_raw($alertRaw);

                    $label = extract_ogn_stream_name($rawForAlt) ?: (clean_ogn_name($ar['name']) ?: (clean_ogn_name($ar['callsign']) ?: (clean_ogn_name($ar['registration']) ?: strtoupper((string)$ar['id']))));
                    $byAddr[$addr] = [
                        'address'        => $addr,
                        'name'           => $label,
                        'status'         => $storedStatus,
                        'last_status'    => $lastStatus,
                        'lat'            => $lastLat,
                        'lon'            => $lastLon,
                        'alt'            => $alertAlt,
                        'raw'            => $rawForAlt,
                        'ts'             => $alertTs,
                        'first_ts'       => $firstTs,
                        'latest_ts'      => $latestTs,
                        'normal_after'   => $subsequentNormal,
                        'alert_still_on' => $stillAlertOnLast,
                    ];
                }
            }

            $stmtA24 = $pdo->prepare("
                SELECT a.id, a.lat, a.lon, a.raw, a.timestamp, a.is_emergency,
                       COALESCE(n.name, pn.name) AS name, d.callsign, d.registration
                FROM aircraft a
                LEFT JOIN names n ON a.id = n.id
                LEFT JOIN names pn ON a.ddb_id != '' AND a.ddb_id = pn.id
                LEFT JOIN ddb d ON a.ddb_id != '' AND a.ddb_id = d.id
                WHERE a.timestamp >= :cutoff24
                  AND (
                    a.is_emergency = 1
                    OR lower(a.raw) LIKE '%fnt7c%'
                    OR lower(a.raw) LIKE '%fnt7d%'
                    OR lower(a.raw) LIKE '%fnt7e%'
                    OR lower(a.raw) LIKE '%fnt7f%'
                  )
                ORDER BY a.timestamp DESC
                LIMIT 100
            ");
            $stmtA24->execute([':cutoff24' => $cutoff24]);
            while ($ar = $stmtA24->fetch(PDO::FETCH_ASSOC)) {
                $addr = strtolower((string)$ar['id']);
                $ts = (int)$ar['timestamp'];
                if (isset($byAddr[$addr]) && $byAddr[$addr]['ts'] >= $ts) continue;
                $raw = (string)$ar['raw'];
                $status = format_packet_status($raw, 'Alert');
                $label = extract_ogn_stream_name($raw) ?: (clean_ogn_name($ar['name']) ?: (clean_ogn_name($ar['callsign']) ?: (clean_ogn_name($ar['registration']) ?: strtoupper((string)$ar['id']))));
                $byAddr[$addr] = [
                    'address'        => $addr,
                    'name'           => $label,
                    'status'         => $status,
                    'last_status'    => $status,
                    'lat'            => (float)$ar['lat'],
                    'lon'            => (float)$ar['lon'],
                    'alt'            => extract_altitude_from_raw($raw),
                    'raw'            => $raw,
                    'ts'             => $ts,
                    'first_ts'       => $ts,
                    'latest_ts'      => $ts,
                    'normal_after'   => false,
                    'alert_still_on' => true,
                ];
            }

            $alerts24h = array_values($byAddr);
            usort($alerts24h, static fn(array $a, array $b): int => $b['ts'] <=> $a['ts']);
            $alertsJson = json_encode($alerts24h, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
            if ($alertsJson !== false) {
                cache_set($cacheDir, $alertsCacheKey, $alertsJson);
            }
        } catch (Throwable $e) {
        }
    }

    // Telemetry / status packets are global, so share one short-lived cache
    // across all viewport cache keys instead of re-querying for every area.
    $telemetry = [];
    $telemetryCacheKey = 'tel_' . $window;
    $telemetryCached = cache_get($cacheDir, $telemetryCacheKey, 5);
    $telemetryFromCache = false;
    if ($telemetryCached !== null) {
        $decodedTelemetry = json_decode($telemetryCached, true);
        if (is_array($decodedTelemetry)) {
            $telemetry = $decodedTelemetry;
            $telemetryFromCache = true;
        }
    }
    if (!$telemetryFromCache) {
        try {
            $stmtTel = $pdo->prepare('
                SELECT id, raw, timestamp
                FROM telemetry
                WHERE timestamp >= :cutoff
                ORDER BY timestamp DESC
                LIMIT 1000
            ');
            $stmtTel->execute([':cutoff' => $cutoff]);
            while ($tr = $stmtTel->fetch(PDO::FETCH_ASSOC)) {
                $telemetry[$tr['id']] = [
                    'raw'       => $tr['raw'],
                    'timestamp' => (int)$tr['timestamp'],
                ];
            }
            $telemetryJson = json_encode($telemetry, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
            if ($telemetryJson !== false) {
                cache_set($cacheDir, $telemetryCacheKey, $telemetryJson);
            }
        } catch (Throwable $e) {
        }
    }

    // Station weather is global; bucket the cutoff so one cache serves all viewports.
    $stationWeather = [];
    $wxBucket = (int)(floor($wxCutoff / 30) * 30);
    $wxCacheKey = 'wx_' . $wxBucket;
    $wxCached = cache_get($cacheDir, $wxCacheKey, 30);
    $wxFromCache = false;
    if ($wxCached !== null) {
        $decodedWxCache = json_decode($wxCached, true);
        if (is_array($decodedWxCache)) {
            $stationWeather = $decodedWxCache;
            $wxFromCache = true;
        }
    }
    if (!$wxFromCache) {
        try {
            $stmtWx = $pdo->prepare('
                SELECT id, wx_json, updated
                FROM station_weather
                WHERE updated >= :cutoff
                ORDER BY updated DESC
                LIMIT 1000
            ');
            $stmtWx->execute([':cutoff' => $wxBucket]);
            while ($wr = $stmtWx->fetch(PDO::FETCH_ASSOC)) {
                $decodedWx = json_decode((string)$wr['wx_json'], true);
                if (is_array($decodedWx)) {
                    $stationWeather[$wr['id']] = [
                        'wx'        => $decodedWx,
                        'timestamp' => (int)$wr['updated'],
                    ];
                }
            }
            $wxJson = json_encode($stationWeather, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
            if ($wxJson !== false) {
                cache_set($cacheDir, $wxCacheKey, $wxJson);
            }
        } catch (Throwable $e) {
        }
    }

    // 24-hour farthest aircraft heard & unique aircraft heard count per ground station in viewport
    $stationStats = [];
    try {
        $stParams = [':south' => $south, ':north' => $north, ':cutoff24' => $cutoff24];
        if (!$fullWorld) {
            $stParams[':west'] = $w;
            $stParams[':east'] = $e;
        }
        $stmtSt = $pdo->prepare("
            SELECT s.id, s.max_km, s.farthest_id, s.farthest_ts, s.heard_24h,
                   COALESCE(n.name, pn.name) AS name, d.callsign, d.registration
            FROM stations s
            LEFT JOIN aircraft a ON s.farthest_id = a.id
            LEFT JOIN names n ON s.farthest_id = n.id
            LEFT JOIN names pn ON a.ddb_id != '' AND a.ddb_id = pn.id
            LEFT JOIN ddb d ON a.ddb_id != '' AND a.ddb_id = d.id
            WHERE s.lat BETWEEN :south AND :north
              AND {$lonClauseS}
              AND (s.farthest_ts >= :cutoff24 OR s.heard_24h > 0 OR s.updated >= :cutoff24)
            LIMIT 500
        ");
        $stmtSt->execute($stParams);
        while ($r = $stmtSt->fetch(PDO::FETCH_ASSOC)) {
            $sid = strtolower((string)$r['id']);
            $farthestTs = (int)$r['farthest_ts'];
            $hasFarthest = $farthestTs >= $cutoff24 && (float)$r['max_km'] > 0;
            $label = clean_ogn_name($r['name']) ?: (clean_ogn_name($r['callsign']) ?: (clean_ogn_name($r['registration']) ?: strtoupper((string)$r['farthest_id'])));
            $stationStats[$r['id']] = [
                'heard_24h' => max(0, (int)($r['heard_24h'] ?? 0)),
                'max_km'    => $hasFarthest ? round((float)$r['max_km'], 1) : 0.0,
                'label'     => $hasFarthest ? $label : '',
                'ts'        => $hasFarthest ? $farthestTs : 0,
            ];
        }
    } catch (Throwable $e) {
    }

    $out = [
        'server_time'     => $now,
        'updated'         => $updated,
        'names_updated'   => $namesUpdated,
        'packets'         => $packets ?: new stdClass(),
        'telemetry'       => $telemetry ?: new stdClass(),
        'station_weather' => $stationWeather ?: new stdClass(),
        'station_stats'   => $stationStats ?: new stdClass(),
        'alerts_24h'      => $alerts24h,
    ];
    if ($includeMeta) {
        $out['names'] = $names ?: new stdClass();
        $out['ddb']   = $ddb ?: new stdClass();
    }

    $json = json_encode($out, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    if ($json !== false) {
        if (!$noCache) cache_set($cacheDir, $cacheKey, $json);
        echo $json;
    }
} catch (Throwable $e) {
    error_log('ogn-proxy DB error: ' . $e->getMessage() . ' at ' . basename($e->getFile()) . ':' . $e->getLine());
    $stale = cache_get($cacheDir, $cacheKey, STALE_CACHE_MAX_AGE);
    if ($stale !== null) {
        header('X-OGN-Stale: 1');
        header('Cache-Control: public, max-age=2');
        echo $stale;
        exit;
    }
    http_response_code(500);
    header('Cache-Control: no-store');
    echo json_encode(['error' => 'Database read error']);
}
