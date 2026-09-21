/**
 * A named spot is only useful as a recommendation when it's tied to a reason grounded
 * in today's actual data — otherwise "the best spot" is just whichever one sounds most
 * confident in the local-knowledge prose, regardless of what the swell/wind/tide are
 * doing. archetype + shinesWhen let the prompt pick (or decline to pick) a spot based
 * on today's conditions instead of always defaulting to the same one.
 *
 * shinesWhen is prose, for the AI prompt, which can read it and reason about it in
 * context. The *deterministic* (non-AI) fallback report can't reason about prose, so it
 * has nothing to go on unless shinesWhen is also expressed as shinesWhenConditions —
 * structured, machine-checkable predicates over the same real surf data. Without that,
 * the fallback's only options are to guess by array position (dishonest — it's exactly
 * the "overconfident beach pick" bug fixed for the AI path in fa043e4) or to name no spot
 * at all (honest, but throws away real local knowledge the deterministic path could use).
 */
export interface SpotFeature {
  /** The geographic setup this spot illustrates — e.g. "channel", "inlet jetty", "sandbar peak", "sheltered/mellow stretch", "pier/structure focus". Shared vocabulary across locations so the prompt can reason about setup types, not just names. */
  archetype: string;
  /**
   * Real, named spots at this location that illustrate the archetype — often several
   * are genuinely interchangeable (per-call caller code picks one at random rather than
   * always showing the first), so the report doesn't repeatedly name the same beach just
   * because it's first in the array.
   */
  examples: string[];
  /** The specific condition under which this setup actually shines (swell size/direction, wind, tide) — must be traceable to something in localKnowledge, not a blanket "always best" claim. */
  shinesWhen: string;
  /**
   * Structured version of shinesWhen: one or more condition groups (OR'd — this
   * archetype is earned if *any* group matches; each group's own fields are AND'd)
   * that `pickEarnedSpotFeatures` checks against real surf data. Every field here must
   * be traceable to the same fact `shinesWhen` states in prose — this isn't a place to
   * invent a plausible-sounding threshold that isn't actually backed by localKnowledge.
   *
   * Omit (or leave empty) for a "most days"/always-decent archetype that isn't tied to
   * a specific trigger — it's then always eligible, the same as a condition-bearing
   * archetype whose condition happens to match today. Some locations genuinely don't
   * have data-groundable differences between their archetypes (see the Boca Raton and
   * Rockaway Beach comments below) — leaving every archetype unconditional there is the
   * honest choice, not a shortcut.
   */
  shinesWhenConditions?: SpotShinesCondition[];
}

export interface SpotShinesCondition {
  /** 16-point compass letters (as degreesToCompass in /api/surfability produces them, e.g. 'NE', 'ENE') the swell must be arriving from. */
  swellFrom?: string[];
  /** Hs (offshore significant wave height, ft — see waveSize.ts for why this isn't the wave face) must be at least this. */
  minWaveHeightFt?: number;
  /** Hs must be at most this. */
  maxWaveHeightFt?: number;
  /** Wave period (s) must be at least this. */
  minPeriodSec?: number;
  /** Wave period (s) must be at most this. */
  maxPeriodSec?: number;
  /** tide_state (e.g. "Low Rising", "Mid Falling") must contain at least one of these substrings. */
  tideIncludes?: string[];
  /** Wind must read as onshore or offshore per wind_direction_description (e.g. "NW offshore (clean offshore conditions)"). */
  wind?: 'onshore' | 'offshore';
}

/** The minimal real surf-data shape shinesWhenConditions are checked against. */
export interface ShinesWhenData {
  swellDirectionCompass: string;
  windDirectionDescription: string;
  waveHeightFt: number;
  wavePeriodSec: number;
  tideState: string;
}

function matchesCondition(condition: SpotShinesCondition, data: ShinesWhenData): boolean {
  if (condition.swellFrom && !condition.swellFrom.includes(data.swellDirectionCompass)) return false;
  if (condition.minWaveHeightFt !== undefined && data.waveHeightFt < condition.minWaveHeightFt) return false;
  if (condition.maxWaveHeightFt !== undefined && data.waveHeightFt > condition.maxWaveHeightFt) return false;
  if (condition.minPeriodSec !== undefined && data.wavePeriodSec < condition.minPeriodSec) return false;
  if (condition.maxPeriodSec !== undefined && data.wavePeriodSec > condition.maxPeriodSec) return false;
  if (condition.tideIncludes && !condition.tideIncludes.some(t => data.tideState.includes(t))) return false;
  if (condition.wind && !data.windDirectionDescription.toLowerCase().includes(condition.wind)) return false;
  return true;
}

/**
 * Which of a location's spotFeatures are genuinely earned by today's real data, for the
 * deterministic (non-AI) fallback report. An archetype with no shinesWhenConditions is
 * always eligible (it's not tied to a specific trigger); one with conditions is eligible
 * only when at least one of its OR'd condition groups actually matches. Can return an
 * empty array — when every condition-bearing archetype fails to match and none are
 * unconditional, the honest answer is to name no spot rather than guess one.
 */
export function pickEarnedSpotFeatures(spotFeatures: SpotFeature[], data: ShinesWhenData): SpotFeature[] {
  return spotFeatures.filter(f =>
    !f.shinesWhenConditions?.length || f.shinesWhenConditions.some(c => matchesCondition(c, data))
  );
}

export interface Location {
  slug: string;
  name: string;
  lat: number;
  lon: number;
  noaaStationId: string;
  timezone: string;
  coastFacingDeg: number; // direction the coast faces (toward the ocean), 0=N, 90=E, 180=S, 270=W
  /**
   * Multiplier applied to the Open-Meteo modelled significant wave height to correct
   * a systematic, location-specific bias. The global wave model resolves open water,
   * not the shoaling/refraction each of these beaches sits behind, so its bias varies
   * by site — it runs ~44% low at St. Augustine and ~12% high on Oahu's North Shore.
   *
   * Each factor is mean(buoy Hs) / mean(model Hs) against the nearest NDBC wave buoy
   * over two complete calendar years (see calibrationBuoyId / calibrationFittedOn),
   * validated out-of-sample by fitting on the first year and scoring on the second.
   * Only factors that beat no correction are applied.
   *
   * The window length matters more than it looks. The bias is strongly seasonal —
   * winter high, summer low, swinging 15-53% across the year at these sites — so a
   * factor fitted over a single month encodes whatever season it was fitted in. The
   * previous generation of factors was fitted in one September window and was
   * materially wrong at four locations as a result; at Oahu the September value was
   * worse than applying no correction at all. Re-fit over a full year, not a month:
   * `pnpm calibration-seasonality --recommend`.
   *
   * Year-over-year the same calendar month repeats to within 3-7%, so these drift
   * slowly. `pnpm refit-calibration` is a cheap monitor for a dead buoy or a genuine
   * regime change, not a source of replacement values.
   */
  waveHeightCalibration: number;
  calibrationBuoyId: string | null; // NDBC station the factor was fitted against
  calibrationFittedOn: string | null; // ISO date of the fit
  calibrationWindow: string | null; // data the fit was computed over
  spotFeatures: SpotFeature[];
  localKnowledge: string;
  voiceDescriptor: string;
}

export const LOCATIONS: Location[] = [
  {
    slug: 'st-augustine',
    name: 'St. Augustine, FL',
    lat: 29.9,
    lon: -81.3,
    noaaStationId: '8720218',
    timezone: 'America/New_York',
    coastFacingDeg: 90,
    // fitted 1.80 (buoy 24km); out-of-sample RMSE 0.495m -> 0.165m
    // the flattest seasonal profile of the set: 1.79-1.81 across all four quarters
    waveHeightCalibration: 1.80,
    calibrationBuoyId: '41117',
    calibrationFittedOn: '2026-09-16',
    calibrationWindow: '2024-2025',
    // TODO(matt): drafted from the existing localKnowledge prose below — you know these
    // breaks firsthand, please correct shinesWhen if it doesn't match reality.
    spotFeatures: [
      { archetype: 'sandbar peak', examples: ['Vilano Beach', 'Anastasia State Park', 'Crescent Beach', 'Matanzas Inlet'], shinesWhen: 'most swell and tide combos — this stretch has several beaches with well-defined sandbars, not just one' },
      {
        archetype: 'pier/structure focus', examples: ['St. Augustine Pier'],
        shinesWhen: 'when the swell angle lines up with the pilings, which can focus and hollow the wave out',
        // localKnowledge's own quoted workable window is NE to E — "lined up" is that band.
        shinesWhenConditions: [{ swellFrom: ['NE', 'ENE', 'E'] }],
      },
      {
        archetype: 'sheltered/mellow stretch', examples: ['Crescent Beach'],
        shinesWhen: 'bigger or messier swell, onshore wind, or a beginner-friendly session — more protected than the open sandbar peaks',
        // "bigger" relative to localKnowledge's quoted 2-6ft range; "onshore wind" as stated.
        shinesWhenConditions: [{ minWaveHeightFt: 5 }, { wind: 'onshore' }],
      },
    ],
    localKnowledge: `East-facing beach break. Works best on NE to E swell, 2–6ft at 8s+. Offshore on W–NW winds. Sandbars shift constantly — Vilano Beach tends to have the most defined peaks. Crescent Beach is more sheltered and mellower, good for beginners. The pier area can focus and hollow out the swell. Mid rising tide is usually the sweet spot. Summer is almost flat; fall through spring is prime season. Water is warm year-round — no wetsuit needed summer through early fall.`,
    voiceDescriptor: `laid-back Florida local who knows every sandbar at St. Augustine. Practical and honest — doesn't oversell bad surf but gets genuinely stoked when the swell shows up`,
  },
  {
    slug: 'boca-raton',
    name: 'Boca Raton, FL',
    lat: 26.35,
    lon: -80.07,
    noaaStationId: '8722670',
    timezone: 'America/New_York',
    coastFacingDeg: 90,
    // fitted 0.67 (buoy 39km); out-of-sample RMSE 0.469m -> 0.272m
    // Least trustworthy factor of the set and the only one no schedule helps: 74%
    // seasonal amplitude with an 18% year-over-year gap, plus whole months missing
    // from 41122's record. No nearer wave buoy exists — pvgf1/lkwf1/pegf1 are all
    // ~29km but met-only. Treat this as a compromise, not a measurement.
    waveHeightCalibration: 0.67,
    calibrationBuoyId: '41122',
    calibrationFittedOn: '2026-09-16',
    calibrationWindow: '2024-2025',
    // checked via web research (see .claude/skills/spot-features-research) — Boca is a
    // short stretch and each archetype only turned up the one well-documented spot
    // already listed here, no additional interchangeable examples found
    //
    // No shinesWhenConditions on any of these three: localKnowledge differentiates them
    // by crowding and "does the tide suit them", neither of which is data this pipeline
    // has. Inventing a plausible-looking tide/swell threshold here would be exactly the
    // ungrounded-guess problem this mechanism exists to avoid — leaving all three
    // unconditional (each always eligible) is the honest reflection of what's actually
    // known.
    spotFeatures: [
      { archetype: 'inlet jetty', examples: ['Boca Inlet South Jetty'], shinesWhen: 'most days — the jetty focuses swell and builds the most reliable sandbars in the area, but check the rip current hazard near the inlet' },
      { archetype: 'sandbar peak', examples: ['Spanish River Park'], shinesWhen: 'typical beach-break conditions away from the inlet' },
      { archetype: 'open beach break', examples: ['Red Reef Park'], shinesWhen: 'an alternative stretch when the inlet peaks are crowded or the tide does not suit them' },
    ],
    localKnowledge: `East-facing stretch of beach break. Very tide-sensitive — low to mid rising is best on most peaks. The Boca Inlet jetties focus swell and create sandbars on the south side, often the best setup in the area. Summer is mostly flat; fall and spring can bring SE swell from tropical systems. Winter NE swells lose energy working down the coast and often arrive soft and disorganised. Seagrass patches near shore can grab fins at low tide. Offshore on W–NW winds. Rip currents common near the inlet — respect the hazard.`,
    voiceDescriptor: `South Florida surfer who keeps expectations realistic but celebrates the spot's potential. Comfortable recommending when to wait for a better swell, but genuinely stoked when conditions deliver`,
  },
  {
    slug: 'higgins-beach',
    name: 'Higgins Beach, ME',
    lat: 43.55,
    lon: -70.27,
    noaaStationId: '8418150',
    timezone: 'America/New_York',
    coastFacingDeg: 135,
    // fitted 1.13 (buoy 11km); out-of-sample RMSE 0.240m -> 0.208m
    // Previously pinned to 1.00 as "already unbiased" on a September window. Over two
    // full years the model runs ~12% low here in every single month, 1.07-1.16 by quarter —
    // the September fit happened to land on the one part of the year that looked clean.
    waveHeightCalibration: 1.13,
    calibrationBuoyId: '44007',
    calibrationFittedOn: '2026-09-16',
    calibrationWindow: '2024-2025',
    // examples sourced via web research (see .claude/skills/spot-features-research)
    spotFeatures: [
      {
        archetype: 'sandbar peak', examples: ['Higgins Beach'],
        shinesWhen: 'low to mid tide, when the sandbars are exposed and producing the best-defined peaks',
        shinesWhenConditions: [{ tideIncludes: ['Low', 'Mid'] }],
      },
      {
        archetype: 'open beach break', examples: ['Scarborough Beach', 'Old Orchard Beach'],
        shinesWhen: 'an alternative when Higgins is crowded or its sandbar shape has shifted',
        // localKnowledge: "High tide often floods the [Higgins] beach entirely" — that's
        // the one condition here actually traceable to a stated fact, not the crowding.
        shinesWhenConditions: [{ tideIncludes: ['High'] }],
      },
      {
        archetype: 'sheltered/mellow stretch', examples: ['Pine Point'],
        shinesWhen: 'smaller or messier swell, or a more forgiving session',
        shinesWhenConditions: [{ maxWaveHeightFt: 3 }],
      },
    ],
    localKnowledge: `North Atlantic cold-water beach break, facing southeast. Prime season is September through May. NE groundswell from winter nor'easters and Gulf of Maine fetch can deliver hollow, powerful waves. Offshore on NW winds. Tidal range is extreme (10–12ft) — timing the tide is critical; low to mid tide usually produces the best peaks over the sandbars. High tide often floods the beach entirely. Water is cold year-round: 5/4mm suit with hood and gloves in winter (38–50°F), at least a 3/2mm spring through fall (55–65°F). Hurricane season (August–October) brings some of the best long-period groundswells. Fog is common — check visibility before paddling out.`,
    voiceDescriptor: `Maine surfer — stoic, no-nonsense, comfortable in cold water. Respects the ocean's power and calls conditions accurately. Gets quietly stoked when it goes off, matter-of-fact about the cold`,
  },
  {
    slug: 'folly-beach',
    name: 'Folly Beach, SC',
    lat: 32.65,
    lon: -79.94,
    noaaStationId: '8665530',
    timezone: 'America/New_York',
    coastFacingDeg: 155,
    // fitted 1.94 (buoy 81km offshore); out-of-sample RMSE 0.732m -> 0.323m
    // Strongest seasonal swing of the set — Q1 2.15 vs Q2 1.70 — so this annual constant
    // is a compromise between winter and summer. Per-quarter factors would cut another
    // 8% here, the largest such gain of any location.
    waveHeightCalibration: 1.94,
    calibrationBuoyId: '41004',
    calibrationFittedOn: '2026-09-16',
    calibrationWindow: '2024-2025',
    // examples sourced via web research (see .claude/skills/spot-features-research) from
    // follybeach.com and visitfolly.com spot guides — matt, you were just there, please
    // correct anything that doesn't match what you saw.
    spotFeatures: [
      { archetype: 'channel', examples: ['The Washout'], shinesWhen: 'most days — a natural channel concentrates swell here more than anywhere else on the island, producing the cleanest peaks with the most push' },
      {
        archetype: 'pier/structure focus', examples: ['Folly Beach Pier'],
        shinesWhen: 'when the swell lines up with the pier pilings for a hollower wave',
        // localKnowledge's own quoted workable window is NE to E.
        shinesWhenConditions: [{ swellFrom: ['NE', 'ENE', 'E'] }],
      },
      { archetype: 'sandbar peak', examples: ['Center Street', '10th Street East', '6th Street East', '13th Street East'], shinesWhen: 'typical beach-break conditions along the developed middle stretch of the island, between the pier and the Washout — several sandbar-and-groin peaks here, not just one' },
    ],
    localKnowledge: `Atlantic-facing barrier island beach break near Charleston, facing south-southeast. Works best on NE to E swell, 3–8ft. The Washout on the west end is the most consistent spot — a natural channel concentrates swell and often produces the cleanest peaks with the most push. Offshore on N–NW winds (which are offshore at the Washout due to its orientation). Significant tidal range (5–6ft) — low to mid rising is usually best. Summer is almost completely flat; fall hurricane season is the best time of year. Water temp is comfortable June–November (70–82°F), cooler spring and winter (55–65°F).`,
    voiceDescriptor: `Charleston-area surfer — chill and unpretentious. Knows the spot's limitations and says so honestly, but gets properly stoked when the fall swells show up. Straightforward about when to skip it`,
  },
  {
    slug: 'rockaway-beach',
    name: 'Rockaway Beach, NY',
    lat: 40.58,
    lon: -73.85,
    noaaStationId: '8531680',
    timezone: 'America/New_York',
    coastFacingDeg: 180,
    // fitted 1.40 (buoy 27km); out-of-sample RMSE 0.377m -> 0.190m
    waveHeightCalibration: 1.40,
    calibrationBuoyId: '44065',
    calibrationFittedOn: '2026-09-16',
    calibrationWindow: '2024-2025',
    // examples sourced via web research (see .claude/skills/spot-features-research)
    //
    // No shinesWhenConditions on any of these three: what actually differentiates them
    // per localKnowledge is crowding ("crowds are intense on good days"), which isn't
    // data this pipeline has — not swell/wind/tide. Leaving all three unconditional
    // (always eligible) reflects that honestly rather than inventing a fake trigger.
    spotFeatures: [
      { archetype: 'jetty-defined peaks', examples: ['Beach 90th Street', 'Beach 67th Street'], shinesWhen: 'most days — these jetties focus swell into defined peaks, though crowds get intense here on good days' },
      { archetype: 'open beach break', examples: ['Riis Park'], shinesWhen: 'when the jetty stretch is too crowded or its sandbars are not holding shape' },
      { archetype: 'sandbar peak', examples: ['Arverne'], shinesWhen: 'an alternative stretch away from the jetty crowds' },
    ],
    localKnowledge: `South-facing Atlantic beach break on the Rockaway Peninsula in Queens, NYC. Picks up NE to SE groundswell and frequent wind swell. Jetties at 67th and 90th Streets focus swell and create defined peaks between them — the best sandbars shift season to season. Can get surprisingly powerful on NE storm swells and during hurricane season. Offshore on N–NW winds. Moderate tidal range (4–5ft) — mid tide tends to be most consistent. Peak season is fall (September–November); winter can be epic but cold (below 50°F water, full suit and boots essential). Summer is mostly small. Crowds are intense on good days — early morning sessions recommended to get your waves.`,
    voiceDescriptor: `New York City surfer — direct, no-nonsense, proud of the local break. Calls it like it is. Factors in the crowd situation and is upfront about conditions that aren't worth the commute`,
  },
  {
    slug: 'huntington-beach',
    name: 'Huntington Beach, CA',
    lat: 33.65,
    lon: -118.00,
    noaaStationId: '9410660',
    timezone: 'America/Los_Angeles',
    coastFacingDeg: 225,
    // fitted 1.01 over 2024-2025 — i.e. no annual bias, so left uncorrected.
    // out-of-sample RMSE is 0.154m with or without the factor; it does nothing.
    // The bias here is purely seasonal (Q1 1.07, Q3 0.94) and invisible to an annual
    // constant. Per-quarter factors would cut RMSE to 0.144m; that is the only
    // correction this location can benefit from.
    waveHeightCalibration: 1.00,
    calibrationBuoyId: '46222',
    calibrationFittedOn: '2026-09-16',
    calibrationWindow: '2024-2025',
    // examples sourced via web research (see .claude/skills/spot-features-research)
    spotFeatures: [
      { archetype: 'pier/structure focus (longer right)', examples: ['HB Pier north side'], shinesWhen: 'most days — the pier focuses swell into a longer, more workable right' },
      {
        archetype: 'pier/structure focus (punchier)', examples: ['HB Pier south side'],
        shinesWhen: 'when you want more power/punch in the wave than the north side offers',
        shinesWhenConditions: [{ minWaveHeightFt: 3 }],
      },
      { archetype: 'open beach break', examples: ['Bolsa Chica', 'Goldenwest (22nd Street)', 'The Cliffs (Broadway)'], shinesWhen: 'an alternative away from the pier crowds' },
      {
        archetype: 'pier/structure focus', examples: ['Newport Beach Pier', 'Seal Beach Pier'],
        shinesWhen: 'a different swell-angle exposure than HB Pier, worth checking if HB is not working',
        // "if HB is not working" — small/marginal Hs at the pier itself.
        shinesWhenConditions: [{ maxWaveHeightFt: 2 }],
      },
    ],
    localKnowledge: `Classic SoCal beach break. Consistent SW to W swell year-round — Southern Hemisphere groundswells arrive spring and summer, NW swells dominate fall and winter. The pier area focuses swell and creates excellent sandbars on both sides; pier north tends to produce a longer workable right, pier south can be punchier. Offshore on NE winds (Santa Ana conditions — classic glassy mornings). Onshore sea breeze builds through the afternoon most days, so morning sessions are almost always better. Low to mid tide usually best for most peaks. Water is cool year-round (56–72°F) — wetsuit recommended except peak summer for most surfers.`,
    voiceDescriptor: `classic SoCal surf culture — relaxed, enthusiastic, knows the lineup and its rhythms. Straightforward about when morning glass makes the alarm clock worth it versus when you can sleep in`,
  },
  {
    slug: 'oahu',
    name: 'Oahu North Shore, HI',
    lat: 21.67,
    lon: -158.07,
    noaaStationId: '1612340',
    timezone: 'Pacific/Honolulu',
    coastFacingDeg: 0,
    // fitted 0.89 (buoy 5km, Waimea Bay); over 2024-2025 RMSE 0.313m -> 0.258m
    // The previous 0.78 was fitted in September, which is Oahu's annual minimum, and
    // applying it year-round made this location's numbers *worse than no correction at
    // all* (0.371m vs 0.272m out-of-sample). Corrected here.
    // Caveat: 0.89 only edges out no correction out-of-sample (0.266m vs 0.272m) because
    // Oahu also varies year to year — 2024 wants ~0.86, 2025 ~0.90. Per-quarter factors
    // reach 0.236m and are the real fix if this is revisited.
    waveHeightCalibration: 0.89,
    calibrationBuoyId: '51201',
    calibrationFittedOn: '2026-09-16',
    calibrationWindow: '2024-2025',
    // examples sourced via web research (see .claude/skills/spot-features-research)
    spotFeatures: [
      {
        archetype: 'reef break, advanced only', examples: ['Pipeline / Backdoor', 'Off the Wall'],
        shinesWhen: 'a solid N to NW groundswell — the most famous and most demanding waves on this stretch, experienced surfers only',
        shinesWhenConditions: [{ swellFrom: ['N', 'NNW', 'NW'], minWaveHeightFt: 4 }],
      },
      {
        archetype: 'reef/point break, advanced only', examples: ['Sunset Beach', 'Waimea Bay'],
        shinesWhen: 'bigger, more open-water swell, or when Pipeline is too heavy or closing out',
        shinesWhenConditions: [{ minWaveHeightFt: 6 }],
      },
      // No condition: Haleiwa/Chun's/Laniakea are the go-to whenever the two advanced
      // setups above are too heavy (or not firing) — that's the always-eligible default.
      { archetype: 'beach/reef mix, more forgiving', examples: ["Haleiwa Ali'i Beach Park", "Chun's Reef", 'Laniakea'], shinesWhen: 'still powerful, but a more forgiving option than Pipe or Sunset for strong intermediate surfers' },
    ],
    localKnowledge: `North Shore of Oahu — the most famous surf stretch on earth. Works on N to NW groundswells from the North Pacific, typically 6–25ft+ faces at Pipe and Sunset. Prime season is October through April; summer is nearly flat on the North Shore (check Ala Moana / South Shore for south swells instead). Trade winds are typically SE–E and tend to produce cross-shore or light onshore conditions; N winds are offshore. Water is warm year-round (75–82°F) — no wetsuit needed. Mid to high tide is generally better for Pipeline to avoid the dangerous shallow reef. These are serious reef breaks — Pipeline and Sunset require experienced surfers only. Haleiwa is more forgiving but still a powerful beach/reef mix. Respect local etiquette; the lineup pecking order is real.`,
    voiceDescriptor: `experienced Hawaii local who deeply respects the North Shore's power. Honest about the skill level required, clear about seasonal patterns, and genuinely stoked on a solid N swell. Never downplays the ocean's danger`,
  },
];

export function getLocation(slug: string): Location | undefined {
  return LOCATIONS.find(loc => loc.slug === slug);
}

export const DEFAULT_LOCATION_SLUG = 'st-augustine';
