<?php
/*
 * OGN Viewport & Track Query API (SQLite + local DDB + short-term cache)
 *   Live viewport: ogn-proxy.php?live=1&north=...&south=...&east=...&west=...&window=<seconds>
 *   Track:         ogn-proxy.php?track=1&id=<aircraft_id>&window=<seconds> (or &since=<unix_ts>)
 */
declare(strict_types=1);

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
    // Lightweight probabilistic cleanup (~1% of writes)
    if (mt_rand(1, 100) === 1) {
        $now = time();
        foreach (glob($cacheDir . '/*.json') ?: [] as $old) {
            if (($now - (int)@filemtime($old)) > 60) {
                @unlink($old);
            }
        }
    }
}

// --- Track Endpoint (up to 24 hours) ---
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
        $cutoff   = max($now - 86400, min($now, $since));
        $cacheKey = 'trk_' . md5($id . '_since_' . $cutoff);
        $metaWindow = max(0, $now - $cutoff);
    } else {
        $window = filter_input(INPUT_GET, 'window', FILTER_VALIDATE_INT);
        if ($window === false || $window === null) {
            $window = 900; // Default 15 minutes
        }
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
        $pdo = new PDO('sqlite:' . $dbFile, null, null, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        ]);
        $pdo->exec('PRAGMA query_only=ON;');
        $pdo->exec('PRAGMA busy_timeout=2000;');

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

// --- Live Viewport Endpoint ---
if (!isset($_GET['live']) || $_GET['live'] !== '1') {
    http_response_code(400);
    header('Cache-Control: no-store');
    echo json_encode(['error' => 'Missing live=1 or track=1 parameter']);
    exit;
}

$north = filter_input(INPUT_GET, 'north', FILTER_VALIDATE_FLOAT);
$south = filter_input(INPUT_GET, 'south', FILTER_VALIDATE_FLOAT);
$east  = filter_input(INPUT_GET, 'east', FILTER_VALIDATE_FLOAT);
$west  = filter_input(INPUT_GET, 'west', FILTER_VALIDATE_FLOAT);

if ($north === false || $south === false || $east === false || $west === false ||
    $north === null  || $south === null  || $east === null  || $west === null) {
    http_response_code(400);
    header('Cache-Control: no-store');
    echo json_encode(['error' => 'Invalid map bounds']);
    exit;
}

$window = filter_input(INPUT_GET, 'window', FILTER_VALIDATE_INT);
if ($window === false || $window === null) {
    $window = 900; // Default 15 minutes
}
$window = max(60, min(86400, $window));

// Snap bounds outward to 0.1 degree grid for high cache hit rate
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

header('Cache-Control: public, max-age=4');

$cacheKey = 'live_' . md5(sprintf('%.1f_%.1f_%.1f_%.1f_%d_%d', $south, $north, $w, $e, $fullWorld ? 1 : 0, $window));
if (($cached = cache_get($cacheDir, $cacheKey, 3)) !== null) {
    echo $cached;
    exit;
}

if (!is_file($dbFile)) {
    echo json_encode([
        'server_time' => time(),
        'updated'     => 0,
        'packets'     => new stdClass(),
        'names'       => new stdClass(),
        'ddb'         => new stdClass(),
    ]);
    exit;
}

try {
    $pdo = new PDO('sqlite:' . $dbFile, null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    ]);
    $pdo->exec('PRAGMA query_only=ON;');
    $pdo->exec('PRAGMA busy_timeout=2000;');

    $cutoff = time() - $window;
    $params = [
        ':south'  => $south,
        ':north'  => $north,
        ':cutoff' => $cutoff,
    ];

    if ($fullWorld) {
        $lonClause = '1=1';
    } else {
        $lonClause = ($w <= $e)
            ? 'a.lon BETWEEN :west AND :east'
            : '(a.lon >= :west OR a.lon <= :east)';
        $params[':west'] = $w;
        $params[':east'] = $e;
    }

    $sql = "
        SELECT a.id, a.ddb_id, a.raw, a.timestamp, n.name,
               d.callsign, d.registration, d.model, d.aircraft_type
        FROM aircraft a
        LEFT JOIN names n ON a.id = n.id
        LEFT JOIN ddb d ON a.ddb_id != '' AND a.ddb_id = d.id
        WHERE a.lat BETWEEN :south AND :north
          AND {$lonClause}
          AND a.timestamp >= :cutoff
        ORDER BY a.timestamp DESC
        LIMIT 3000
    ";

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);

    $packets = [];
    $names   = [];
    $ddb     = [];

    while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
        $id    = $row['id'];
        $ddbId = $row['ddb_id'];
        $packets[$id] = [
            'raw'       => $row['raw'],
            'timestamp' => (int)$row['timestamp'],
        ];
        if (!empty($row['name'])) {
            $names[$id] = $row['name'];
        }
        if ($ddbId !== '' && ($row['callsign'] !== null || $row['registration'] !== null || $row['model'] !== null || $row['aircraft_type'] !== null)) {
            $ddb[$ddbId] = [
                'callsign'        => (string)$row['callsign'],
                'registration'    => (string)$row['registration'],
                'model'           => (string)$row['model'],
                'ddbAircraftType' => (string)$row['aircraft_type'],
            ];
        }
    }

    $updated = (int)$pdo->query('SELECT value FROM meta WHERE key = "updated"')->fetchColumn();

    $json = json_encode([
        'server_time' => time(),
        'updated'     => $updated,
        'packets'     => $packets ?: new stdClass(),
        'names'       => $names ?: new stdClass(),
        'ddb'         => $ddb ?: new stdClass(),
    ], JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);

    if ($json !== false) {
        cache_set($cacheDir, $cacheKey, $json);
        echo $json;
    }
} catch (Throwable $e) {
    http_response_code(500);
    header('Cache-Control: no-store');
    echo json_encode(['error' => 'Database read error']);
}
