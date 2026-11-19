<?php
/*
 * OGN Viewport Query API (SQLite + local DDB)
 *   ogn-proxy.php?live=1&north=...&south=...&east=...&west=...
 */
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, max-age=0');

if (!isset($_GET['live']) || $_GET['live'] !== '1') {
    http_response_code(400);
    echo json_encode(['error' => 'Missing live=1 parameter']);
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

$dbFile = __DIR__ . '/ogn-live.sqlite';
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

    $cutoff = time() - 900; // 15 minutes
    $lonClause = ($west <= $east)
        ? 'a.lon BETWEEN :west AND :east'
        : '(a.lon >= :west OR a.lon <= :east)';

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
        LIMIT 500
    ";

    $stmt = $pdo->prepare($sql);
    $stmt->execute([
        ':south'  => $south,
        ':north'  => $north,
        ':west'   => $west,
        ':east'   => $east,
        ':cutoff' => $cutoff,
    ]);

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
