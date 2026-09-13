# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm dev          # Start development server (localhost:3000)
pnpm build        # Build for production
pnpm start        # Start production server
pnpm lint         # Run ESLint
pnpm type-check   # TypeScript type checking (tsc --noEmit)
pnpm setup-db     # Initialize Neon PostgreSQL schema
pnpm test         # Vitest: route-handler/unit tests (external calls mocked)
pnpm test:watch   # Vitest in watch mode
pnpm test:e2e     # Playwright: e2e smoke tests (spins up pnpm dev)
```

The Bun service has its own commands, run from `bun-service/`:

```bash
bun test          # Unit tests — offline, no model calls
bun run eval      # Eval harness — calls the REAL model, costs money, CI gate on index.ts
bun dev           # Hot-reload dev server
```

### Testing

Baseline suite covering the golden paths: home page, a `[slug]` location page, `/api/surf-report` (cache-hit and cache-miss), `/api/og`.

- **Vitest** (`tests/unit/`) tests route-handler logic in isolation — `@/lib/db` and `fetch` are mocked, so no real DB/network calls happen. Also covers the coast-orientation scoring and the Hs→body-scale conversion.
- **`bun test`** (from `bun-service/`) covers `waveSizeOf`. Offline — it calls no models, unlike `bun run eval`.
- **Playwright** (`tests/e2e/`) drives a real `pnpm dev` server in a browser. The `/api/surf-report` client fetch is intercepted with `page.route` to avoid exercising the live generation chain (surfability → Bun AI service → DB write); server-side reads of the DB cache (in `[slug]/page.tsx`) are real, so `.env.local` must be present locally. Not wired into CI yet.
- `/api/og`'s e2e test is `test.fixme()` — the route currently crashes on every request in dev (tracked in [#36](https://github.com/mttwhlly/swells/issues/36)), pre-existing and unrelated to any of this repo's other in-flight work.

### Service worker cache trap (local dev)

`public/sw.js` is registered from `SurfAppClient.tsx` and aggressively caches JS chunks/assets for offline use (see `CACHE_STRATEGIES`). When testing a frontend change in a browser (manually or via `claude-in-chrome`/Playwright), a **previously-registered SW can keep serving the old JS bundle** even after the dev server has recompiled and is sending fresh HTML — a plain reload or hard reload does not fix this. Symptoms: a hydration mismatch or "stale" behavior that shows the *pre-edit* client output alongside *post-edit* server output, or UI that just doesn't reflect a change you just made.

If a browser session for this app was used in an earlier conversation/tab, or the symptom looks like this, unregister the SW and clear caches before trusting what you see:

```js
const regs = await navigator.serviceWorker.getRegistrations();
for (const r of regs) await r.unregister();
const keys = await caches.keys();
for (const k of keys) await caches.delete(k);
```

Run that in the page context (e.g. `javascript_tool`/`browser_evaluate`), then reload. Only needed for browser-based manual/e2e testing — Vitest and Playwright's mocked-fetch tests aren't affected.

## Architecture

This is a Next.js 14 app (App Router) that delivers AI-generated surf reports for seven US surf spots (see `src/app/lib/locations.ts`); St. Augustine, FL is the default. Each location has its own slug route, coast orientation, NOAA tide station, local knowledge, and cached report row. The live site is `swells.surf` (previously `surf-report-rouge.vercel.app` and `canisurf.today`, now inactive).

### Data Flow

```
Browser → /api/surf-report (GET)
           ├── Cache hit (< 8h old) → return cached DB row immediately
           └── Cache miss → fetch /api/surfability → POST to Bun AI service → save to DB → return
```

**Cron job** (`/api/admin/request-forecast`, 4× daily): clears the DB cache, then calls the Bun service to pre-generate a fresh report so user requests are always served from cache.

### Key architectural decision: Bun AI service

Report generation is **not done inside Next.js** — but its source *is* in this repo, at [`bun-service/`](bun-service/CLAUDE.md). Only the *deployment* is separate: it ships as its own Docker image on Coolify (base directory `/bun-service`), and `BUN_SERVICE_URL` points the Next.js app at it over HTTP. Edit the prompt, the model ladder, or the generation fallbacks in `bun-service/index.ts`, not in `src/`.

The service runs a model ladder — Claude Haiku (`@ai-sdk/anthropic`) primary, GPT-4o-mini (`@ai-sdk/openai`) secondary if the primary errors or fails `validateReportText`, then a deterministic non-AI template. The Next.js `surf-report` route only calls the service; if it's unreachable entirely, Next.js falls back to its own local text template (`createDetailedFallbackReport`). Note there are therefore **two** deterministic templates — one in each process — and they need to stay in step.

### External data sources (all in `/api/surfability/route.ts`)

- **Open-Meteo Marine API** — wave height (m→ft), wave period, swell direction, sea surface temperature
- **Open-Meteo Weather API** — air temp, wind speed (m/s→knots), wind direction, weather code
- **NOAA Tides API** — current tide height, hi/lo predictions. Station is per-location (`noaaStationId` in `locations.ts`), not a single hardcoded station.

`/api/surfability` will 503 if any real data source fails; it has no fallback estimates (strict by design).

#### Wave height calibration

Open-Meteo's modelled significant wave height carries a systematic, **location-specific** bias — it resolves open water rather than the shoaling and refraction each beach sits behind. Measured against the nearest NDBC wave buoy over ~30 days (Sept 2026), `best_match` ran 43% low at St. Augustine, 25% low at Rockaway, and 25% high on Oahu's North Shore, while being essentially unbiased in Maine.

Each location therefore carries a `waveHeightCalibration` multiplier in `locations.ts`, applied in `findCurrentMarineData` *after* the plausibility bounds are checked against the raw model value. Factors were fitted as `mean(buoy Hs) / mean(model Hs)` and validated out-of-sample (fit on the first half of the window, test on the second); only factors that measurably beat no correction were adopted, the rest are pinned to `1.0` with the fit recorded in a comment. At St. Augustine this cut out-of-sample RMSE from 0.34m to 0.12m.

Two caveats worth knowing:

- **These drift.** They are fitted on a single late-summer window and should be re-fitted periodically, not treated as constants. `calibrationBuoyId` and `calibrationFittedOn` record the provenance for each.
- **Don't "fix" this by switching wave models instead.** `ncep_gfswave025` is markedly better than `best_match` on the East Coast but returns a hardcoded `0.00m` at Oahu (it resolves a land cell there), and the route's `waveHeight > 30` guard would not catch a flat zero — it would silently report "flat" forever.

Note that `wave_period` from Open-Meteo tracks the buoy's *dominant/peak* period (DPD) within ~1s, not the average period — so it is already the quantity surf forecasts quote, and needs no correction.

#### Hs vs. face height (`src/app/lib/waveSize.ts`)

Every upstream source reports **significant wave height (Hs)** — mean trough-to-crest of the highest third of waves, measured offshore. Surfers mean **face height**: the individual breaking wave at the beach. Face is reliably larger (waves shoal before breaking; surfers describe sets, not the mean including lulls), typically ~1.3–1.6× Hs depending on period.

`waveSize.ts` derives `face_height_ft` and a body-scale `size_descriptor` ("chest to shoulder high") from Hs and period. **Unlike the calibration factors, this conversion is a heuristic and cannot be validated** — no instrument measures face height. That's why `size_descriptor` is the field intended for anything user-facing: a band is honest about the precision available, a bare "5.2 ft" is not.

Field conventions, which matter because several consumers read these:

- `wave_height_ft` **is still Hs** everywhere it appears (surfability payload, `surf_reports.conditions`, push `criteria` thresholds). It was not repurposed — changing its meaning would silently shift every stored row and every subscriber's saved threshold.
- `face_height_ft` / `size_descriptor` are derived, optional additions. Consumers use `waveSizeFor()` in `surf-report/route.ts`, which recomputes from Hs when they're absent so older payloads don't fall back to quoting Hs as a face.
- User-facing surfaces (page/tab titles, meta description, OG card, push body, report prose) use body scale. Numeric Hs stays in the API payload.
- Push *matching* (`matchesCriteria`) still compares against Hs, because those thresholds are numbers subscribers set themselves.

**The generation prompt is in `bun-service/index.ts`** — that service deploys separately but its source lives in this repo. Its prompt receives `Surf Size: <body scale label>` rather than a height in feet, plus an explicit instruction not to quote feet. `surf-report/route.ts` also sends a `sizeGuidance` object alongside the payload. Both the AI prose and the deterministic fallback templates now describe size in body scale; verified against the live model with `bun run eval`.

Because the Bun service deploys as its own image and cannot import from `src/`, it carries a mirror of this conversion (`waveSizeOf` in `bun-service/index.ts`). The two are held in step by an identical golden table in `tests/unit/wave-size.test.ts` and `bun-service/waveSize.test.ts` — if they drift, one suite fails. Change both implementations, then both tables.

Two user-facing explanations of all this: a footnote in the "Data sources" dock popover (`SurfAppClient.tsx`) and a section on `/about`.

### Frontend

`page.tsx` (server component) → `SurfAppClient.tsx` (client component) → `useSurfReportOptimized` hook (TanStack Query) → `/api/surf-report`

The hook is configured with aggressive caching (`staleTime: 30m`, no polling interval) because reports only update via cron; it does refetch on window focus (once the 30m staleTime has elapsed) so long-lived open tabs catch up when revisited. `SurfReportCard` renders the raw AI-generated text as a large prose block.

### Database

Neon PostgreSQL (`@neondatabase/serverless`). Three tables: `surf_reports`, `location_requests` (spot suggestions from the "Suggest a spot" form), and `push_subscriptions` (browser push subscriptions, one row per subscription `endpoint`, scoped to a single `location`). All DB functions are in `src/app/lib/db.ts`. The `getCachedReport` function fetches the most recent row for a location regardless of `cached_until` — the 8-hour staleness check is done in the route handler.

### Environment variables required

| Variable | Purpose |
|---|---|
| `NEON_DATABASE_URL` | Neon PostgreSQL connection string |
| `BUN_SERVICE_URL` | URL of external Bun AI generation service |
| `BUN_API_SECRET` | Auth token sent to Bun service |
| `CRON_SECRET` | Bearer token required by `/api/admin/request-forecast` |
| `NEXT_PUBLIC_API_URL` | Base URL for internal self-calls (optional, falls back to host header) |
| `RESEND_API_KEY` | Sends the "suggest a spot" notification email via Resend (`/api/location-request`) |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | VAPID public key passed to `PushManager.subscribe()` in the browser |
| `VAPID_PRIVATE_KEY` | VAPID private key used server-side to sign push messages (`web-push`) |
| `VAPID_SUBJECT` | Contact identifier (URL) sent to push services alongside VAPID-signed requests |

### What's in the codebase but not active

The web app manifest (`public/manifest.json`, linked from `layout.tsx`), the install-prompt flow (`beforeinstallprompt`/`appinstalled` handling and Install button in `SurfAppClient.tsx`'s dock bar), and `public/sw.js`'s offline caching (registered from `SurfAppClient.tsx`, with `install`/`activate`/`fetch` handlers implementing its `CACHE_STRATEGIES`) are all fully wired up.

Push notifications are fully wired up end to end. A "Notify" button in `SurfAppClient.tsx`'s dock bar (shown only where `PushManager` exists — which on iOS means only inside an installed PWA) requests `Notification` permission, subscribes via `pushManager.subscribe()` with the VAPID public key, and POSTs the subscription (plus per-subscriber condition thresholds entered in the Notify popover) to `/api/push-subscription`, which upserts it into the `push_subscriptions` table keyed by `endpoint`. Scope is single-location: a subscription is tied to whichever location the visitor was viewing when they opted in, and re-subscribing from a different location moves it (re-upserts the same `endpoint` row with the new `location`). Clicking again unsubscribes client-side and `DELETE`s the row. `public/sw.js` has `push` and `notificationclick` handlers that render and route the notification, and `src/app/lib/push.ts` (using `web-push`) is called from the cron flow to evaluate each subscriber's thresholds against the fresh report and send matching notifications.

On iOS Safari when the app hasn't been added to the home screen, neither `beforeinstallprompt` nor `PushManager` are available (Apple platform limitations, not bugs), so the Install and Notify buttons are hidden. In that case `SurfAppClient.tsx` shows an "Install" dock item with a share/user-agent-detected iOS check (`isIOS`) that opens a popover instructing the visitor to use Safari's Share → "Add to Home Screen" to install and unlock notifications.
