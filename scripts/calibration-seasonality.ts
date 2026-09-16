/**
 * Measures how the Open-Meteo wave height bias varies across the year, per location.
 *
 * `pnpm refit-calibration` answers "what is the factor right now". This answers the
 * question behind the refit *cadence*: how fast does the factor actually move, and does
 * it move seasonally (schedulable) or just wander (not schedulable)?
 *
 * It pulls two complete calendar years from NDBC's historical archive and Open-Meteo's
 * matching model output, then computes a monthly mean(buoy Hs)/mean(model Hs) — the same
 * estimator the live factors use, so the numbers are directly comparable.
 *
 * Read three things off the output:
 *   - AMPLITUDE   how far the factor swings across a year. Small => one constant is fine.
 *   - REPEATABILITY  does year 2 trace year 1? Repeating => seasonal, so schedule the
 *                    refit just after each transition. Not repeating => drift, which
 *                    needs a shorter cadence rather than a better-timed one.
 *   - PERSISTENCE how many consecutive months stay within tolerance of each other. That
 *                 interval is the cadence.
 *
 * Downloads are cached under .cache/seasonality so re-runs are cheap.
 *
 * Usage:
 *   pnpm calibration-seasonality
 *   pnpm calibration-seasonality --years 2024,2025 --location boca-raton
 *   pnpm calibration-seasonality --min-hs 0.5   # only hours with rideable surf
 *   pnpm calibration-seasonality --json
 */

import { LOCATIONS, type Location } from '../src/app/lib/locations';
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const CACHE_DIR = join(process.cwd(), '.cache', 'seasonality');
/** Relative gap between two monthly factors beyond which they are "different". */
const TOLERANCE = 0.05;
/** A month needs at least this many paired hours to be trusted. */
const MIN_HOURS_PER_MONTH = 200;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

type Obs = { time: number; hs: number };
type MonthStat = { year: number; month: number; ratio: number; hours: number; meanBuoyHs: number };

// ---------------------------------------------------------------------------
// cached fetch
// ---------------------------------------------------------------------------

async function cached(key: string, fetcher: () => Promise<string>): Promise<string> {
  const path = join(CACHE_DIR, key);
  try {
    return await readFile(path, 'utf8');
  } catch {
    const body = await fetcher();
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(path, body);
    return body;
  }
}

/**
 * NDBC historical stdmet. Same leading columns as the realtime2 feed (index 8 is WVHT),
 * but missing values are sentinel numbers — 99.00 for WVHT — rather than "MM".
 */
async function fetchBuoyYear(buoyId: string, year: number): Promise<Obs[]> {
  const raw = await cached(`${buoyId}-${year}.txt`, async () => {
    const url = `https://www.ndbc.noaa.gov/data/historical/stdmet/${buoyId}h${year}.txt.gz`;
    const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error(`NDBC ${buoyId} ${year} returned ${res.status}`);
    return text(Readable.fromWeb(res.body as any).pipe(createGunzip()));
  });

  const out: Obs[] = [];
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const f = line.trim().split(/\s+/);
    if (f.length < 9) continue;
    const hs = Number(f[8]);
    // 99.00 is NDBC's "missing"; anything at or above it is not a real reading.
    if (!Number.isFinite(hs) || hs <= 0 || hs >= 99) continue;
    const [yy, mm, dd, hh, mi] = f.slice(0, 5).map(Number);
    if ([yy, mm, dd, hh, mi].some(n => !Number.isFinite(n))) continue;
    out.push({ time: Date.UTC(yy, mm - 1, dd, hh, mi), hs });
  }
  return out;
}

/** Open-Meteo best_match for a full calendar year — the same model /api/surfability uses. */
async function fetchModelYear(loc: Location, year: number): Promise<Obs[]> {
  const raw = await cached(`model-${loc.slug}-${year}.json`, async () => {
    const url =
      `https://marine-api.open-meteo.com/v1/marine?latitude=${loc.lat}&longitude=${loc.lon}` +
      `&hourly=wave_height&start_date=${year}-01-01&end_date=${year}-12-31&timezone=UTC`;
    const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error(`Open-Meteo ${loc.slug} ${year} returned ${res.status}`);
    return res.text();
  });

  const json = JSON.parse(raw);
  const times: string[] = json?.hourly?.time ?? [];
  const heights: (number | null)[] = json?.hourly?.wave_height ?? [];
  const out: Obs[] = [];
  for (let i = 0; i < times.length; i++) {
    const hs = heights[i];
    if (hs === null || hs === undefined || !Number.isFinite(hs) || hs <= 0) continue;
    out.push({ time: new Date(`${times[i]}:00Z`).getTime(), hs });
  }
  return out;
}

// ---------------------------------------------------------------------------
// analysis
// ---------------------------------------------------------------------------

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function monthlyRatios(buoy: Obs[], model: Obs[], minHs: number): MonthStat[] {
  const HOUR = 3600_000;

  // Average the ~30-minute buoy observations into the model's hourly grid.
  const buckets = new Map<number, number[]>();
  for (const o of buoy) {
    const hour = Math.round(o.time / HOUR) * HOUR;
    const b = buckets.get(hour);
    if (b) b.push(o.hs);
    else buckets.set(hour, [o.hs]);
  }

  const byMonth = new Map<string, { buoy: number[]; model: number[] }>();
  for (const m of model) {
    const bucket = buckets.get(m.time);
    if (!bucket?.length) continue;
    const buoyHs = mean(bucket);
    if (buoyHs < minHs) continue;

    const d = new Date(m.time);
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    let entry = byMonth.get(key);
    if (!entry) byMonth.set(key, (entry = { buoy: [], model: [] }));
    entry.buoy.push(buoyHs);
    entry.model.push(m.hs);
  }

  const stats: MonthStat[] = [];
  for (const [key, v] of Array.from(byMonth.entries())) {
    if (v.buoy.length < MIN_HOURS_PER_MONTH) continue;
    const [year, month] = key.split('-').map(Number);
    stats.push({
      year,
      month,
      ratio: mean(v.buoy) / mean(v.model),
      hours: v.buoy.length,
      meanBuoyHs: mean(v.buoy),
    });
  }
  return stats.sort((a, b) => a.year - b.year || a.month - b.month);
}

/**
 * Longest run of consecutive months whose factors all sit within TOLERANCE of the run's
 * own mean. This is the cadence the data supports: refit at least this often.
 */
function longestStableRun(stats: MonthStat[]): number {
  const chron = [...stats].sort((a, b) => a.year - b.year || a.month - b.month);
  let best = 0;
  for (let i = 0; i < chron.length; i++) {
    for (let j = i; j < chron.length; j++) {
      // Only extend across genuinely adjacent months.
      if (j > i) {
        const prev = chron[j - 1];
        const cur = chron[j];
        const gap = (cur.year - prev.year) * 12 + (cur.month - prev.month);
        if (gap !== 1) break;
      }
      const run = chron.slice(i, j + 1);
      const m = mean(run.map(r => r.ratio));
      if (run.every(r => Math.abs(r.ratio - m) / m <= TOLERANCE)) {
        best = Math.max(best, run.length);
      } else break;
    }
  }
  return best;
}

type LocationReport = {
  slug: string;
  name: string;
  buoyId: string;
  current: number;
  stats: MonthStat[];
  amplitude: number | null;
  repeatability: number | null;
  stableRunMonths: number;
  annualRatio: number | null;
  note?: string;
};

function analyse(loc: Location, stats: MonthStat[]): LocationReport {
  const base = {
    slug: loc.slug,
    name: loc.name,
    buoyId: loc.calibrationBuoyId!,
    current: loc.waveHeightCalibration,
    stats,
  };

  if (stats.length < 6) {
    return {
      ...base,
      amplitude: null,
      repeatability: null,
      stableRunMonths: 0,
      annualRatio: null,
      note: `only ${stats.length} usable months — too sparse to conclude`,
    };
  }

  const ratios = stats.map(s => s.ratio);
  const lo = Math.min(...ratios);
  const hi = Math.max(...ratios);
  const amplitude = (hi - lo) / mean(ratios);

  // Repeatability: mean relative gap between the same month in different years. Low =
  // the pattern repeats, so it is seasonal and worth timing a refit around.
  const byMonth = new Map<number, number[]>();
  for (const s of stats) {
    const b = byMonth.get(s.month);
    if (b) b.push(s.ratio);
    else byMonth.set(s.month, [s.ratio]);
  }
  const gaps: number[] = [];
  for (const v of Array.from(byMonth.values())) {
    if (v.length < 2) continue;
    gaps.push((Math.max(...v) - Math.min(...v)) / mean(v));
  }

  return {
    ...base,
    amplitude,
    repeatability: gaps.length >= 3 ? mean(gaps) : null,
    stableRunMonths: longestStableRun(stats),
    annualRatio: mean(ratios),
  };
}

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------

const pad = (s: string, w: number) => (s.length >= w ? s : s + ' '.repeat(w - s.length));
const padL = (s: string, w: number) => (s.length >= w ? s : ' '.repeat(w - s.length) + s);

function printLocation(r: LocationReport, years: number[]) {
  console.log('');
  console.log(`${r.slug} — ${r.name}  (buoy ${r.buoyId}, in-repo factor ${r.current.toFixed(2)})`);

  if (r.note) {
    console.log(`  ${r.note}`);
    return;
  }

  console.log('  ' + pad('', 7) + MONTHS.map(m => padL(m, 6)).join(''));
  for (const y of years) {
    const row = MONTHS.map((_, mi) => {
      const s = r.stats.find(x => x.year === y && x.month === mi);
      return padL(s ? s.ratio.toFixed(2) : '·', 6);
    }).join('');
    console.log('  ' + pad(String(y), 7) + row);
  }

  const amp = (r.amplitude! * 100).toFixed(0);
  const rep = r.repeatability === null ? 'n/a' : (r.repeatability * 100).toFixed(0) + '%';
  console.log(
    `  annual ${r.annualRatio!.toFixed(2)} · amplitude ${amp}% · ` +
      `year-over-year gap ${rep} · longest stable run ${r.stableRunMonths}mo`
  );
}

function verdict(reports: LocationReport[]) {
  const usable = reports.filter(r => !r.note);
  if (usable.length === 0) return;

  console.log('');
  console.log('='.repeat(78));
  console.log('CADENCE READ');
  console.log('='.repeat(78));
  console.log('');
  console.log(
    '  ' +
      pad('location', 17) +
      padL('annual', 8) +
      padL('in-repo', 9) +
      padL('ampl', 7) +
      padL('yoy gap', 9) +
      padL('stable', 8) +
      '  reading'
  );
  console.log('  ' + '-'.repeat(74));

  for (const r of usable) {
    // Amplitude says how much there is to chase; the year-over-year gap says whether
    // chasing it on a calendar is even possible. The gap has to be small both relative
    // to the amplitude *and* in absolute terms — a shape that repeats to within 18% is
    // not a shape you can schedule around, however large the swing it sits inside.
    const seasonal =
      r.repeatability !== null && r.repeatability < r.amplitude! * 0.5 && r.repeatability < 0.08;
    let reading: string;
    if (r.amplitude! < 0.1) reading = 'stable — one constant is fine';
    else if (seasonal) reading = 'seasonal — per-month factor';
    else reading = 'wanders — no schedule helps';

    console.log(
      '  ' +
        pad(r.slug, 17) +
        padL(r.annualRatio!.toFixed(2), 8) +
        padL(r.current.toFixed(2), 9) +
        padL((r.amplitude! * 100).toFixed(0) + '%', 7) +
        padL(r.repeatability === null ? 'n/a' : (r.repeatability * 100).toFixed(0) + '%', 9) +
        padL(r.stableRunMonths + 'mo', 8) +
        '  ' +
        reading
    );
  }

  const runs = usable.map(r => r.stableRunMonths).filter(n => n > 0);
  if (runs.length) {
    console.log('');
    console.log(
      `  Shortest stable run across locations: ${Math.min(...runs)} months — ` +
        `the cadence must be at least this frequent.`
    );
  }
  console.log('');
  console.log('  amplitude  = peak-to-trough swing of the monthly factor, as % of its mean');
  console.log('  yoy gap    = mean spread between the same calendar month in different years;');
  console.log('               well below amplitude means the shape repeats and is schedulable');
  console.log('  stable     = longest run of consecutive months within ' + TOLERANCE * 100 + '%');
  console.log('');
}

// ---------------------------------------------------------------------------
// out-of-sample scheme comparison
// ---------------------------------------------------------------------------

type Paired = { time: number; buoy: number; model: number };

function pairAll(buoy: Obs[], model: Obs[]): Paired[] {
  const HOUR = 3600_000;
  const buckets = new Map<number, number[]>();
  for (const o of buoy) {
    const hour = Math.round(o.time / HOUR) * HOUR;
    const b = buckets.get(hour);
    if (b) b.push(o.hs);
    else buckets.set(hour, [o.hs]);
  }
  const out: Paired[] = [];
  for (const m of model) {
    const b = buckets.get(m.time);
    if (b?.length) out.push({ time: m.time, buoy: mean(b), model: m.hs });
  }
  return out;
}

const rmseOf = (pairs: Paired[], factorAt: (p: Paired) => number) =>
  Math.sqrt(mean(pairs.map(p => (p.model * factorAt(p) - p.buoy) ** 2)));

/** Ratio-of-means over a subset, falling back to the global ratio when a bucket is thin. */
function bucketFactors(pairs: Paired[], keyOf: (p: Paired) => number, minN: number) {
  const groups = new Map<number, Paired[]>();
  for (const p of pairs) {
    const k = keyOf(p);
    const g = groups.get(k);
    if (g) g.push(p);
    else groups.set(k, [p]);
  }
  const global = mean(pairs.map(p => p.buoy)) / mean(pairs.map(p => p.model));
  const table = new Map<number, number>();
  for (const [k, g] of Array.from(groups.entries())) {
    table.set(k, g.length < minN ? global : mean(g.map(x => x.buoy)) / mean(g.map(x => x.model)));
  }
  return { table, global };
}

const monthOf = (p: Paired) => new Date(p.time).getUTCMonth();
const quarterOf = (p: Paired) => Math.floor(new Date(p.time).getUTCMonth() / 3);

async function validate(targets: Location[], fitYear: number, testYear: number) {
  console.log('');
  console.log('='.repeat(78));
  console.log(`SCHEME COMPARISON — fit on ${fitYear}, evaluate on ${testYear} (out of sample)`);
  console.log('='.repeat(78));
  console.log('');
  console.log(
    '  ' +
      pad('location', 17) +
      padL('none', 8) +
      padL('in-repo', 9) +
      padL('annual', 8) +
      padL('quarter', 9) +
      padL('month', 8) +
      '  best'
  );
  console.log('  ' + '-'.repeat(74));

  const wins = new Map<string, number>();

  for (const loc of targets) {
    const fit = pairAll(
      await fetchBuoyYear(loc.calibrationBuoyId!, fitYear),
      await fetchModelYear(loc, fitYear)
    );
    const test = pairAll(
      await fetchBuoyYear(loc.calibrationBuoyId!, testYear),
      await fetchModelYear(loc, testYear)
    );
    if (fit.length < 1000 || test.length < 1000) {
      console.log('  ' + pad(loc.slug, 17) + `  too few pairs (fit ${fit.length}, test ${test.length})`);
      continue;
    }

    const annual = mean(fit.map(p => p.buoy)) / mean(fit.map(p => p.model));
    const byMonth = bucketFactors(fit, monthOf, 200);
    const byQuarter = bucketFactors(fit, quarterOf, 400);

    const scores: Record<string, number> = {
      none: rmseOf(test, () => 1),
      'in-repo': rmseOf(test, () => loc.waveHeightCalibration),
      annual: rmseOf(test, () => annual),
      quarter: rmseOf(test, p => byQuarter.table.get(quarterOf(p)) ?? byQuarter.global),
      month: rmseOf(test, p => byMonth.table.get(monthOf(p)) ?? byMonth.global),
    };

    const best = Object.entries(scores).sort((a, b) => a[1] - b[1])[0][0];
    wins.set(best, (wins.get(best) ?? 0) + 1);

    console.log(
      '  ' +
        pad(loc.slug, 17) +
        padL(scores.none.toFixed(3), 8) +
        padL(scores['in-repo'].toFixed(3), 9) +
        padL(scores.annual.toFixed(3), 8) +
        padL(scores.quarter.toFixed(3), 9) +
        padL(scores.month.toFixed(3), 8) +
        '  ' +
        best
    );
  }

  console.log('');
  console.log('  RMSE in metres of significant wave height. Lower is better.');
  console.log('  none    = no correction        in-repo = the factor currently shipped');
  console.log(`  annual  = one constant fitted on ${fitYear}`);
  console.log(`  quarter = four factors fitted on ${fitYear}    month = twelve factors`);
  console.log('');
  console.log(
    '  best scheme per location: ' +
      Array.from(wins.entries())
        .map(([k, v]) => `${k} ${v}`)
        .join(', ')
  );
  console.log('');
}

/**
 * Proposed replacement factors, fitted over every year requested rather than a single
 * month-long window. Prints paste-ready values; nothing is written automatically.
 */
async function recommend(targets: Location[], years: number[]) {
  console.log('');
  console.log('='.repeat(78));
  console.log(`PROPOSED FACTORS — ratio of means over ${years.join(' + ')}`);
  console.log('='.repeat(78));

  for (const loc of targets) {
    const pairs: Paired[] = [];
    for (const y of years) {
      pairs.push(
        ...pairAll(await fetchBuoyYear(loc.calibrationBuoyId!, y), await fetchModelYear(loc, y))
      );
    }
    if (pairs.length < 2000) {
      console.log(`\n  ${loc.slug}: only ${pairs.length} pairs — skipped`);
      continue;
    }

    const annual = mean(pairs.map(p => p.buoy)) / mean(pairs.map(p => p.model));
    const quarterly = bucketFactors(pairs, quarterOf, 400);

    const rNone = rmseOf(pairs, () => 1);
    const rRepo = rmseOf(pairs, () => loc.waveHeightCalibration);
    const rAnnual = rmseOf(pairs, () => annual);

    console.log('');
    console.log(`  ${loc.slug}  (${pairs.length} paired hours)`);
    console.log(
      `    shipped ${loc.waveHeightCalibration.toFixed(2)} → proposed ${annual.toFixed(2)}` +
        `   in-sample RMSE ${rRepo.toFixed(3)} → ${rAnnual.toFixed(3)}m (no correction ${rNone.toFixed(3)})`
    );
    if (rRepo > rNone) {
      console.log(`    !! the shipped factor is WORSE than applying no correction at all`);
    }
    const q = [0, 1, 2, 3].map(i => quarterly.table.get(i) ?? annual);
    console.log(`    by quarter: Q1 ${q[0].toFixed(2)}  Q2 ${q[1].toFixed(2)}  Q3 ${q[2].toFixed(2)}  Q4 ${q[3].toFixed(2)}`);
  }
  console.log('');
  console.log('  Applying any of these is a manual edit to locations.ts.');
  console.log('');
}

// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const arg = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i !== -1 ? argv[i + 1] : undefined;
  };

  const years = (arg('years') ?? '2024,2025').split(',').map(Number);
  const only = arg('location');
  const minHs = Number(arg('min-hs') ?? 0);
  const asJson = argv.includes('--json');

  let targets = LOCATIONS.filter(l => l.calibrationBuoyId);
  if (only) {
    targets = targets.filter(l => l.slug === only);
    if (!targets.length) {
      console.error(`No location with slug "${only}" and a calibrationBuoyId`);
      process.exit(1);
    }
  }

  if (!asJson) {
    console.log(`Seasonal bias study — ${years.join(', ')} · ${targets.length} location(s)`);
    console.log(`Monthly mean(buoy Hs) / mean(model Hs)` + (minHs ? `, hours with buoy Hs >= ${minHs}m` : ''));
    console.log(`Downloads cached in .cache/seasonality`);
  }

  const reports: LocationReport[] = [];
  for (const loc of targets) {
    try {
      const buoy: Obs[] = [];
      const model: Obs[] = [];
      for (const y of years) {
        buoy.push(...(await fetchBuoyYear(loc.calibrationBuoyId!, y)));
        model.push(...(await fetchModelYear(loc, y)));
      }
      reports.push(analyse(loc, monthlyRatios(buoy, model, minHs)));
    } catch (err) {
      reports.push({
        slug: loc.slug,
        name: loc.name,
        buoyId: loc.calibrationBuoyId!,
        current: loc.waveHeightCalibration,
        stats: [],
        amplitude: null,
        repeatability: null,
        stableRunMonths: 0,
        annualRatio: null,
        note: err instanceof Error ? err.message : String(err),
      });
    }
    if (!asJson) printLocation(reports[reports.length - 1], years);
  }

  if (asJson) {
    console.log(JSON.stringify({ years, minHs, reports }, null, 2));
    return;
  }
  verdict(reports);

  if (argv.includes('--validate') && years.length >= 2) {
    await validate(targets, years[0], years[years.length - 1]);
  }
  if (argv.includes('--recommend')) {
    await recommend(targets, years);
  }
}

main().catch(err => {
  console.error('Study failed:', err);
  process.exit(1);
});
