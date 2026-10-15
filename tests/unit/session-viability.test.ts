import { describe, expect, it } from 'vitest';
import { getSessionViability, type SessionViability } from '@/lib/sessionViability';

/**
 * DRIFT GUARD.
 *
 * `src/app/lib/sessionViability.ts` mirrors `getSessionViability` in bun-service/index.ts,
 * which deploys separately and can't be imported. The table below is duplicated verbatim
 * in `bun-service/session-viability.test.ts`. If someone changes the logic in one place and
 * not the other, one of the two suites fails.
 *
 * Keep the two tables identical. Do not "fix" a failure here by editing the expected
 * values alone — change both implementations, then both tables.
 */
// [instant, lat, lon, timezone, weather, expected];
// St. Augustine unless noted. Local times are what the row is for.
export const GOLDEN_VIABILITY: Array<[iso: string, lat: number, lon: number, timezone: string, weather: string, expected: SessionViability]> = [
  // 2pm EDT
  ['2026-08-28T18:00:00Z', 29.9, -81.31, 'America/New_York', 'Partly cloudy', { viable: true }],
  // 2am EDT — past midnight, long before sunrise
  ['2026-08-28T06:00:00Z', 29.9, -81.31, 'America/New_York', 'Partly cloudy', { viable: false, reason: 'night', riseStr: '6:59 AM', minutesToRise: 300, isPreDawn: false, sunriseIsLaterToday: true }],
  // 5am EDT — past midnight, outside the pre-dawn window: the production "check back tomorrow" bug
  ['2026-08-28T09:00:00Z', 29.9, -81.31, 'America/New_York', 'Partly cloudy', { viable: false, reason: 'night', riseStr: '6:59 AM', minutesToRise: 120, isPreDawn: false, sunriseIsLaterToday: true }],
  // 6:15am EDT — inside the 90-minute pre-dawn window
  ['2026-08-28T10:15:00Z', 29.9, -81.31, 'America/New_York', 'Partly cloudy', { viable: false, reason: 'night', riseStr: '6:59 AM', minutesToRise: 45, isPreDawn: true, sunriseIsLaterToday: true }],
  // 10:30pm EDT the night before — "tomorrow morning" is right here
  ['2026-08-28T02:30:00Z', 29.9, -81.31, 'America/New_York', 'Partly cloudy', { viable: false, reason: 'night', riseStr: '6:59 AM', minutesToRise: 510, isPreDawn: false, sunriseIsLaterToday: false }],
  // 5:07am EDT — the cron run that shipped "no surfing tonight ... check back tomorrow"
  ['2026-10-15T09:07:00Z', 29.9, -81.31, 'America/New_York', 'Clear sky', { viable: false, reason: 'night', riseStr: '7:25 AM', minutesToRise: 139, isPreDawn: false, sunriseIsLaterToday: true }],
  // Lightning overrides daylight, and darkness
  ['2026-08-28T18:00:00Z', 29.9, -81.31, 'America/New_York', 'Thunderstorm', { viable: false, reason: 'lightning' }],
  ['2026-08-28T06:00:00Z', 29.9, -81.31, 'America/New_York', 'Thunderstorm', { viable: false, reason: 'lightning' }],
  // Huntington Beach: 5:30am PDT pre-dawn, and 10:30pm PDT the night before
  ['2026-08-28T12:30:00Z', 33.65, -118, 'America/Los_Angeles', 'Clear sky', { viable: false, reason: 'night', riseStr: '6:22 AM', minutesToRise: 53, isPreDawn: true, sunriseIsLaterToday: true }],
  ['2026-08-28T05:30:00Z', 33.65, -118, 'America/Los_Angeles', 'Clear sky', { viable: false, reason: 'night', riseStr: '6:22 AM', minutesToRise: 473, isPreDawn: false, sunriseIsLaterToday: false }],
  // Higgins Beach, winter solstice, 6:30am EST
  ['2026-12-21T11:30:00Z', 43.55, -70.36, 'America/New_York', 'Clear sky', { viable: false, reason: 'night', riseStr: '7:11 AM', minutesToRise: 41, isPreDawn: true, sunriseIsLaterToday: true }],
];

describe('getSessionViability', () => {
  it.each(GOLDEN_VIABILITY)('%s at (%p, %p) %s, %s', (iso, lat, lon, timezone, weather, expected) => {
    expect(getSessionViability(new Date(iso), lat, lon, timezone, weather)).toEqual(expected);
  });
});
