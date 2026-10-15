// Which tier wrote each report, and why the first tier lost when it didn't.
//
// The rest of the harness passes as long as *some* tier produces a valid report, so a
// primary that fails schema validation 20% of the time — no HTTP status, so not a
// configuration error — is invisible to it. This makes it visible.
//
// Only a collapse fails the run. Across 32 Haiku 4.5 runs (320 reports) the primary lost
// 26 times, ~8%, at 0-4 losses per 10-report run. At n=10 a threshold of 3 would have
// failed 2 of those 32 runs for nothing; at half, the chance of a spurious failure at the
// 8% base rate is ~0.06%. A 20% problem shows up in the breakdown, not as a red build —
// pool several runs to judge it.

import type { TierError, TierRejection } from '../index'

export const FIRST_TIER_MAX_LOSS_SHARE = 0.5

export interface ReportOutcome {
  backend: string
  tier_errors: TierError[]
  tier_rejections: TierRejection[]
}

export interface WinRate {
  firstTier: string
  reports: number
  wins: Map<string, number>
  // One entry per report the first tier didn't write: what stopped it.
  lossReasons: string[]
  failed: boolean
}

function whyLost(outcome: ReportOutcome, tier: string): string {
  const error = outcome.tier_errors.find(e => e.backend === tier)
  if (error) return error.status === null ? `error: ${error.message}` : `HTTP ${error.status}: ${error.message}`
  const rejection = outcome.tier_rejections.find(r => r.backend === tier)
  if (rejection) return `rejected: ${rejection.issues.map(i => i.code).join(', ')}`
  return 'unknown'
}

export function tierWinRate(outcomes: ReportOutcome[], firstTier: string): WinRate {
  const wins = new Map<string, number>()
  const lossReasons: string[] = []
  for (const o of outcomes) {
    wins.set(o.backend, (wins.get(o.backend) ?? 0) + 1)
    if (o.backend !== firstTier) lossReasons.push(whyLost(o, firstTier))
  }
  const failed = outcomes.length > 0 && lossReasons.length / outcomes.length >= FIRST_TIER_MAX_LOSS_SHARE
  return { firstTier, reports: outcomes.length, wins, lossReasons, failed }
}
