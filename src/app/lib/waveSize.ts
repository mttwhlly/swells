/**
 * Translating "how big is the ocean" into "how big is the wave you'll ride".
 *
 * Every upstream source (Open-Meteo, NDBC buoys) reports **significant wave height
 * (Hs)** — the mean trough-to-crest height of the highest one-third of waves, measured
 * in open water. Surfers quote **face height**: trough to crest of the individual
 * breaking wave, at the break, in a few feet of water. These are different quantities
 * and the second is reliably larger.
 *
 * IMPORTANT: unlike the per-location `waveHeightCalibration` in locations.ts — which was
 * fitted against real buoy measurements and validated out-of-sample — the conversion
 * below is a **heuristic**, and it cannot be empirically validated because no instrument
 * measures face height. Treat its output as a rough translation for human phrasing, not
 * as a measurement. That is why `describeSize()` is the intended consumer: a size *band*
 * ("chest-to-head high") is honest about the precision we actually have, where a bare
 * "5.2 ft" is not.
 */

/**
 * Average of the highest 1/10 of waves, as a multiple of Hs, for a Rayleigh-distributed
 * sea. Surfers describe the sets they ride, not the mean of everything including lulls,
 * so the perceived size starts above Hs before shallow water is involved at all.
 */
const SETS_OVER_HS = 1.27;

/**
 * Shoaling gain: waves slow and steepen entering shallow water, growing before they
 * break. The gain rises with period — a long-period groundswell "feels" the bottom
 * sooner and converges more energy than short-period windswell of the same height.
 * Bounds are a practical range; true gain depends on bathymetry we do not model.
 */
function shoalingGain(periodSec: number): number {
  if (periodSec <= 6) return 1.05; // short windswell — breaks close to its open-water size
  if (periodSec >= 16) return 1.25; // long groundswell — substantial gain before breaking
  // Linear between the two anchors.
  return 1.05 + ((periodSec - 6) / 10) * 0.2;
}

/**
 * Estimate breaking face height (ft) from significant wave height (ft) and peak period.
 * Result is deliberately rounded to the nearest half foot — the underlying estimate does
 * not support finer precision.
 */
export function estimateFaceHeightFt(significantHeightFt: number, periodSec: number): number {
  if (!Number.isFinite(significantHeightFt) || significantHeightFt <= 0) return 0;
  const period = Number.isFinite(periodSec) && periodSec > 0 ? periodSec : 8;
  const face = significantHeightFt * SETS_OVER_HS * shoalingGain(period);
  return Math.round(face * 2) / 2;
}

/**
 * Body-scale size bands, keyed on estimated face height. This is how surfers actually
 * talk about size, and it carries no more precision than we can justify.
 * Each band is [maxFaceFt exclusive, descriptor].
 */
const SIZE_BANDS: Array<[number, string]> = [
  [1, 'flat'],
  [2, 'ankle to knee high'],
  [3, 'knee to waist high'],
  [4, 'waist to chest high'],
  [5, 'chest to shoulder high'],
  [6.5, 'shoulder to head high'],
  [8, 'overhead'],
  [12, 'well overhead'],
  [18, 'double overhead'],
];

const BIGGEST_BAND = 'triple overhead or bigger';

/** Body-scale descriptor ("chest to shoulder high") for an estimated face height in ft. */
export function describeSize(faceHeightFt: number): string {
  if (!Number.isFinite(faceHeightFt) || faceHeightFt <= 0) return 'flat';
  for (const [max, label] of SIZE_BANDS) {
    if (faceHeightFt < max) return label;
  }
  return BIGGEST_BAND;
}

/**
 * Everything the report generator needs to talk about size accurately, derived from Hs.
 * `significant_height_ft` is the measured quantity; the other two are derived estimates.
 */
export function describeWaveSize(significantHeightFt: number, periodSec: number) {
  const face = estimateFaceHeightFt(significantHeightFt, periodSec);
  return {
    significant_height_ft: significantHeightFt,
    face_height_ft: face,
    size_descriptor: describeSize(face),
  };
}
