import { serve } from "bun"
import { generateObject } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { openai } from '@ai-sdk/openai'
import { z } from 'zod'

const surfReportSchema = z.object({
  conditionsAnalysis: z.string().min(80).describe("Paragraph 1 of the surf report — follow the prompt's angle and structure instructions exactly, do not default to a generic conditions-summary opener"),
  recommendationsAndOutlook: z.string().min(60).describe("Paragraph 2 of the surf report — a single clear recommendation and honest verdict, not a rundown of every spot. Do not restate paragraph 1"),

  recommendations: z.object({
    boardType: z.string().describe("General board type recommendation (longboard, shortboard, funboard) - NO specific sizes"),
    wetsuitThickness: z.string().optional().describe("Wetsuit recommendation"),
    skillLevel: z.enum(['beginner', 'intermediate', 'advanced']).describe("Recommended skill level"),
    bestSpots: z.array(z.string()).min(2).describe("Top 2-3 spot recommendations for this location"),
    timingAdvice: z.string().describe("When to surf — or when to check back if conditions are not currently viable. Must stay within the prompt's Daylight Window (never recommend surfing, or waiting for a tide change, after sunset or before sunrise).")
  })
})

// Deterministic sanity checks run against every model's output before it's trusted —
// mirrors the bounds-checking style in src/app/api/surfability/route.ts. Catches the two
// failure modes prompt instructions alone can't guarantee: the model contradicting a
// ground-truth fact it was told to use verbatim (the exact bug fixed in d590e12), and
// output that's technically schema-valid but too short/long to be the report described
// in the prompt. A tier that fails validation is treated the same as a thrown error —
// the caller moves on to the next model, then to the deterministic template.
export interface ReportValidationIssue {
  code: 'banned_opener' | 'word_count' | 'wind_contradiction'
  detail: string
}

const BANNED_OPENERS = [/^right now,?\s+we'?re looking at/i, /^we'?re looking at/i]

export function validateReportText(paragraphs: string[], windDescription: string | null): ReportValidationIssue[] {
  const issues: ReportValidationIssue[] = []
  const combined = paragraphs.join(' ')

  const firstParagraph = paragraphs[0]?.trim() ?? ''
  if (BANNED_OPENERS.some(re => re.test(firstParagraph))) {
    issues.push({ code: 'banned_opener', detail: 'Opens with the generic "looking at" cliche' })
  }

  paragraphs.forEach((p, i) => {
    const words = p.trim().split(/\s+/).filter(Boolean).length
    if (words < 25 || words > 130) {
      issues.push({ code: 'word_count', detail: `Paragraph ${i + 1} is ${words} words (expected roughly 25-130)` })
    }
  })

  if (windDescription) {
    const groundTruthOffshore = /\boffshore\b/i.test(windDescription) && !/\bonshore\b/i.test(windDescription)
    const groundTruthOnshore = /\bonshore\b/i.test(windDescription) && !/\boffshore\b/i.test(windDescription)
    const mentionsOffshore = /\boffshore\b/i.test(combined)
    const mentionsOnshore = /\bonshore\b/i.test(combined)

    if (groundTruthOffshore && mentionsOnshore && !mentionsOffshore) {
      issues.push({ code: 'wind_contradiction', detail: `Ground truth says offshore ("${windDescription}") but report calls the wind onshore` })
    }
    if (groundTruthOnshore && mentionsOffshore && !mentionsOnshore) {
      issues.push({ code: 'wind_contradiction', detail: `Ground truth says onshore ("${windDescription}") but report calls the wind offshore` })
    }
  }

  return issues
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400'
}

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  })
}

function corsResponse() {
  return new Response(null, { status: 204, headers: corsHeaders })
}

function getLocalTime(timezone: string, now: Date = new Date()): { hour: number; formatted: string; date: string } {
  const local = new Date(now.toLocaleString('en-US', { timeZone: timezone }))
  const hour = local.getHours() + local.getMinutes() / 60
  const formatted = local.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
  const date = local.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  return { hour, formatted, date }
}

// Sunrise/sunset via the standard NOAA solar-position approximation (accurate to
// ~1 minute outside polar latitudes). Solar noon is computed in UTC from the date
// and longitude (a location west of its timezone's standard meridian sees solar
// noon *later* in clock time — e.g. Folly Beach, SC is ~20 min west of the Eastern
// meridian), then sunrise/sunset are offset from it by the day's hour angle. The
// previous version assumed solar noon == 12:00 local clock time, which ignored both
// this longitude offset and DST, understating sunrise by up to ~2 hours in summer.
// Returned as real Date instants (not decimal local hours) so any timezone/DST
// conversion happens once, at display time, via formatClockTime.
function getDaylightWindow(lat: number, lon: number, now: Date = new Date()): { rise: Date; set: Date } {
  const utcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const dayOfYear = Math.round((utcMidnight - Date.UTC(now.getUTCFullYear(), 0, 1)) / 86400000)
  const gamma = 2 * Math.PI / 365 * dayOfYear  // fractional year, radians

  // Equation of time (minutes) — corrects for Earth's elliptical orbit and axial tilt
  const eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma)
    - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma))

  // Solar declination (radians)
  const decl = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma)
    - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma)
    - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma)

  const latRad = lat * Math.PI / 180
  // cos(90.833°) (not cos(90°)) accounts for atmospheric refraction and the sun's
  // apparent radius — the standard "sunrise" definition (top of disk on the horizon).
  const cosHA = Math.cos(90.833 * Math.PI / 180) / (Math.cos(latRad) * Math.cos(decl)) - Math.tan(latRad) * Math.tan(decl)

  if (cosHA > 1) return { rise: new Date(utcMidnight), set: new Date(utcMidnight) }  // polar night — never rises today
  if (cosHA < -1) return { rise: new Date(utcMidnight), set: new Date(utcMidnight + 86400000) }  // midnight sun — never sets today

  const haDeg = Math.acos(cosHA) * 180 / Math.PI  // half-day arc, degrees

  const solarNoonUTC = 720 - 4 * lon - eqTime  // minutes from UTC midnight
  const riseUTC = solarNoonUTC - 4 * haDeg
  const setUTC = solarNoonUTC + 4 * haDeg

  return {
    rise: new Date(utcMidnight + riseUTC * 60000),
    set: new Date(utcMidnight + setUTC * 60000),
  }
}

// Format an instant as a 12-hour clock string in the given timezone (e.g. "7:08 AM")
function formatClockTime(date: Date, timezone: string): string {
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: timezone })
}

type SessionViability =
  | { viable: true }
  | { viable: false; reason: 'night'; riseStr: string; minutesToRise: number; isPreDawn: boolean }
  | { viable: false; reason: 'lightning' }

// Within this many minutes of sunrise, it's "pre-dawn" (sky lightening) rather than "the middle of the night"
const PRE_DAWN_WINDOW_MINUTES = 90

function getSessionViability(now: Date, lat: number, lon: number, timezone: string, weatherDescription: string): SessionViability {
  if (/thunder|lightning|tropical storm|hurricane/i.test(weatherDescription)) {
    return { viable: false, reason: 'lightning' }
  }
  const { rise, set } = getDaylightWindow(lat, lon, now)
  if (now.getTime() < rise.getTime() || now.getTime() >= set.getTime()) {
    const riseStr = formatClockTime(rise, timezone)
    // Before sunrise, minutesToRise is straightforward. After sunset, the next sunrise
    // is tomorrow's — approximate it as today's sunrise time, 24h later.
    const nextRise = now.getTime() >= set.getTime() ? new Date(rise.getTime() + 86400000) : rise
    const minutesToRise = Math.round((nextRise.getTime() - now.getTime()) / 60000)
    return { viable: false, reason: 'night', riseStr, minutesToRise, isPreDawn: minutesToRise <= PRE_DAWN_WINDOW_MINUTES }
  }
  return { viable: true }
}

function getCompassDirection(degrees: number): string {
  const directions = ['North', 'NNE', 'NE', 'ENE', 'East', 'ESE', 'SE', 'SSE',
    'South', 'SSW', 'SW', 'WSW', 'West', 'WNW', 'NW', 'NNW']
  const index = Math.round(degrees / 22.5) % 16
  return directions[index]
}

function getWaveQuality(height: number, period: number): string {
  if (period >= 12) return 'Quality groundswell with good power and long rides.'
  if (period >= 8) return 'Decent swell with moderate power and rideable waves.'
  if (period >= 6) return 'Short period wind swell — waves will be quick and choppy.'
  return 'Very short period — expect weak, mushy waves.'
}

function getTideContext(tideState: string): string {
  if (tideState === 'Low Falling') return 'Already near low tide and still dropping — sandbars exposed, watch for shallow spots.'
  if (tideState === 'Low Rising') return 'Just past low tide and filling in — bars exposed now but water coming up.'
  if (tideState === 'High Rising') return 'Near high tide and still coming in — deep water, waves may be mushier.'
  if (tideState === 'High Falling') return 'Just past high tide and starting to drain — water still full but dropping.'
  if (tideState === 'Mid Rising') return 'Mid rising tide — usually the best window for shape and power.'
  if (tideState === 'Mid Falling') return 'Mid falling tide — still good water on the bars, often decent conditions.'
  if (tideState.includes('Rising')) return 'Tide rising — typically improves wave shape and power.'
  if (tideState.includes('Falling')) return 'Tide falling — can expose sandbars but watch for shallowing.'
  if (tideState.includes('High')) return 'High tide — deeper water but waves may be mushier.'
  if (tideState.includes('Low')) return 'Low tide — sandbars exposed, watch for shallow sections.'
  return 'Mid tide — typically the most consistent window.'
}

function getBoardTypeRecommendation(waveHeight: number): string {
  if (waveHeight >= 4) return 'Shortboard recommended'
  if (waveHeight >= 2.5) return 'Shortboard or funboard'
  return 'Longboard recommended'
}

function getFallbackTimingAdvice(tideState: string, viability: SessionViability): string {
  if (!viability.viable) {
    if (viability.reason === 'lightning') return 'Wait for the storm to clear completely before considering paddling out'
    if (viability.isPreDawn) return `Check back once it's light (~${viability.riseStr}) for an accurate read on conditions`
    return 'Check back tomorrow for an accurate read on conditions'
  }
  if (tideState.includes('Rising')) return 'Session now — rising tide tends to clean up the waves'
  if (tideState.includes('Falling')) return 'Go sooner rather than later — falling tide can get shallow over the sandbars'
  if (tideState.includes('Low')) return 'Wait for the tide to come up a bit for better shape'
  return 'Mid to outgoing tide usually favours the local breaks — check tide charts for timing'
}

export interface LocationContext {
  locationName: string;
  localKnowledge: string;
  voiceDescriptor: string;
  bestSpots: string[];
  lat: number;
  lon: number;
  timezone: string;
}

// Rotated per call (not per data) so two reports built from identical conditions —
// same spot two days running, or different spots in the same batch — don't land on
// the same lead sentence just because the underlying data is the same.
const OPENING_ANGLES = [
  'Lead with the verdict — worth paddling out or not — then explain why. Save the conditions breakdown for after.',
  'Lead with what today demands from a surfer (board choice, positioning, patience) rather than a conditions recap.',
  'Lead with the crowd and vibe you would find in the water right now, then work back to the conditions driving it.',
  'Lead by naming the specific spot that matters most today and what is actually happening there.',
  'Lead with a direct, second-person line about what paddling out would feel like in the first few minutes.',
  'Lead with how today compares to what this spot normally does, using your local knowledge — not a plain conditions list.',
  'Lead with whichever single factor (wind, period, or tide) is doing the most work today and build outward from it.',
  'Lead with a blunt, one-line gut check on the swell before any analysis.',
]

function pickOpeningAngle(): string {
  return OPENING_ANGLES[Math.floor(Math.random() * OPENING_ANGLES.length)]!
}

export function createDetailedSurfPrompt(surfData: any, ctx: LocationContext, now: Date = new Date()): string {
  const windMph = Math.round(surfData.details.wind_speed_kts * 1.15078)
  const swellDirection = getCompassDirection(surfData.details.swell_direction_deg)
  const windDirection = getCompassDirection(surfData.details.wind_direction_deg)
  const windOnshoreOffshore = surfData.details.wind_direction_description ?? null
  const { formatted: localTime, date: localDate } = getLocalTime(ctx.timezone, now)
  const viability = getSessionViability(now, ctx.lat, ctx.lon, ctx.timezone, surfData.weather.weather_description)

  const viabilityNote = viability.viable
    ? 'Surfable now'
    : viability.reason === 'lightning'
      ? 'NOT SURFABLE — thunderstorm/lightning activity'
      : `NOT SURFABLE NOW — ${viability.isPreDawn ? 'pre-dawn, still dark' : 'nighttime'} (light returns ~${viability.riseStr})`

  const viabilityInstructions = viability.viable ? '' : viability.reason === 'lightning'
    ? `
IMPORTANT — SAFETY OVERRIDE:
There is active lightning or thunderstorm activity. This overrides everything else.
- Lead paragraph 1 with a clear, direct safety warning: the ocean is UNSAFE during electrical activity. No hedging.
- Paragraph 2 should describe what conditions will look like once the storm clears, and when to check back.
- timingAdvice must tell the user to wait until the storm passes before considering the water.`
    : viability.isPreDawn
    ? `
IMPORTANT — TIMING OVERRIDE:
It is currently pre-dawn (still dark, but sunrise is only ~${viability.minutesToRise} minutes away at ${viability.riseStr}). Nobody's surfing yet, but this is NOT "the middle of the night" — do not use that phrase or imply it's late-night. Say it's early morning / not light enough yet / sunrise is close.
- Do NOT attempt to describe or predict tomorrow's conditions — you have no forecast data, only a current snapshot that may not reflect what daylight will bring.
- Paragraph 1: acknowledge it's still too dark to surf but sunrise is coming soon. If the user seems curious about conditions, you may briefly describe the CURRENT snapshot (not as a prediction).
- Paragraph 2: keep it short. Tell them conditions can be properly assessed once it's light. No guessing, no false optimism.
- timingAdvice: mention checking back once it's light, referencing the approximate sunrise time.`
    : `
IMPORTANT — TIMING OVERRIDE:
It is currently nighttime. Nobody surfs in the dark.
- Do NOT attempt to describe or predict tomorrow's conditions — you have no forecast data, only a current snapshot that may not reflect what morning will bring.
- Paragraph 1: acknowledge it's night and surfing isn't happening, in one line — don't pad it with a tautology like "daylight won't return until dawn" or "it'll stay dark until sunrise" (dawn/sunrise being when light returns is definitionally true and says nothing). If the user seems curious about conditions, you may briefly describe the CURRENT snapshot (not as a prediction).
- Paragraph 2: keep it short. Tell them to come back tomorrow when conditions can be properly assessed. No guessing, no false optimism.
- timingAdvice: "Check back tomorrow" — nothing more specific.`

  const daylight = getDaylightWindow(ctx.lat, ctx.lon, now)
  const sunriseStr = formatClockTime(daylight.rise, ctx.timezone)
  const sunsetStr = formatClockTime(daylight.set, ctx.timezone)

  const nextTideStr = (() => {
    const nh = surfData.tides?.next_high
    const nl = surfData.tides?.next_low
    if (nh && nl) {
      const nextIsHigh = new Date(nh.timestamp) < new Date(nl.timestamp)
      return nextIsHigh
        ? `next high at ${nh.time} (${nh.height}ft)`
        : `next low at ${nl.time} (${nl.height}ft)`
    }
    if (nh) return `next high at ${nh.time} (${nh.height}ft)`
    if (nl) return `next low at ${nl.time} (${nl.height}ft)`
    return null
  })()

  return `You are a ${ctx.voiceDescriptor}. Write a 2-paragraph surf report for ${ctx.locationName}. Be honest — don't oversell poor surf.

LOCAL KNOWLEDGE FOR THIS SPOT:
${ctx.localKnowledge}

RECOMMENDED SPOTS:
${ctx.bestSpots.join(', ')}

CURRENT CONDITIONS (raw data — reference in your own words, see NOTE below on the two hint lines):
• Wave Height: ${surfData.details.wave_height_ft} feet
• Wave Period: ${surfData.details.wave_period_sec} seconds
• Swell Direction: ${surfData.details.swell_direction_deg}° (${swellDirection})
• Wind: ${windMph} mph ${windDirection}${windOnshoreOffshore ? `
• Wind Effect (ground truth, already calculated from this coast's orientation — use this label as-is, do not recompute or contradict it from local knowledge or the compass direction): ${windOnshoreOffshore}` : ''}
• Tide: ${surfData.details.tide_state} (${surfData.details.tide_height_ft}ft${nextTideStr ? ` — ${nextTideStr}` : ''})
• Water Temp: ${surfData.weather.water_temperature_f}°F
• Weather: ${surfData.weather.weather_description}
• Overall Score: ${surfData.score}/100
• Wave Quality (hint, not a sentence to reuse): ${getWaveQuality(surfData.details.wave_height_ft, surfData.details.wave_period_sec)}
• Tide Context (hint, not a sentence to reuse): ${getTideContext(surfData.details.tide_state)}
• Local Date: ${localDate}
• Local Time: ${localTime}
• Daylight Window: sunrise ~${sunriseStr}, sunset ~${sunsetStr} — nobody surfs before sunrise or after sunset
• Session Status: ${viabilityNote}
${viabilityInstructions}
NOTE: Do not restate raw figures verbatim in prose (wave height, period, temperature, wind speed, etc.) — interpret and contextualise what they mean for the surf experience instead.
NOTE: The "Wave Quality" and "Tide Context" lines above are internal hints describing what the numbers mean, not sentences to paraphrase or echo. Reach your own conclusion about the surf in your own words — do not restate their wording or sentence shape.
NOTE: Do not state any date, day-of-week, season, or "time of year" framing, and do not claim conditions are typical/atypical for the season — unless it is directly supported by the data given above. If you reference the day or date, it must match Local Date exactly.

AVOID GENERIC OPENERS: Never start with "Right now we're looking at", "We're looking at", "Right now, we're looking at", or any close variant of that phrasing — it's the default surf-report cliché and every report should not sound the same.
AVOID STOCK PHRASES: Don't reach for worn-out crutches like "bathwater warm", "honestly", "real talk", "quick and choppy", "worth the paddle out", "get your feet wet", "is your best bet" — find your own words each time, specific to today's conditions.
THIS CALL'S ANGLE: ${pickOpeningAngle()}

WRITE 2 SHORT PARAGRAPHS, totaling roughly 100-160 words (not padded to hit that number — shorter is fine if the conditions don't need more words to describe; vary sentence count and length naturally). This report renders in large type on a phone screen, so every sentence has to earn its place — cut anything that only restates or decorates a point you've already made.

**Paragraph 1 - Conditions Analysis** (~50-90 words):
Open using THIS CALL'S ANGLE above. Synthesise what the wave height, period, swell direction, and wind actually mean for surf quality at this specific spot — the character of the waves, whether they'll have power or be mushy. For the onshore/offshore effect, use the Wind Effect ground-truth label given above verbatim in meaning (do not re-derive it from the raw wind compass direction or from local-knowledge phrases like "offshore on X winds" — those describe a different location's or spot's typical pattern and can mislead you on today's actual angle). Use your local knowledge of this break to make it specific and accurate otherwise. Mention the tide and water temp only if they actually change what the surfer should expect today — skip them if they're unremarkable.

**Paragraph 2 - Verdict & Move** (~50-80 words):
Move forward, don't repeat — the reader already has paragraph 1's conditions read, so don't re-explain it in different words. Give ONE clear recommendation: name the single best spot for today's conditions and why, in a phrase — not a ranked rundown of every spot on the list. Mention the crowd or vibe only if it changes the call. Close with the honest bottom line — worth paddling out or not — and a timing window if one actually matters.
When you name a "best window" or point to a future tide change (next high/low), only ever recommend a time inside the Daylight Window above — never suggest waiting for a tide, or paddling out, after sunset or before sunrise. If the next favorable tide falls outside daylight hours, say plainly that today's window is what's in front of you right now (or already closed for the day) rather than pointing the reader at an after-dark tide change as if it were a real option.

TONE: ${ctx.voiceDescriptor}. Use some surf slang but keep it readable.`
}

// Shared across every tier so the three report shapes below (primary model, secondary
// model, deterministic template) can't drift from each other field-by-field.
function reportConditions(surfData: any) {
  return {
    wave_height_ft: surfData.details.wave_height_ft,
    wave_period_sec: surfData.details.wave_period_sec,
    wind_speed_kts: surfData.details.wind_speed_kts,
    wind_direction_deg: surfData.details.wind_direction_deg,
    tide_state: surfData.details.tide_state,
    weather_description: surfData.weather.weather_description,
    surfability_score: surfData.score,
    swell_direction_deg: surfData.details.swell_direction_deg,
    swell_direction_compass: surfData.details.swell_direction_compass,
    swell_direction_text: surfData.details.swell_direction_text,
    swell_direction_description: surfData.details.swell_direction_description,
    wind_direction_compass: surfData.details.wind_direction_compass,
    wind_direction_text: surfData.details.wind_direction_text,
    wind_direction_description: surfData.details.wind_direction_description,
    tide_height_ft: surfData.details.tide_height_ft,
    water_temperature_c: surfData.weather.water_temperature_c,
    water_temperature_f: surfData.weather.water_temperature_f,
    air_temperature_c: surfData.weather.air_temperature_c,
    air_temperature_f: surfData.weather.air_temperature_f
  }
}

// Model tiers, tried in order. Anthropic is primary; OpenAI is a same-shape secondary
// so a single provider outage doesn't drop straight to the hardcoded template. Each
// tier's output is schema-validated by generateObject AND fact-checked by
// validateReportText — either failure moves to the next tier.
const MODEL_TIERS = [
  { backend: 'anthropic-primary', modelId: 'claude-haiku-4-5-20251001', model: anthropic('claude-haiku-4-5-20251001') },
  { backend: 'openai-secondary', modelId: 'gpt-4o-mini', model: openai('gpt-4o-mini') },
] as const

export async function generateDetailedSurfReport(surfData: any, ctx: LocationContext, now: Date = new Date()) {
  console.log(`🤖 Generating surf report for ${ctx.locationName}...`)

  const prompt = createDetailedSurfPrompt(surfData, ctx, now)
  const windDescription: string | null = surfData.details.wind_direction_description ?? null

  let lastIssues: ReportValidationIssue[] = []
  let lastError: unknown = null

  for (const tier of MODEL_TIERS) {
    try {
      const { object: aiResponse } = await generateObject({
        model: tier.model,
        schema: surfReportSchema,
        prompt,
        temperature: 0.6,
        maxTokens: 800,
      })

      const issues = validateReportText(
        [aiResponse.conditionsAnalysis, aiResponse.recommendationsAndOutlook],
        windDescription
      )

      if (issues.length > 0) {
        console.warn(`⚠️ ${tier.backend} output failed validation for ${ctx.locationName}: ${issues.map(i => i.detail).join('; ')}`)
        lastIssues = issues
        continue
      }

      const fullReport = [aiResponse.conditionsAnalysis, aiResponse.recommendationsAndOutlook].join('\n\n')
      console.log(`✅ ${tier.backend} generated report for ${ctx.locationName} (${fullReport.split(' ').length} words)`)

      return {
        id: `surf_${ctx.locationName.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        timestamp: new Date().toISOString(),
        location: surfData.locationSlug ?? surfData.location,
        report: fullReport,
        conditions: reportConditions(surfData),
        recommendations: {
          board_type: aiResponse.recommendations.boardType,
          wetsuit_thickness: aiResponse.recommendations.wetsuitThickness,
          skill_level: aiResponse.recommendations.skillLevel,
          best_spots: aiResponse.recommendations.bestSpots,
          timing_advice: aiResponse.recommendations.timingAdvice
        },
        cached_until: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
        generation_meta: {
          backend: tier.backend,
          model: tier.modelId,
          report_length: fullReport.length,
          word_count: fullReport.split(' ').length,
          paragraphs: 2,
          prompt_version: '3.2',
          validation_issues: [] as string[],
        }
      }

    } catch (error) {
      console.error(`❌ ${tier.backend} generation failed for ${ctx.locationName}:`, error)
      lastError = error
    }
  }

  // Every model tier either errored or failed fact-checking — fall back to the
  // deterministic template. Still built from the same live, validated surf data.
  console.error(
    `❌ All AI tiers exhausted for ${ctx.locationName}, using deterministic fallback.` +
    (lastIssues.length ? ` Last validation issues: ${lastIssues.map(i => i.detail).join('; ')}.` : '') +
    (lastError ? ` Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}` : '')
  )

  const windMph = Math.round(surfData.details.wind_speed_kts * 1.15078)
  const viability = getSessionViability(now, ctx.lat, ctx.lon, ctx.timezone, surfData.weather.weather_description)
  const fallbackReport = createEnhancedFallbackReport(surfData, windMph, ctx, viability)

  return {
    id: `surf_fallback_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    timestamp: new Date().toISOString(),
    location: surfData.locationSlug ?? surfData.location,
    report: fallbackReport,
    conditions: reportConditions(surfData),
    recommendations: {
      board_type: getBoardTypeRecommendation(surfData.details.wave_height_ft),
      wetsuit_thickness: surfData.weather.water_temperature_f < 65 ? '3/2mm'
        : surfData.weather.water_temperature_f < 72 ? 'Spring suit'
        : undefined,
      skill_level: surfData.score >= 65 ? 'intermediate' : 'beginner',
      best_spots: ctx.bestSpots,
      timing_advice: getFallbackTimingAdvice(surfData.details.tide_state, viability)
    },
    cached_until: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
    generation_meta: {
      backend: 'bun-fallback',
      model: 'hardcoded',
      report_length: fallbackReport.length,
      word_count: fallbackReport.split(' ').length,
      paragraphs: 2,
      prompt_version: '3.2',
      validation_issues: lastIssues.map(i => i.detail),
    }
  }
}

function createEnhancedFallbackReport(surfData: any, windMph: number, ctx: LocationContext, viability: SessionViability): string {
  if (!viability.viable) {
    if (viability.reason === 'lightning') {
      const p1 = `Lightning and thunderstorm activity means the ocean is unsafe right now — stay out of the water. No surf session is worth the risk during an electrical storm.`
      const p2 = `Keep an eye on the radar and check back once the storm fully clears. The ${surfData.details.wave_height_ft}ft swell at ${surfData.details.wave_period_sec}s should still be around once it's safe to paddle out.`
      return `${p1}\n\n${p2}`
    }
    const waveDesc = surfData.details.wave_height_ft >= 4 ? 'solid' : surfData.details.wave_height_ft >= 2 ? 'fun-sized' : 'small'
    const p1 = viability.isPreDawn
      ? `Still too dark to surf at ${ctx.locationName} — sunrise is around ${viability.riseStr}. If you're still curious, the current snapshot shows ${waveDesc} ${surfData.details.wave_height_ft}ft waves at ${surfData.details.wave_period_sec}s from the ${surfData.details.swell_direction_compass || 'east'} with ${windMph} mph ${surfData.details.wind_direction_compass || 'variable'} winds, but that's right now — not a forecast for once it's light.`
      : `It's dark out — no surfing tonight at ${ctx.locationName}. If you're still curious, the current snapshot shows ${waveDesc} ${surfData.details.wave_height_ft}ft waves at ${surfData.details.wave_period_sec}s from the ${surfData.details.swell_direction_compass || 'east'} with ${windMph} mph ${surfData.details.wind_direction_compass || 'variable'} winds, but that's right now — not a forecast for tomorrow.`
    const p2 = viability.isPreDawn
      ? `Check back once the sun's up (~${viability.riseStr}) for an accurate read on conditions. No guessing in the dark.`
      : `Check back tomorrow for an accurate read on conditions. Night surf isn't worth it, and neither is guessing.`
    return `${p1}\n\n${p2}`
  }

  const condition = surfData.score >= 70 ? 'good' : surfData.score >= 50 ? 'fair' : 'poor'
  const waveDesc = surfData.details.wave_height_ft >= 4 ? 'solid' : surfData.details.wave_height_ft >= 2 ? 'fun-sized' : 'small'
  const swellCompass = surfData.details.swell_direction_compass || 'unknown direction'
  const windCompass = surfData.details.wind_direction_compass || 'variable'
  const primarySpot = ctx.bestSpots[0] || ctx.locationName

  const paragraph1 = `${ctx.locationName} surf check shows ${waveDesc} ${surfData.details.wave_height_ft}ft waves at ${surfData.details.wave_period_sec} seconds coming from the ${swellCompass}, delivering ${surfData.details.wave_period_sec >= 10 ? 'decent power with some nice long rides' : 'quicker, choppier waves with less power'}. Wind is ${windMph} mph from the ${windCompass} which ${windMph < 10 ? 'is light enough for clean, glassy conditions' : 'is creating some texture and bump on the water'}. Tide is ${surfData.details.tide_state.toLowerCase()} at ${surfData.details.tide_height_ft}ft and water temp is ${surfData.weather.water_temperature_f}°F.`

  const tideNote = surfData.details.tide_state.includes('Rising')
    ? 'Tide is rising which often cleans things up — worth getting out sooner'
    : surfData.details.tide_state.includes('Falling')
    ? 'Falling tide can expose more sandbar sections, but watch for shallow spots'
    : surfData.details.tide_state.includes('Low')
    ? 'Low tide means shallower bars — check for exposed sections before paddling out'
    : 'High tide will keep things deeper and a bit mushier'

  const verdict = condition === 'good' ? 'Definitely worth the paddle out today!'
    : condition === 'fair' ? 'Surfable if you need your wave fix.'
    : 'Might be better for a beach walk, but conditions can change quickly.'

  return `${paragraph1}\n\n${primarySpot} is worth checking. ${tideNote}. ${verdict}`
}

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const method = req.method

  console.log(`${method} ${url.pathname}`)

  if (method === 'OPTIONS') return corsResponse()

  if (method === 'GET' && url.pathname === '/health') {
    return jsonResponse({
      status: 'ok',
      service: 'Swells',
      timestamp: new Date().toISOString(),
      runtime: 'Bun',
      version: Bun.version,
      features: ['multi-location', 'detailed-reports', 'session-viability', 'local-knowledge']
    })
  }

  if (method === 'POST' && url.pathname === '/generate-surf-report') {
    try {
      const body = await req.json()
      const { surfData, apiKey, localKnowledge, voiceDescriptor, bestSpots, locationName, lat, lon, timezone } = body

      if (apiKey !== process.env.API_SECRET) {
        return jsonResponse({ error: 'Unauthorized' }, 401)
      }
      if (!surfData) {
        return jsonResponse({ error: 'Missing surf data' }, 400)
      }

      const ctx: LocationContext = {
        locationName: locationName ?? surfData.location ?? 'Unknown',
        localKnowledge: localKnowledge ?? '',
        voiceDescriptor: voiceDescriptor ?? 'experienced surf forecaster',
        bestSpots: bestSpots ?? [],
        lat: lat ?? 30,
        lon: lon ?? -81,
        timezone: timezone ?? 'America/New_York',
      }

      const report = await generateDetailedSurfReport(surfData, ctx)

      return jsonResponse({
        success: true,
        report,
        performance: { backend: 'bun-multi-location', runtime: 'bun' }
      })

    } catch (error) {
      console.error('❌ Generate endpoint failed:', error)
      return jsonResponse({
        success: false,
        error: 'Generation failed',
        details: error instanceof Error ? error.message : String(error)
      }, 500)
    }
  }

  if (method === 'POST' && url.pathname === '/cron/generate-fresh-report') {
    try {
      const body = await req.json()
      const {
        cronSecret, vercelUrl,
        locationSlug, locationName, localKnowledge, voiceDescriptor, bestSpots, lat, lon, timezone
      } = body

      if (cronSecret !== process.env.CRON_SECRET) {
        return jsonResponse({ error: 'Unauthorized' }, 401)
      }

      const slug = locationSlug ?? 'st-augustine'
      const ctx: LocationContext = {
        locationName: locationName ?? slug,
        localKnowledge: localKnowledge ?? '',
        voiceDescriptor: voiceDescriptor ?? 'experienced surf forecaster',
        bestSpots: bestSpots ?? [],
        lat: lat ?? 30,
        lon: lon ?? -81,
        timezone: timezone ?? 'America/New_York',
      }

      console.log(`🌊 Fetching surf data for ${ctx.locationName}...`)
      const surfDataResponse = await fetch(`${vercelUrl}/api/surfability?location=${slug}`)

      if (!surfDataResponse.ok) {
        throw new Error(`Surf data failed: ${surfDataResponse.status}`)
      }

      const surfData = await surfDataResponse.json()
      console.log(`📊 Got surf data for ${ctx.locationName}: ${surfData.details?.wave_height_ft}ft`)

      const report = await generateDetailedSurfReport(surfData, ctx)
      console.log(`✅ Report generated: ${report.id} (${report.generation_meta.word_count} words)`)

      try {
        const saveResponse = await fetch(`${vercelUrl}/api/admin/save-report`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${cronSecret}`
          },
          body: JSON.stringify({ report })
        })

        if (!saveResponse.ok) {
          console.warn(`⚠️ Save failed for ${ctx.locationName}:`, saveResponse.status)
        } else {
          console.log(`✅ Saved report for ${ctx.locationName}`)
        }
      } catch (saveError) {
        console.warn(`⚠️ Save error for ${ctx.locationName}:`, saveError)
      }

      return jsonResponse({
        success: true,
        timestamp: new Date().toISOString(),
        backend: 'bun-multi-location',
        actions: {
          surf_data_fetched: true,
          ai_report_generated: true,
          new_report_id: report.id,
          location: ctx.locationName,
          report_quality: {
            word_count: report.generation_meta.word_count,
            paragraphs: report.generation_meta.paragraphs,
            length: report.generation_meta.report_length,
          }
        }
      })

    } catch (error) {
      console.log('❌ Cron endpoint failed:', error)
      return jsonResponse({
        success: false,
        error: 'Cron generation failed',
        details: error instanceof Error ? error.message : String(error)
      }, 500)
    }
  }

  return jsonResponse({ error: 'Not found' }, 404)
}

if (import.meta.main) {
  const port = parseInt(process.env.PORT || '3000')

  console.log(`🚀 Swells (multi-location) starting on port ${port}`)
  console.log(`⚡ Runtime: Bun ${Bun.version}`)

  serve({
    port,
    async fetch(req) {
      try {
        return await handleRequest(req)
      } catch (error) {
        console.error('🚨 Request failed:', error)
        return jsonResponse({
          error: 'Internal error',
          details: error instanceof Error ? error.message : String(error)
        }, 500)
      }
    }
  })

  console.log(`✅ Bun server running at http://localhost:${port}`)
}
