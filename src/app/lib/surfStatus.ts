/**
 * A 2–5 word, lowercase phrase for the current surf that reads after "where the waves
 * are …" — "clean and waist-high", "bumpy and chest-high", "flat". Served by
 * /api/now to mattwhalley.com.
 *
 * Deterministic on purpose: it reads only the `conditions` stored with the latest report,
 * so it never needs an upstream fetch or a model call.
 */
import type { SurfReport } from '@/types/surf-report';
import { estimateFaceHeightFt } from '@/lib/waveSize';
import { isOffshoreWind } from '@/lib/wind';

// Face height (ft, exclusive upper bound) → size. Same cut points as waveSize's
// SIZE_BANDS, collapsed to the band's upper word so the phrase stays short.
const SIZE_WORDS: Array<[number, string]> = [
  [2, 'knee-high'],
  [3, 'waist-high'],
  [4, 'chest-high'],
  [5, 'shoulder-high'],
  [6.5, 'head-high'],
  [8, 'overhead'],
  [12, 'well overhead'],
];

const OVERHEAD_FT = 6.5;

// Same thresholds as getWindDescription in /api/surfability.
function surfaceWord(windKts: number, offshore: boolean): string {
  if (offshore) return windKts < 15 ? 'clean' : 'choppy';
  if (windKts < 5) return 'clean';
  if (windKts < 10) return 'bumpy';
  if (windKts < 20) return 'choppy';
  return 'blown out';
}

export function describeSurfStatus(conditions: SurfReport['conditions'], coastFacingDeg: number): string {
  if (/thunder|lightning|tropical storm|hurricane/i.test(conditions.weather_description ?? '')) return 'stormy';

  const face = conditions.face_height_ft ?? estimateFaceHeightFt(conditions.wave_height_ft, conditions.wave_period_sec);
  if (!(face >= 1)) return 'flat';
  const size = SIZE_WORDS.find(([max]) => face < max)?.[1] ?? 'big';

  const { wind_speed_kts: windKts, wind_direction_deg: windDeg } = conditions;
  if (!Number.isFinite(windKts) || !Number.isFinite(windDeg)) return size;
  const offshore = isOffshoreWind(windDeg, coastFacingDeg);

  if (face >= OVERHEAD_FT && !offshore && windKts >= 10) return 'big and messy';
  return `${surfaceWord(windKts, offshore)} and ${size}`;
}
