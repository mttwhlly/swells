import { describe, expect, it } from 'vitest';
import { describeSize, describeWaveSize, estimateFaceHeightFt } from '@/lib/waveSize';

describe('estimateFaceHeightFt', () => {
  it('always estimates a face at least as large as Hs', () => {
    // The whole point of the conversion: face height is never smaller than significant
    // wave height, for any period in range.
    for (let hs = 0.5; hs <= 20; hs += 0.5) {
      for (let period = 3; period <= 22; period += 1) {
        expect(estimateFaceHeightFt(hs, period)).toBeGreaterThanOrEqual(hs);
      }
    }
  });

  it('estimates a bigger face for longer period at the same height', () => {
    const windswell = estimateFaceHeightFt(6, 6);
    const mid = estimateFaceHeightFt(6, 11);
    const groundswell = estimateFaceHeightFt(6, 18);
    expect(groundswell).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(windswell);
  });

  it('keeps the ratio inside the range real forecasting uses (~1.3-1.6x)', () => {
    for (const period of [4, 8, 12, 16, 20]) {
      const ratio = estimateFaceHeightFt(10, period) / 10;
      expect(ratio).toBeGreaterThanOrEqual(1.3);
      expect(ratio).toBeLessThanOrEqual(1.62);
    }
  });

  it('rounds to the half foot rather than implying false precision', () => {
    for (const hs of [1.3, 2.7, 4.1, 7.9]) {
      expect((estimateFaceHeightFt(hs, 10) * 2) % 1).toBe(0);
    }
  });

  it('handles flat and malformed input without producing a size', () => {
    expect(estimateFaceHeightFt(0, 10)).toBe(0);
    expect(estimateFaceHeightFt(-1, 10)).toBe(0);
    expect(estimateFaceHeightFt(NaN, 10)).toBe(0);
    // A missing/absurd period should not crash or blow up the estimate.
    expect(estimateFaceHeightFt(3, NaN)).toBeGreaterThan(3);
    expect(estimateFaceHeightFt(3, 0)).toBeGreaterThan(3);
  });
});

describe('describeSize', () => {
  it('increases monotonically through the bands', () => {
    const seen: string[] = [];
    for (let ft = 0.5; ft <= 25; ft += 0.5) {
      const d = describeSize(ft);
      if (seen[seen.length - 1] !== d) seen.push(d);
    }
    // Bands should be visited in order, each exactly once.
    expect(seen).toEqual([
      'flat',
      'ankle to knee high',
      'knee to waist high',
      'waist to chest high',
      'chest to shoulder high',
      'shoulder to head high',
      'overhead',
      'well overhead',
      'double overhead',
      'triple overhead or bigger',
    ]);
  });

  it('never returns a number-like string', () => {
    for (let ft = 0; ft <= 30; ft += 0.5) {
      expect(describeSize(ft)).not.toMatch(/\d/);
    }
  });

  it('treats nothing as flat', () => {
    expect(describeSize(0)).toBe('flat');
    expect(describeSize(NaN)).toBe('flat');
  });
});

/**
 * DRIFT GUARD — mirrored verbatim in `bun-service/waveSize.test.ts`.
 *
 * The Bun service deploys separately and cannot import from this module, so it carries
 * its own copy of the conversion. This table is duplicated there; if the two
 * implementations diverge, one of the two suites fails.
 *
 * Keep the tables identical. Do not "fix" a failure by editing the expected values
 * alone — change both implementations, then both tables.
 */
const GOLDEN_SIZES: Array<[hsFt: number, periodSec: number, faceFt: number, descriptor: string]> = [
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
];

describe('golden sizes (mirrored in bun-service/waveSize.test.ts)', () => {
  it.each(GOLDEN_SIZES)('Hs %pft at %ps -> %pft face, %p', (hs, period, face, descriptor) => {
    const out = describeWaveSize(hs, period);
    expect(out.face_height_ft).toBe(face);
    expect(out.size_descriptor).toBe(descriptor);
  });
});

describe('describeWaveSize', () => {
  it('keeps Hs intact alongside the derived fields', () => {
    const out = describeWaveSize(3.5, 9);
    expect(out.significant_height_ft).toBe(3.5);
    expect(out.face_height_ft).toBeGreaterThan(3.5);
    expect(out.size_descriptor).toBe(describeSize(out.face_height_ft));
  });

  it('turns a typical St. Augustine reading into a plausible surfer description', () => {
    // ~0.73m Hs measured at buoy 41117, calibrated, at 7s -> a small but rideable day.
    const out = describeWaveSize(2.4, 7);
    expect(out.face_height_ft).toBeGreaterThanOrEqual(3);
    expect(out.face_height_ft).toBeLessThanOrEqual(4);
    expect(out.size_descriptor).toBe('waist to chest high');
  });
});
