# Swells

AI-generated surf reports for 7 locations across the US, written in the voice of a local at each spot. Live at [swells.surf](https://swells.surf).

Report generation is a two-model pipeline — Claude Haiku, with GPT-4o-mini as an automatic fallback — grounded in real-time wave, wind, and tide data, with a deterministic template as the last-resort fallback if both models fail or produce output that fails fact-checking. See [Reliability](#-reliability) below.

## Features

- **AI-generated reports** — 2-paragraph natural-language surf reports per location, refreshed 4×/day
- **7 locations** — St. Augustine FL, Boca Raton FL, Higgins Beach ME, Folly Beach SC, Rockaway Beach NY, Huntington Beach CA, Oahu HI (`src/app/lib/locations.ts`)
- **Real, unfaked data** — wave height/period/swell direction (Open-Meteo Marine), wind (Open-Meteo Weather), tides (NOAA). If a source fails, the conditions API returns `503` rather than estimating.
- **Buoy-calibrated wave height** — global wave models resolve open ocean, not the sandbars each beach sits behind, so they run consistently small at some spots and large at others (~43% low at St. Augustine, ~25% high on Oahu). Each spot carries a correction factor fitted against its nearest NDBC buoy and validated out-of-sample.
- **Size in body scale, not feet** — forecasts report significant wave height offshore, which is smaller than the wave face you ride. Reports say "chest to shoulder high" rather than quoting a number that invites the wrong comparison.
- **Audio reports** — on-demand text-to-speech via ElevenLabs
- **"Suggest a spot"** — inline form that emails a notification and stores the request in Postgres
- **Installable PWA** — manifest + service worker with offline caching, install prompt, and push notifications wired end to end (per-subscriber condition thresholds, evaluated on each cron run)

## Architecture

```
Browser → /api/surf-report (GET)
           ├── cache hit (< 8h old) → return cached DB row
           └── cache miss → /api/surfability → Bun AI service → save to DB → return
```

Report generation runs in a **separate Bun service** (`bun-service/`), not inside Next.js — deployed independently on Coolify. The Next.js app only calls it over HTTP; if it's unreachable, `/api/surf-report` falls back to a local deterministic template.

A GitHub Actions cron (`.github/workflows/surf-cron.yml`) hits `/api/admin/request-forecast` 4×/day, which clears the cache and asks the Bun service to pre-generate every location — so a live user request almost never triggers synchronous AI generation.

Full breakdown of each layer: [`bun-service/CLAUDE.md`](bun-service/CLAUDE.md) and the root [`CLAUDE.md`](CLAUDE.md).

## Reliability

The report pipeline is built to fail safely rather than fail confidently:

| Layer | What it does |
|---|---|
| **No-fallback data** | `/api/surfability` returns `503` instead of estimating if any real source (marine, tide, weather) is unavailable |
| **Deterministic ground truth** | Onshore/offshore, swell favorability, and tide state are computed in code from coast orientation — never left for the model to infer — and injected into the prompt as facts to use verbatim |
| **Model fallback ladder** | Claude Haiku (primary) → GPT-4o-mini (secondary) → hardcoded template (last resort). A tier is skipped if it errors *or* if its output fails fact-checking |
| **Output validation** | `validateReportText()` in `bun-service/index.ts` rejects output that contradicts the wind ground truth, opens with a banned cliché, or falls outside a sane word-count range |
| **Eval harness as a CI gate** | `bun-service/eval/harness.ts` runs golden scenarios against the real model — cross-location and cross-day repetition checks, a specific past-bug repro — and exits non-zero on failure. Wired into [`.github/workflows/eval-prompt.yml`](.github/workflows/eval-prompt.yml) on changes to the prompt/generation code |
| **Alerting** | Cron failures (whole job or individual locations) email a notification via Resend (`src/app/lib/alerts.ts`) instead of only appearing in Actions logs |
| **Provenance in the UI** | `SurfReportCard` shows a small notice when a report isn't a normal live-AI report — degraded template, backup model, or stale emergency cache — and stays silent otherwise |
| **Calibration drift guard** | The Hs→body-scale conversion is duplicated in the Bun service (which deploys separately and can't import from `src/`). Both copies are pinned to an identical golden table in `tests/unit/wave-size.test.ts` and `bun-service/waveSize.test.ts`, so a change to one without the other fails CI |
| **Readiness health check** | `/api/health` pings the database and the Bun AI service and returns `degraded`/`error` with per-dependency detail, instead of always returning `200` |

## Tech Stack

- **Frontend**: Next.js 14 (App Router), React, TypeScript, Tailwind CSS, TanStack Query
- **Report generation**: separate Bun service — Vercel AI SDK (`generateObject`) against Claude Haiku and GPT-4o-mini, deployed on Coolify
- **Database**: Neon PostgreSQL
- **Audio**: ElevenLabs TTS
- **Email**: Resend (spot suggestions + reliability alerts)
- **Data sources**: Open-Meteo Marine API, Open-Meteo Weather API, NOAA Tides & Currents API
- **Deployment**: Vercel (Next.js app) + Coolify (Bun service) + GitHub Actions (cron, eval CI gate)

## Getting Started

### Prerequisites

- Node.js 18.17+ and [pnpm](https://pnpm.io/)
- [Bun](https://bun.sh/) 1.1+ (for `bun-service/`)
- A Neon PostgreSQL database

### Install & run

```bash
git clone <your-repo-url>
cd surf-lab
pnpm install
pnpm setup-db     # initialize the Neon schema
pnpm dev          # http://localhost:3000
```

The Bun AI service is a separate app (`bun-service/`) with its own dependencies and deployment — see [`bun-service/CLAUDE.md`](bun-service/CLAUDE.md) to run it locally.

### Environment variables

Next.js app (`.env.local`):

| Variable | Purpose |
|---|---|
| `NEON_DATABASE_URL` | Neon PostgreSQL connection string |
| `BUN_SERVICE_URL` | URL of the deployed Bun AI service |
| `BUN_API_SECRET` | Auth token sent to the Bun service |
| `CRON_SECRET` | Bearer token required by `/api/admin/request-forecast` |
| `RESEND_API_KEY` | Sends spot-suggestion notifications and reliability alerts |
| `NEXT_PUBLIC_API_URL` | Base URL for internal self-calls (optional) |

Bun service (`bun-service/.env`, loaded automatically by Bun — separate deployment):

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Primary model (Claude Haiku) |
| `OPENAI_API_KEY` | Secondary model (GPT-4o-mini), used only if Anthropic fails or is rejected by validation |
| `API_SECRET` | Shared secret for `/generate-surf-report` |
| `CRON_SECRET` | Shared secret for `/cron/generate-fresh-report` (must match the Next.js app's) |

## Project Structure

```
src/app/
├── [slug]/                       # Per-location page (e.g. /st-augustine)
├── api/
│   ├── surf-report/               # Main report endpoint — cache-first, falls back to Bun service
│   ├── surfability/                # Real-time conditions — strict, no fallback estimates
│   ├── audio-report/                # On-demand ElevenLabs TTS
│   ├── location-request/           # "Suggest a spot" form handler
│   ├── health/                      # Dependency-aware readiness check
│   └── admin/
│       ├── request-forecast/       # Cron entrypoint — clears cache, triggers regeneration, alerts on failure
│       └── save-report/             # Receives generated reports from the Bun service
├── components/
│   ├── LocationGate.tsx            # First-visit location picker
│   ├── SurfAppClient.tsx           # Client shell
│   └── surf/SurfReportCard.tsx     # Renders the AI report + provenance notice
├── hooks/useSurfReportOptimized.ts # TanStack Query hook (30min staleTime, no auto-refetch)
├── lib/
│   ├── db.ts                       # Neon queries
│   ├── locations.ts                # The 7 locations — local knowledge, coast orientation, buoy calibration
│   ├── waveSize.ts                 # Hs -> face height -> body-scale descriptor
│   ├── push.ts                     # Threshold matching + web-push delivery
│   └── alerts.ts                   # Resend-based reliability alerting
└── types/surf-report.ts

bun-service/
├── index.ts                        # Model fallback ladder, prompt, validation, HTTP handlers
├── waveSize.test.ts                # Unit tests + drift guard against src/app/lib/waveSize.ts
├── eval/harness.ts                 # Golden-scenario eval harness (CI-gated, calls real models)
└── CLAUDE.md
```

## API Endpoints

- `GET /api/surf-report?location=<slug>` — AI-generated report (cache-first, ~8h TTL)
- `GET /api/surfability?location=<slug>` — real-time conditions and scoring (503 if any source fails)
- `GET /api/audio-report?location=<slug>` — TTS audio of the current report
- `POST /api/location-request` — spot suggestion form
- `GET /api/health` — dependency-aware readiness check
- `GET /api/admin/request-forecast` — cron entrypoint (requires `CRON_SECRET`)

## Deployment

- **Next.js app** → Vercel. Set the env vars above in the Vercel dashboard.
- **Bun AI service** → Docker on Coolify, base directory `/bun-service`. Set its env vars there.
- **Cron** → GitHub Actions (`.github/workflows/surf-cron.yml`), 4×/day, hits `/api/admin/request-forecast`.
- **Eval gate** → GitHub Actions (`.github/workflows/eval-prompt.yml`), runs on changes to `bun-service/index.ts` or `bun-service/eval/**`. Needs `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` set as repo secrets.

## Scripts

```bash
pnpm dev          # Next.js dev server
pnpm build        # Production build
pnpm start        # Production server
pnpm lint         # ESLint
pnpm type-check   # tsc --noEmit
pnpm setup-db     # Initialize Neon schema
```

Bun service: `bun dev` (hot reload), `bun start`, `bun test` (offline unit tests), `bun run eval` (golden-scenario harness — calls the real models, so it costs money).

## License

No LICENSE file is currently checked in — the `bun-service` package.json declares MIT, but that hasn't been made official for the repo as a whole.
