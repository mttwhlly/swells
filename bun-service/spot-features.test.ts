import { describe, expect, it } from 'bun:test'
import { pickEarnedSpotFeatures, type ShinesWhenData, type SpotFeature } from './index'

/**
 * DRIFT GUARD.
 *
 * `pickEarnedSpotFeatures`/`matchesCondition` here are a deliberate mirror of the same
 * functions in `src/app/lib/locations.ts` — this service deploys separately and cannot
 * import from it. These cases mirror `tests/unit/spot-features.test.ts` on the Next.js
 * side. If someone changes the matching logic in one place and not the other, one of
 * the two suites should start disagreeing on cases like these.
 */
function data(overrides: Partial<ShinesWhenData> = {}): ShinesWhenData {
  return {
    swellDirectionCompass: 'E',
    windDirectionDescription: 'W offshore (clean offshore conditions)',
    waveHeightFt: 3,
    wavePeriodSec: 9,
    tideState: 'Mid Rising',
    ...overrides,
  }
}

describe('pickEarnedSpotFeatures', () => {
  it('always includes an archetype with no shinesWhenConditions, regardless of data', () => {
    const unconditional: SpotFeature = { archetype: 'default', examples: ['Somewhere'], shinesWhen: 'most days' }
    expect(pickEarnedSpotFeatures([unconditional], data())).toEqual([unconditional])
    expect(pickEarnedSpotFeatures([unconditional], data({ waveHeightFt: 20 }))).toEqual([unconditional])
  })

  it('includes a conditional archetype only when its condition matches', () => {
    const bigSwellOnly: SpotFeature = {
      archetype: 'advanced', examples: ['Heavy Reef'], shinesWhen: 'bigger swell',
      shinesWhenConditions: [{ minWaveHeightFt: 6 }],
    }
    expect(pickEarnedSpotFeatures([bigSwellOnly], data({ waveHeightFt: 3 }))).toEqual([])
    expect(pickEarnedSpotFeatures([bigSwellOnly], data({ waveHeightFt: 6 }))).toEqual([bigSwellOnly])
  })

  it('ANDs fields within one condition group', () => {
    const nGroundswell: SpotFeature = {
      archetype: 'reef', examples: ['Pipeline'], shinesWhen: 'solid N swell',
      shinesWhenConditions: [{ swellFrom: ['N', 'NNW', 'NW'], minWaveHeightFt: 4 }],
    }
    expect(pickEarnedSpotFeatures([nGroundswell], data({ swellDirectionCompass: 'N', waveHeightFt: 2 }))).toEqual([])
    expect(pickEarnedSpotFeatures([nGroundswell], data({ swellDirectionCompass: 'S', waveHeightFt: 8 }))).toEqual([])
    expect(pickEarnedSpotFeatures([nGroundswell], data({ swellDirectionCompass: 'NW', waveHeightFt: 8 }))).toEqual([nGroundswell])
  })

  it('ORs multiple condition groups on the same archetype', () => {
    const shelteredOrOnshore: SpotFeature = {
      archetype: 'sheltered', examples: ['Cove'], shinesWhen: 'bigger swell or onshore wind',
      shinesWhenConditions: [{ minWaveHeightFt: 5 }, { wind: 'onshore' }],
    }
    expect(pickEarnedSpotFeatures([shelteredOrOnshore], data({ waveHeightFt: 6, windDirectionDescription: 'W offshore' }))).toEqual([shelteredOrOnshore])
    expect(pickEarnedSpotFeatures([shelteredOrOnshore], data({ waveHeightFt: 2, windDirectionDescription: 'E onshore (choppy)' }))).toEqual([shelteredOrOnshore])
    expect(pickEarnedSpotFeatures([shelteredOrOnshore], data({ waveHeightFt: 2, windDirectionDescription: 'W offshore' }))).toEqual([])
  })

  it('matches tideIncludes by substring against tide_state', () => {
    const lowTideOnly: SpotFeature = {
      archetype: 'sandbar', examples: ['Flats'], shinesWhen: 'low to mid tide',
      shinesWhenConditions: [{ tideIncludes: ['Low', 'Mid'] }],
    }
    expect(pickEarnedSpotFeatures([lowTideOnly], data({ tideState: 'Low Rising' }))).toEqual([lowTideOnly])
    expect(pickEarnedSpotFeatures([lowTideOnly], data({ tideState: 'Mid Falling' }))).toEqual([lowTideOnly])
    expect(pickEarnedSpotFeatures([lowTideOnly], data({ tideState: 'High Rising' }))).toEqual([])
  })

  it('returns an empty array — not a guess — when every archetype is conditional and none match', () => {
    const advancedOnly: SpotFeature = {
      archetype: 'advanced', examples: ['Heavy Reef'], shinesWhen: 'big swell only',
      shinesWhenConditions: [{ minWaveHeightFt: 10 }],
    }
    expect(pickEarnedSpotFeatures([advancedOnly], data({ waveHeightFt: 1 }))).toEqual([])
  })
})
