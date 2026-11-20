<?php
/*
 * OGN Viewport, Track, Thermal & Replay API (SQLite + local DDB + Gzip + Cache)
 *   Live viewport: ogn-proxy.php?live=1&north=...&south=...&east=...&west=...&window=<sec>&meta=<0|1>
 *   Track:         ogn-proxy.php?track=1&id=<aircraft_id>&window=<sec> (or &since=<unix_ts>)
 *   Thermals:      ogn-proxy.php?thermals=1&north=...&south=...&east=...&west=...
 *   Replay:        ogn-proxy.php?replay=1&ts=<unix_ts>&north=...&south=...&east=...&west=...
 */
declare(strict_types=1);

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
            if (($now - (int)@filemtime($old)) > 120) {
                @unlink($old);
            }
        }
    }
}

function open_db(string $dbFile): PDO {
    $pdo = new PDO('sqlite:' . $dbFile, null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    ]);
    $pdo->exec('PRAGMA query_only=ON;');
    $pdo->exec('PRAGMA busy_timeout=2000;');
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

    header('Cache-Control: public, max-age=60');
    $cacheKey = 'thm_' . md5(sprintf('%.1f_%.1f_%.1f_%.1f_%d', $south, $north, $w, $e, $fullWorld ? 1 : 0));
    if (($cached = cache_get($cacheDir, $cacheKey, 60)) !== null) {
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

        $stmt = $pdo->prepare("
            SELECT id, lat, lon, alt, ts
            FROM tracks
            WHERE ts >= :cutoff
              AND alt IS NOT NULL
              AND lat BETWEEN :south AND :north
              AND {$lonClause}
            ORDER BY id ASC, ts ASC
            LIMIT 40000
        ");
        $stmt->execute($params);

        $heat = [];
        $prev = null;
        while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
            if ($prev !== null && $prev['id'] === $row['id']) {
                $dt = (int)$row['ts'] - (int)$prev['ts'];
                if ($dt >= 3 && $dt <= 120) {
                    $climb = ((float)$row['alt'] - (float)$prev['alt']) / $dt;
                    if ($climb >= 1.5 && $climb <= 15.0) {
                        $heat[] = [
                            round((float)$row['lat'], 4),
                            round((float)$row['lon'], 4),
                            round(min(1.0, $climb / 5.0), 2),
                        ];
                        if (count($heat) >= 3000) break;
                    }
                }
            }
            $prev = $row;
        }

        $json = json_encode(['points' => $heat]);
        if ($json !== false) {
            cache_set($cacheDir, $cacheKey, $json);
            echo $json;
        }
    } catch (Throwable $e) {
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
            $label = $r['name'] ?: ($r['callsign'] ?: ($r['registration'] ?: strtoupper($r['id'])));
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

header('Cache-Control: public, max-age=4');

$cacheKey = 'live_' . md5(sprintf('%.1f_%.1f_%.1f_%.1f_%d_%d_%d', $south, $north, $w, $e, $fullWorld ? 1 : 0, $window, $includeMeta ? 1 : 0));
if (($cached = cache_get($cacheDir, $cacheKey, 3)) !== null) {
    echo $cached;
    exit;
}

if (!is_file($dbFile)) {
    echo json_encode([
        'server_time'    => time(),
        'updated'        => 0,
        'packets'        => new stdClass(),
        'telemetry'      => new stdClass(),
        'station_weather'=> new stdClass(),
        'names'          => new stdClass(),
        'ddb'            => new stdClass(),
        'station_stats'  => new stdClass(),
    ]);
    exit;
}

try {
    $pdo = open_db($dbFile);
    $now = time();
    $cutoff = $now - $window;
    $wxCutoff = $now - max($window, 1800);
    $params = [':south' => $south, ':north' => $north, ':cutoff' => $cutoff];

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
            if (!empty($row['name'])) {
                $names[$id] = $row['name'];
            }
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
            FROM aircraft a
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
            FROM aircraft a
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

    // Telemetry / status packets
    $telemetry = [];
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
    } catch (Throwable $e) {
    }

    // Persisted station weather cache across reloads and multi-minute intervals
    $stationWeather = [];
    try {
        $stmtWx = $pdo->prepare('
            SELECT id, wx_json, updated
            FROM station_weather
            WHERE updated >= :cutoff
            ORDER BY updated DESC
            LIMIT 1000
        ');
        $stmtWx->execute([':cutoff' => $wxCutoff]);
        while ($wr = $stmtWx->fetch(PDO::FETCH_ASSOC)) {
            $decodedWx = json_decode((string)$wr['wx_json'], true);
            if (is_array($decodedWx)) {
                $stationWeather[$wr['id']] = [
                    'wx'        => $decodedWx,
                    'timestamp' => (int)$wr['updated'],
                ];
            }
        }
    } catch (Throwable $e) {
    }

    // 24-hour farthest aircraft heard per ground station in viewport
    $stationStats = [];
    try {
        $stParams = [':south' => $south, ':north' => $north, ':cutoff24' => $now - 86400];
        if (!$fullWorld) {
            $stParams[':west'] = $w;
            $stParams[':east'] = $e;
        }
        $stmtSt = $pdo->prepare("
            SELECT s.id, s.max_km, s.farthest_id, s.farthest_ts,
                   n.name, d.callsign, d.registration
            FROM stations s
            LEFT JOIN aircraft a ON s.farthest_id = a.id
            LEFT JOIN names n ON s.farthest_id = n.id
            LEFT JOIN ddb d ON a.ddb_id != '' AND a.ddb_id = d.id
            WHERE s.lat BETWEEN :south AND :north
              AND {$lonClauseS}
              AND s.max_km > 0
              AND s.farthest_ts >= :cutoff24
            LIMIT 500
        ");
        $stmtSt->execute($stParams);
        while ($r = $stmtSt->fetch(PDO::FETCH_ASSOC)) {
            $label = $r['name'] ?: ($r['callsign'] ?: ($r['registration'] ?: strtoupper($r['farthest_id'])));
            $stationStats[$r['id']] = [
                'max_km' => round((float)$r['max_km'], 1),
                'label'  => $label,
                'ts'     => (int)$r['farthest_ts'],
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
    http_response_code(500);
    header('Cache-Control: no-store');
    echo json_encode(['error' => 'Database read error']);
}
