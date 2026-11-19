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

const RUN_SECONDS       = 55;
const EXPIRE_SECONDS    = 86400; // 24 hours
const FLUSH_INTERVAL    = 3.0;   // Batch-write to SQLite every 3 seconds
const DDB_SYNC_INTERVAL = 21600; // Refresh full DDB every 6 hours

$lockFile = __DIR__ . '/ogn-collector.lock';
$dbFile   = __DIR__ . '/ogn-live.sqlite';

$lockFp = fopen($lockFile, 'c');
if (!$lockFp || !flock($lockFp, LOCK_EX | LOCK_NB)) {
    exit(0);
}

$pdo = new PDO('sqlite:' . $dbFile, null, null, [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
]);
$pdo->exec('PRAGMA journal_mode=WAL;');
$pdo->exec('PRAGMA synchronous=NORMAL;');
$pdo->exec('PRAGMA busy_timeout=3000;');

$pdo->exec('
    CREATE TABLE IF NOT EXISTS aircraft (
        id TEXT PRIMARY KEY,
        lat REAL NOT NULL,
        lon REAL NOT NULL,
        raw TEXT NOT NULL,
        timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_aircraft_coords ON aircraft (lat, lon);
    CREATE INDEX IF NOT EXISTS idx_aircraft_ts ON aircraft (timestamp);

    CREATE TABLE IF NOT EXISTS tracks (
        id TEXT NOT NULL,
        lat REAL NOT NULL,
        lon REAL NOT NULL,
        alt REAL,
        ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tracks_id_ts ON tracks (id, ts);
    CREATE INDEX IF NOT EXISTS idx_tracks_ts ON tracks (ts);

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

// --- Sync full OGN DDB once every 6 hours ---
$ddbUpdated = (int)$pdo->query('SELECT value FROM meta WHERE key = "ddb_updated"')->fetchColumn();
if ((time() - $ddbUpdated) >= DDB_SYNC_INTERVAL) {
    try {
        $ctx  = stream_context_create(['http' => ['timeout' => 15, 'user_agent' => 'OGN-Global-Collector/1.2']]);
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
    INSERT INTO aircraft (id, lat, lon, raw, timestamp)
    VALUES (:id, :lat, :lon, :raw, :ts)
    ON CONFLICT(id) DO UPDATE SET
        lat = excluded.lat,
        lon = excluded.lon,
        raw = excluded.raw,
        timestamp = excluded.timestamp
');
$stmtInsertTrack = $pdo->prepare('
    INSERT INTO tracks (id, lat, lon, alt, ts)
    VALUES (:id, :lat, :lon, :alt, :ts)
');
$stmtTouchPos = $pdo->prepare('UPDATE aircraft SET timestamp = :ts WHERE id = :id');
$stmtUpsertName = $pdo->prepare('
    INSERT INTO names (id, name, updated)
    VALUES (:id, :name, :ts)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated = excluded.updated
');
$stmtMeta = $pdo->prepare('
    INSERT INTO meta (key, value) VALUES ("updated", :ts)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
');

function flush_batch(
    PDO $pdo,
    PDOStatement $stmtUpsertPos,
    PDOStatement $stmtInsertTrack,
    PDOStatement $stmtTouchPos,
    PDOStatement $stmtUpsertName,
    PDOStatement $stmtMeta,
    array &$posBatch,
    array &$trackBatch,
    array &$touchBatch,
    array &$nameBatch,
    bool $prune = false
): void {
    $now = time();
    $pdo->beginTransaction();
    try {
        foreach ($posBatch as $id => $p) {
            $stmtUpsertPos->execute([
                ':id'  => $id,
                ':lat' => $p['lat'],
                ':lon' => $p['lon'],
                ':raw' => $p['raw'],
                ':ts'  => $p['ts'],
            ]);
        }
        foreach ($trackBatch as $t) {
            $stmtInsertTrack->execute([
                ':id'  => $t['id'],
                ':lat' => $t['lat'],
                ':lon' => $t['lon'],
                ':alt' => $t['alt'],
                ':ts'  => $t['ts'],
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
            $cutoff = $now - EXPIRE_SECONDS;
            $pdo->exec('DELETE FROM aircraft WHERE timestamp < ' . $cutoff);
            $pdo->exec('DELETE FROM tracks WHERE ts < ' . $cutoff);
        }
        $stmtMeta->execute([':ts' => (string)$now]);
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
    }
    $posBatch   = [];
    $trackBatch = [];
    $touchBatch = [];
    $nameBatch  = [];
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
fwrite($socket, "user PARAGUIDE pass -1 vers OGN-Global-Collector 1.2 filter a/90/-180/-90/180\r\n");

$deadline  = microtime(true) + RUN_SECONDS;
$lastFlush = microtime(true);

$posBatch      = [];
$trackBatch    = [];
$touchBatch    = [];
$nameBatch     = [];
$lastTrackPoint = [];

while (microtime(true) < $deadline && !feof($socket)) {
    $line = fgets($socket, 1024);

    if ($line !== false) {
        $line = trim($line);
        if ($line !== '' && $line[0] !== '#' && strpos($line, '>') !== false) {
            $id = '';
            if (preg_match('/\bid[0-9a-fA-F]{8,10}\b/i', $line, $m)) {
                $id = strtolower(substr($m[0], -6));
            } elseif (preg_match('/^([^>]+)>/', $line, $m)) {
                $id = preg_match('/([0-9A-F]{6})$/i', $m[1], $hm)
                    ? strtolower($hm[1])
                    : strtolower($m[1]);
            }

            if ($id !== '') {
                $now = time();

                if (preg_match('/Name="([^"]+)"/', $line, $nm)) {
                    $nameBatch[$id] = $nm[1];
                }

                if (preg_match('/(\d{6})h(\d{2})(\d{2}\.\d+)([NS])(.)(\d{3})(\d{2}\.\d+)([EW])(.)/', $line, $bm)) {
                    $lat = (int)$bm[2] + ((float)$bm[3] / 60.0);
                    if ($bm[4] === 'S') $lat = -$lat;

                    $lon = (int)$bm[6] + ((float)$bm[7] / 60.0);
                    if ($bm[8] === 'W') $lon = -$lon;

                    $posBatch[$id] = [
                        'lat' => $lat,
                        'lon' => $lon,
                        'raw' => $line,
                        'ts'  => $now,
                    ];

                    // Skip fixed ground/weather stations from tracks table
                    $sym = $bm[9];
                    $isStation = ($sym === '_' || $sym === '&' || $sym === '#' || $sym === 'r');
                    if (!$isStation && abs($lat) <= 90 && abs($lon) <= 180 && !($lat == 0.0 && $lon == 0.0)) {
                        $alt = null;
                        if (preg_match('/\/A=(-?\d{6})/', $line, $am)) {
                            $alt = round((int)$am[1] * 0.3048, 1);
                        }

                        // Record track point if moved > ~10m or first point this run
                        $prev = $lastTrackPoint[$id] ?? null;
                        if ($prev === null || abs($lat - $prev['lat']) > 0.0001 || abs($lon - $prev['lon']) > 0.0001) {
                            $trackBatch[] = [
                                'id'  => $id,
                                'lat' => $lat,
                                'lon' => $lon,
                                'alt' => $alt,
                                'ts'  => $now,
                            ];
                            $lastTrackPoint[$id] = ['lat' => $lat, 'lon' => $lon];
                        }
                    }
                } else {
                    $touchBatch[$id] = $now;
                }
            }
        }
    }

    if ((microtime(true) - $lastFlush) >= FLUSH_INTERVAL) {
        flush_batch($pdo, $stmtUpsertPos, $stmtInsertTrack, $stmtTouchPos, $stmtUpsertName, $stmtMeta, $posBatch, $trackBatch, $touchBatch, $nameBatch, false);
        $lastFlush = microtime(true);
    }
}

fclose($socket);
flush_batch($pdo, $stmtUpsertPos, $stmtInsertTrack, $stmtTouchPos, $stmtUpsertName, $stmtMeta, $posBatch, $trackBatch, $touchBatch, $nameBatch, true);

flock($lockFp, LOCK_UN);
fclose($lockFp);
