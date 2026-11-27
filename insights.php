<?php
declare(strict_types=1);

/*
 * OGN Tracker Insights — read-only rolling 24-hour statistics.
 * Regeneration is done by a 4-hourly cron job (php insights.php --generate)
 * or on demand with ?fresh=1.
 */

$dbFile = __DIR__ . '/ogn-live.sqlite';
$cutoff = time() - 86400;
$cacheTtl = 4 * 3600;
$trackGapSeconds = 600; // A gap longer than this starts a new continuous track
$altRecordNearM = 500.0; // A record needs another packet this close to its altitude
$cacheDir = rtrim(sys_get_temp_dir(), '/\\') . '/ogn_tracker_cache';
$cacheFile = $cacheDir . '/insights_page.html';
$cacheMeta = $cacheDir . '/insights_page.meta.json';
$historyFile = $cacheDir . '/insights_history.json';

// SQLite's 'localtime' modifier follows the process TZ env var, which can differ
// from PHP's timezone. Use an explicit offset in the SQL so hour grouping always
// matches the timezone used for the server-side labels and epoch conversion.
$serverTz = trim((string)@file_get_contents('/etc/timezone'));
if ($serverTz === '' || !in_array($serverTz, timezone_identifiers_list(), true)) $serverTz = 'Asia/Kolkata';
date_default_timezone_set($serverTz);
$tzOffset = (new DateTimeZone($serverTz))->getOffset(new DateTimeImmutable('@' . time()));

$cliGenerate  = PHP_SAPI === 'cli' && in_array('--generate', $_SERVER['argv'] ?? [], true);
$forceGenerate = isset($_GET['fresh']);
$doGenerate   = $cliGenerate || $forceGenerate;
$generatedAt = time();
$generationStarted = microtime(true);
$genDuration = 0.0;

if (!is_dir($cacheDir)) @mkdir($cacheDir, 0755, true);

// Web requests serve the snapshot unless ?fresh=1 forces a regeneration.
if (!$doGenerate) {
    if (is_readable($cacheFile)) {
        readfile($cacheFile);
        exit;
    }
    http_response_code(503);
    ?><!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OGN Tracker — Insights</title>
<link rel="stylesheet" href="style.css?v=20261127zz3d62"></head><body>
<div class="app"><header><div class="brand"><div class="logo">✈</div><div>
<h1>OGN Tracker — Insights</h1><div class="sub">Waiting for the scheduled refresh</div>
</div></div></header><main><div class="ins-page">
<div class="ins-error">No snapshot has been generated yet. The 4-hourly refresh job will create it shortly.</div>
</div></main></div></body></html><?php
    exit;
}

ob_start();
// Generation can scan millions of tracks rows; give it room to finish.
set_time_limit(180);

$OGN_TYPES = [
    1  => 'Glider',
    2  => 'Towplane',
    3  => 'Helicopter',
    4  => 'Parachutist',
    5  => 'Drop plane',
    6  => 'Hang glider',
    7  => 'Paraglider',
    8  => 'Powered',
    9  => 'Jet',
    10 => 'UFO',
    11 => 'Balloon',
    12 => 'Airship',
    13 => 'Drone',
    14 => 'Ground support',
    15 => 'Ground Station',
    16 => 'Ultralight',
];

$FANET_STATUS = [
    0  => 'Other',
    1  => 'Walking',
    2  => 'Vehicle',
    3  => 'Bike',
    4  => 'Boot',
    8  => 'Need a ride',
    9  => 'Landed well',
    12 => 'Need technical support',
    13 => 'Need medical help',
    14 => 'Distress call',
    15 => 'Distress call automatically',
];

function h($v): string { return htmlspecialchars((string)$v, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); }
function n(int|float $v): string { return number_format((int)$v); }
function pct(int $n, int $total): string { return $total > 0 ? number_format($n * 100 / $total, 1) . '%' : '0%'; }
function kpiDelta(int $current, ?int $previous): string {
    if ($previous === null) return '';
    if ($previous === 0) {
        if ($current > 0) {
            return '<span class="ins-delta ins-delta-up">' . h('↑ +' . n($current) . ' vs prior 24h (was 0)') . '</span>';
        }
        return '<span class="ins-delta ins-delta-flat">' . h('→ 0 vs prior 24h (was 0)') . '</span>';
    }
    $change = (int)round(($current - $previous) * 100 / $previous);
    if ($change > 0) {
        return '<span class="ins-delta ins-delta-up">' . h('↑ +' . $change . '% vs prior 24h') . '</span>';
    }
    if ($change < 0) {
        return '<span class="ins-delta ins-delta-down">' . h('↓ ' . abs($change) . '% vs prior 24h') . '</span>';
    }
    return '<span class="ins-delta ins-delta-flat">' . h('→ 0% vs prior 24h') . '</span>';
}

function haversine_km(float $lat1, float $lon1, float $lat2, float $lon2): float {
    $dLat = deg2rad($lat2 - $lat1);
    $dLon = deg2rad($lon2 - $lon1);
    $a = sin($dLat / 2.0) ** 2 + cos(deg2rad($lat1)) * cos(deg2rad($lat2)) * sin($dLon / 2.0) ** 2;
    return 6371.0 * 2.0 * atan2(sqrt($a), sqrt(1.0 - $a));
}

/** Credible ground-speed ceiling (km/h), mirroring the collector's position-jump guard. */
function max_plausible_speed_kmh(int $type): float {
    if (in_array($type, [4, 6, 7, 13], true)) return 250.0;
    if ($type === 1) return 400.0;
    return 1300.0;
}

/** Tracker deep link: #lat,lon,zoom,address (resolved relative to /ogn/). */
function tracker_hash_url(?float $lat, ?float $lon, string $address): string {
    if ($lat === null || $lon === null || $address === '') return '';
    return './#' . number_format($lat, 4, '.', '') . ',' . number_format($lon, 4, '.', '') . ',12,' . rawurlencode($address);
}

/** Keep the per-type record holder together with its winning aircraft id. */
function note_type_record(string $label, string $id, float $value, array &$best, array &$bestId): void {
    if (!isset($best[$label]) || $value > $best[$label]) {
        $best[$label] = $value;
        $bestId[$label] = $id;
    }
}

/** Aircraft type from the latest packet, mirroring collector / frontend logic. */
function detect_aircraft_type(string $raw, string $sym, string $ddbId, array $ddbTypes, array &$packetTypeCounts): int {
    $isStationSym = in_array($sym, ['_', '&', '#', 'r'], true);
    $type = $isStationSym ? 15 : 0;
    if (preg_match('/\bid([0-9a-fA-F]{2})[0-9a-fA-F]{6,8}\b/i', $raw, $im)) {
        $pt = (hexdec($im[1]) >> 2) & 0x0F;
        $packetTypeCounts[$pt] = ($packetTypeCounts[$pt] ?? 0) + 1;
        if (!$isStationSym && $pt > 0) {
            if ($pt === 15 && (preg_match('/\bFNT7[0-9a-f]\b/i', $raw) || preg_match('/^FNT[0-9a-f]{6}>/i', $raw))) {
                $type = 7;
            } elseif ($pt === 7 && preg_match('/^[^>]+>OGADSB\b/i', $raw)) {
                $type = 16;
            } else {
                $type = $pt;
            }
        }
    } elseif ($type === 0) {
        if ($sym === 'g') $type = 7;
        elseif ($sym === "'") $type = 1;
        elseif ($sym === '^') $type = 8;
        elseif ($sym === 'X') $type = 3;
        elseif ($sym === 'O') $type = 11;
    }
    $ddbType = $ddbTypes[$ddbId] ?? '';
    if ($type === 0 && $ddbType !== '' && ctype_digit($ddbType) && (int)$ddbType > 0) {
        $type = (int)$ddbType;
    }
    return $type;
}

function ageText(int $ts): string {
    $s = max(0, time() - $ts);
    if ($s < 60) $txt = $s . 's ago';
    elseif ($s < 3600) $txt = intdiv($s, 60) . 'm ago';
    else $txt = intdiv($s, 3600) . 'h ' . intdiv($s % 3600, 60) . 'm ago';
    // The page is cached for hours, so relative ages are refreshed client-side.
    return '<time class="ins-time-age" data-ts="' . $ts . '">' . h($txt) . '</time>';
}
function localHourEpoch(string $key, string $tz): int {
    try {
        $d = DateTimeImmutable::createFromFormat('!Y-m-d H:i', $key, new DateTimeZone($tz));
        return $d ? $d->getTimestamp() : 0;
    } catch (Throwable $e) {
        return 0;
    }
}

function barRow(string $label, int $count, int $total, string $color = 'var(--accent)', string $sub = '', array $subLinks = []): string {
    $w = $total > 0 ? min(100.0, $count * 100 / $total) : 0.0;
    $subHtml = $sub !== '' ? h($sub) : '';
    foreach ($subLinks as $link) {
        if ($subHtml !== '') $subHtml .= ' · ';
        $subHtml .= '<a class="ins-bar-link" href="' . h($link['url']) . '" title="' . h($link['title'] ?? '') . '">' . h($link['text']) . '</a>';
    }
    return '<div class="ins-bar-row">'
        . '<div class="ins-bar-label">' . h($label) . '</div>'
        . '<div class="ins-bar-track"><div class="ins-bar-fill" style="width:' . number_format($w, 2) . '%;background:' . h($color) . '"></div></div>'
        . '<div class="ins-bar-value">' . n($count) . '</div>'
        . ($subHtml !== '' ? '<div class="ins-bar-sub">' . $subHtml . '</div>' : '')
        . '</div>';
}

function simpleTable(array $headers, array $rows): string {
    if (!$rows) return '<div class="ins-empty">No data in the last 24 hours.</div>';
    $out = '<div class="ins-table-wrap"><table class="ins-table"><thead><tr>';
    foreach ($headers as $hd) $out .= '<th>' . h($hd) . '</th>';
    $out .= '</tr></thead><tbody>';
    foreach ($rows as $r) {
        $out .= '<tr>';
        foreach ($r as $cell) $out .= '<td>' . $cell . '</td>';
        $out .= '</tr>';
    }
    return $out . '</tbody></table></div>';
}

function sectionCard(string $title, string $subtitle, string $body, string $span = '', string $id = ''): string {
    return '<section class="ins-card' . ($span !== '' ? ' ins-span-' . $span : '') . '"'
        . ($id !== '' ? ' id="' . h($id) . '"' : '') . '>'
        . '<div class="ins-card-head"><h2>' . h($title) . '</h2><span class="ins-card-sub">' . h($subtitle) . '</span></div>'
        . '<div class="ins-card-body">' . $body . '</div></section>';
}

/** Rows for a top-flights table, shared by the overall and per-type leaderboards. */
function top_flight_rows(array $records, array $posById, array $names, array $typeById, array $ognTypes, bool $withType, string $metric): array {
    $rows = [];
    foreach ($records as $id => $value) {
        $pos = $posById[$id] ?? [null, null];
        $url = tracker_hash_url($pos[0], $pos[1], $id);
        $label = h($names[$id] ?? strtoupper($id));
        $nameHtml = $url !== ''
            ? '<a href="' . h($url) . '" title="Show ' . h($id) . ' on the tracker">' . $label . '</a>'
            : $label;
        $row = [$nameHtml];
        if ($withType) {
            $tt = $typeById[$id] ?? 0;
            $row[] = h($ognTypes[$tt] ?? ($tt > 0 ? 'Type ' . $tt : 'Unknown'));
        }
        $row[] = '<span class="num">' . ($metric === 'altitude'
            ? n(round($value)) . ' m'
            : number_format($value, 1) . ' km') . '</span>';
        $rows[] = $row;
    }
    return $rows;
}

/** Horizontally scrollable bar chart. $data = [[label or [date, hour], value, tooltip, epoch], ...] */
function scrollChart(array $data, string $c1, string $c2, int $visible = 8): string {
    if (!$data) return '<div class="ins-empty">No data in the last 24 hours.</div>';
    $max = 0;
    foreach ($data as $d) $max = max($max, (int)$d[1]);
    if ($max <= 0) $max = 1;
    $out = '<div class="ins-scroll-chart" data-visible="' . $visible . '"><div class="ins-chart-cols">';
    foreach ($data as $d) {
        [$label, $value] = $d;
        $lines = is_array($label) ? array_values($label) : [$label];
        $date = (string)($lines[0] ?? '');
        $hour = (string)($lines[1] ?? '');
        $tip = $d[2] ?? ($date . ' ' . $hour . ': ' . n($value));
        $epoch = (int)($d[3] ?? 0);
        $bh = max(2, $value / $max * 100);
        $peak = (int)$value === $max ? ' ins-col-peak' : '';
        $out .= '<div class="ins-col' . $peak . '"' . ($epoch > 0 ? ' data-ts="' . $epoch . '"' : '') . ' title="' . h($tip) . '">'
            . '<div class="ins-col-plot">'
            . '<div class="ins-col-val">' . h($value) . '</div>'
            . '<div class="ins-col-bar" style="height:' . number_format($bh, 2) . '%;background:linear-gradient(180deg,' . h($c1) . ',' . h($c2) . ')"></div>'
            . '</div>'
            . '<div class="ins-col-date">' . h($date) . '</div>'
            . '<div class="ins-col-hour">' . h($hour) . '</div>'
            . '</div>';
    }
    return $out . '</div></div>';
}

try {
    if (!file_exists($dbFile)) throw new RuntimeException('Database file not found.');

    // Work from a consistent snapshot in /tmp (tmpfs): the live DB is on a slow
    // disk, and a 3.7M-row tracks scan otherwise blows the 60s FastCGI timeout.
    $snapshotFile = sys_get_temp_dir() . '/ogn_insights_snapshot_' . bin2hex(random_bytes(6)) . '.sqlite';
    register_shutdown_function(static function () use ($snapshotFile) { @unlink($snapshotFile); });
    $src = new SQLite3($dbFile, SQLITE3_OPEN_READONLY);
    $dst = new SQLite3($snapshotFile, SQLITE3_OPEN_READWRITE | SQLITE3_OPEN_CREATE);
    if (!$src->backup($dst)) throw new RuntimeException('Unable to snapshot database.');
    $dst->close();
    $src->close();

    $pdo = new PDO('sqlite:' . $snapshotFile, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);

    $meta = [];
    foreach ($pdo->query('SELECT key, value FROM meta') as $r) $meta[$r['key']] = $r['value'];
    $dataUpdated = (int)($meta['updated'] ?? 0);
    $dataAge = $dataUpdated > 0 ? time() - $dataUpdated : -1;
    $dataOk = $dataAge >= 0 && $dataAge < 300;

    // Cron runs every 4 hours, so the next refresh is one interval from now.
    $nextRefreshAt = $generatedAt + $cacheTtl;

    // ---- Aircraft (last known position per ID, 24h) -----------------------
    $aircraft = $pdo->prepare('SELECT id, ddb_id, lat, lon, raw, timestamp, is_emergency FROM aircraft WHERE timestamp >= :cutoff');
    $aircraft->execute([':cutoff' => $cutoff]);
    $aircraftRows = $aircraft->fetchAll(PDO::FETCH_ASSOC);
    $aircraftTotal = count($aircraftRows);

    // DDB type lookup by ddb_id.
    $ddbTypes = [];
    foreach ($pdo->query('SELECT id, aircraft_type FROM ddb') as $r) {
        $ddbTypes[strtolower((string)$r['id'])] = (string)$r['aircraft_type'];
    }
    $ddbKnown = 0;

    // Names table ( aircraft id -> display name ) for "identified" count.
    $names = [];
    foreach ($pdo->query('SELECT id, name FROM names') as $r) $names[strtolower((string)$r['id'])] = (string)$r['name'];

    // Raw packet / last-known-position lookup (avoid N+1 queries below).
    $rawById = [];
    $posById = [];
    foreach ($aircraftRows as $r) {
        $rid = strtolower((string)$r['id']);
        $rawById[$rid] = (string)$r['raw'];
        $posById[$rid] = [(float)$r['lat'], (float)$r['lon']];
    }

    // Max altitude per aircraft in the rolling window, rolled up by type below.
    $altByAircraft = [];
    // Ignore lone altitude samples, and records not supported by another packet
    // from the same aircraft within 500 m of the record altitude (spike filter).
    $nearSql = number_format($altRecordNearM, 1, '.', '');
    $altStmt = $pdo->prepare('WITH pts AS (SELECT id, alt, MAX(alt) OVER (PARTITION BY id) AS ma FROM tracks INDEXED BY sqlite_autoindex_tracks_1 WHERE ts >= :cutoff AND alt IS NOT NULL) SELECT id, ma FROM pts GROUP BY id, ma HAVING COUNT(*) >= 2 AND SUM(CASE WHEN ABS(alt - ma) <= ' . $nearSql . ' THEN 1 ELSE 0 END) >= 2');
    $altStmt->execute([':cutoff' => $cutoff]);
    foreach ($altStmt as $r) $altByAircraft[strtolower((string)$r['id'])] = (float)$r['ma'];

    $typeCounts = [];       // aircraft only (ground stations excluded)
    $typeById = [];         // aircraft id -> resolved type (used by the distance guard)
    $typeMaxAlt = [];       // highest altitude seen per aircraft type
    $typeMaxAltId = [];     // aircraft that reached it
    $typeMaxDist = [];      // longest plausibly-travelled distance per type
    $typeMaxDistId = [];    // aircraft that flew it
    $stationCounts = [];    // type 15 / station symbols
    $networkCounts = [];    // packet source network, all aircraft-table rows
    $fanetCounts = [];      // unique aircraft per FANET status from latest packet
    $emergencyCount = 0;
    $noAltCount = 0;
    $identifiedCount = 0;
    $packetTypeCounts = [];

    foreach ($aircraftRows as $row) {
        $raw = (string)$row['raw'];
        $sym = '';
        if (preg_match('/(\d{6})h(\d{2})(\d{2}\.\d+)([NS])(.)(\d{3})(\d{2}\.\d+)([EW])(.)/', $raw, $bm)) {
            $sym = $bm[9];
        }
        // Receiver / source network.
        if (preg_match('/^[^>]+>([^,]+)/', $raw, $m)) {
            $net = strtoupper($m[1]);
            $networkCounts[$net] = ($networkCounts[$net] ?? 0) + 1;
        }

        // Packet-derived type + DDB fallback (mirrors collector / frontend logic).
        $id = strtolower((string)$row['id']);
        $ddbId = strtolower((string)$row['ddb_id']);
        $ddbType = $ddbTypes[$ddbId] ?? '';
        if ($ddbId !== '' && $ddbType !== '') $ddbKnown++;
        $type = detect_aircraft_type($raw, $sym, $ddbId, $ddbTypes, $packetTypeCounts);
        $typeById[$id] = $type;
        if (isset($names[$id])) $identifiedCount++;

        if ($type === 15) {
            $stationCounts['Ground station'] = ($stationCounts['Ground station'] ?? 0) + 1;
        } else {
            $label = $OGN_TYPES[$type] ?? ($type > 0 ? 'Type ' . $type : 'Unknown');
            $typeCounts[$label] = ($typeCounts[$label] ?? 0) + 1;
            // Records are only for aircraft still inside the 24h aircraft window.
            if (isset($altByAircraft[$id]) && isset($posById[$id])) {
                note_type_record($label, $id, $altByAircraft[$id], $typeMaxAlt, $typeMaxAltId);
            }
        }

        if ((int)$row['is_emergency'] === 1) $emergencyCount++;
        if (!preg_match('/\/A=-?\d{6}/', $raw)) $noAltCount++;

        // FANET status from the latest packet for this aircraft.
        if (preg_match('/\bFNT([17])([0-9a-f])\b/i', $raw, $fm)) {
            if ($fm[1] === '1') {
                $st = 'Airborne';
            } else {
                $nib = (int)hexdec($fm[2]);
                $st = $FANET_STATUS[$nib] ?? ('Other status (FNT7' . strtoupper($fm[2]) . ')');
            }
            $fanetCounts[$st] = ($fanetCounts[$st] ?? 0) + 1;
        }
    }

    // Longest single continuous track per aircraft (not the sum of separate flights).
    // A time gap or an implausible hop ends the current track; the next fix starts a new one.
    // The per-hop speed guard mirrors the collector so corrupt jumps cannot inflate the result.
    $distByAircraft = [];
    $distCur = [];
    // Pull a little history before the window so a track that started earlier
    // can be recognised and excluded: only tracks with both ends inside the
    // 24h window count as records.
    $hasPreWindowStmt = $pdo->prepare('SELECT 1 FROM tracks WHERE ts < :cutoff LIMIT 1');
    $hasPreWindowStmt->execute([':cutoff' => $cutoff]);
    $trackLookbackCutoff = $hasPreWindowStmt->fetchColumn() === false
        ? $cutoff
        : $cutoff - $trackGapSeconds;
    $trackStmt = $pdo->prepare('SELECT id, ts, lat, lon FROM tracks WHERE ts >= :cutoff ORDER BY id, ts');
    $trackStmt->execute([':cutoff' => $trackLookbackCutoff]);
    $distPrev = [];
    $preWindow = [];
    $inWindow = [];
    $trackStartsInWindow = [];
    while ($tr = $trackStmt->fetch(PDO::FETCH_ASSOC)) {
        $tid = strtolower((string)$tr['id']);
        $tts = (int)$tr['ts'];
        $tlat = (float)$tr['lat'];
        $tlon = (float)$tr['lon'];
        if ($tts < $cutoff) {
            $preWindow[$tid] = ['ts' => $tts, 'lat' => $tlat, 'lon' => $tlon];
            continue;
        }
        if (!isset($inWindow[$tid])) {
            $inWindow[$tid] = true;
            $startsInWindow = true;
            $pre = $preWindow[$tid] ?? null;
            if ($pre !== null) {
                $dt = max(0, $tts - $pre['ts']);
                $km = haversine_km($pre['lat'], $pre['lon'], $tlat, $tlon);
                $allowedKm = max_plausible_speed_kmh($typeById[$tid] ?? 0) * $dt / 3600.0 + 2.0;
                if ($dt <= $trackGapSeconds && $km <= $allowedKm) $startsInWindow = false;
            }
            $trackStartsInWindow[$tid] = $startsInWindow;
            $distPrev[$tid] = ['ts' => $tts, 'lat' => $tlat, 'lon' => $tlon];
            continue;
        }
        $p = $distPrev[$tid] ?? null;
        if ($p !== null) {
            $dt = max(0, $tts - $p['ts']);
            // Stationary hovers are common; skip the trig when the fix has not
            // moved far enough to matter (~11 m) inside the same gap.
            if ($dt <= $trackGapSeconds &&
                abs($tlat - $p['lat']) < 0.0001 && abs($tlon - $p['lon']) < 0.0001) {
                $distPrev[$tid] = ['ts' => $tts, 'lat' => $tlat, 'lon' => $tlon];
                continue;
            }
            $km = haversine_km($p['lat'], $p['lon'], $tlat, $tlon);
            $allowedKm = max_plausible_speed_kmh($typeById[$tid] ?? 0) * $dt / 3600.0 + 2.0;
            if ($km > $allowedKm || $dt > $trackGapSeconds) {
                // Close the current track, but only keep it if it began inside the window.
                if ($trackStartsInWindow[$tid]) {
                    $distByAircraft[$tid] = max($distByAircraft[$tid] ?? 0.0, $distCur[$tid] ?? 0.0);
                }
                $distCur[$tid] = 0.0;
                $trackStartsInWindow[$tid] = true;
                if ($km > $allowedKm) continue; // corrupt hop: skip it, keep last valid point
            }
            $distCur[$tid] = ($distCur[$tid] ?? 0.0) + $km;
        }
        $distPrev[$tid] = ['ts' => $tts, 'lat' => $tlat, 'lon' => $tlon];
    }
    foreach ($distCur as $tid => $km) {
        if (!($trackStartsInWindow[$tid] ?? false)) continue;
        $distByAircraft[$tid] = max($distByAircraft[$tid] ?? 0.0, $km);
    }
    foreach ($distByAircraft as $tid => $km) {
        if (!isset($posById[$tid])) continue; // outside the 24h aircraft window
        $tt = $typeById[$tid] ?? 0;
        if ($tt === 15) continue;
        $label = $OGN_TYPES[$tt] ?? ($tt > 0 ? 'Type ' . $tt : 'Unknown');
        note_type_record($label, $tid, $km, $typeMaxDist, $typeMaxDistId);
    }

    // Paragliders, gliders and hang gliders get their own leaderboard cards.
    $featuredFlightTypes = [
        7 => 'Top paraglider flights (24h)',
        1 => 'Top glider flights (24h)',
        6 => 'Top hang glider flights (24h)',
    ];
    $featuredTypeIds = array_keys($featuredFlightTypes);

    // Overall leaderboards use the same filtered records as the per-type links
    // above, but leave the three featured types to their dedicated cards.
    $topDistance = [];
    foreach ($distByAircraft as $tid => $km) {
        $tt = (int)($typeById[$tid] ?? 0);
        if (!isset($posById[$tid]) || $tt === 15 || in_array($tt, $featuredTypeIds, true)) continue;
        $topDistance[$tid] = $km;
    }
    arsort($topDistance, SORT_NUMERIC);
    $topDistance = array_slice($topDistance, 0, 10, true);

    $topAltitude = [];
    foreach ($altByAircraft as $tid => $alt) {
        $tt = (int)($typeById[$tid] ?? 0);
        if (!isset($posById[$tid]) || $tt === 15 || in_array($tt, $featuredTypeIds, true)) continue;
        $topAltitude[$tid] = $alt;
    }
    arsort($topAltitude, SORT_NUMERIC);
    $topAltitude = array_slice($topAltitude, 0, 10, true);

    // Same 24h, plausibility-filtered records, split out per featured type.
    $topFlightsByType = [];
    foreach ($featuredFlightTypes as $typeId => $title) {
        $distance = [];
        foreach ($distByAircraft as $tid => $km) {
            if (!isset($posById[$tid]) || (int)($typeById[$tid] ?? 0) !== $typeId) continue;
            $distance[$tid] = $km;
        }
        arsort($distance, SORT_NUMERIC);
        $altitude = [];
        foreach ($altByAircraft as $tid => $alt) {
            if (!isset($posById[$tid]) || (int)($typeById[$tid] ?? 0) !== $typeId) continue;
            $altitude[$tid] = $alt;
        }
        arsort($altitude, SORT_NUMERIC);
        $topFlightsByType[$typeId] = [
            'title'    => $title,
            'distance' => array_slice($distance, 0, 10, true),
            'altitude' => array_slice($altitude, 0, 10, true),
        ];
    }

    arsort($typeCounts);
    arsort($stationCounts);
    arsort($networkCounts);
    arsort($fanetCounts);

    // ---- Stations ---------------------------------------------------------
    $stationRows = $pdo->prepare('SELECT id, lat, lon, max_km, farthest_id, farthest_ts, updated, heard_24h FROM stations WHERE updated >= :cutoff');
    $stationRows->execute([':cutoff' => $cutoff]);
    $stations = $stationRows->fetchAll(PDO::FETCH_ASSOC);
    $stationTotal = count($stations);

    $stationNetworks = [];
    $stationRoles = [];
    $stationsWithWeather = 0;
    $farthest = [];
    $staleStations = 0;
    foreach ($stations as $s) {
        $id = strtolower((string)$s['id']);
        $raw = $rawById[$id] ?? '';
        if ($raw !== '' && preg_match('/^[^>]+>([^,]+)/', $raw, $m)) {
            $net = strtoupper($m[1]);
            $stationNetworks[$net] = ($stationNetworks[$net] ?? 0) + 1;
        } else {
            $stationNetworks['Unknown'] = ($stationNetworks['Unknown'] ?? 0) + 1;
        }
        $sym = '';
        if ($raw !== '' && preg_match('/(\d{6})h(\d{2})(\d{2}\.\d+)([NS])(.)(\d{3})(\d{2}\.\d+)([EW])(.)/', $raw, $bm)) $sym = $bm[9];
        if ($sym === '_') $role = 'Weather station';
        elseif ($sym === '&') $role = 'OGN receiver';
        elseif ($sym === '#') $role = 'APRS station';
        elseif ($sym === 'r') $role = 'Receive-only station';
        else $role = 'Other station';
        $stationRoles[$role] = ($stationRoles[$role] ?? 0) + 1;

        if ((float)$s['max_km'] > 0) $farthest[] = $s;
        if ((int)$s['updated'] < time() - 3600) $staleStations++;
    }
    arsort($stationNetworks);
    arsort($stationRoles);
    usort($farthest, fn($a, $b) => (float)$b['max_km'] <=> (float)$a['max_km']);
    $farthest = array_slice($farthest, 0, 10);

    // Station weather presence.
    $wxStmt = $pdo->prepare('SELECT wx_json FROM station_weather WHERE updated >= :cutoff');
    $wxStmt->execute([':cutoff' => $cutoff]);
    $wxRows = $wxStmt->fetchAll(PDO::FETCH_COLUMN);
    $stationsWithWeather = count($wxRows);
    $wxStats = ['temp' => 0, 'pressure' => 0, 'wind' => 0, 'gust' => 0, 'humidity' => 0];
    $temps = []; $pressures = []; $winds = [];
    foreach ($wxRows as $j) {
        $w = json_decode((string)$j, true);
        if (!is_array($w)) continue;
        if (isset($w['tempC']) && $w['tempC'] !== null) { $wxStats['temp']++; $temps[] = (float)$w['tempC']; }
        if (isset($w['pressureHpa']) && $w['pressureHpa'] !== null) { $wxStats['pressure']++; $pressures[] = (float)$w['pressureHpa']; }
        if (isset($w['spdKmh']) && $w['spdKmh'] !== null) { $wxStats['wind']++; $winds[] = (float)$w['spdKmh']; }
        if (isset($w['gustKmh']) && $w['gustKmh'] !== null) $wxStats['gust']++;
        if (isset($w['humidityPct']) && $w['humidityPct'] !== null) $wxStats['humidity']++;
    }

    // ---- Tracks / hourly traffic (single scan) ----------------------------
    $hourly = [];
    $trackAircraft = 0; $trackPoints = 0; $maxAlt = null;
    // PK (id, ts) scan is much faster here than random lookups via idx_tracks_ts.
    $hourExpr = "strftime('%Y-%m-%d %H:00', datetime(ts + " . $tzOffset . ", 'unixepoch'))";
    $tracksStmt = $pdo->prepare("SELECT $hourExpr AS hr, COUNT(DISTINCT id) AS ac, COUNT(*) AS pts, MAX(alt) AS ma FROM tracks INDEXED BY sqlite_autoindex_tracks_1 WHERE ts >= :cutoff GROUP BY hr ORDER BY hr");
    $tracksStmt->execute([':cutoff' => $cutoff]);
    foreach ($tracksStmt as $r) {
        $hourly[] = [(string)$r['hr'], (int)$r['ac'], (int)$r['pts']];
        $trackPoints += (int)$r['pts'];
        if ($r['ma'] !== null) $maxAlt = max($maxAlt ?? -1e12, (float)$r['ma']);
    }
    $taStmt = $pdo->prepare('SELECT COUNT(DISTINCT id) FROM tracks WHERE ts >= :cutoff');
    $taStmt->execute([':cutoff' => $cutoff]);
    $trackAircraft = (int)$taStmt->fetchColumn();

    // ---- Receivers by aircraft heard --------------------------------------
    $topReceivers = [];
    foreach ($pdo->query('SELECT station_id, COUNT(*) AS n, MAX(last_ts) AS last_ts FROM station_heard GROUP BY station_id ORDER BY n DESC LIMIT 12') as $r) {
        $topReceivers[] = $r;
    }

    // ---- Alerts -----------------------------------------------------------
    $alerts = [];
    foreach ($pdo->query('SELECT status, COUNT(*) AS n, MAX(last_ts) AS last_ts FROM alerts GROUP BY status ORDER BY n DESC') as $r) {
        $status = (string)$r['status'];
        $colon = strpos($status, ':');
        if ($colon !== false) $status = trim(substr($status, 0, $colon));
        $alerts[$status] = ($alerts[$status] ?? 0) + (int)$r['n'];
    }
    arsort($alerts);
    $alertAircraft = (int)$pdo->query('SELECT COUNT(DISTINCT id) FROM alerts')->fetchColumn();

    // ---- Thermals ---------------------------------------------------------
    $thStmt = $pdo->prepare('SELECT COUNT(*) FROM thermals WHERE ts >= :cutoff');
    $thStmt->execute([':cutoff' => $cutoff]);
    $thermalTotal = (int)$thStmt->fetchColumn();
    $thermalCells = [];
    $tcStmt = $pdo->prepare('SELECT ROUND(lat,1) la, ROUND(lon,1) lo, COUNT(*) n FROM thermals WHERE ts >= :cutoff GROUP BY la, lo ORDER BY n DESC LIMIT 10');
    $tcStmt->execute([':cutoff' => $cutoff]);
    foreach ($tcStmt as $r) $thermalCells[] = $r;

    // ---- Misc counts ------------------------------------------------------
    $ddbTotal = (int)$pdo->query('SELECT COUNT(*) FROM ddb')->fetchColumn();
    $namesTotal = (int)$pdo->query('SELECT COUNT(*) FROM names')->fetchColumn();
    $telStmt = $pdo->prepare('SELECT COUNT(*) FROM telemetry WHERE timestamp >= :cutoff');
    $telStmt->execute([':cutoff' => $cutoff]);
    $telemetryTotal = (int)$telStmt->fetchColumn();

    // ---- Rolling history for 24h KPI deltas -------------------------------
    $linksTotal = (int)$pdo->query('SELECT COUNT(*) FROM station_heard')->fetchColumn();
    $currentSnapshot = [
        'ts'           => $generatedAt,
        'aircraft'     => $aircraftTotal,
        'track_points' => $trackPoints,
        'stations'     => $stationTotal,
        'thermals'     => $thermalTotal,
        'links'        => $linksTotal,
        'alerts'       => $alertAircraft,
    ];
    $history = [];
    if (is_readable($historyFile)) {
        $decoded = json_decode((string)@file_get_contents($historyFile), true);
        if (is_array($decoded)) $history = $decoded;
    }
    $previous = null;
    $bestDiff = null;
    foreach ($history as $entry) {
        if (!is_array($entry) || !isset($entry['ts'])) continue;
        $age = $generatedAt - (int)$entry['ts'];
        if ($age < 20 * 3600 || $age > 28 * 3600) continue;
        $diff = abs($age - 86400);
        if ($bestDiff === null || $diff < $bestDiff) {
            $previous = $entry;
            $bestDiff = $diff;
        }
    }
    $history[] = $currentSnapshot;
    $keepAfter = $generatedAt - 7 * 86400;
    $history = array_values(array_filter($history, static function ($entry) use ($keepAfter): bool {
        return is_array($entry) && isset($entry['ts']) && (int)$entry['ts'] >= $keepAfter;
    }));
    usort($history, static fn($a, $b): int => (int)$a['ts'] <=> (int)$b['ts']);
    $tmpHistory = $historyFile . '.tmp';
    @file_put_contents($tmpHistory, json_encode($history), LOCK_EX);
    @rename($tmpHistory, $historyFile);
    $prevVal = static function (string $key) use ($previous): ?int {
        return ($previous !== null && isset($previous[$key])) ? (int)$previous[$key] : null;
    };

} catch (Throwable $e) {
    http_response_code(500);
    $fatal = $e->getMessage();
}
$genDuration = microtime(true) - $generationStarted;
?>
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Cache-Control" content="no-store">
<title>OGN Tracker — Insights</title>
<link rel="stylesheet" href="style.css?v=20261127zz3d62">
<style>
  header{cursor:default}
  main{display:block!important}
  .ins-headline{display:flex;flex-wrap:wrap;align-items:flex-end;gap:10px;justify-content:space-between;margin-bottom:10px}
  .ins-headline h2{font-size:20px;margin:0}
  .ins-headline p{margin:3px 0 0;color:var(--muted);font-size:12px}
  .ins-refresh{font-size:12px;color:var(--muted);text-decoration:none;border:1px solid var(--line);border-radius:8px;padding:7px 10px;background:var(--control-bg)}
  .ins-refresh:hover{border-color:var(--accent);color:var(--text)}
  .ins-gen{display:inline-block;font-size:11px;color:var(--muted);background:var(--panel2);border:1px solid var(--line);border-radius:999px;padding:4px 9px;margin-left:6px;white-space:nowrap}
  .ins-nav{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 16px}
  .ins-nav a{font-size:11px;color:var(--muted);text-decoration:none;border:1px solid var(--line);border-radius:999px;padding:5px 11px;background:var(--control-bg)}
  .ins-nav a:hover{color:var(--text);border-color:var(--accent)}
  .ins-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(165px,100%),1fr));gap:10px;margin-bottom:12px}
  .ins-kpis-secondary{grid-template-columns:repeat(auto-fit,minmax(min(150px,100%),1fr));margin-bottom:18px}
  .ins-kpi{background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:13px 14px}
  .ins-kpi-hero{padding:16px 18px;border-color:#2a4354}
  .ins-kpi-label{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.6px;font-weight:700}
  .ins-kpi-value{font-size:25px;font-weight:800;line-height:1.2;margin-top:4px;color:var(--text)}
  .ins-kpi-hero .ins-kpi-value{font-size:32px}
  .ins-kpis-secondary .ins-kpi{padding:10px 12px}
  .ins-kpis-secondary .ins-kpi-value{font-size:20px}
  .ins-kpis-secondary .ins-kpi-sub{font-size:10px}
  .ins-kpi-sub{font-size:11px;color:#b7c7d2;margin-top:3px}
  .ins-delta{display:inline-block;margin-left:5px;padding:1px 5px;border:1px solid currentColor;border-radius:999px;font-size:9px;font-weight:700;white-space:nowrap;vertical-align:1px}
  .ins-delta-up{color:var(--accent);background:var(--up-bg)}
  .ins-delta-down{color:var(--down-red);background:var(--danger-bg)}
  .ins-delta-flat{color:var(--muted);background:var(--table-line)}
  .ins-grid{display:grid;grid-template-columns:1fr;gap:12px;align-items:start}
  .ins-section{grid-column:1/-1;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);margin:6px 0 -2px;padding-bottom:6px;border-bottom:1px solid var(--line)}
  .ins-card{background:var(--panel);border:1px solid var(--line);border-radius:11px;overflow:hidden;min-width:0}
  .ins-card-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:11px 14px;border-bottom:1px solid var(--line);background:#14202b}
  .ins-card-head h2{font-size:13px;margin:0;font-weight:800}
  .ins-card-sub{font-size:10px;color:var(--muted);white-space:nowrap}
  .ins-card-body{padding:11px 14px 14px}
  .ins-bar-row{display:grid;grid-template-columns:minmax(210px,290px) minmax(70px,1fr) 58px;gap:9px;row-gap:1px;align-items:center;margin:7px 0;font-size:12px}
  .ins-bar-label{min-width:0;white-space:normal;color:#d8e4eb}
  .ins-bar-sub{grid-column:1/-1;color:var(--muted);font-size:10px;line-height:1.35;white-space:normal}
  .ins-bar-link{color:var(--accent);text-decoration:none;border-bottom:1px dotted var(--accent)}
  .ins-bar-link:hover{color:#fff;border-bottom-color:#fff}
  .ins-bar-track{height:8px;border-radius:5px;background:#223442;overflow:hidden;max-width:180px}
  .ins-bar-fill{height:100%;border-radius:5px;min-width:2px}
  .ins-bar-value{text-align:right;font-weight:700;font-variant-numeric:tabular-nums}
  .dot.warn{background:var(--yellow)}
  .ins-table-wrap{overflow-x:auto}
  .ins-table{border-collapse:collapse;width:100%;font-size:12px}
  .ins-table th{text-align:left;color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.4px;padding:6px 8px;border-bottom:1px solid var(--line)}
  .ins-table td{padding:6px 8px;border-bottom:1px solid #22313e;white-space:nowrap}
  .ins-table a{color:var(--accent);text-decoration:none}
  .ins-table a:hover{text-decoration:underline}
  .ins-table tr:last-child td{border-bottom:0}
  .ins-table td.num,.ins-table th.num{text-align:right;font-variant-numeric:tabular-nums}
  .ins-empty{color:var(--muted);font-size:12px;padding:8px 0}
  .ins-note{font-size:11px;color:var(--muted);margin:10px 0 0;line-height:1.5}
  .ins-note--spaced{margin-top:16px}
  .ins-scroll-hint{display:inline-block;font-size:11px;color:var(--accent);background:var(--card-head);border:1px solid var(--line);border-radius:999px;padding:3px 9px;margin-top:8px}
  .ins-scroll-chart{overflow-x:auto;overflow-y:hidden;margin-top:6px;padding-bottom:3px;scrollbar-color:var(--line) var(--panel);scrollbar-width:thin}
  .ins-scroll-chart::-webkit-scrollbar{height:8px}
  .ins-scroll-chart::-webkit-scrollbar-thumb{background:var(--line);border-radius:5px}
  .ins-chart-cols{display:flex;gap:3px;width:max-content;align-items:flex-end}
  .ins-col{flex:0 0 72px;display:flex;flex-direction:column;align-items:center;gap:3px;min-width:0}
  .ins-col-plot{height:140px;width:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;border-bottom:1px solid var(--line);background:repeating-linear-gradient(to top,transparent 0,transparent 69px,#22313e 69px,#22313e 70px)}
  .ins-col-val{font-size:11px;color:var(--text);height:14px;line-height:14px;white-space:nowrap}
  .ins-col-peak .ins-col-val{color:#fff;font-weight:800}
  .ins-col-peak .ins-col-bar{box-shadow:0 0 12px #57d3b066}
  .ins-col-bar{width:100%;border-radius:3px 3px 0 0;min-height:2px}
  .ins-col-date{font-size:10px;color:var(--muted);line-height:1.1;white-space:nowrap}
  .ins-col-hour{font-size:10px;color:#b7c7d2;font-weight:600;line-height:1.1;white-space:nowrap}
  .ins-split{display:grid;grid-template-columns:1fr 1fr;gap:18px}
  .ins-split h3{font-size:11px;margin:0 0 6px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}
  @media(max-width:800px){
    .ins-split{grid-template-columns:1fr}
    .ins-nav{margin-bottom:12px}
    .ins-col-val{font-size:12px}
    .ins-col-date,.ins-col-hour{font-size:11px}
  }
  @media(max-width:480px){
    .ins-page{padding:10px}
    .ins-nav{gap:5px}
    .ins-nav a{padding:8px 12px;font-size:12px}
    .ins-gen{display:none}
    .ins-headline h2{font-size:18px}
    .ins-headline .sub{font-size:11px}
    .status{white-space:normal}
    .status-updated{width:100%;text-align:right}
    .ins-kpi-hero{padding:13px 14px}
    .ins-kpi-hero .ins-kpi-value{font-size:27px}
    .ins-section{margin-top:10px}
    .ins-bar-row{grid-template-columns:minmax(150px,210px) minmax(40px,1fr) 50px;gap:6px;row-gap:1px;font-size:11px}
    .ins-bar-track{max-width:120px}
    .ins-table{font-size:11px}
    .ins-table th,.ins-table td{padding:5px 6px}
  }
</style>
</head>
<body>
<header>
  <div class="brand">
    <div class="logo">✈</div>
    <div>
      <h1>OGN Tracker — Insights</h1>
      <div class="sub">Rolling 24-hour snapshot · regenerated every 4 hours</div>
    </div>
  </div>
  <div class="status" id="insStatus" data-data-ts="<?php echo $dataUpdated; ?>" data-gen-ts="<?php echo $generatedAt; ?>">
    <span class="dot <?php echo $dataOk ? 'live' : 'error'; ?>"></span>
    <span id="insStatusText"><?php echo $dataOk ? 'Snapshot OK' : 'Collector overdue'; ?></span>
    <span class="status-updated" id="insStatusAge">
      <?php if ($dataUpdated > 0): ?>data @ <time class="ins-time" data-ts="<?php echo $dataUpdated; ?>"><?php echo h(date('H:i', $dataUpdated)); ?></time><?php else: ?>no data timestamp<?php endif; ?>
    </span>
    <a class="ins-refresh" href="index.html">← Tracker</a>
  </div>
</header>

<main>
<div class="ins-page">
<?php if (isset($fatal)): ?>
  <div class="ins-error"><b>Unable to load insights.</b><br><?php echo h($fatal); ?></div>
<?php else: ?>

  <div class="ins-headline">
    <div>
      <h2>Network &amp; traffic summary</h2>
      <p>Window: last 24 hours · <time class="ins-time ins-time-dt" data-ts="<?php echo $cutoff; ?>"><?php echo h(date('Y-m-d H:i', $cutoff)); ?></time> → <time class="ins-time ins-time-dt" data-ts="<?php echo $generatedAt; ?>"><?php echo h(date('Y-m-d H:i', $generatedAt)); ?></time> (<span class="ins-tz-note">server time</span>)</p>
    </div>
    <div class="sub">Snapshot generated <time class="ins-time ins-time-dt" data-ts="<?php echo $generatedAt; ?>"><?php echo h(date('Y-m-d H:i', $generatedAt)); ?></time> · next refresh <time class="ins-time" data-ts="<?php echo $nextRefreshAt; ?>"><?php echo h(date('H:i', $nextRefreshAt)); ?></time><span class="ins-gen">built in <?php echo number_format($genDuration, 1); ?>s</span></div>
  </div>

  <nav class="ins-nav">
    <a href="#traffic">Traffic</a><a href="#network">Network</a><a href="#environment">Environment</a><a href="#quality">Data quality</a>
  </nav>

  <div class="ins-kpis">
    <div class="ins-kpi ins-kpi-hero"><div class="ins-kpi-label">Unique aircraft</div><div class="ins-kpi-value"><?php echo n($aircraftTotal); ?></div><div class="ins-kpi-sub"><?php echo n($trackAircraft); ?> with track data<?php echo kpiDelta($aircraftTotal, $prevVal('aircraft')); ?></div></div>
    <div class="ins-kpi ins-kpi-hero"><div class="ins-kpi-label">Track points</div><div class="ins-kpi-value"><?php echo n($trackPoints); ?></div><div class="ins-kpi-sub"><?php echo $maxAlt !== null ? 'max altitude ' . n(round($maxAlt)) . ' m' : 'altitude n/a'; ?><?php echo kpiDelta($trackPoints, $prevVal('track_points')); ?></div></div>
    <div class="ins-kpi ins-kpi-hero"><div class="ins-kpi-label">Ground stations</div><div class="ins-kpi-value"><?php echo n($stationTotal); ?></div><div class="ins-kpi-sub"><?php echo n($stationsWithWeather); ?> reporting weather<?php echo kpiDelta($stationTotal, $prevVal('stations')); ?></div></div>
    <div class="ins-kpi ins-kpi-hero"><div class="ins-kpi-label">Thermal samples</div><div class="ins-kpi-value"><?php echo n($thermalTotal); ?></div><div class="ins-kpi-sub">gliders / paragliders only<?php echo kpiDelta($thermalTotal, $prevVal('thermals')); ?></div></div>
  </div>

  <div class="ins-kpis ins-kpis-secondary">
    <div class="ins-kpi"><div class="ins-kpi-label">Station ↔ aircraft links</div><div class="ins-kpi-value"><?php echo n($linksTotal); ?></div><div class="ins-kpi-sub">reception pairs in 24h</div></div>
    <div class="ins-kpi"><div class="ins-kpi-label">Identified</div><div class="ins-kpi-value"><?php echo n($identifiedCount); ?></div><div class="ins-kpi-sub"><?php echo pct($identifiedCount, max(1, $aircraftTotal)); ?> have a stream name</div></div>
    <div class="ins-kpi"><div class="ins-kpi-label">DDB metadata</div><div class="ins-kpi-value"><?php echo n($ddbKnown); ?></div><div class="ins-kpi-sub">of <?php echo n($ddbTotal); ?> catalogue records</div></div>
    <div class="ins-kpi"><div class="ins-kpi-label">Alerts / emergencies</div><div class="ins-kpi-value"><?php echo n($alertAircraft); ?></div><div class="ins-kpi-sub"><?php echo n($emergencyCount); ?> emergency-flagged packets<?php echo kpiDelta($alertAircraft, $prevVal('alerts')); ?></div></div>
  </div>

  <div class="ins-grid">
    <?php
    // One restrained palette: cool tones for traffic, green/blue for network, warm for environment.
    $colors = ['var(--accent)', '#38bdf8', '#a78bfa', '#34d399', '#f5c451', '#fb923c', '#60a5fa', '#f07878', '#e879f9', '#94a3b8'];

    echo '<h3 class="ins-section" id="traffic">Traffic</h3>';

    $typeTotal = array_sum($typeCounts); // excludes ground stations, matches the card subtitle
    $typeHtml = ''; $i = 0;
    foreach ($typeCounts as $label => $c) {
        $sub = ''; $links = [];
        if (isset($typeMaxAlt[$label])) {
            $aid = $typeMaxAltId[$label] ?? '';
            $pos = $posById[$aid] ?? [null, null];
            $url = tracker_hash_url($pos[0], $pos[1], $aid);
            $text = '(max alt ' . n(round($typeMaxAlt[$label])) . ' m)';
            if ($url !== '') $links[] = ['url' => $url, 'text' => $text, 'title' => 'Show max-altitude aircraft ' . $aid . ' on the tracker'];
            else $sub = $text;
        }
        if (isset($typeMaxDist[$label])) {
            $aid = $typeMaxDistId[$label] ?? '';
            $pos = $posById[$aid] ?? [null, null];
            $url = tracker_hash_url($pos[0], $pos[1], $aid);
            $text = '(longest track ' . n(round($typeMaxDist[$label])) . ' km)';
            if ($url !== '') $links[] = ['url' => $url, 'text' => $text, 'title' => 'Show longest single-track aircraft ' . $aid . ' on the tracker'];
            else $sub .= ($sub !== '' ? ' ' : '') . $text;
        }
        $typeHtml .= barRow($label, $c, $typeTotal, $colors[$i++ % count($colors)], $sub, $links);
    }
    echo sectionCard('Aircraft types', n($typeTotal) . ' aircraft', $typeHtml ?: '<div class="ins-empty">No aircraft seen.</div>');

    // Top flights leaderboards, built from the same 24h record arrays as the links above.
    $topNote = '<p class="ins-note">Plausibility-filtered track data, not verified flights: corrupted positions or reused IDs can still appear. Open a tracker link to inspect the path before relying on a value.</p>';
    $topHtml = '<div class="ins-split">'
        . simpleTable(['Aircraft', 'Type', 'Distance'], top_flight_rows($topDistance, $posById, $names, $typeById, $OGN_TYPES, true, 'distance'))
        . simpleTable(['Aircraft', 'Type', 'Max alt'], top_flight_rows($topAltitude, $posById, $names, $typeById, $OGN_TYPES, true, 'altitude'))
        . '</div>' . $topNote;
    echo sectionCard('Top flights (24h)', 'longest tracks & highest climbs (other types, unverified)', $topHtml);

    foreach ($topFlightsByType as $flightType) {
        $typeHtml = '<div class="ins-split">'
            . simpleTable(['Aircraft', 'Distance'], top_flight_rows($flightType['distance'], $posById, $names, $typeById, $OGN_TYPES, false, 'distance'))
            . simpleTable(['Aircraft', 'Max alt'], top_flight_rows($flightType['altitude'], $posById, $names, $typeById, $OGN_TYPES, false, 'altitude'))
            . '</div>' . $topNote;
        echo sectionCard($flightType['title'], 'top 10 longest tracks & highest climbs (unverified)', $typeHtml);
    }

    // Hourly traffic chart.
    $hourData = [];
    foreach ($hourly as $hh) {
        $key = $hh[0]; // YYYY-MM-DD HH:00
        $hourData[] = [[substr($key, 5, 5), substr($key, 11, 5)], (int)$hh[1],
            $key . ' — ' . n($hh[1]) . ' aircraft, ' . n($hh[2]) . ' track points',
            localHourEpoch($key, $serverTz)];
    }
    $chart = scrollChart($hourData, 'var(--accent)', '#2387a6', 8)
        . '<span class="ins-scroll-hint">← Scroll for earlier hours</span>'
        . '<p class="ins-note">One bar per hour (hour boundaries follow server time); all times shown in your local timezone. The brightest bar is the peak hour.</p>';
    echo sectionCard('Hourly traffic', 'unique aircraft by hour', $chart);

    // Alerts.
    $alertHtml = '';
    foreach ($alerts as $label => $c) $alertHtml .= barRow($label, $c, array_sum($alerts), 'var(--red)');
    echo sectionCard('Alerts seen', $alertAircraft . ' aircraft affected',
        ($alertHtml ?: '<div class="ins-empty">No alerts in the database.</div>')
        . '<p class="ins-note">Labels only; trailing packet text is stripped. Alert records are keyed per aircraft and status.</p>');

    echo '<h3 class="ins-section" id="network">Network</h3>';

    $netHtml = ''; $i = 0;
    foreach ($networkCounts as $label => $c) { $netHtml .= barRow($label, $c, $aircraftTotal, $colors[$i++ % count($colors)]); }
    echo sectionCard('Packet source networks', 'where positions came from', $netHtml ?: '<div class="ins-empty">No packets.</div>');

    $fanetHtml = ''; $i = 0;
    foreach ($fanetCounts as $label => $c) { $fanetHtml .= barRow($label, $c, array_sum($fanetCounts), $colors[$i++ % count($colors)]); }
    echo sectionCard('FANET statuses', n(array_sum($fanetCounts)) . ' aircraft with status',
      ($fanetHtml ?: '<div class="ins-empty">No FANET status packets in the last 24 hours.</div>')
      . '<p class="ins-note">From <code>FNT1x</code> (airborne) and <code>FNT7x</code> status codes in the latest packet per aircraft.</p>');

    $stHtml = '<div class="ins-split"><div><h3>By receiver network</h3>';
    foreach ($stationNetworks as $label => $c) $stHtml .= barRow($label, $c, $stationTotal, 'var(--accent)');
    $stHtml .= '</div><div><h3>By station role</h3>';
    foreach ($stationRoles as $label => $c) $stHtml .= barRow($label, $c, $stationTotal, '#38bdf8');
    $stHtml .= '</div></div>';
    echo sectionCard('Station types', n($stationTotal) . ' active stations', $stHtml);

    // Top receivers table.
    $rows = [];
    foreach ($topReceivers as $r) {
        $rows[] = [
            '<b>' . h($r['station_id']) . '</b>',
            '<span class="num">' . n((int)$r['n']) . '</span>',
            ageText((int)$r['last_ts']),
        ];
    }
    echo sectionCard('Top receiving stations', 'most aircraft heard in 24h',
        simpleTable(['Station', 'Aircraft heard', 'Last heard'], $rows));

    // Farthest reception table.
    $rows = [];
    foreach ($farthest as $s) {
        $rows[] = [
            '<b>' . h($s['id']) . '</b>',
            '<span class="num">' . h(number_format((float)$s['max_km'], 1)) . ' km</span>',
            h((string)$s['farthest_id']),
            ageText((int)$s['farthest_ts']),
        ];
    }
    echo sectionCard('Farthest reception records', 'longest station → aircraft range',
        simpleTable(['Station', 'Distance', 'Aircraft', 'When'], $rows));

    echo '<h3 class="ins-section" id="environment">Environment</h3>';

    // Weather.
    $wxHtml = '';
    $wxHtml .= barRow('Temperature', $wxStats['temp'], $stationsWithWeather, '#fb923c');
    $wxHtml .= barRow('Pressure', $wxStats['pressure'], $stationsWithWeather, '#38bdf8');
    $wxHtml .= barRow('Wind speed', $wxStats['wind'], $stationsWithWeather, 'var(--accent)');
    $wxHtml .= barRow('Gusts', $wxStats['gust'], $stationsWithWeather, '#f5c451');
    $wxHtml .= barRow('Humidity', $wxStats['humidity'], $stationsWithWeather, '#a78bfa');
    $extra = '';
    if ($temps) $extra .= 'Temp ' . h(number_format(min($temps), 1)) . ' … ' . h(number_format(max($temps), 1)) . ' °C · ';
    if ($pressures) $extra .= 'Pressure ' . h(number_format(min($pressures), 1)) . ' … ' . h(number_format(max($pressures), 1)) . ' hPa · ';
    if ($winds) $extra .= 'Wind up to ' . h(number_format(max($winds), 0)) . ' km/h';
    echo sectionCard('Weather reports', $stationsWithWeather . ' stations', $wxHtml
        . ($extra !== '' ? '<p class="ins-note">' . $extra . '</p>' : ''));

    // Thermal hotspots.
    $rows = [];
    foreach ($thermalCells as $c) {
        $lat = (float)$c['la'];
        $lon = (float)$c['lo'];
        $label = number_format($lat, 1) . ', ' . number_format($lon, 1);
        $mapUrl = 'https://www.google.com/maps/search/?api=1&query=' . rawurlencode((string)$lat) . ',' . rawurlencode((string)$lon);
        $rows[] = [
            '<a href="' . h($mapUrl) . '" target="_blank" rel="noopener">' . h($label) . '</a>',
            '<span class="num">' . n((int)$c['n']) . '</span>',
        ];
    }
    echo sectionCard('Thermal activity', n($thermalTotal) . ' samples',
        simpleTable(['0.1° cell', 'Samples'], $rows)
        . '<p class="ins-note">Heatmap intensity is an accumulated proxy, not a calibrated climb rate.</p>');

    echo '<h3 class="ins-section" id="quality">Data quality</h3>';

    // Data quality.
    $rows = [
        ['Aircraft with no altitude in packet', '<span class="num">' . n($noAltCount) . '</span>', h(pct($noAltCount, max(1, $aircraftTotal)))],
        ['Aircraft without a DDB match', '<span class="num">' . n(max(0, $aircraftTotal - $ddbKnown)) . '</span>', h(pct(max(0, $aircraftTotal - $ddbKnown), max(1, $aircraftTotal)))],
        ['Stations stale (>1h)', '<span class="num">' . n($staleStations) . '</span>', h(pct($staleStations, max(1, $stationTotal)))],
        ['Telemetry records', '<span class="num">' . n($telemetryTotal) . '</span>', ''],
        ['Name records', '<span class="num">' . n($namesTotal) . '</span>', ''],
    ];
    echo sectionCard('Data quality', 'coverage & metadata gaps', simpleTable(['Metric', 'Count', 'Share'], $rows));
    ?>
  </div>

  <p class="ins-note ins-note--spaced">
    Notes: type counts use the packet-derived OGN type with DDB as fallback. Ground stations are separated into the
    station section. Counts are based on the latest packet per aircraft in the <code>aircraft</code> table, so one
    aircraft contributes one row. Track and thermal figures come from the 24-hour history tables.
  </p>
<?php endif; ?>
</div>
</main>
<script>
(function () {
  const pad = v => String(v).padStart(2, '0');
  const timeOf = ts => { const d = new Date(ts * 1000); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  const dateTimeOf = ts => { const d = new Date(ts * 1000); return d.toLocaleDateString() + ' ' + timeOf(ts); };
  const dateOf = ts => { const d = new Date(ts * 1000); return pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const hourOf = ts => { const d = new Date(ts * 1000); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };

  document.querySelectorAll('.ins-time').forEach(el => {
    const ts = Number(el.dataset.ts || 0);
    if (!ts) return;
    el.textContent = el.classList.contains('ins-time-dt') ? dateTimeOf(ts) : timeOf(ts);
  });
  const tzNote = document.querySelector('.ins-tz-note');
  if (tzNote) tzNote.textContent = 'your local time';

  const relAge = ts => {
    const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm ago';
  };
  document.querySelectorAll('.ins-time-age').forEach(el => {
    const ts = Number(el.dataset.ts || 0);
    if (ts) el.textContent = relAge(ts);
  });

  const status = document.getElementById('insStatus');
  if (status) {
    const dataTs = Number(status.dataset.dataTs || 0);
    const genTs = Number(status.dataset.genTs || 0);
    const mins = ts => Math.max(0, Math.round((Date.now() / 1000 - ts) / 60));
    const dataAge = mins(dataTs);
    const genAge = mins(genTs);
    const dot = status.querySelector('.dot');
    const text = document.getElementById('insStatusText');
    const age = document.getElementById('insStatusAge');
    let cls = 'dot', label = 'No data timestamp';
    if (dataTs > 0) {
      if (dataAge < 5) { cls += ' live'; label = 'Data live'; }
      else if (dataAge < 60) { cls += ' warn'; label = 'Data delayed'; }
      else { cls += ' error'; label = 'Collector overdue'; }
      if (age) age.textContent = 'data ' + dataAge + 'm ago · snapshot ' + genAge + 'm ago';
    }
    if (dot) dot.className = cls;
    if (text) text.textContent = label;
  }

  document.querySelectorAll('.ins-col').forEach(col => {
    const ts = Number(col.dataset.ts || 0);
    if (!ts) return;
    const dateEl = col.querySelector('.ins-col-date');
    const hourEl = col.querySelector('.ins-col-hour');
    if (dateEl) dateEl.textContent = dateOf(ts);
    if (hourEl) hourEl.textContent = hourOf(ts);
    const title = col.getAttribute('title') || '';
    const sep = title.indexOf(' — ');
    if (sep !== -1) col.setAttribute('title', dateTimeOf(ts) + ' — ' + title.slice(sep + 3));
    else col.setAttribute('title', dateTimeOf(ts) + ': ' + (col.querySelector('.ins-col-val')?.textContent || ''));
  });

  function layoutCharts() {
    document.querySelectorAll('.ins-scroll-chart').forEach(box => {
      const cols = box.querySelector('.ins-chart-cols');
      if (!cols || !cols.children.length) return;
      const visible = Math.max(1, Number(box.dataset.visible || 8));
      const gap = 3;
      const width = Math.max(44, (box.clientWidth - gap * (visible - 1)) / visible);
      Array.from(cols.children).forEach(col => { col.style.flexBasis = width + 'px'; });
      cols.style.width = (cols.children.length * width + gap * (cols.children.length - 1)) + 'px';
      box.scrollLeft = box.scrollWidth;
    });
  }
  layoutCharts();
  window.addEventListener('resize', layoutCharts);
})();
</script>
</body>
</html>
<?php
$pageHtml = ob_get_clean();
if (!isset($fatal)) {
    $tmpHtml = $cacheFile . '.tmp';
    $tmpMeta = $cacheMeta . '.tmp';
    @file_put_contents($tmpHtml, $pageHtml, LOCK_EX);
    @file_put_contents($tmpMeta, json_encode([
        'data_updated' => $dataUpdated,
        'generated_at' => $generatedAt,
        'next_at'      => $nextRefreshAt,
        'duration'     => round($genDuration, 2),
    ]), LOCK_EX);
    @rename($tmpHtml, $cacheFile);
    @rename($tmpMeta, $cacheMeta);
}
if ($cliGenerate) {
    if (isset($fatal)) {
        fwrite(STDERR, 'Insights generation failed: ' . $fatal . "\n");
    } else {
        echo 'Insights regenerated in ' . number_format($genDuration, 1) . "s\n";
    }
} else {
    echo $pageHtml;
}
