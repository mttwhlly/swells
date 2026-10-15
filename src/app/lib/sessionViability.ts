/**
 * Is anyone surfing right now — or is it dark, or is there lightning?
 *
 * Mirrors `getSessionViability` / `getDaylightWindow` in `bun-service/index.ts`. That
 * service deploys as its own image and can't import from `src/`, so this is a deliberate
 * copy, held in step by an identical golden table in `tests/unit/session-viability.test.ts`
 * and `bun-service/session-viability.test.ts`. Change both implementations, then both
 * tables.
 *
 * Only the Next.js deterministic fallback reads this. Without it, that template described
 * a surf session at 2am whenever the Bun service was unreachable.
 */

export type SessionViability =
  | { viable: true }
  | { viable: false; reason: 'night'; riseStr: string; minutesToRise: number; isPreDawn: boolean; sunriseIsLaterToday: boolean }
  | { viable: false; reason: 'lightning' };

/** Within this many minutes of sunrise it's "pre-dawn" (sky lightening), not the middle of the night. */
export const PRE_DAWN_WINDOW_MINUTES = 90;

/**
 * Sunrise/sunset via the standard NOAA solar-position approximation (~1 minute outside
 * polar latitudes), as real instants so timezone/DST conversion happens once, at display.
 * Anchored to `now`'s UTC calendar date — see `localDateKey` for why that matters.
 */
function getDaylightWindow(lat: number, lon: number, now: Date): { rise: Date; set: Date } {
  const utcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dayOfYear = Math.round((utcMidnight - Date.UTC(now.getUTCFullYear(), 0, 1)) / 86400000);
  const gamma = 2 * Math.PI / 365 * dayOfYear;

  const eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma)
    - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma));

  const decl = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma)
    - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma)
    - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);

  const latRad = lat * Math.PI / 180;
  // 90.833° rather than 90° accounts for refraction and the sun's apparent radius.
  const cosHA = Math.cos(90.833 * Math.PI / 180) / (Math.cos(latRad) * Math.cos(decl)) - Math.tan(latRad) * Math.tan(decl);

  if (cosHA > 1) return { rise: new Date(utcMidnight), set: new Date(utcMidnight) };
  if (cosHA < -1) return { rise: new Date(utcMidnight), set: new Date(utcMidnight + 86400000) };

  const haDeg = Math.acos(cosHA) * 180 / Math.PI;
  const solarNoonUTC = 720 - 4 * lon - eqTime;

  return {
    rise: new Date(utcMidnight + (solarNoonUTC - 4 * haDeg) * 60000),
    set: new Date(utcMidnight + (solarNoonUTC + 4 * haDeg) * 60000),
  };
}

function formatClockTime(date: Date, timezone: string): string {
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: timezone });
}

/**
 * The location's calendar date for an instant. getDaylightWindow's UTC anchor rolls over
 * 4-5 hours before local midnight in US timezones, so "is sunrise today or tomorrow" has
 * to be decided on local dates, not raw instants.
 */
function localDateKey(date: Date, timezone: string): string {
  return date.toLocaleDateString('en-CA', { timeZone: timezone });
}

export function getSessionViability(now: Date, lat: number, lon: number, timezone: string, weatherDescription: string): SessionViability {
  if (/thunder|lightning|tropical storm|hurricane/i.test(weatherDescription)) {
    return { viable: false, reason: 'lightning' };
  }
  const { rise, set } = getDaylightWindow(lat, lon, now);
  if (now.getTime() < rise.getTime() || now.getTime() >= set.getTime()) {
    const riseStr = formatClockTime(rise, timezone);
    // After sunset the next sunrise is tomorrow's — approximated as today's, 24h later.
    const nextRise = now.getTime() < rise.getTime() ? rise : new Date(rise.getTime() + 86400000);
    const minutesToRise = Math.round((nextRise.getTime() - now.getTime()) / 60000);
    const sunriseIsLaterToday = localDateKey(nextRise, timezone) === localDateKey(now, timezone);
    return { viable: false, reason: 'night', riseStr, minutesToRise, isPreDawn: minutesToRise <= PRE_DAWN_WINDOW_MINUTES, sunriseIsLaterToday };
  }
  return { viable: true };
}
