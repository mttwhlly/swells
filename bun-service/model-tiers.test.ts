import { describe, expect, it } from 'bun:test'
import { isConfigurationError } from './index'

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
