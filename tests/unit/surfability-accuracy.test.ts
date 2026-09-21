import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/api/surfability/route';
import { LOCATIONS, getLocation } from '@/lib/locations';

// These cover the two accuracy corrections made on 2026-09-13:
//   1. surf scoring is relative to each location's coastFacingDeg, not hardcoded to
//      an east-facing Florida beach
//   2. modelled wave height is multiplied by a per-location calibration factor

const MARINE_WAVE_HEIGHT_M = 1.0;

function marineResponse() {
  const time = [new Date().toISOString().slice(0, 13) + ':00'];
  return {
    hourly: {
      time,
      wave_height: [MARINE_WAVE_HEIGHT_M],
      wave_period: [9],
      swell_wave_direction: [90],
      sea_surface_temperature: [26],
    },
  };
}

function weatherResponse(windDirection: number, windSpeedKmh: number) {
  return {
    current: {
      temperature_2m: 28,
      weather_code: 0,
      wind_speed_10m: windSpeedKmh,
      wind_direction_10m: windDirection,
    },
  };
}

/** Stub the three upstream APIs so only our own logic is under test. */
function stubUpstream({
  swellDirection,
  windDirection,
  windSpeedKmh = 18.5, // ~10 kts
  waveHeightM = MARINE_WAVE_HEIGHT_M,
}: {
  swellDirection: number;
  windDirection: number;
  windSpeedKmh?: number;
  waveHeightM?: number;
}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/marine')) {
        const body = marineResponse();
        body.hourly.wave_height = [waveHeightM];
        body.hourly.swell_wave_direction = [swellDirection];
        return new Response(JSON.stringify(body), { status: 200 });
      }
      if (url.includes('/v1/forecast')) {
        return new Response(JSON.stringify(weatherResponse(windDirection, windSpeedKmh)), {
          status: 200,
        });
      }
      if (url.includes('tidesandcurrents')) {
        // No tide predictions -> route falls back to its default tide handling.
        return new Response(JSON.stringify({ predictions: [] }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    })
  );
}

async function getReport(slug: string) {
  const res = await GET(new NextRequest(`http://localhost:3000/api/surfability?location=${slug}`));
  return res.json();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('swell/wind scoring is relative to the coast orientation', () => {
  // Asserted as a *difference* between ideal and backside conditions at the same
  // location. The absolute score is not usable here: the wave-height and period
  // terms alone can clear any fixed threshold, which lets the old location-blind
  // scoring pass an absolute assertion at coasts it was actively getting wrong.
  const MODERATE_WIND_KMH = 22.2; // ~12 kts: offshore scores 20, onshore scores 0

  it.each(LOCATIONS.map((l) => [l.slug, l.coastFacingDeg] as const))(
    'rates ideal conditions 40 points above backside conditions at %s',
    async (slug, coastFacingDeg) => {
      stubUpstream({
        swellDirection: coastFacingDeg, // square onto the beach
        windDirection: (coastFacingDeg + 180) % 360, // straight offshore
        windSpeedKmh: MODERATE_WIND_KMH,
      });
      const ideal = await getReport(slug);
      expect(ideal.details.swell_direction_description).toContain('direct, favorable');
      expect(ideal.details.wind_direction_description).toContain('offshore');

      stubUpstream({
        swellDirection: (coastFacingDeg + 180) % 360, // from behind the coast
        windDirection: coastFacingDeg, // straight onshore
        windSpeedKmh: MODERATE_WIND_KMH,
      });
      const backside = await getReport(slug);
      expect(backside.details.swell_direction_description).toContain('backside swell');
      expect(backside.details.wind_direction_description).toContain('onshore');

      // Every other scoring term is identical between the two runs, so the gap is
      // exactly the swell (20) + offshore wind (20) credit.
      expect(ideal.score - backside.score).toBe(40);
    }
  );

  it('does not credit a backside swell with a dead-onshore wind', async () => {
    // Huntington faces 225; this is the case the old hardcoded 225–315 band scored
    // as a perfect offshore wind on a favorable swell.
    const { coastFacingDeg } = getLocation('huntington-beach')!;
    stubUpstream({
      swellDirection: (coastFacingDeg + 180) % 360,
      windDirection: coastFacingDeg,
    });

    const body = await getReport('huntington-beach');

    expect(body.details.swell_direction_description).toContain('backside swell');
    expect(body.details.wind_direction_description).toContain('onshore');
  });

  it('scores the same conditions differently on differently-oriented coasts', async () => {
    // An E swell with a W wind: ideal in Florida, backside/onshore on the North Shore.
    stubUpstream({ swellDirection: 90, windDirection: 270 });
    const florida = await getReport('st-augustine');
    const hawaii = await getReport('oahu');

    expect(florida.score).toBeGreaterThan(hawaii.score);
  });
});

describe('per-location wave height calibration', () => {
  it('applies the location factor to the modelled height', async () => {
    const stAug = getLocation('st-augustine')!;
    stubUpstream({ swellDirection: 90, windDirection: 270, waveHeightM: 1.0 });

    const body = await getReport('st-augustine');

    const expectedFt = 1.0 * stAug.waveHeightCalibration * 3.28084;
    expect(body.details.wave_height_ft).toBeCloseTo(Math.round(expectedFt * 10) / 10, 1);
  });

  // Huntington is the one location left uncorrected: over 2024-2025 it fits to 1.01 and
  // the factor changes out-of-sample RMSE by nothing at all. (Higgins used to play this
  // role, on a September window that made it look unbiased. Two full years showed it
  // running ~13% low in every month, so it now carries a real factor.)
  it('leaves height unchanged where the model has no annual bias', async () => {
    const socal = getLocation('huntington-beach')!;
    expect(socal.waveHeightCalibration).toBe(1);
    stubUpstream({ swellDirection: 225, windDirection: 45, waveHeightM: 1.0 });

    const body = await getReport('huntington-beach');

    expect(body.details.wave_height_ft).toBeCloseTo(3.3, 1);
  });

  it('keeps every calibration factor within a plausible range', () => {
    for (const loc of LOCATIONS) {
      expect(loc.waveHeightCalibration).toBeGreaterThan(0.5);
      expect(loc.waveHeightCalibration).toBeLessThan(2.5);
      // A factor other than 1.0 must record where it came from.
      if (loc.waveHeightCalibration !== 1) {
        expect(loc.calibrationBuoyId).toBeTruthy();
        expect(loc.calibrationFittedOn).toBeTruthy();
      }
    }
  });

  // The previous factors were each fitted on one ~30-day September window, which encoded
  // the late-summer trough as a year-round constant and left four locations materially
  // wrong — Oahu's was worse than applying no correction at all. The window a factor was
  // fitted over is the thing that makes it trustworthy, so it has to be recorded.
  it('records the fitting window for every calibrated location', () => {
    for (const loc of LOCATIONS) {
      if (loc.calibrationBuoyId === null) continue;
      expect(loc.calibrationWindow).toBeTruthy();
      // Two distinct calendar years, so seasonal swing is averaged out and
      // year-over-year repeatability is actually observable.
      expect(loc.calibrationWindow).toMatch(/^\d{4}-\d{4}$/);
      const [from, to] = loc.calibrationWindow!.split('-').map(Number);
      expect(to).toBeGreaterThan(from);
    }
  });
});
