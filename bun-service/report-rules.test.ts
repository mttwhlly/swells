import { describe, expect, it } from 'bun:test'
import { findWrongDayReference, getSessionViability, validateReportText, type TierError, type TierRejection } from './index'
import { tierWinRate } from './eval/win-rate'

// validateReportText also enforces a 25-130 word range per paragraph, so every fixture
// is padded to a realistic length — otherwise a word_count issue masks what's under test.
const FILLER = 'The swell is pushing in at a steady clip and the sandbars are holding their shape well enough to give you something to work with on most sets today out there now.'
const para = (s: string) => `${s} ${FILLER}`
const codesFor = (text: string, localDate: string | null = null) =>
  validateReportText([para(text)], null, localDate).map(i => i.code)

// Each of these three rules lived in the prompt as prose and was audited against a pooled
// corpus of eval transcripts. The prose alone left a residue in every case; these are the
// gates that remove it. The percentages quoted are the measured residues.

describe('size_in_feet — the surf size must not be quoted in feet', () => {
  // Every upstream source reports significant wave height measured offshore, which is
  // smaller than the face a surfer rides. Measured 15% of reports before the prompt
  // stopped passing a height in feet, 0% of 278 after — this gate is the regression guard.
  it.each([
    'At 1.8 feet with that wind, it is mushy and gutless.',
    'but two-foot waves with that kind of short fetch go nowhere',
    'these little 1.8-foot waves have no juice',
    'two feet of short-interval chop will not excite anyone',
    '1.8 feet just does not have the juice to build anything',
    'we have got barely 2 feet of east swell running',
    'Expect 3 to 4 foot faces on the bigger sets.',
    'chest high, maybe a 5 footer on the sets',
    'solid 6ft waves out the back',
  ])('rejects %p', text => {
    expect(codesFor(text)).toContain('size_in_feet')
  })

  // Tide height, depth and distance are all legitimately measured in feet — the prompt
  // itself supplies the tide that way — so the unit alone can't decide.
  it.each([
    'The next high at 4:12 PM tops out at 4.8ft, so the bars will be covered.',
    'Tide is mid rising at 2.1ft and still filling.',
    'You will be standing in a few feet of water over the inner bar.',
    'The sandbar sits about 30 feet off the beach, past the shorebreak.',
    'The tidal range here is 10 feet, so timing matters more than anywhere else.',
    'Low tide leaves barely 2 feet of water over the bar.',
  ])('allows %p', text => {
    expect(codesFor(text)).not.toContain('size_in_feet')
  })

  it.each([
    'Waves are knee to waist high with the odd chest-high set.',
    'Overhead and clean, the best it has been all week.',
    'Shoulder to head high on the sets, dropping off between them.',
  ])('allows the body scale it is steering toward: %p', text => {
    expect(codesFor(text)).not.toContain('size_in_feet')
  })
})

describe('restated_orientation — the spot\'s cardinal orientation is not news', () => {
  // LOCAL KNOWLEDGE opens with it so the model can reason about swell and wind angles.
  // The prompt note took restatement from 18% of reports to 3.4%; this removes the rest.
  it.each([
    'The east-facing break is getting fed by an east swell today.',
    'The ENE angle is dialing in perfectly for our east-facing beach.',
    'This south-facing stretch picks up the swell well enough.',
    'The beach faces east, so that swell angle is about right.',
  ])('rejects %p', text => {
    expect(codesFor(text)).toContain('restated_orientation')
  })

  it.each([
    'The swell is coming in from the east at a workable angle.',
    'That east swell lines up with the outer bar nicely today.',
    'Wind is out of the west and holding the faces clean.',
  ])('allows talking about direction without restating orientation: %p', text => {
    expect(codesFor(text)).not.toContain('restated_orientation')
  })
})

describe('wrong_date — the named weekday must match Local Date', () => {
  const FRIDAY = 'Friday, August 28, 2026'

  it('rejects a weekday that is not today', () => {
    expect(codesFor('This is one of those Tuesday afternoons where you go anyway.', FRIDAY))
      .toContain('wrong_date')
  })

  it('allows the weekday that matches Local Date', () => {
    expect(codesFor('This is one of those Friday afternoons where you go anyway.', FRIDAY))
      .not.toContain('wrong_date')
  })

  it('is inert when no Local Date is supplied', () => {
    expect(codesFor('This is one of those Tuesday afternoons where you go anyway.'))
      .not.toContain('wrong_date')
  })

  // Month names are deliberately not gated: a forward-looking seasonal reference is not
  // a claim about what day it is, and both month mentions in the audited corpus were that.
  it('allows a forward-looking seasonal reference by month', () => {
    expect(codesFor('Come back when the nor\'easters start rolling in September.', FRIDAY))
      .not.toContain('wrong_date')
  })
})

// St. Augustine on Oct 15, 2026 — sunrise ~7:25 AM EDT. The 5:07 AM cron run is the one
// that shipped "no surfing tonight ... check back tomorrow".
const ST_AUG = { lat: 29.8946, lon: -81.3145, tz: 'America/New_York' }
const viabilityAt = (iso: string) => getSessionViability(new Date(iso), ST_AUG.lat, ST_AUG.lon, ST_AUG.tz, 'Clear sky')
const EARLY_MORNING = viabilityAt('2026-10-15T09:07:00Z') // 5:07 AM EDT
const LATE_EVENING = viabilityAt('2026-10-15T02:30:00Z')  // 10:30 PM EDT the night before
const DAYTIME = viabilityAt('2026-10-15T16:00:00Z')       // noon EDT
const SNAPSHOT = 'Too dark to surf right now. Current snapshot: knee to waist high, light east wind, falling tide.'

describe('wrong_day_reference — before sunrise, the next light is later today', () => {
  it('classifies 5:07 AM as night with sunrise later today', () => {
    expect(EARLY_MORNING).toMatchObject({ viable: false, reason: 'night', sunriseIsLaterToday: true })
  })

  it.each([
    'No surfing tonight at St. Augustine.',
    'Check back tomorrow for an accurate read.',
  ])('rejects %p in the early morning', text => {
    expect(validateReportText([SNAPSHOT, text], null, null, EARLY_MORNING).map(i => i.code))
      .toContain('wrong_day_reference')
  })

  // Pre-dawn is also past midnight — sunrise is under 90 minutes away, later today.
  it('rejects "tomorrow" inside the pre-dawn window', () => {
    const PRE_DAWN = viabilityAt('2026-10-15T10:30:00Z') // 6:30 AM EDT
    expect(PRE_DAWN).toMatchObject({ viable: false, reason: 'night', isPreDawn: true, sunriseIsLaterToday: true })
    expect(validateReportText([SNAPSHOT, 'Check back tomorrow once it is light.'], null, null, PRE_DAWN).map(i => i.code))
      .toContain('wrong_day_reference')
  })

  it('allows "later this morning" in the early morning', () => {
    expect(validateReportText([SNAPSHOT, 'Check back later this morning, around 7:25 AM.'], null, null, EARLY_MORNING).map(i => i.code))
      .not.toContain('wrong_day_reference')
  })

  it('allows "tonight" and "tomorrow" before midnight', () => {
    expect(LATE_EVENING).toMatchObject({ viable: false, reason: 'night', sunriseIsLaterToday: false })
    expect(validateReportText([SNAPSHOT, 'Check back tomorrow morning around 7:25 AM.'], null, null, LATE_EVENING).map(i => i.code))
      .not.toContain('wrong_day_reference')
  })
})

describe('word_count — night reports are terse by design', () => {
  const SHORT_P2 = 'Check back later this morning, around 7:25 AM, for an accurate read.'

  it('accepts a one-line paragraph 2 at night', () => {
    expect(validateReportText([SNAPSHOT, SHORT_P2], null, null, EARLY_MORNING).map(i => i.code))
      .not.toContain('word_count')
  })

  it('still holds a daytime report to the 25-word floor', () => {
    expect(DAYTIME).toEqual({ viable: true })
    expect(validateReportText([SNAPSHOT, SHORT_P2], null, null, DAYTIME).map(i => i.code))
      .toContain('word_count')
  })
})

describe('fabricated_crowd_count — "head out" is a verb, not a headcount', () => {
  it.each([
    'Head out once it is light, around 7:25 AM.',
    'If you have time, head out before the sun drops.',
  ])('allows %p', text => {
    expect(codesFor(text)).not.toContain('fabricated_crowd_count')
  })

  it.each([
    'You will find maybe half a dozen heads out right now.',
    'There are a few heads in the water already.',
  ])('still rejects %p', text => {
    expect(codesFor(text)).toContain('fabricated_crowd_count')
  })
})

// recommendations.timing_advice isn't rendered anywhere, so the harness only monitors it —
// but with the same finder the prose gate uses, so the two can't disagree.
describe('findWrongDayReference — applied to timing_advice', () => {
  it('flags "tomorrow" at 5am', () => {
    expect(findWrongDayReference('Check back tomorrow morning (~7:25 AM) for an accurate read.', EARLY_MORNING)).toBe('tomorrow')
  })

  it('leaves "tomorrow" alone before midnight', () => {
    expect(findWrongDayReference('Check back tomorrow morning (~7:25 AM) for an accurate read.', LATE_EVENING)).toBeNull()
  })

  it('leaves daytime and lightning advice alone', () => {
    expect(findWrongDayReference('Surf tomorrow if the swell holds.', DAYTIME)).toBeNull()
    expect(findWrongDayReference('Wait until tomorrow.', { viable: false, reason: 'lightning' })).toBeNull()
  })
})

describe('tierWinRate — the eval fails only when the first tier collapses', () => {
  const won = (backend: string, tier_errors: TierError[] = [], tier_rejections: TierRejection[] = []) =>
    ({ backend, tier_errors, tier_rejections })
  const primaryWins = (n: number) => Array.from({ length: n }, () => won('anthropic-primary'))
  const schemaFailure = won('openai-secondary', [{ backend: 'anthropic-primary', status: null, message: 'No output generated.' }])
  const rejected = won('openai-secondary', [], [{ backend: 'anthropic-primary', issues: [{ code: 'stock_phrase', detail: '' }, { code: 'size_in_feet', detail: '' }] }])

  // ~8% is the historical base rate; 4/10 is the worst run on record.
  it('passes at 4 losses in 10', () => {
    const r = tierWinRate([...primaryWins(6), schemaFailure, schemaFailure, rejected, rejected], 'anthropic-primary')
    expect(r.failed).toBe(false)
    expect(r.wins.get('anthropic-primary')).toBe(6)
    expect(r.wins.get('openai-secondary')).toBe(4)
  })

  it('fails at half', () => {
    expect(tierWinRate([...primaryWins(5), ...Array(5).fill(schemaFailure)], 'anthropic-primary').failed).toBe(true)
  })

  // A schema failure carries no HTTP status, so isConfigurationError never sees it — this is
  // the only place it shows up.
  it('says why the first tier lost each report', () => {
    const r = tierWinRate([schemaFailure, rejected, won('bun-fallback', [{ backend: 'anthropic-primary', status: 529, message: 'Overloaded' }])], 'anthropic-primary')
    expect(r.lossReasons).toEqual([
      'error: No output generated.',
      'rejected: stock_phrase, size_in_feet',
      'HTTP 529: Overloaded',
    ])
  })

  it('does not fail an empty run', () => {
    expect(tierWinRate([], 'anthropic-primary').failed).toBe(false)
  })
})
