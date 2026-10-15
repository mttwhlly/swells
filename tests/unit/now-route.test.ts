import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { SurfReport } from '@/types/surf-report';
import { GET, OPTIONS } from '@/api/now/route';
import { describeSurfStatus } from '@/lib/surfStatus';

const mockGetCachedReport = vi.fn();

vi.mock('@/lib/db', () => ({
  getCachedReport: (...args: unknown[]) => mockGetCachedReport(...args),
}));

// St. Augustine faces east (90°): a west wind (270°) is offshore, an east wind onshore.
const OFFSHORE = 270;
const ONSHORE = 90;

function conditions(overrides: Partial<SurfReport['conditions']> = {}): SurfReport['conditions'] {
  return {
    wave_height_ft: 1.8,
    face_height_ft: 2.5,
    size_descriptor: 'knee to waist high',
    wave_period_sec: 6.4,
    wind_speed_kts: 3,
    wind_direction_deg: OFFSHORE,
    tide_state: 'Mid Rising',
    weather_description: 'Clear sky',
    surfability_score: 60,
    ...overrides,
  };
}

function report(hoursOld: number, overrides: Partial<SurfReport['conditions']> = {}): SurfReport {
  return {
    id: 'surf_1',
    timestamp: new Date(Date.now() - hoursOld * 3_600_000).toISOString(),
    location: 'st-augustine',
    report: 'Report body',
    conditions: conditions(overrides),
    recommendations: { board_type: 'longboard', skill_level: 'beginner' },
    cached_until: new Date().toISOString(),
  };
}

function request(origin?: string, method = 'GET') {
  return new NextRequest('https://swells.surf/api/now', { method, headers: origin ? { origin } : {} });
}

describe('describeSurfStatus', () => {
  it.each([
    [{ face_height_ft: 0.5 }, 'flat'],
    [{ face_height_ft: 1.5 }, 'clean and knee-high'],
    [{ face_height_ft: 2.5 }, 'clean and waist-high'],
    [{ face_height_ft: 3.5, wind_direction_deg: ONSHORE, wind_speed_kts: 7 }, 'bumpy and chest-high'],
    [{ face_height_ft: 4.5, wind_direction_deg: ONSHORE, wind_speed_kts: 12 }, 'choppy and shoulder-high'],
    [{ face_height_ft: 5.5, wind_direction_deg: ONSHORE, wind_speed_kts: 22 }, 'blown out and head-high'],
    [{ face_height_ft: 7, wind_direction_deg: OFFSHORE, wind_speed_kts: 18 }, 'choppy and overhead'],
    [{ face_height_ft: 10 }, 'clean and well overhead'],
    [{ face_height_ft: 20 }, 'clean and big'],
    [{ face_height_ft: 7, wind_direction_deg: ONSHORE, wind_speed_kts: 12 }, 'big and messy'],
    [{ face_height_ft: 4, weather_description: 'Thunderstorm: slight or moderate' }, 'stormy'],
  ])('%o → %s', (overrides, expected) => {
    expect(describeSurfStatus(conditions(overrides), 90)).toBe(expected);
  });

  it('derives size from Hs on older rows without face_height_ft', () => {
    expect(describeSurfStatus(conditions({ face_height_ft: undefined, wave_height_ft: 1.8, wave_period_sec: 6.4 }), 90))
      .toBe('clean and waist-high');
  });

  it('every phrase is 1–5 lowercase words with no trailing punctuation', () => {
    for (const face of [0, 1, 2, 3, 4, 5, 6, 7, 9, 13, 25]) {
      for (const [deg, kts] of [[OFFSHORE, 3], [OFFSHORE, 20], [ONSHORE, 3], [ONSHORE, 7], [ONSHORE, 15], [ONSHORE, 30]]) {
        const status = describeSurfStatus(conditions({ face_height_ft: face, wind_direction_deg: deg, wind_speed_kts: kts }), 90);
        expect(status).toMatch(/^[a-z-]+( [a-z-]+){0,4}$/);
      }
    }
  });
});

describe('GET /api/now', () => {
  // Braces matter: a function returned from beforeEach runs as a teardown, which
  // would call the mock again after the test.
  beforeEach(() => { mockGetCachedReport.mockReset(); });
  afterEach(() => vi.restoreAllMocks());

  it('returns the status and when the report was written, cached at the edge', async () => {
    const row = report(2);
    mockGetCachedReport.mockResolvedValue(row);
    const res = await GET(request('https://mattwhalley.com'));
    expect(mockGetCachedReport).toHaveBeenCalledWith('st-augustine');
    expect(await res.json()).toEqual({ status: 'clean and waist-high', updatedAt: row.timestamp });
    expect(res.headers.get('cache-control')).toBe('public, s-maxage=1200, stale-while-revalidate=600');
    expect(res.headers.get('access-control-allow-origin')).toBe('https://mattwhalley.com');
    expect(res.headers.get('vary')).toBe('Origin');
  });

  it('allows the local portfolio dev server', async () => {
    mockGetCachedReport.mockResolvedValue(report(1));
    const res = await GET(request('http://localhost:4321'));
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:4321');
  });

  it('sends no CORS header to other origins', async () => {
    mockGetCachedReport.mockResolvedValue(report(1));
    const res = await GET(request('https://evil.example'));
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it.each([
    ['stale', () => mockGetCachedReport.mockResolvedValue(report(6.5))],
    ['missing', () => mockGetCachedReport.mockResolvedValue(null)],
  ])('returns 200 { status: null } with a short cache when the data is %s', async (_, arrange) => {
    arrange();
    const res = await GET(request('https://mattwhalley.com'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: null });
    expect(res.headers.get('cache-control')).toBe('public, s-maxage=300');
  });

  it('returns 200 { status: null } when the database read fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockGetCachedReport.mockRejectedValue(new Error('db down'));
    const res = await GET(request('https://mattwhalley.com'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: null });
  });

  it('answers the CORS preflight', async () => {
    const res = OPTIONS(request('https://mattwhalley.com', 'OPTIONS'));
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://mattwhalley.com');
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS');
  });
});
