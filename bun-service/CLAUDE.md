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

**Model fallback ladder** (`generateDetailedSurfReport`, `MODEL_TIERS`): Claude Haiku (`@ai-sdk/anthropic`) is primary; if it errors, or its output fails `validateReportText` (banned openers, word-count sanity, contradicting the wind onshore/offshore ground truth, inventing a crowd count, leaning on a gated stock phrase, quoting the surf size in feet, restating the spot's cardinal orientation, or naming a weekday that isn't today's), the prompt is retried against OpenAI `gpt-4o-mini` (`@ai-sdk/openai`) as a secondary model.

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

Nothing the prompt embeds may contain a phrase from `GATED_STOCK_PHRASES`. `getWaveQuality` used to return "...waves will be quick and choppy", which the prompt passed in as a Wave Quality hint — the model echoed it and was then rejected for it, making it the most-rejected phrase in every eval run. `stock-phrases.test.ts` guards this across every data branch. (Both hint helpers have since been deleted — see the rule audit below — so that particular trap can no longer be set, but the invariant still has to hold for everything else the prompt embeds.)

**Stock phrases** (`STOCK_PHRASES`): the prompt's `AVOID STOCK PHRASES` line is generated from this array, so the banned list and the detector can't drift. The list is split in two, because measured incidence differs by an order of magnitude. `GATED_STOCK_PHRASES` ("bathwater warm", "quick and choppy", …) are a hard `validateReportText` rejection — ~13% incidence, which the retry ladder absorbs. `MONITORED_STOCK_PHRASES` is just `"honestly"`, reported by the eval harness but **never** a rejection reason: it's an ordinary adverb appearing in ~45% of reports, and gating it would bounce nearly half of all output into the retry.

The instruction alone was measurably ~0% effective — 4-5 of every 10 reports contained a banned phrase despite the prompt forbidding them. Prohibitions in the prompt don't enforce themselves; the regex guards do. Same lesson as `CROWD_COUNT_PATTERN`.

## The prompt's rules: which ones actually work

Every remaining rule in `createDetailedSurfPrompt` has now been measured the same way `AVOID STOCK PHRASES` was. **The headline is that "prompt prohibitions don't work" is too simple a lesson** — some of them do enormous work, some do nothing, and the only way to tell them apart is to delete one and count. Don't re-litigate these from intuition.

Two corpora were used. **Observational**: 318 model-generated reports pooled from `eval/output/` (fallbacks excluded), split by the commit that introduced each rule, which gives a natural before/after wherever a rule postdates some transcripts. **Ablation**: the production prompt with exactly one rule deleted, run against Haiku at the production temperature with no validation or retry, n≈40 per arm — that measures raw incidence, which the gated eval transcript can't show you.

| Rule | Measured | Verdict |
|---|---|---|
| `NOTE: Do not restate raw figures` | **18% → 93%** when deleted (period alone 15% → 88%) | **Kept.** By far the hardest-working line in the prompt |
| `NOTE ON SIZE` (no feet) | 15% before the data line switched to body scale, **0/278 after**; deleting the note changes nothing (0/39) | **Shortened, and now gated.** See below |
| `NOTE:` hints are "not sentences to paraphrase" | echo 60% with it, **70% without** — no effect. Deleting the *hints* instead: **3%** | **Deleted, with the hints.** See below |
| `NOTE:` no date / day-of-week / season | weekday wrong **0/318**; season framing ~15% but traceable to LOCAL KNOWLEDGE, so permitted by the rule's own carve-out | **Kept**, obeyed. Weekday half now gated as a backstop |
| `NOTE:` don't restate cardinal orientation | 18% before the rule → 7% → **3.4%** now | **Shortened, and now gated** for the residue |
| `AVOID GENERIC OPENERS` | 0/318 in the corpus, and **0/39 with the line deleted** | **Deleted.** `BANNED_OPENERS` still gates it; the prose was doing nothing |
| Daylight-window rule | **0/40** baseline and 0/278 post-rule; 2/38 when deleted | **Kept**, obeyed. Not gateable — see below |

Three of these are worth understanding rather than just knowing:

- **`NOTE ON SIZE` was never the thing that fixed quoting feet.** The commit that added it also replaced the raw `Wave Height: 1.8 ft` data line with the body-scale `Surf Size` label. Deleting the note leaves incidence at zero, because the model no longer has a number in feet to quote. The note is now one clause instead of five sentences, and `size_in_feet` gates it — at 0% incidence that costs nothing and guards the highest-stakes rule in the prompt against a future prompt or model change putting a feet figure back in front of the model.

- **The hint lines were causing the thing their own note forbade.** `Wave Quality` and `Tide Context` were prose sentences generated from `wave_period_sec` and `tide_state` — both already in the prompt — so they added no information and handed the model a ready-made sentence to paraphrase. It did, in 60% of reports ("little organisation between sets", "the best window for shape and power"). The note telling it not to was worth nothing (70% without it). Gating was not an option at that incidence, for the same reason `"honestly"` isn't gated. Deleting both helpers took the echo to 3% with no loss of reasoning about period or tide — the model derives it from the raw data, which is where it was coming from anyway. **If you are tempted to re-add an interpretive hint line, don't: it will come back as prose.**

- **The daylight rule is obeyed and deliberately not gated.** The rule explicitly *permits* naming an after-dark tide in order to rule it out, and the model uses that permission well ("the next low hits after sunset — no good to you"). A regex can see the time but not the framing, so a gate would reject the compliant case along with the violation. Its ablation arm (0/40 → 2/38) is suggestive but not significant at this n; it stays on the strength of being obeyed and the failure being user-harmful.

**Paragraph 2 is not the structural problem paragraph 1 was.** The suspicion was that the `For where to go:` block enumerates its beats and so prescribes their order, the way paragraph 1's spec did before `REPORT_SHAPES`. Measured on the same beat-order instrument, it doesn't: paragraph 2 opens on its most common beat 66% of the time across 30 distinct orders, where paragraph 1 — *after* the fix — opens on its most common beat 84% of the time across 23. Paragraph 2 is the less templated of the two. It also didn't move across the #58 boundary, which is the control that says the instrument is reading prompt structure and not noise. No `REPORT_SHAPES` equivalent is warranted for it.

**How to audit another rule.** Write a detector for the thing the rule forbids and run it over the pooled `eval/output/` transcripts first — free, and if the rule postdates some of them you get a natural experiment. If it doesn't, ablate: string-surgery one line out of the real prompt, call the model directly with no validation or retry (that's the part the eval harness can't give you, since gated output is invisible), n≈40 per arm. Then decide by measured incidence, exactly as the gated/monitored stock-phrase split did: gate when the retry ladder can absorb it (≤~13%), leave it monitored when it can't (~45%). Two traps worth avoiding, both of which caught this audit: check what the fixture data actually says before calling something a hallucination (`2026-08-28` in the harness is a **Friday**, and a first pass scored every correct "Friday afternoon" as a wrong-date bug), and make sure a detector is measuring the violation rather than its vicinity (the daylight detector first counted "you've got light until 8 PM", which is the rule being followed).

**Tests** (`bun test`): unit tests for `waveSizeOf` (including the drift guard above), `pickEarnedSpotFeatures`, the stock-phrase gated/monitored split, and the three rule gates added by the audit above (`report-rules.test.ts`). Cheap and offline — unlike the eval harness, these call no models.

The `size_in_feet` gate is the one with a real precision problem to respect: tide height, water depth and distance are all legitimately quoted in feet — the prompt itself supplies the tide that way — so the gate excludes those contexts rather than requiring a wave context, which missed a bare `"1.8 feet just doesn't have the juice"`. As tuned it catches 5 of the 6 known violations with **zero** false positives across all 278 compliant reports in the corpus. Across four eval runs after the change the three new gates fired on 5% of reports (all `restated_orientation`), every one absorbed by the retry with no fallthrough to the deterministic template.

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
