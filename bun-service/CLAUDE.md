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

**Model fallback ladder** (`generateDetailedSurfReport`, `MODEL_TIERS`): Claude Haiku (`@ai-sdk/anthropic`) is primary; if it errors, or its output fails `validateReportText` (banned openers, word-count sanity, contradicting the wind onshore/offshore ground truth, inventing a crowd count, or leaning on a gated stock phrase), the prompt is retried against OpenAI `gpt-4o-mini` (`@ai-sdk/openai`) as a secondary model.

The retry prompt is **not** byte-identical to the first: the previous tier's `validateReportText` issues are appended to it. Retrying unchanged wastes the tier — the second model can't know why the first was rejected and independently trips the same rule. Observed before this was added: Haiku's `"get your feet wet"` was followed by gpt-4o-mini's `"quick and choppy"`, dropping a report to the deterministic template. If both tiers fail, `createEnhancedFallbackReport` produces a deterministic, non-AI template from the same surf data. `generation_meta.backend` on the returned report records which tier actually won (`anthropic-primary` / `openai-secondary` / `bun-fallback`).

**Cron flow:**
1. GitHub Actions calls `POST /cron/generate-fresh-report` with `{ cronSecret, vercelUrl }`
2. This service fetches `vercelUrl/api/surfability`
3. Runs the model fallback ladder above via `generateObject` (Vercel AI SDK)
4. POSTs result to `vercelUrl/api/admin/save-report`

**Direct flow:**
- `POST /generate-surf-report` with `{ surfData, apiKey }` — caller provides surf data directly

**Wave size (`waveSizeOf`):** `details.wave_height_ft` is significant wave height (Hs) measured offshore — **not** the face of the wave a surfer rides, which is reliably larger. The prompt is given a body-scale label ("waist to chest high") as `Surf Size` and explicitly instructed not to quote a size in feet, because quoting Hs understates the surf. `/api/surfability` supplies `face_height_ft` and `size_descriptor`; `waveSizeOf` prefers those and recomputes from Hs only when they're absent (older payloads). The conversion mirrors `src/app/lib/waveSize.ts` in the Next.js app — this service deploys separately and can't import from it, so `waveSize.test.ts` here and `tests/unit/wave-size.test.ts` there share an identical golden table as a drift guard. Change both implementations, then both tables.

**Report variety** (`OPENING_ANGLES`, `REPORT_SHAPES`): both are rotated per call, not per data, so identical conditions don't produce identical prose. `OPENING_ANGLES` varies the first sentence; `REPORT_SHAPES` varies how the body is organised.

`REPORT_SHAPES` exists because rotating only the opener wasn't enough. Measured over 179 eval reports, the six most common beat orders all ended `… → tide → water temp → verdict` and 88% of reports mentioned water temperature, because paragraph 1's spec *enumerated* the factors to cover and so prescribed the order to cover them in. Replacing that enumeration with a rotated shape cut water-temp mentions to 30% and the "tide is … in your favor" frame from 33% to 23%.

It did **not** fix lexical repetition: top-10 sentence-opener share barely moved (63% → 61%) and the most-shared 7-gram still reaches 16% of reports. Structural rotation fixes structure; the remaining sameness is sentence rhythm and frame reuse.

**That residue was investigated and deliberately left alone — don't re-open it without reading the next section.** Pooled corpus statistics overstate it badly. The case a real user actually experiences is one spot read repeatedly, and on the worst case available (same spot, identical conditions, two reports back to back) six of seven pairs shared **zero** 7-word frames, at 24-32% word overlap. A favourite phrase recurring in 16% of a pooled corpus is a verbal tic, not a template tell — arguably part of the consistent local voice `voiceDescriptor` exists to cultivate. Contrast the structural problem above, which showed up in a *single* read.

If a specific phrase does start grating in production, add it to `GATED_STOCK_PHRASES`; the gate and targeted retry remove it with no prompt surgery. That's much cheaper than another prompt experiment.

Nothing the prompt embeds may contain a phrase from `GATED_STOCK_PHRASES`. `getWaveQuality` used to return "...waves will be quick and choppy", which the prompt passes in as a Wave Quality hint — the model echoed it and was then rejected for it, making it the most-rejected phrase in every eval run. `stock-phrases.test.ts` guards this across every hint branch.

**Stock phrases** (`STOCK_PHRASES`): the prompt's `AVOID STOCK PHRASES` line is generated from this array, so the banned list and the detector can't drift. The list is split in two, because measured incidence differs by an order of magnitude. `GATED_STOCK_PHRASES` ("bathwater warm", "quick and choppy", …) are a hard `validateReportText` rejection — ~13% incidence, which the retry ladder absorbs. `MONITORED_STOCK_PHRASES` is just `"honestly"`, reported by the eval harness but **never** a rejection reason: it's an ordinary adverb appearing in ~45% of reports, and gating it would bounce nearly half of all output into the retry.

The instruction alone was measurably ~0% effective — 4-5 of every 10 reports contained a banned phrase despite the prompt forbidding them. Prohibitions in the prompt don't enforce themselves; the regex guards do. Same lesson as `CROWD_COUNT_PATTERN`.

**Tests** (`bun test`): unit tests for `waveSizeOf` (including the drift guard above), `pickEarnedSpotFeatures`, and the stock-phrase gated/monitored split. Cheap and offline — unlike the eval harness, these call no models.

**Eval harness** (`eval/harness.ts`, run with `bun run eval`): runs golden scenarios against the real model and asserts on the output — `validateReportText` issues, cross-location and cross-day text-repetition checks, and whether any scenario fell through to the deterministic template.

Three things it reports but does not fail on, because they're instruments for A/B-ing prompt changes rather than regression gates: stock-phrase compliance, shared sentence frames, and sentence-opener concentration. **The jaccard similarity gate is nearly useless for judging variety** — it sits at 22-29% against a 55% threshold on every run, because reports reuse frames and structure while carrying distinct location nouns, which bag-of-words comparison averages away. Use the frame and opener numbers instead.

Both are underpowered within a single 10-report run. To evaluate a prompt change, run the harness several times and pool the transcripts in `eval/output/` — the effects above were only visible at n≈80 or more.

**Pool deliberately, and know which number reflects a user.** Most of this harness compares four locations on identical conditions, which is a view no visitor ever has — a reader sees one spot. Cross-location pooling therefore *inflates* apparent repetition (`"you're looking at knee to waist high"` reaches 22% across locations but the same corpus filtered to one spot looks materially better), and it was what made the residual lexical repetition above look worth chasing when it wasn't. The honest user-facing metric is the **Day 1 vs Day 2 pair**: one location, consecutive reports. Judge prose-quality changes on that; use cross-location only for the convergence regression it was built to catch. Exits non-zero on failure, so it's wired into `.github/workflows/eval-prompt.yml` as a CI gate on changes to `index.ts` or `eval/**`, in addition to being runnable by hand.

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
