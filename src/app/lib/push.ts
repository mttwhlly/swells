import webpush from 'web-push';
import type { SurfReport } from '../types/surf-report';
import {
  getSubscriptionsForLocation,
  setSubscriptionMatchState,
  deletePushSubscription,
} from './db';
import { describeWaveSize } from './waveSize';

// Whatever a subscriber opts into is matched against this shape — the same field names
// already written to surf_reports.conditions by both the Bun service and the local
// fallback (see api/surf-report/route.ts and bun-service/index.ts). Every field is
// optional: an absent field means "don't filter on this."
export interface PushCriteria {
  min_wave_height_ft?: number;
  max_wave_height_ft?: number;
  min_wave_period_sec?: number;
  max_wind_speed_kts?: number;
  tide_states?: string[];
  min_score?: number;
}

const DEFAULT_CRITERIA: PushCriteria = { min_score: 65 }; // matches the "Good" rating band

export function matchesCriteria(conditions: SurfReport['conditions'], criteria: unknown): boolean {
  const c = (criteria && typeof criteria === 'object' ? criteria : DEFAULT_CRITERIA) as PushCriteria;

  if (c.min_wave_height_ft !== undefined && conditions.wave_height_ft < c.min_wave_height_ft) return false;
  if (c.max_wave_height_ft !== undefined && conditions.wave_height_ft > c.max_wave_height_ft) return false;
  if (c.min_wave_period_sec !== undefined && conditions.wave_period_sec < c.min_wave_period_sec) return false;
  if (c.max_wind_speed_kts !== undefined && conditions.wind_speed_kts > c.max_wind_speed_kts) return false;
  if (c.tide_states && c.tide_states.length > 0 && !c.tide_states.includes(conditions.tide_state)) return false;
  if (c.min_score !== undefined && conditions.surfability_score < c.min_score) return false;

  return true;
}

let vapidConfigured = false;
function ensureVapidConfigured(): boolean {
  if (vapidConfigured) return true;

  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) {
    console.warn('⚠️ VAPID env vars not fully configured — skipping push notifications');
    return false;
  }

  webpush.setVapidDetails(subject, publicKey, privateKey);
  vapidConfigured = true;
  return true;
}

// Called right after a fresh report is saved for a location. Notifies only subscribers
// whose criteria just transitioned from not-matching to matching (rising edge), so a
// subscriber gets one push per good window, not one every cron run while it stays good.
export async function notifySubscribersForLocation(
  location: string,
  locationName: string,
  conditions: SurfReport['conditions']
): Promise<void> {
  if (!ensureVapidConfigured()) return;

  let subscriptions;
  try {
    subscriptions = await getSubscriptionsForLocation(location);
  } catch (error) {
    console.error(`❌ Failed to load push subscriptions for ${location}:`, error);
    return;
  }
  if (subscriptions.length === 0) return;

  // Body scale, not feet — wave_height_ft is offshore Hs and reads as a face height to a
  // surfer glancing at a notification. Subscriber *thresholds* still use Hs (see
  // matchesCriteria) because those are numbers the subscriber set themselves.
  const size =
    conditions.size_descriptor ??
    describeWaveSize(conditions.wave_height_ft, conditions.wave_period_sec).size_descriptor;

  const payload = JSON.stringify({
    title: `${locationName} is looking good 🌊`,
    body: `${size} @ ${conditions.wave_period_sec}s, ${conditions.tide_state.toLowerCase()} tide`,
    url: `/${location}`,
  });

  for (const row of subscriptions) {
    const isMatch = matchesCriteria(conditions, row.criteria);

    if (isMatch === row.last_matched) {
      continue; // no state change: either still in a good window (already notified) or still bad
    }

    if (!isMatch) {
      await setSubscriptionMatchState(row.endpoint, false);
      continue;
    }

    try {
      await webpush.sendNotification(row.subscription as webpush.PushSubscription, payload);
      await setSubscriptionMatchState(row.endpoint, true);
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) {
        console.log(`🗑️ Dead push subscription for ${location}, removing:`, row.endpoint);
        await deletePushSubscription(row.endpoint);
      } else {
        console.error(`❌ Failed to send push notification for ${location}:`, error);
      }
    }
  }
}
