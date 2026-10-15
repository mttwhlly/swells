import { describe, expect, it } from 'bun:test'
import { APICallError, NoOutputGeneratedError, RetryError } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { generateDetailedSurfReport, isConfigurationError, tierErrorFrom, type LocationContext, type ModelTier } from './index'

const err = (status: number | null) => ({ backend: 'anthropic-primary', status, message: '' })

// Both model upgrades (Haiku 5.5, gpt-6-luna) were refused with a 400 for a request
// parameter the old SDK still sends, and the eval passed anyway because the ladder fell
// through to the other tier. These are the errors the harness now fails on.
describe('isConfigurationError — which tier failures are bugs rather than bad luck', () => {
  it.each([400, 401, 403, 404])('treats HTTP %p as a configuration error', status => {
    expect(isConfigurationError(err(status))).toBe(true)
  })

  it.each([429, 500, 503, 529])('treats HTTP %p as transient', status => {
    expect(isConfigurationError(err(status))).toBe(false)
  })

  // Schema-mismatch and network errors carry no status — model behaviour, not config.
  it('ignores errors without an HTTP status', () => {
    expect(isConfigurationError(err(null))).toBe(false)
  })
})

describe('tierErrorFrom — where the HTTP status lives on the SDK\'s errors', () => {
  const apiError = (statusCode: number) =>
    new APICallError({ message: `HTTP ${statusCode}`, url: 'https://api.example.com', requestBodyValues: {}, statusCode })

  it('reads the status off a refused request', () => {
    expect(tierErrorFrom('anthropic-primary', apiError(404)).status).toBe(404)
  })

  // Exhausted 429/5xx retries are wrapped; without unwrapping, an outage is
  // indistinguishable from a schema failure in generation_meta.tier_errors.
  it('reads the status off the last attempt when retries are exhausted', () => {
    const e = new RetryError({ message: 'Failed after 3 attempts', reason: 'maxRetriesExceeded', errors: [apiError(529), apiError(529)] })
    expect(tierErrorFrom('anthropic-primary', e).status).toBe(529)
  })

  it('records no status when the model answered but produced no usable object', () => {
    expect(tierErrorFrom('anthropic-primary', new NoOutputGeneratedError()).status).toBeNull()
  })
})

// A request that never answers must not hold the ladder open. An eval run sat for 12
// minutes on a secondary call that never returned, before tiers had a timeout.
describe('generateDetailedSurfReport — a tier that never answers', () => {
  const surfData = {
    location: 'St. Augustine, FL', locationSlug: 'st-augustine', score: 42,
    details: { wave_height_ft: 1.8, wave_period_sec: 6, swell_direction_deg: 80, swell_direction_compass: 'E', wind_speed_kts: 12, wind_direction_deg: 270, wind_direction_compass: 'W', wind_direction_description: 'W offshore (clean offshore conditions)', tide_state: 'Mid Rising', tide_height_ft: 2.1 },
    weather: { water_temperature_c: 26, water_temperature_f: 78, air_temperature_c: 24, air_temperature_f: 75, weather_description: 'Partly cloudy' },
  }
  const ctx: LocationContext = { locationName: 'St. Augustine, FL', localKnowledge: '', voiceDescriptor: 'local', spotFeatures: [], lat: 29.9, lon: -81.31, timezone: 'America/New_York' }
  const DAYTIME = new Date('2026-08-28T18:00:00Z')

  const sentence = 'Small soft waves roll through with a clean offshore breeze grooming the faces and the rising tide filling in over the sandbars nicely.'
  const report = {
    conditionsAnalysis: `${sentence} ${sentence}`,
    recommendationsAndOutlook: `${sentence} ${sentence}`,
    recommendations: { boardType: 'longboard', wetsuitThickness: null, skillLevel: 'beginner', bestSpots: [], timingAdvice: 'This afternoon.' },
  }
  const usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 20, text: 20, reasoning: undefined },
  }

  const hangs: ModelTier = {
    backend: 'anthropic-primary', modelId: 'hangs',
    model: new MockLanguageModelV4({
      doGenerate: ({ abortSignal }) => new Promise((_, reject) => {
        abortSignal?.addEventListener('abort', () => reject(abortSignal.reason))
      }),
    }),
    timeout: { totalMs: 50 },
  }
  const answers: ModelTier = {
    backend: 'openai-secondary', modelId: 'answers',
    model: new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: 'text', text: JSON.stringify(report) }],
        finishReason: { unified: 'stop', raw: undefined },
        usage,
        warnings: [],
      }),
    }),
  }

  it('times the tier out and moves on to the next one', async () => {
    const result = await generateDetailedSurfReport(surfData, ctx, DAYTIME, [hangs, answers])

    expect(result.generation_meta.backend).toBe('openai-secondary')
    expect(result.generation_meta.tier_errors).toHaveLength(1)
    expect(result.generation_meta.tier_errors[0]).toMatchObject({ backend: 'anthropic-primary', status: null })
  })
})
