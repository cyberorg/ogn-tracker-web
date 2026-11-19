<?php
/*
 * OGN Viewport & Track Query API (SQLite + local DDB)
 *   Live viewport: ogn-proxy.php?live=1&north=...&south=...&east=...&west=...
 *   Track:         ogn-proxy.php?track=1&id=<aircraft_id>&window=<seconds>
 */
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, max-age=0');

$dbFile = __DIR__ . '/ogn-live.sqlite';

// --- Track Endpoint (up to 24 hours) ---
if (isset($_GET['track']) && $_GET['track'] === '1') {
    $id = strtolower(trim((string)($_GET['id'] ?? '')));
    if ($id === '' || !preg_match('/^[a-z0-9_-]{1,20}$/', $id)) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid aircraft id']);
        exit;
    }

    $window = filter_input(INPUT_GET, 'window', FILTER_VALIDATE_INT);
    if ($window === false || $window === null) {
        $window = 3600; // Default 1 hour
    }
    $window = max(60, min(86400, $window));

    if (!is_file($dbFile)) {
        echo json_encode(['id' => $id, 'window' => $window, 'points' => []]);
        exit;
    }

    try {
        $pdo = new PDO('sqlite:' . $dbFile, null, null, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        ]);
        $pdo->exec('PRAGMA busy_timeout=2000;');

        $cutoff = time() - $window;
        $stmt = $pdo->prepare('
            SELECT lat, lon, alt, ts
            FROM tracks
            WHERE id = :id AND ts >= :cutoff
            ORDER BY ts ASC
            LIMIT 5000
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

        echo json_encode(['id' => $id, 'window' => $window, 'points' => $points]);
    } catch (Throwable $e) {
        http_response_code(500);
        echo json_encode(['error' => 'Track read error']);
    }
    exit;
}

// --- Live Viewport Endpoint ---
if (!isset($_GET['live']) || $_GET['live'] !== '1') {
    http_response_code(400);
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
    echo json_encode(['error' => 'Invalid map bounds']);
    exit;
}

$south = max(-90.0, min(90.0, $south));
$north = max(-90.0, min(90.0, $north));

if (!is_file($dbFile)) {
    echo json_encode([
        'updated' => 0,
        'packets' => new stdClass(),
        'names'   => new stdClass(),
        'ddb'     => new stdClass(),
    ]);
    exit;
}

try {
    $pdo = new PDO('sqlite:' . $dbFile, null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    ]);
    $pdo->exec('PRAGMA busy_timeout=2000;');

    $cutoff = time() - 900; // Show aircraft active in the last 15 minutes
    $params = [
        ':south'  => $south,
        ':north'  => $north,
        ':cutoff' => $cutoff,
    ];

    if (($east - $west) >= 360.0) {
        $lonClause = '1=1';
    } else {
        // Normalize longitude into [-180, 180]
        $w = fmod(fmod($west + 180.0, 360.0) + 360.0, 360.0) - 180.0;
        $e = fmod(fmod($east + 180.0, 360.0) + 360.0, 360.0) - 180.0;
        $lonClause = ($w <= $e)
            ? 'a.lon BETWEEN :west AND :east'
            : '(a.lon >= :west OR a.lon <= :east)';
        $params[':west'] = $w;
        $params[':east'] = $e;
    }

    $sql = "
        SELECT a.id, a.raw, a.timestamp, n.name,
               d.callsign, d.registration, d.model, d.aircraft_type, d.raw_json
        FROM aircraft a
        LEFT JOIN names n ON a.id = n.id
        LEFT JOIN ddb d ON a.id = d.id
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
        $id = $row['id'];
        $packets[$id] = [
            'raw'       => $row['raw'],
            'timestamp' => (int)$row['timestamp'],
        ];
        if (!empty($row['name'])) {
            $names[$id] = $row['name'];
        }
        if ($row['raw_json'] !== null) {
            $ddb[$id] = [
                'callsign'        => $row['callsign'],
                'registration'    => $row['registration'],
                'model'           => $row['model'],
                'ddbAircraftType' => $row['aircraft_type'],
                'ddbRecord'       => json_decode($row['raw_json'], true),
            ];
        }
    }

    $updated = (int)$pdo->query('SELECT value FROM meta WHERE key = "updated"')->fetchColumn();

    echo json_encode([
        'updated' => $updated,
        'packets' => $packets ?: new stdClass(),
        'names'   => $names ?: new stdClass(),
        'ddb'     => $ddb ?: new stdClass(),
    ], JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode(['error' => 'Database read error']);
}
