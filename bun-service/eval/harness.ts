// Local eval harness for createDetailedSurfPrompt / generateDetailedSurfReport.
// Run with: bun run eval/harness.ts   (from bun-service/, needs ANTHROPIC_API_KEY in env)
//
// Hits the real model (no mocked LLM) so output can be eyeballed for repetition
// and hallucination. Writes a timestamped transcript to eval/output/ and prints
// to stdout. Two kinds of check run on top of the transcript:
//   1. validateReportText (same fact-checker generateDetailedSurfReport runs in
//      production) — banned openers, word-count sanity, wind-label contradiction.
//   2. Cross-location text similarity — the specific repetition bug fixed in 3436774,
//      re-checked on every run so it can't silently regress.
// Exits non-zero on any failure so this can run as a CI gate, not just by hand.

import { generateDetailedSurfReport, validateReportText, type LocationContext } from '../index'

interface MockConditions {
  wave_height_ft: number
  wave_period_sec: number
  swell_direction_deg: number
  wind_speed_kts: number
  wind_direction_deg: number
  tide_state: string
  tide_height_ft: number
  water_temperature_f: number
  weather_description: string
  score: number
}

// Mirrors isOffshoreWind/getWindDescription in src/app/api/surfability/route.ts so the
// harness exercises the same ground-truth wind_direction_description the real prompt
// gets in production (mocked surf data previously omitted it entirely).
const COAST_FACING_DEG: Record<string, number> = {
  'st-augustine': 90,
  'boca-raton': 90,
  'higgins-beach': 135,
  'huntington-beach': 225,
}

function compassOf(degrees: number): string {
  const directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
  return directions[Math.round(degrees / 22.5) % 16]!
}

function windDescriptionOf(windDirection: number, windSpeed: number, coastFacingDeg: number): string {
  const offshoreCenter = (coastFacingDeg + 180) % 360
  let diff = Math.abs(windDirection - offshoreCenter)
  if (diff > 180) diff = 360 - diff
  const offshore = diff <= 90
  const windType = offshore ? 'offshore' : 'onshore'
  const quality = offshore
    ? (windSpeed < 5 ? 'glassy conditions' : windSpeed < 15 ? 'clean offshore conditions' : windSpeed < 25 ? 'strong offshore - may be difficult to paddle out' : 'very strong offshore - challenging conditions')
    : (windSpeed < 5 ? 'light onshore - fairly clean' : windSpeed < 10 ? 'moderate onshore - some chop' : windSpeed < 20 ? 'strong onshore - choppy conditions' : 'very strong onshore - blown out')
  return `${compassOf(windDirection)} ${windType} (${quality})`
}

function mockSurfData(locationSlug: string, locationName: string, c: MockConditions) {
  const coastFacingDeg = COAST_FACING_DEG[locationSlug] ?? 90
  return {
    location: locationName,
    locationSlug,
    score: c.score,
    details: {
      wave_height_ft: c.wave_height_ft,
      wave_period_sec: c.wave_period_sec,
      swell_direction_deg: c.swell_direction_deg,
      wind_speed_kts: c.wind_speed_kts,
      wind_direction_deg: c.wind_direction_deg,
      wind_direction_description: windDescriptionOf(c.wind_direction_deg, c.wind_speed_kts, coastFacingDeg),
      tide_state: c.tide_state,
      tide_height_ft: c.tide_height_ft,
    },
    weather: {
      water_temperature_c: Math.round((c.water_temperature_f - 32) * 5 / 9),
      water_temperature_f: c.water_temperature_f,
      air_temperature_c: 24,
      air_temperature_f: 75,
      weather_description: c.weather_description,
    },
    tides: {
      next_high: { time: '4:12 PM', height: 4.8, timestamp: new Date().toISOString() },
      next_low: { time: '10:03 PM', height: 0.6, timestamp: new Date().toISOString() },
    },
  }
}

// The exact "mediocre, choppy, no punch" conditions called out in the map as
// today's live repro — used unchanged across locations to stress cross-location
// convergence.
const MEDIOCRE: MockConditions = {
  wave_height_ft: 1.8,
  wave_period_sec: 6,
  swell_direction_deg: 80,
  wind_speed_kts: 12,
  wind_direction_deg: 200,
  tide_state: 'Mid Rising',
  tide_height_ft: 2.1,
  water_temperature_f: 78,
  weather_description: 'Partly cloudy',
  score: 42,
}

const GOOD_DAY: MockConditions = {
  wave_height_ft: 4.5,
  wave_period_sec: 11,
  swell_direction_deg: 70,
  wind_speed_kts: 6,
  wind_direction_deg: 280,
  tide_state: 'Low Rising',
  tide_height_ft: 0.8,
  water_temperature_f: 70,
  weather_description: 'Clear sky',
  score: 82,
}

const LIGHTNING: MockConditions = {
  ...MEDIOCRE,
  weather_description: 'Thunderstorm',
}

// Repro for the reported bug: NE wind at St. Augustine (east-facing coast) is
// onshore, but the model previously called it "offshore" when left to derive
// onshore/offshore itself from local-knowledge phrasing.
const NE_WIND_BUG_REPRO: MockConditions = {
  ...MEDIOCRE,
  wind_direction_deg: 45,
}

const CROSS_LOCATION_CONTEXTS: Array<{ slug: string; ctx: LocationContext }> = [
  {
    slug: 'st-augustine',
    ctx: {
      locationName: 'St. Augustine, FL',
      localKnowledge: `East-facing beach break. Works best on NE to E swell, 2–6ft at 8s+. Offshore on W–NW winds. Sandbars shift constantly — Vilano Beach tends to have the most defined peaks. Crescent Beach is more sheltered and mellower, good for beginners. The pier area can focus and hollow out the swell. Mid rising tide is usually the sweet spot. Summer is almost flat; fall through spring is prime season. Water is warm year-round — no wetsuit needed summer through early fall.`,
      voiceDescriptor: `laid-back Florida local who knows every sandbar at St. Augustine. Practical and honest — doesn't oversell bad surf but gets genuinely stoked when the swell shows up`,
      bestSpots: ['Vilano Beach', 'St. Augustine Pier', 'Crescent Beach'],
      lat: 29.9,
      lon: -81.31,
      timezone: 'America/New_York',
    },
  },
  {
    slug: 'boca-raton',
    ctx: {
      locationName: 'Boca Raton, FL',
      localKnowledge: `East-facing stretch of beach break. Very tide-sensitive — low to mid rising is best on most peaks. The Boca Inlet jetties focus swell and create sandbars on the south side, often the best setup in the area. Summer is mostly flat; fall and spring can bring SE swell from tropical systems. Winter NE swells lose energy working down the coast and often arrive soft and disorganised. Seagrass patches near shore can grab fins at low tide. Offshore on W–NW winds. Rip currents common near the inlet — respect the hazard.`,
      voiceDescriptor: `South Florida surfer who keeps expectations realistic but celebrates the spot's potential. Comfortable recommending when to wait for a better swell, but genuinely stoked when conditions deliver`,
      bestSpots: ['Spanish River Park', 'Red Reef Park', 'Boca Inlet South Jetty'],
      lat: 26.35,
      lon: -80.07,
      timezone: 'America/New_York',
    },
  },
  {
    slug: 'higgins-beach',
    ctx: {
      locationName: 'Higgins Beach, ME',
      localKnowledge: `North Atlantic cold-water beach break, facing southeast. Prime season is September through May. NE groundswell from winter nor'easters and Gulf of Maine fetch can deliver hollow, powerful waves. Offshore on NW winds. Tidal range is extreme (10–12ft) — timing the tide is critical; low to mid tide usually produces the best peaks over the sandbars. High tide often floods the beach entirely. Water is cold year-round: 5/4mm suit with hood and gloves in winter (38–50°F), at least a 3/2mm spring through fall (55–65°F). Hurricane season (August–October) brings some of the best long-period groundswells. Fog is common — check visibility before paddling out.`,
      voiceDescriptor: `Maine surfer — stoic, no-nonsense, comfortable in cold water. Respects the ocean's power and calls conditions accurately. Gets quietly stoked when it goes off, matter-of-fact about the cold`,
      bestSpots: ['Higgins Beach', 'Scarborough Beach', 'Pine Point'],
      lat: 43.55,
      lon: -70.36,
      timezone: 'America/New_York',
    },
  },
  {
    slug: 'huntington-beach',
    ctx: {
      locationName: 'Huntington Beach, CA',
      localKnowledge: `Classic SoCal beach break. Consistent SW to W swell year-round — Southern Hemisphere groundswells arrive spring and summer, NW swells dominate fall and winter. The pier area focuses swell and creates excellent sandbars on both sides; pier north tends to produce a longer workable right, pier south can be punchier. Offshore on NE winds (Santa Ana conditions — classic glassy mornings). Onshore sea breeze builds through the afternoon most days, so morning sessions are almost always better. Low to mid tide usually best for most peaks. Water is cool year-round (56–72°F) — wetsuit recommended except peak summer for most surfers.`,
      voiceDescriptor: `classic SoCal surf culture — relaxed, enthusiastic, knows the lineup and its rhythms. Straightforward about when morning glass makes the alarm clock worth it versus when you can sleep in`,
      bestSpots: ['HB Pier (north and south sides)', 'Bolsa Chica', 'Newport Beach Pier'],
      lat: 33.65,
      lon: -118.0,
      timezone: 'America/Los_Angeles',
    },
  },
]

const ST_AUGUSTINE_CTX = CROSS_LOCATION_CONTEXTS[0]!.ctx

// Fixed UTC instants so day/night is deterministic regardless of when the harness runs.
const DAYTIME_NOW = new Date('2026-08-28T18:00:00Z')  // ~2pm EDT / 11am PDT
const NIGHT_NOW = new Date('2026-08-28T06:00:00Z')     // ~2am EDT — before sunrise

const lines: string[] = []
function log(s: string = '') {
  console.log(s)
  lines.push(s)
}

function header(title: string) {
  log()
  log('='.repeat(80))
  log(title)
  log('='.repeat(80))
}

// Same crude bag-of-words overlap check either direction — good enough to catch
// "these two reports are basically the same template with nouns swapped" without
// needing a real similarity model. Some shared surf vocabulary is expected; the
// threshold is set well above that baseline.
const SIMILARITY_THRESHOLD = 0.55

function jaccardSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().match(/[a-z']+/g) ?? [])
  const wordsB = new Set(b.toLowerCase().match(/[a-z']+/g) ?? [])
  const intersection = [...wordsA].filter(w => wordsB.has(w)).length
  const union = new Set([...wordsA, ...wordsB]).size
  return union === 0 ? 0 : intersection / union
}

const failures: string[] = []

async function runOne(label: string, slug: string, locationName: string, ctx: LocationContext, c: MockConditions, now: Date): Promise<string> {
  header(label)
  const surfData = mockSurfData(slug, locationName, c)
  const result = await generateDetailedSurfReport(surfData, ctx, now)
  log(`[backend: ${result.generation_meta.backend}, words: ${result.generation_meta.word_count}]`)
  log()
  log(result.report)

  const issues = validateReportText(result.report.split('\n\n'), surfData.details.wind_direction_description ?? null)
  if (issues.length > 0) {
    log()
    log(`⚠️ VALIDATION FAILED: ${issues.map(i => i.detail).join('; ')}`)
    failures.push(`${label}: ${issues.map(i => i.detail).join('; ')}`)
  }
  if (result.generation_meta.backend === 'bun-fallback') {
    log(`⚠️ Fell through to the deterministic template — every model tier failed or was rejected.`)
    failures.push(`${label}: fell through to deterministic template (all model tiers failed or invalid)`)
  }

  return result.report
}

async function main() {
  header('CROSS-LOCATION: identical mediocre conditions across 4 locations')
  log('(Testing whether output converges on the same template regardless of place.)')
  const crossLocation: Array<{ label: string; text: string }> = []
  for (const { slug, ctx } of CROSS_LOCATION_CONTEXTS) {
    const text = await runOne(`Location: ${ctx.locationName}`, slug, ctx.locationName, ctx, MEDIOCRE, DAYTIME_NOW)
    crossLocation.push({ label: ctx.locationName, text })
  }
  for (let i = 0; i < crossLocation.length; i++) {
    for (let j = i + 1; j < crossLocation.length; j++) {
      const sim = jaccardSimilarity(crossLocation[i]!.text, crossLocation[j]!.text)
      if (sim > SIMILARITY_THRESHOLD) {
        const msg = `${crossLocation[i]!.label} vs ${crossLocation[j]!.label}: ${(sim * 100).toFixed(0)}% word overlap on identical conditions (threshold ${SIMILARITY_THRESHOLD * 100}%)`
        log(`⚠️ REPETITION: ${msg}`)
        failures.push(msg)
      }
    }
  }

  header('CROSS-DAY: same location, same conditions, generated twice')
  log('(Simulating two consecutive days with near-identical conditions.)')
  const day1 = await runOne('St. Augustine — "Day 1"', 'st-augustine', ST_AUGUSTINE_CTX.locationName, ST_AUGUSTINE_CTX, MEDIOCRE, DAYTIME_NOW)
  const day2 = await runOne('St. Augustine — "Day 2" (same inputs)', 'st-augustine', ST_AUGUSTINE_CTX.locationName, ST_AUGUSTINE_CTX, MEDIOCRE, DAYTIME_NOW)
  const daySim = jaccardSimilarity(day1, day2)
  if (daySim > SIMILARITY_THRESHOLD) {
    const msg = `Day 1 vs Day 2, same location and conditions: ${(daySim * 100).toFixed(0)}% word overlap (threshold ${SIMILARITY_THRESHOLD * 100}%)`
    log(`⚠️ REPETITION: ${msg}`)
    failures.push(msg)
  }

  header('EDGE CASES')
  await runOne('Normal daytime, good conditions', 'st-augustine', ST_AUGUSTINE_CTX.locationName, ST_AUGUSTINE_CTX, GOOD_DAY, DAYTIME_NOW)
  await runOne('Night (before sunrise)', 'st-augustine', ST_AUGUSTINE_CTX.locationName, ST_AUGUSTINE_CTX, MEDIOCRE, NIGHT_NOW)
  await runOne('Lightning / thunderstorm override', 'st-augustine', ST_AUGUSTINE_CTX.locationName, ST_AUGUSTINE_CTX, LIGHTNING, DAYTIME_NOW)

  header('BUG REPRO: NE wind at St. Augustine must be called onshore, not offshore')
  log('(St. Augustine faces east — coastFacingDeg 90 — so offshore wind blows from the W/NW, not the NE.)')
  await runOne('St. Augustine — NE wind', 'st-augustine', ST_AUGUSTINE_CTX.locationName, ST_AUGUSTINE_CTX, NE_WIND_BUG_REPRO, DAYTIME_NOW)

  const outPath = `eval/output/${new Date().toISOString().replace(/[:.]/g, '-')}.txt`
  await Bun.write(outPath, lines.join('\n') + '\n')
  console.log(`\nTranscript written to ${outPath}`)

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed:`)
    failures.forEach(f => console.error(`  - ${f}`))
    process.exit(1)
  }

  console.log(`\nAll checks passed (${crossLocation.length + 7} reports generated).`)
}

main()
