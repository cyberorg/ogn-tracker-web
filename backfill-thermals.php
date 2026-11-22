<?php
/**
 * One-time backfill of the thermals heatmap table from historical track points.
 *
 * Usage: php backfill-thermals.php [path/to/ogn-live.sqlite] [window-seconds]
 *
 * Defaults to the database beside this script and the same 6-hour window used
 * by the thermals endpoint. Safe to re-run: existing points are ignored.
 *
 * Work is split into short transactions so the collector's frequent writes are
 * never blocked for long. SQLite's own locking (not the collector's flock file)
 * serialises the two writers; busy_timeout plus retries handle contention.
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('CLI only.');
}

$dbFile = $argv[1] ?? __DIR__ . '/ogn-live.sqlite';
$window = isset($argv[2]) ? max(60, min(86400, (int)$argv[2])) : 21600;

if (!is_file($dbFile)) {
    fwrite(STDERR, "Database not found: {$dbFile}\n");
    exit(1);
}

$pdo = new PDO('sqlite:' . $dbFile, null, null, [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
]);
$pdo->exec('PRAGMA busy_timeout=5000');
$pdo->exec('
    CREATE TABLE IF NOT EXISTS thermals (
        id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        lat REAL NOT NULL,
        lon REAL NOT NULL,
        intensity REAL NOT NULL,
        PRIMARY KEY (id, ts)
    ) WITHOUT ROWID
');
$pdo->exec('CREATE INDEX IF NOT EXISTS idx_thermals_ts ON thermals (ts)');
$pdo->exec('CREATE TEMP TABLE glider_ids (id TEXT PRIMARY KEY)');

function packet_type_from_raw(string $line): int
{
    $sym = '';
    if (preg_match('/(\d{6})h(\d{2})(\d{2}\.\d+)([NS])(.)(\d{3})(\d{2}\.\d+)([EW])(.)/', $line, $m)) {
        $sym = $m[9];
    }
    $isStation = in_array($sym, ['_', '&', '#', 'r'], true);
    $type = $isStation ? 15 : 0;

    if (preg_match('/\bid([0-9a-fA-F]{2})[0-9a-fA-F]{6,8}\b/i', $line, $im)) {
        $parsed = (hexdec($im[1]) >> 2) & 0x0F;
        if (!$isStation && $parsed > 0) {
            if ($parsed === 15 && (preg_match('/\bFNT7[0-9a-f]\b/i', $line) || preg_match('/^FNT[0-9a-f]{6}>/i', $line))) {
                $type = 7;
            } elseif ($parsed === 7 && preg_match('/^[^>]+>OGADSB\b/i', $line)) {
                $type = 16;
            } else {
                $type = $parsed;
            }
        }
    } elseif ($type === 0) {
        if ($sym === 'g') $type = 7;
        elseif ($sym === "'") $type = 1;
        elseif ($sym === '^') $type = 8;
        elseif ($sym === 'X') $type = 3;
        elseif ($sym === 'O') $type = 11;
    }
    return $type;
}

// Same rule as the collector: packet type wins, DDB type is the fallback.
$stmtAircraft = $pdo->query("
    SELECT a.id, a.raw, CAST(COALESCE(NULLIF(d.aircraft_type, ''), '0') AS INTEGER) AS ddb_type
    FROM aircraft a
    LEFT JOIN ddb d ON a.ddb_id != '' AND a.ddb_id = d.id
");
$stmtAddGlider = $pdo->prepare('INSERT OR IGNORE INTO glider_ids (id) VALUES (:id)');
while ($row = $stmtAircraft->fetch(PDO::FETCH_ASSOC)) {
    $type = packet_type_from_raw((string)($row['raw'] ?? ''));
    $effective = $type > 0 ? $type : (int)$row['ddb_type'];
    if (in_array($effective, [1, 6, 7], true)) {
        $stmtAddGlider->execute([':id' => $row['id']]);
    }
}

$gliderCount = (int)$pdo->query('SELECT count(*) FROM glider_ids')->fetchColumn();
if (in_array('--clean', $argv, true)) {
    $removed = $pdo->exec('DELETE FROM thermals WHERE id NOT IN (SELECT id FROM glider_ids)');
    fwrite(STDOUT, "Removed {$removed} points from non-glider aircraft.\n");
}
$cutoff = time() - $window;
fwrite(STDOUT, "Backfilling last {$window}s using {$gliderCount} glider IDs...\n");

$stmt = $pdo->prepare('
    WITH recent AS (
        SELECT t.id, t.lat, t.lon, t.alt, t.ts,
               LAG(t.alt) OVER (PARTITION BY t.id ORDER BY t.ts) AS prev_alt,
               LAG(t.ts) OVER (PARTITION BY t.id ORDER BY t.ts) AS prev_ts
        FROM tracks t
        WHERE t.ts >= :from
          AND t.ts < :to
          AND t.alt IS NOT NULL
          AND EXISTS (SELECT 1 FROM glider_ids g WHERE g.id = t.id)
    )
    INSERT OR IGNORE INTO thermals (id, ts, lat, lon, intensity)
    SELECT id, ts, lat, lon,
           round(min(1.0, ((alt - prev_alt) / (ts - prev_ts)) / 5.0), 2)
    FROM recent
    WHERE prev_ts IS NOT NULL
      AND (ts - prev_ts) BETWEEN 3 AND 120
      AND ((alt - prev_alt) / (ts - prev_ts)) BETWEEN 1.5 AND 15.0
');

$chunkSeconds = 600;
$overlapSeconds = 120; // Re-scan a little before each chunk so no boundary climb is lost.
$started = microtime(true);
$inserted = 0;

for ($chunkEnd = time(); $chunkEnd > $cutoff; $chunkEnd -= $chunkSeconds) {
    $chunkStart = max($cutoff, $chunkEnd - $chunkSeconds);
    $params = [
        ':from' => $chunkStart - $overlapSeconds,
        ':to'   => $chunkEnd,
    ];

    for ($attempt = 1; $attempt <= 5; $attempt++) {
        try {
            $stmt->execute($params);
            $inserted += $stmt->rowCount();
            break;
        } catch (PDOException $e) {
            if (stripos($e->getMessage(), 'locked') === false || $attempt === 5) {
                throw $e;
            }
            usleep(200000 * $attempt);
        }
    }
    usleep(100000); // Brief pause so the collector can flush between chunks.
}

printf("Inserted %d thermal points in %.1fs\n", $inserted, microtime(true) - $started);
