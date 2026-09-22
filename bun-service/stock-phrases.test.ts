import { describe, expect, it } from 'bun:test'
import { findStockPhrases, validateReportText, STOCK_PHRASES, GATED_STOCK_PHRASES, createDetailedSurfPrompt, type LocationContext } from './index'

// validateReportText also enforces a 25-130 word range per paragraph, so every fixture
// here is padded to a realistic length — otherwise a word_count issue masks what's
// actually under test.
const FILLER = 'The swell is pushing in at a steady clip and the sandbars are holding their shape well enough to give you something to work with on most sets today out there now.'

const para = (s: string) => `${s} ${FILLER}`

const codesFor = (text: string) =>
  validateReportText([para(text)], null).map(i => i.code)

describe('findStockPhrases', () => {
  it('finds gated and monitored phrases alike', () => {
    expect(findStockPhrases('Honestly, the water is bathwater warm today.').map(s => s.toLowerCase()))
      .toEqual(expect.arrayContaining(['honestly', 'bathwater warm']))
  })

  it('is case-insensitive and finds every use, not just the first', () => {
    expect(findStockPhrases('Honestly. honestly. HONESTLY.')).toHaveLength(3)
  })

  it('respects word boundaries', () => {
    expect(findStockPhrases('dishonestly')).toHaveLength(0)
  })

  it('returns nothing for clean prose', () => {
    expect(findStockPhrases(FILLER)).toHaveLength(0)
  })
})

describe('validateReportText — stock_phrase gating', () => {
  it('rejects a distinctive stock phrase', () => {
    expect(codesFor('Waves are quick and choppy out there.')).toContain('stock_phrase')
  })

  it.each([
    'bathwater warm',
    'real talk',
    'quick and choppy',
    'worth the paddle out',
    'get your feet wet',
    'is your best bet',
  ])('rejects %p', phrase => {
    expect(codesFor(`Today it ${phrase} for sure.`)).toContain('stock_phrase')
  })

  // The deliberate carve-out: "honestly" is an ordinary adverb with ~45% incidence in
  // eval runs. Gating on it would bounce nearly half of all reports into the retry
  // ladder, so it stays in the prompt and the harness metric but must never reject.
  it('does NOT reject "honestly", which is monitored only', () => {
    expect(codesFor('Honestly, the wind is doing it no favors.')).not.toContain('stock_phrase')
  })

  it('still surfaces "honestly" to the harness metric', () => {
    expect(findStockPhrases('Honestly, the wind is doing it no favors.')).toHaveLength(1)
  })

  it('passes clean prose', () => {
    expect(codesFor('Conditions are soft but rideable.')).not.toContain('stock_phrase')
  })

  // Regression guard for a real trap: getWaveQuality's 6-11s branch used to return
  // "...waves will be quick and choppy", which the prompt passes in as a Wave Quality
  // hint. The model echoed it and was then rejected for it — "quick and choppy" was the
  // single most-rejected phrase across eval runs as a direct result. Nothing the prompt
  // hands the model may be a phrase we reject it for using.
  it('never feeds a gated stock phrase into the prompt', () => {
    const ctx: LocationContext = {
      locationName: 'Testville, FL',
      localKnowledge: 'East-facing beach break. Offshore on W winds.',
      voiceDescriptor: 'test voice',
      spotFeatures: [{ archetype: 'sandbar peak', examples: ['Test Bar'], shinesWhen: 'most conditions' }],
      lat: 29.9,
      lon: -81.31,
      timezone: 'America/New_York',
    }
    const surfData = (wave_period_sec: number, tide_state: string) => ({
      score: 50,
      details: {
        wave_height_ft: 2.5, wave_period_sec, swell_direction_deg: 90,
        swell_direction_compass: 'E', wind_speed_kts: 10, wind_direction_deg: 270,
        wind_direction_description: 'W offshore (clean offshore conditions)',
        tide_state, tide_height_ft: 2.1,
      },
      weather: { water_temperature_f: 75, weather_description: 'Clear sky' },
      tides: {},
    })

    // Sweep the branches of every hint helper the prompt embeds.
    for (const period of [4, 6, 9, 13]) {
      for (const tide of ['Low Falling', 'Low Rising', 'Mid Rising', 'Mid Falling', 'High Rising', 'High Falling']) {
        const prompt = createDetailedSurfPrompt(surfData(period, tide), ctx)
        // The AVOID STOCK PHRASES line legitimately lists them; everything else must not.
        const body = prompt.split('\n').filter(l => !l.startsWith('AVOID STOCK PHRASES:')).join('\n').toLowerCase()
        const found = GATED_STOCK_PHRASES.filter(p => body.includes(p))
        expect({ period, tide, found }).toEqual({ period, tide, found: [] })
      }
    }
  })

  it('keeps the prompt list and the detector list in step', () => {
    // The prompt's AVOID STOCK PHRASES line is generated from STOCK_PHRASES, so every
    // phrase the model is told to avoid must be one the harness can actually detect.
    for (const phrase of STOCK_PHRASES) {
      expect(findStockPhrases(`something ${phrase} something`)).toHaveLength(1)
    }
  })
})
