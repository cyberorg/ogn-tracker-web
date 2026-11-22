<?php
/*
 * OGN Viewport, Track, Thermal & Replay API (SQLite + local DDB + Gzip + Cache)
 *   Live viewport: ogn-proxy.php?live=1&north=...&south=...&east=...&west=...&window=<sec>&meta=<0|1>
 *   Track:         ogn-proxy.php?track=1&id=<aircraft_id>&window=<sec> (or &since=<unix_ts>)
 *   Thermals:      ogn-proxy.php?thermals=1&north=...&south=...&east=...&west=...
 *   Replay:        ogn-proxy.php?replay=1&ts=<unix_ts>&north=...&south=...&east=...&west=...
 */
declare(strict_types=1);

const THERMAL_CACHE_TTL = 600;
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
    if (mt_rand(1, 100) === 1) {
        $now = time();
        foreach (glob($cacheDir . '/*.json') ?: [] as $old) {
            $name = basename($old);
            if (str_starts_with($name, 'thm_')) {
                $ttl = THERMAL_CACHE_TTL;
            } elseif (str_starts_with($name, 'live_')) {
                $ttl = STALE_CACHE_MAX_AGE;
            } else {
                $ttl = 120;
            }
            if (($now - (int)@filemtime($old)) > $ttl) {
                @unlink($old);
            }
        }
    }
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

function open_db(string $dbFile): PDO {
    $pdo = new PDO('sqlite:' . $dbFile, null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    ]);
    $pdo->exec('PRAGMA query_only=ON;');
    $pdo->exec('PRAGMA busy_timeout=10000;');
    return $pdo;
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
    $fullWorld = (($east - $west) >= 360.0);

    if ($fullWorld) {
        $w = -180.0;
        $e = 180.0;
    } else {
        $w = floor($west * 10.0) / 10.0;
        $e = ceil($east * 10.0) / 10.0;
        $w = fmod(fmod($w + 180.0, 360.0) + 360.0, 360.0) - 180.0;
        $e = fmod(fmod($e + 180.0, 360.0) + 360.0, 360.0) - 180.0;
    }

    return [$south, $north, $w, $e, $fullWorld];
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

// --- 1. Track Endpoint ---
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

    if ($since !== false && $since !== null) {
        $cutoff     = max($now - 86400, min($now, $since));
        $cacheKey   = 'trk_' . md5($id . '_since_' . $cutoff);
        $metaWindow = max(0, $now - $cutoff);
    } else {
        $window = filter_input(INPUT_GET, 'window', FILTER_VALIDATE_INT);
        if ($window === false || $window === null) $window = 900;
        $window     = max(60, min(86400, $window));
        $cutoff     = $now - $window;
        $cacheKey   = 'trk_' . md5($id . '_win_' . $window);
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
            LIMIT 20000
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
        if ($total > 1500) {
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

// --- 2. Today's Thermal Heatmap Endpoint ---
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

// --- 3. 24-Hour Time-Lapse Replay Endpoint ---
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

    header('Cache-Control: public, max-age=30');
    $cacheKey = 'rpl_' . md5(sprintf('%.1f_%.1f_%.1f_%.1f_%d_%d', $south, $north, $w, $e, $fullWorld ? 1 : 0, $tsBucket));
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
        if ($fullWorld) {
            $lonClause = '1=1';
        } else {
            $lonClause = ($w <= $e) ? 'lon BETWEEN :west AND :east' : '(lon >= :west OR lon <= :east)';
            $params[':west'] = $w;
            $params[':east'] = $e;
        }

        $stmt = $pdo->prepare("
            SELECT latest.id, latest.lat, latest.lon, latest.alt, latest.ts,
                   n.name, d.callsign, d.registration
            FROM (
                SELECT id, lat, lon, alt, MAX(ts) AS ts
                FROM tracks
                WHERE ts BETWEEN :t1 AND :t2
                  AND lat BETWEEN :south AND :north
                  AND {$lonClause}
                GROUP BY id
                LIMIT 2000
            ) latest
            LEFT JOIN aircraft a ON latest.id = a.id
            LEFT JOIN names n ON latest.id = n.id
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

// --- 4. Live Viewport Endpoint ---
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

header('Cache-Control: public, max-age=' . $liveTtl);

$cacheKey = 'live_' . md5(sprintf('%.1f_%.1f_%.1f_%.1f_%d_%d_%d', $south, $north, $w, $e, $fullWorld ? 1 : 0, $window, $includeMeta ? 1 : 0));
if (($cached = cache_get($cacheDir, $cacheKey, $liveTtl)) !== null) {
    echo $cached;
    exit;
}

if (!is_file($dbFile)) {
    echo json_encode([
        'server_time'     => time(),
        'updated'         => 0,
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
            SELECT a.id, a.ddb_id, a.raw, a.timestamp, n.name,
                   d.callsign, d.registration, d.model, d.aircraft_type
            FROM aircraft a {$aircraftIndex}
            LEFT JOIN names n ON a.id = n.id
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
            SELECT a.id, a.ddb_id, a.raw, a.timestamp, n.name,
                   d.callsign, d.registration, d.model, d.aircraft_type
            FROM aircraft a
            LEFT JOIN names n ON a.id = n.id
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
    $alertsCacheKey = 'alerts24h_v9';
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
                    SELECT al.id, al.status, al.lat, al.lon, al.alt, al.raw, al.last_ts,
                           a.lat AS latest_lat, a.lon AS latest_lon,
                           a.timestamp AS latest_ts, a.is_emergency AS latest_emerg, a.raw AS latest_raw,
                           n.name, d.callsign, d.registration
                    FROM alerts al
                    LEFT JOIN aircraft a ON al.id = a.id
                    LEFT JOIN names n ON al.id = n.id
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
                        'latest_ts'      => $latestTs,
                        'normal_after'   => $subsequentNormal,
                        'alert_still_on' => $stillAlertOnLast,
                    ];
                }
            }

            $stmtA24 = $pdo->prepare("
                SELECT a.id, a.lat, a.lon, a.raw, a.timestamp, a.is_emergency, n.name, d.callsign, d.registration
                FROM aircraft a
                LEFT JOIN names n ON a.id = n.id
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
                   n.name, d.callsign, d.registration
            FROM stations s
            LEFT JOIN aircraft a ON s.farthest_id = a.id
            LEFT JOIN names n ON s.farthest_id = n.id
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

    $updated = (int)$pdo->query('SELECT value FROM meta WHERE key = "updated"')->fetchColumn();

    $out = [
        'server_time'     => $now,
        'updated'         => $updated,
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
        cache_set($cacheDir, $cacheKey, $json);
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
