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
const EXPIRE_SECONDS       = 86400; // 24 hours for last-known aircraft positions
const TRACK_EXPIRE_SECONDS = 86400; // 24 hours for flight tracks (supports full "Today" tracks)
const TRACK_MIN_INTERVAL   = 15;    // Min seconds between track points for non-paragliders
const FLUSH_INTERVAL       = 3.0;   // Batch-write to SQLite every 3 seconds
const DDB_SYNC_INTERVAL    = 21600; // Refresh full DDB every 6 hours

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

    CREATE TABLE IF NOT EXISTS tracks (
        id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        lat REAL NOT NULL,
        lon REAL NOT NULL,
        alt REAL,
        PRIMARY KEY (id, ts)
    ) WITHOUT ROWID;
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

// Auto-migrate existing databases to add is_emergency column + partial index
$cols = array_column($pdo->query('PRAGMA table_info(aircraft)')->fetchAll(PDO::FETCH_ASSOC), 'name');
if (!in_array('is_emergency', $cols, true)) {
    $pdo->exec('ALTER TABLE aircraft ADD COLUMN is_emergency INTEGER NOT NULL DEFAULT 0;');
}
$pdo->exec('CREATE INDEX IF NOT EXISTS idx_aircraft_emerg ON aircraft (timestamp) WHERE is_emergency = 1;');

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

// --- Sync full OGN DDB once every 6 hours ---
$ddbUpdated = (int)$pdo->query('SELECT value FROM meta WHERE key = "ddb_updated"')->fetchColumn();
if ((time() - $ddbUpdated) >= DDB_SYNC_INTERVAL) {
    try {
        $ctx  = stream_context_create(['http' => ['timeout' => 15, 'user_agent' => 'OGN-Global-Collector/1.7']]);
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
$stmtInsertTrack = $pdo->prepare('
    INSERT OR IGNORE INTO tracks (id, ts, lat, lon, alt)
    VALUES (:id, :ts, :lat, :lon, :alt)
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
                ':id'     => $id,
                ':ddb_id' => $p['ddb_id'],
                ':lat'    => $p['lat'],
                ':lon'    => $p['lon'],
                ':raw'    => $p['raw'],
                ':ts'     => $p['ts'],
                ':emerg'  => $p['is_emergency'],
            ]);
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
        foreach ($touchBatch as $id => $ts) {
            if (!isset($posBatch[$id])) {
                $stmtTouchPos->execute([':id' => $id, ':ts' => $ts]);
            }
        }
        foreach ($nameBatch as $id => $name) {
            $stmtUpsertName->execute([':id' => $id, ':name' => $name, ':ts' => $now]);
        }
        if ($prune) {
            $pdo->exec('DELETE FROM aircraft WHERE timestamp < ' . ($now - EXPIRE_SECONDS));
            $pdo->exec('DELETE FROM tracks WHERE ts < ' . ($now - TRACK_EXPIRE_SECONDS));
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
fwrite($socket, "user PARAGUIDE pass -1 vers OGN-Global-Collector 1.7 filter a/90/-180/-90/180\r\n");

$deadline  = microtime(true) + RUN_SECONDS;
$lastFlush = microtime(true);

$posBatch       = [];
$trackBatch     = [];
$touchBatch     = [];
$nameBatch      = [];
$lastTrackPoint = [];

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

            if (preg_match('/Name="([^"]+)"/', $line, $nm)) {
                $nameBatch[$id] = $nm[1];
            }

            if (preg_match('/(\d{6})h(\d{2})(\d{2}\.\d+)([NS])(.)(\d{3})(\d{2}\.\d+)([EW])(.)/', $line, $bm, PREG_OFFSET_CAPTURE)) {
                $lat = (int)$bm[2][0] + ((float)$bm[3][0] / 60.0);
                if ($bm[4][0] === 'S') $lat = -$lat;

                $lon = (int)$bm[6][0] + ((float)$bm[7][0] / 60.0);
                if ($bm[8][0] === 'W') $lon = -$lon;

                // Reject corrupted coordinates before touching aircraft or tracks
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
                if (preg_match('/^(\d{3})\/(\d{3})/', $remainder, $csm)) {
                    $speed = (int)$csm[2] * 1.852;
                }
                $alt = null;
                if (preg_match('/\/A=(-?\d{6})/', $remainder, $am)) {
                    $alt = round((int)$am[1] * 0.3048, 1);
                }

                // Reject impossible RF noise telemetry so it never overwrites a good packet
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

                $posBatch[$id] = [
                    'ddb_id'       => $ddbId,
                    'lat'          => $lat,
                    'lon'          => $lon,
                    'raw'          => $line,
                    'ts'           => $now,
                    'is_emergency' => is_emergency_packet($line),
                ];

                // Log tracks (skip fixed ground/weather stations; log all points for paragliders)
                if (!$isStation) {
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
                }
            } else {
                $touchBatch[$id] = $now;
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

// Reclaim freed pages and keep WAL file compact
try {
    $pdo->exec('PRAGMA incremental_vacuum(500);');
    $pdo->exec('PRAGMA wal_checkpoint(TRUNCATE);');
} catch (Throwable $e) {
    // Non-fatal if another reader holds a lock
}

flock($lockFp, LOCK_UN);
fclose($lockFp);
