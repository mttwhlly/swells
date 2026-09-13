# CLAUDE.md

This file provides guidance to Claude Code when working with the Bun AI service in this directory.

## Runtime: Always Use Bun

- `bun run index.ts` — run the server
- `bun --watch index.ts` — dev with hot reload
- `bun install` — install dependencies
- Bun auto-loads `.env` — do not use `dotenv`

## Commands

```bash
bun dev      # hot-reload dev server
bun start    # production run
```

## Architecture

Single-file service (`index.ts`) deployed as a Docker container on Coolify. Receives a cron trigger, fetches surf data from the Next.js app, generates an AI report, and saves the result back to the Next.js app.

**Model fallback ladder** (`generateDetailedSurfReport`, `MODEL_TIERS`): Claude Haiku (`@ai-sdk/anthropic`) is primary; if it errors, or its output fails `validateReportText` (banned openers, word-count sanity, or contradicting the wind onshore/offshore ground truth), the same prompt is retried against OpenAI `gpt-4o-mini` (`@ai-sdk/openai`) as a secondary model. If both tiers fail, `createEnhancedFallbackReport` produces a deterministic, non-AI template from the same surf data. `generation_meta.backend` on the returned report records which tier actually won (`anthropic-primary` / `openai-secondary` / `bun-fallback`).

**Cron flow:**
1. GitHub Actions calls `POST /cron/generate-fresh-report` with `{ cronSecret, vercelUrl }`
2. This service fetches `vercelUrl/api/surfability`
3. Runs the model fallback ladder above via `generateObject` (Vercel AI SDK)
4. POSTs result to `vercelUrl/api/admin/save-report`

**Direct flow:**
- `POST /generate-surf-report` with `{ surfData, apiKey }` — caller provides surf data directly

**Wave size (`waveSizeOf`):** `details.wave_height_ft` is significant wave height (Hs) measured offshore — **not** the face of the wave a surfer rides, which is reliably larger. The prompt is given a body-scale label ("waist to chest high") as `Surf Size` and explicitly instructed not to quote a size in feet, because quoting Hs understates the surf. `/api/surfability` supplies `face_height_ft` and `size_descriptor`; `waveSizeOf` prefers those and recomputes from Hs only when they're absent (older payloads). The conversion mirrors `src/app/lib/waveSize.ts` in the Next.js app — this service deploys separately and can't import from it, so `waveSize.test.ts` here and `tests/unit/wave-size.test.ts` there share an identical golden table as a drift guard. Change both implementations, then both tables.

**Tests** (`bun test`): unit tests for `waveSizeOf`, including the drift guard above. Cheap and offline — unlike the eval harness, these call no models.

**Eval harness** (`eval/harness.ts`, run with `bun run eval`): runs golden scenarios against the real model and asserts on the output — `validateReportText` issues, cross-location and cross-day text-repetition checks, and whether any scenario fell through to the deterministic template. Exits non-zero on failure, so it's wired into `.github/workflows/eval-prompt.yml` as a CI gate on changes to `index.ts` or `eval/**`, in addition to being runnable by hand.

## Deployment

Docker on Coolify. Set the **Base Directory** in Coolify source settings to `/bun-service`.

## Environment Variables

```
ANTHROPIC_API_KEY  # Primary model (Claude Haiku)
OPENAI_API_KEY     # Secondary model (gpt-4o-mini), used only if Anthropic fails or is rejected by validation
API_SECRET         # Shared secret for /generate-surf-report
CRON_SECRET        # Shared secret for /cron/generate-fresh-report
PORT               # Default 3000
```
