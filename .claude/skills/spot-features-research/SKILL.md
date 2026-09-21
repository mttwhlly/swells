---
name: spot-features-research
description: Research real, named surf spots to populate a location's spotFeatures.examples in src/app/lib/locations.ts (and mirror into bun-service/eval/harness.ts where that location already appears there). Use when adding a new location to LOCATIONS, or when an existing location's archetypes only have one example and firsthand local correction isn't available.
---

## Why this exists

`spotFeatures` (see the `SpotFeature` doc comment in `src/app/lib/locations.ts`) lets the
generation prompt name a specific real spot only when today's conditions match that
spot's `shinesWhen`. Where an archetype genuinely has several interchangeable named
spots, `examples` should list all of them — `pickExample()` (in `bun-service/index.ts`
and `src/app/api/surf-report/route.ts`) picks one at random per call so the report
doesn't always surface the same beach. A single-entry `examples` array is not wrong,
it just means the research below didn't turn up a second genuinely interchangeable spot
— don't pad it with a weak or ambiguous one just to have two.

Firsthand correction from Matt (who has actually surfed these breaks) always beats web
research — ask first if he's been there recently, per CLAUDE.md's guidance for this repo.
This skill is for the locations where that isn't available yet.

## Process

For each location, working from its existing `spotFeatures` archetypes (don't invent new
archetypes — that's a bigger structural change than "add examples"):

1. **Search broadly first**, e.g. `WebSearch("<location> surf spots named breaks guide")`,
   then **fetch the richest-looking result(s)** with `WebFetch` for full spot-by-spot
   detail (a search snippet is usually too thin to judge fit; the fetched page's actual
   list of named spots with descriptions is what you need).
2. Good sources: official visitor/city sites, established local surf shops, aggregator
   surf-guide sites (Surfline, surf-forecast, American Surf Magazine, etc.) that name and
   describe individual spots. Treat a single vague mention with no description as
   insufficient.
3. **Only add a spot as an additional example when**:
   - it's a real, specifically named place (not "the beach in general"),
   - it's geographically part of the same location (same town/stretch of coast — use
     judgment on distance the way the existing data does: St. Augustine's sandbar-peak
     examples span roughly the same ~20mi stretch as its single-spot archetypes),
   - its documented character genuinely matches the archetype's existing `shinesWhen` —
     don't reassign a spot to a different archetype than the one already defined, and
     don't invent a new archetype to fit a spot that doesn't match any existing one,
     and
   - it's corroborated by more than a passing one-line mention, or, if only one source
     names it, that source gives real distinguishing detail (break type, tide/swell
     preference) rather than just a name in a list.
4. **When research finds nothing usable**, say so in a code comment rather than forcing
   in a weak match — see the Boca Raton entry in `locations.ts` for the pattern. A
   short coastline genuinely may have only one well-known spot per archetype.
5. **Apply the result**:
   - Edit `examples: [...]` in the relevant `SpotFeature` entry in
     `src/app/lib/locations.ts`. Don't touch `shinesWhen` unless a new example needs it
     reworded to still apply to all examples in that archetype.
   - Add a one-line comment above the location's `spotFeatures` block noting it was
     "sourced via web research (see .claude/skills/spot-features-research)" and, if the
     location is one Matt has actually surfed, inviting correction.
   - Check whether the location's `slug` already has a hardcoded scenario context in
     `bun-service/eval/harness.ts`'s `CROSS_LOCATION_CONTEXTS` (only a subset of
     locations are mirrored there). If it does, apply the identical `examples` change
     there too — the two must stay in sync the same way the wave-size golden tables do.
6. **Verify**: `pnpm type-check` (Next.js side) and, from `bun-service/`,
   `bun build index.ts --target bun --outdir /tmp/x` (a quick compile check — `bun build`
   without `--target bun` fails on `import { serve } from "bun"` even when the code is
   fine) plus `bun test`. Neither suite asserts on specific spot names, so this only
   catches structural breakage, not factual accuracy — accuracy rests on the sourcing
   bar above and, ultimately, firsthand correction.

## Example search queries that worked

- `"<Location> surf spots" "<existing example 1>" "<existing example 2>" named breaks guide`
  — anchoring the query on spots you already have surfaces guides that list the rest.
- `"<Location> surf" "<archetype-ish term, e.g. jetty/pier/inlet>" alternatives named breaks`
- Follow up with `WebFetch` on the most detailed-looking guide site, prompting for
  "every named spot mentioned, with break type and swell/tide/skill notes."
