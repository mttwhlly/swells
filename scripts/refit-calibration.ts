/**
 * Re-fits the per-location `waveHeightCalibration` factors in src/app/lib/locations.ts
 * against fresh NDBC buoy observations.
 *
 * The factors correct a systematic, location-specific bias in Open-Meteo's modelled
 * significant wave height. They were fitted on a single late-summer window and drift,
 * so they need periodic re-fitting — see the quarterly reminder in
 * .github/workflows/refit-calibration.yml.
 *
 * Method (identical to the original fit, so results are comparable):
 *   1. Pull buoy WVHT (significant wave height, m) from NDBC's realtime2 feed, which
 *      carries ~45 days of 30-minute observations.
 *   2. Pull Open-Meteo's modelled wave_height for the same window and coordinates,
 *      using the same default `best_match` model the surfability route uses.
 *   3. Pair them on the UTC hour.
 *   4. Fit on the first half of the window: factor = mean(buoy Hs) / mean(model Hs).
 *   5. Validate out-of-sample on the second half — compare RMSE with the fitted factor
 *      against RMSE with no correction. Only adopt a factor that measurably wins.
 *
 * This only *reports*. Applying a new factor is a manual edit to locations.ts, so a bad
 * buoy window can't silently change what the site tells people.
 *
 * Usage:
 *   pnpm refit-calibration                 # all locations, 30-day window
 *   pnpm refit-calibration --days 45       # widen the window
 *   pnpm refit-calibration --location oahu # one location
 *   pnpm refit-calibration --json          # machine-readable output
 */

import { LOCATIONS, type Location } from '../src/app/lib/locations';

/** Relative RMSE improvement a fitted factor must clear out-of-sample to be worth adopting. */
const MIN_RMSE_IMPROVEMENT = 0.02;
/** Relative change from the in-repo factor that's worth flagging for review. */
const DRIFT_THRESHOLD = 0.05;
/** Below this many paired hours the window is too thin to conclude anything. */
const MIN_PAIRS = 100;

type Pair = { time: number; buoy: number; model: number };

type Result = {
  slug: string;
  name: string;
  buoyId: string;
  status: 'ok' | 'insufficient-data' | 'error';
  message?: string;
  current: number;
  fittedOn: string | null;
  // populated when status === 'ok'
  fitted?: number;
  recommended?: number;
  correlation?: number;
  pairs?: number;
  distanceKm?: number;
  rmseUncorrected?: number;
  rmseFitted?: number;
  windowStart?: string;
  windowEnd?: string;
  drifted?: boolean;
};

// ---------------------------------------------------------------------------
// data sources
// ---------------------------------------------------------------------------

/**
 * NDBC's realtime2 feed: whitespace-delimited, two `#` header lines, newest row first,
 * missing values as "MM". We want YY MM DD hh mm (UTC) and WVHT (column index 8).
 */
async function fetchBuoyObservations(buoyId: string): Promise<{ time: number; hs: number }[]> {
  const res = await fetch(`https://www.ndbc.noaa.gov/data/realtime2/${buoyId}.txt`, {
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    throw new Error(`NDBC ${buoyId} returned ${res.status} — station may be decommissioned`);
  }

  const out: { time: number; hs: number }[] = [];
  for (const line of (await res.text()).split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const f = line.trim().split(/\s+/);
    if (f.length < 9) continue;

    const wvht = f[8];
    if (wvht === 'MM') continue;
    const hs = Number(wvht);
    if (!Number.isFinite(hs) || hs <= 0) continue;

    const [yy, mm, dd, hh, mi] = f.slice(0, 5).map(Number);
    if ([yy, mm, dd, hh, mi].some(n => !Number.isFinite(n))) continue;

    out.push({ time: Date.UTC(yy, mm - 1, dd, hh, mi), hs });
  }
  return out.sort((a, b) => a.time - b.time);
}

/**
 * Open-Meteo modelled Hs for the same window. No `models=` parameter, so this is
 * `best_match` — the same thing /api/surfability calls. Don't switch models here to
 * chase a better fit: ncep_gfswave025 returns a hardcoded 0.00m at Oahu.
 */
async function fetchModelWaveHeights(
  lat: number,
  lon: number,
  startDate: string,
  endDate: string
): Promise<{ time: number; hs: number }[]> {
  const url =
    `https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lon}` +
    `&hourly=wave_height&start_date=${startDate}&end_date=${endDate}&timezone=UTC`;

  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Open-Meteo returned ${res.status}`);

  const json = await res.json();
  const times: string[] = json?.hourly?.time ?? [];
  const heights: (number | null)[] = json?.hourly?.wave_height ?? [];

  const out: { time: number; hs: number }[] = [];
  for (let i = 0; i < times.length; i++) {
    const hs = heights[i];
    if (hs === null || hs === undefined || !Number.isFinite(hs) || hs <= 0) continue;
    out.push({ time: new Date(`${times[i]}:00Z`).getTime(), hs });
  }
  return out;
}

/** Station lat/lon, so the report can record how far the buoy sits from the break. */
async function fetchStationCoords(): Promise<Map<string, { lat: number; lon: number }>> {
  const map = new Map<string, { lat: number; lon: number }>();
  try {
    const res = await fetch('https://www.ndbc.noaa.gov/data/stations/station_table.txt', {
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return map;

    for (const line of (await res.text()).split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const fields = line.split('|');
      if (fields.length < 7) continue;
      const m = fields[6].match(/([\d.]+)\s*([NS])\s+([\d.]+)\s*([EW])/);
      if (!m) continue;
      map.set(fields[0].trim().toLowerCase(), {
        lat: Number(m[1]) * (m[2] === 'S' ? -1 : 1),
        lon: Number(m[3]) * (m[4] === 'W' ? -1 : 1),
      });
    }
  } catch {
    // Provenance only — a failure here shouldn't sink the refit.
  }
  return map;
}

// ---------------------------------------------------------------------------
// statistics
// ---------------------------------------------------------------------------

function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function pearson(xs: number[], ys: number[]): number {
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < xs.length; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  return dx === 0 || dy === 0 ? 0 : num / Math.sqrt(dx * dy);
}

function rmse(pairs: Pair[], factor: number): number {
  return Math.sqrt(mean(pairs.map(p => (p.model * factor - p.buoy) ** 2)));
}

/**
 * Buoy obs arrive every ~30 min, the model is hourly. Average every observation falling
 * inside a model hour rather than picking the nearest, so a single noisy reading doesn't
 * anchor the pair.
 */
function pairOnHour(
  buoy: { time: number; hs: number }[],
  model: { time: number; hs: number }[]
): Pair[] {
  const HOUR = 3600_000;
  const buckets = new Map<number, number[]>();
  for (const obs of buoy) {
    const hour = Math.round(obs.time / HOUR) * HOUR;
    const bucket = buckets.get(hour);
    if (bucket) bucket.push(obs.hs);
    else buckets.set(hour, [obs.hs]);
  }

  const pairs: Pair[] = [];
  for (const m of model) {
    const bucket = buckets.get(m.time);
    if (bucket?.length) pairs.push({ time: m.time, buoy: mean(bucket), model: m.hs });
  }
  return pairs.sort((a, b) => a.time - b.time);
}

// ---------------------------------------------------------------------------
// per-location refit
// ---------------------------------------------------------------------------

async function refit(
  loc: Location,
  days: number,
  coords: Map<string, { lat: number; lon: number }>
): Promise<Result> {
  const base: Result = {
    slug: loc.slug,
    name: loc.name,
    buoyId: loc.calibrationBuoyId!,
    status: 'ok',
    current: loc.waveHeightCalibration,
    fittedOn: loc.calibrationFittedOn,
  };

  const buoyAll = await fetchBuoyObservations(loc.calibrationBuoyId!);
  if (buoyAll.length === 0) {
    return { ...base, status: 'error', message: 'buoy returned no usable WVHT readings' };
  }

  // Anchor the window on the buoy's newest reading — a stalled feed shouldn't silently
  // compare fresh model output against weeks-old observations.
  const end = buoyAll[buoyAll.length - 1].time;
  const start = end - days * 86400_000;
  const buoy = buoyAll.filter(o => o.time >= start);

  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  const model = await fetchModelWaveHeights(loc.lat, loc.lon, iso(start), iso(end));

  const pairs = pairOnHour(buoy, model);
  if (pairs.length < MIN_PAIRS) {
    return {
      ...base,
      status: 'insufficient-data',
      message: `only ${pairs.length} paired hours (need ${MIN_PAIRS})`,
      pairs: pairs.length,
    };
  }

  // Fit on the first half, test on the second — the same out-of-sample check used for
  // the original factors.
  const split = Math.floor(pairs.length / 2);
  const fitHalf = pairs.slice(0, split);
  const testHalf = pairs.slice(split);

  const fitted = mean(fitHalf.map(p => p.buoy)) / mean(fitHalf.map(p => p.model));
  const rmseUncorrected = rmse(testHalf, 1.0);
  const rmseFitted = rmse(testHalf, fitted);

  const improvement = (rmseUncorrected - rmseFitted) / rmseUncorrected;
  const recommended = improvement > MIN_RMSE_IMPROVEMENT ? fitted : 1.0;

  const station = coords.get(loc.calibrationBuoyId!.toLowerCase());

  return {
    ...base,
    fitted,
    recommended,
    correlation: pearson(pairs.map(p => p.model), pairs.map(p => p.buoy)),
    pairs: pairs.length,
    distanceKm: station ? haversineKm(loc.lat, loc.lon, station.lat, station.lon) : undefined,
    rmseUncorrected,
    rmseFitted,
    windowStart: iso(pairs[0].time),
    windowEnd: iso(pairs[pairs.length - 1].time),
    drifted: Math.abs(recommended - loc.waveHeightCalibration) / loc.waveHeightCalibration >
      DRIFT_THRESHOLD,
  };
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

function pad(s: string, width: number) {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}
function padLeft(s: string, width: number) {
  return s.length >= width ? s : ' '.repeat(width - s.length) + s;
}

function printTable(results: Result[]) {
  console.log('');
  console.log(
    pad('location', 17) +
      pad('buoy', 7) +
      padLeft('current', 8) +
      padLeft('fitted', 8) +
      padLeft('suggest', 9) +
      padLeft('r', 7) +
      padLeft('RMSE', 16) +
      '  flag'
  );
  console.log('-'.repeat(80));

  for (const r of results) {
    if (r.status !== 'ok') {
      console.log(
        pad(r.slug, 17) + pad(r.buoyId, 7) + padLeft(r.current.toFixed(2), 8) + `  — ${r.message}`
      );
      continue;
    }
    console.log(
      pad(r.slug, 17) +
        pad(r.buoyId, 7) +
        padLeft(r.current.toFixed(2), 8) +
        padLeft(r.fitted!.toFixed(2), 8) +
        padLeft(r.recommended!.toFixed(2), 9) +
        padLeft(r.correlation!.toFixed(2), 7) +
        padLeft(`${r.rmseUncorrected!.toFixed(2)}→${r.rmseFitted!.toFixed(2)}m`, 16) +
        (r.drifted ? '  * drifted' : '')
    );
  }
  console.log('');
}

function printDetail(results: Result[]) {
  const drifted = results.filter(r => r.status === 'ok' && r.drifted);
  if (drifted.length === 0) {
    console.log('No factor drifted more than ' + DRIFT_THRESHOLD * 100 + '% — nothing to change.');
    console.log('');
    return;
  }

  console.log(`${drifted.length} factor(s) drifted past ${DRIFT_THRESHOLD * 100}% — review each:`);
  console.log('');
  for (const r of drifted) {
    const dist = r.distanceKm !== undefined ? `, ${Math.round(r.distanceKm)}km` : '';
    const beatsNull = r.rmseFitted! < r.rmseUncorrected!;
    console.log(`  ${r.slug} (${r.name})`);
    console.log(`    buoy ${r.buoyId}${dist} · ${r.pairs} paired hours · ${r.windowStart} → ${r.windowEnd}`);
    console.log(`    current ${r.current.toFixed(2)} (fitted ${r.fittedOn}) → suggested ${r.recommended!.toFixed(2)}`);
    console.log(
      `    out-of-sample RMSE ${r.rmseUncorrected!.toFixed(2)}m → ${r.rmseFitted!.toFixed(2)}m` +
        (beatsNull ? '' : ' (does NOT beat no correction — suggest 1.00)')
    );
    console.log(`    to apply, in src/app/lib/locations.ts:`);
    console.log(
      `      // fitted ${r.fitted!.toFixed(2)} (r=${r.correlation!.toFixed(2)}${dist}); ` +
        `out-of-sample RMSE ${r.rmseUncorrected!.toFixed(2)}m -> ${r.rmseFitted!.toFixed(2)}m`
    );
    console.log(`      waveHeightCalibration: ${r.recommended!.toFixed(2)},`);
    console.log(`      calibrationFittedOn: '${new Date().toISOString().slice(0, 10)}',`);
    console.log('');
  }
  console.log('Applying a factor is a deliberate manual edit — nothing here writes to locations.ts.');
  console.log('');
}

// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const arg = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i !== -1 ? argv[i + 1] : undefined;
  };

  const days = Number(arg('days') ?? 30);
  const only = arg('location');
  const asJson = argv.includes('--json');

  if (!Number.isFinite(days) || days < 7 || days > 45) {
    console.error('--days must be between 7 and 45 (NDBC realtime2 holds ~45 days)');
    process.exit(1);
  }

  let targets = LOCATIONS.filter(l => l.calibrationBuoyId);
  if (only) {
    targets = targets.filter(l => l.slug === only);
    if (targets.length === 0) {
      console.error(`No location with slug "${only}" and a calibrationBuoyId`);
      process.exit(1);
    }
  }

  if (!asJson) {
    console.log(`Re-fitting wave height calibration over the last ${days} days`);
    console.log(`${targets.length} location(s) · Open-Meteo best_match vs NDBC buoy Hs`);
  }

  const coords = await fetchStationCoords();

  const results: Result[] = [];
  for (const loc of targets) {
    try {
      results.push(await refit(loc, days, coords));
    } catch (err) {
      results.push({
        slug: loc.slug,
        name: loc.name,
        buoyId: loc.calibrationBuoyId!,
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
        current: loc.waveHeightCalibration,
        fittedOn: loc.calibrationFittedOn,
      });
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ days, generatedAt: new Date().toISOString(), results }, null, 2));
    return;
  }

  printTable(results);
  printDetail(results);

  const failed = results.filter(r => r.status === 'error');
  if (failed.length > 0) {
    console.log(`${failed.length} location(s) could not be refit:`);
    for (const r of failed) console.log(`  ${r.slug} (buoy ${r.buoyId}): ${r.message}`);
    console.log('');
    console.log('A dead buoy needs a replacement station in calibrationBuoyId, not a retry.');
  }
}

main().catch(err => {
  console.error('Refit failed:', err);
  process.exit(1);
});
