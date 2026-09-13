import { describe, expect, it } from 'bun:test'
import { waveSizeOf } from './index'

/**
 * DRIFT GUARD.
 *
 * `waveSizeOf` in index.ts is a deliberate mirror of `src/app/lib/waveSize.ts` in the
 * Next.js app — this service deploys separately and cannot import from it. The table
 * below is duplicated verbatim in `tests/unit/wave-size.test.ts` on the Next.js side.
 * If someone changes the conversion in one place and not the other, one of the two
 * suites fails.
 *
 * Keep the two tables identical. Do not "fix" a failure here by editing the expected
 * values alone — change both implementations, then both tables.
 */
export const GOLDEN_SIZES: Array<[hsFt: number, periodSec: number, faceFt: number, descriptor: string]> = [
  [0, 9, 0, 'flat'],
  [0.5, 8, 0.5, 'flat'],
  [1, 8, 1.5, 'ankle to knee high'],
  [1.6, 7.1, 2, 'knee to waist high'],
  [2.8, 5.8, 3.5, 'waist to chest high'],
  [2.9, 8.2, 4, 'chest to shoulder high'],
  [3.1, 8.7, 4.5, 'chest to shoulder high'],
  [4.5, 12, 6.5, 'overhead'],
  [8, 16, 12.5, 'double overhead'],
  [15, 18, 24, 'triple overhead or bigger'],
]

describe('waveSizeOf', () => {
  it.each(GOLDEN_SIZES)(
    'Hs %pft at %ps -> %pft face, %p',
    (hs, period, expectedFace, expectedDescriptor) => {
      const out = waveSizeOf({ details: { wave_height_ft: hs, wave_period_sec: period } })
      expect(out.faceHeightFt).toBe(expectedFace)
      expect(out.descriptor).toBe(expectedDescriptor)
    }
  )

  it('prefers the fields /api/surfability supplies over recomputing', () => {
    const out = waveSizeOf({
      details: {
        wave_height_ft: 3,
        wave_period_sec: 9,
        face_height_ft: 99,
        size_descriptor: 'supplied by the API',
      },
    })
    expect(out.faceHeightFt).toBe(99)
    expect(out.descriptor).toBe('supplied by the API')
  })

  it('recomputes when the payload predates those fields', () => {
    const out = waveSizeOf({ details: { wave_height_ft: 2.9, wave_period_sec: 8.2 } })
    expect(out.descriptor).toBe('chest to shoulder high')
  })

  it('never reports Hs itself as the face height', () => {
    for (let hs = 0.5; hs <= 20; hs += 0.5) {
      for (let period = 3; period <= 22; period += 1) {
        const out = waveSizeOf({ details: { wave_height_ft: hs, wave_period_sec: period } })
        expect(out.faceHeightFt).toBeGreaterThanOrEqual(hs)
      }
    }
  })

  it('degrades to flat rather than throwing on malformed input', () => {
    expect(waveSizeOf({}).descriptor).toBe('flat')
    expect(waveSizeOf({ details: {} }).descriptor).toBe('flat')
    expect(waveSizeOf({ details: { wave_height_ft: -3, wave_period_sec: 9 } }).descriptor).toBe('flat')
  })

  it('still produces a sensible size when period is missing', () => {
    const out = waveSizeOf({ details: { wave_height_ft: 3 } })
    expect(out.faceHeightFt).toBeGreaterThan(3)
  })
})
