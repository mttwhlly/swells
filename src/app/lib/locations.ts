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
   * by site — it runs ~43% low at St. Augustine and ~22% high on Oahu's North Shore.
   *
   * Each factor is mean(buoy Hs) / mean(model Hs) fitted against the nearest NDBC
   * wave buoy over ~30 days (see calibrationBuoyId / calibrationFittedOn). Validated
   * out-of-sample by fitting on the first half of the window and testing on the
   * second; only factors that measurably beat no correction are applied, the rest
   * are pinned to 1.0.
   *
   * These are fitted on a single season and are expected to drift — re-fit
   * periodically rather than treating them as constants.
   */
  waveHeightCalibration: number;
  calibrationBuoyId: string | null; // NDBC station the factor was fitted against
  calibrationFittedOn: string | null; // ISO date of the fit
  bestSpots: string[];
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
    // fitted 1.74 (r=0.89, 24km); out-of-sample RMSE 0.34m -> 0.12m
    waveHeightCalibration: 1.74,
    calibrationBuoyId: '41117',
    calibrationFittedOn: '2026-09-13',
    bestSpots: ['Vilano Beach', 'St. Augustine Pier', 'Crescent Beach'],
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
    // fitted 0.83 (r=0.73, 39km); out-of-sample RMSE 0.17m -> 0.14m
    waveHeightCalibration: 0.83,
    calibrationBuoyId: '41122',
    calibrationFittedOn: '2026-09-13',
    bestSpots: ['Spanish River Park', 'Red Reef Park', 'Boca Inlet South Jetty'],
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
    // fitted 1.00 (r=0.88, 11km) — model already unbiased here, no correction
    waveHeightCalibration: 1.00,
    calibrationBuoyId: '44007',
    calibrationFittedOn: '2026-09-13',
    bestSpots: ['Higgins Beach', 'Scarborough Beach', 'Pine Point'],
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
    // fitted 1.58 (r=0.89) but nearest live buoy is 81km offshore — weakest provenance of the set
    waveHeightCalibration: 1.58,
    calibrationBuoyId: '41004',
    calibrationFittedOn: '2026-09-13',
    bestSpots: ['The Washout', 'Folly Beach Pier', 'Center Street'],
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
    // fitted 1.36 (r=0.90, 27km); out-of-sample RMSE 0.27m -> 0.16m
    waveHeightCalibration: 1.36,
    calibrationBuoyId: '44065',
    calibrationFittedOn: '2026-09-13',
    bestSpots: ['Rockaway Beach 90th–110th St', 'Riis Park', 'Arverne'],
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
    // fitted 0.94 (r=0.74, 29km) but barely beat no correction — left uncorrected
    waveHeightCalibration: 1.00,
    calibrationBuoyId: '46222',
    calibrationFittedOn: '2026-09-13',
    bestSpots: ['HB Pier (north and south sides)', 'Bolsa Chica', 'Newport Beach Pier'],
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
    // fitted 0.78 (r=0.90, 5km, Waimea Bay); out-of-sample RMSE 0.42m -> 0.22m
    waveHeightCalibration: 0.78,
    calibrationBuoyId: '51201',
    calibrationFittedOn: '2026-09-13',
    bestSpots: ['Pipeline / Backdoor', 'Sunset Beach', "Haleiwa Ali'i Beach Park"],
    localKnowledge: `North Shore of Oahu — the most famous surf stretch on earth. Works on N to NW groundswells from the North Pacific, typically 6–25ft+ faces at Pipe and Sunset. Prime season is October through April; summer is nearly flat on the North Shore (check Ala Moana / South Shore for south swells instead). Trade winds are typically SE–E and tend to produce cross-shore or light onshore conditions; N winds are offshore. Water is warm year-round (75–82°F) — no wetsuit needed. Mid to high tide is generally better for Pipeline to avoid the dangerous shallow reef. These are serious reef breaks — Pipeline and Sunset require experienced surfers only. Haleiwa is more forgiving but still a powerful beach/reef mix. Respect local etiquette; the lineup pecking order is real.`,
    voiceDescriptor: `experienced Hawaii local who deeply respects the North Shore's power. Honest about the skill level required, clear about seasonal patterns, and genuinely stoked on a solid N swell. Never downplays the ocean's danger`,
  },
];

export function getLocation(slug: string): Location | undefined {
  return LOCATIONS.find(loc => loc.slug === slug);
}

export const DEFAULT_LOCATION_SLUG = 'st-augustine';
