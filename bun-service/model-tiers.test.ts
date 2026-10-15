import { describe, expect, it } from 'bun:test'
import { APICallError, NoOutputGeneratedError, RetryError } from 'ai'
import { isConfigurationError, tierErrorFrom } from './index'

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
