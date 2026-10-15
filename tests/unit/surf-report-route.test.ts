import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { SurfReport } from '@/types/surf-report';
import { GET } from '@/api/surf-report/route';

const mockGetCachedReport = vi.fn();
const mockSaveReport = vi.fn();
const mockEnsureInitialized = vi.fn();

vi.mock('@/lib/db', () => ({
  getCachedReport: (...args: unknown[]) => mockGetCachedReport(...args),
  saveReport: (...args: unknown[]) => mockSaveReport(...args),
  ensureInitialized: (...args: unknown[]) => mockEnsureInitialized(...args),
}));

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

const surfabilityFixture = {
  location: 'st-augustine',
  score: 72,
  details: {
    wave_height_ft: 3.5,
    wave_period_sec: 9,
    swell_direction_deg: 80,
    swell_direction_compass: 'E',
    swell_direction_text: 'East',
    swell_direction_description: 'Cross-shore E swell',
    wind_direction_deg: 270,
    wind_direction_compass: 'W',
    wind_direction_text: 'West',
    wind_direction_description: 'Offshore W wind',
    wind_speed_kts: 6,
    tide_state: 'Rising',
    tide_height_ft: 1.2,
  },
  weather: {
    water_temperature_c: 24,
    water_temperature_f: 75,
    air_temperature_c: 27,
    air_temperature_f: 81,
    weather_description: 'Clear',
  },
};

function makeCachedReport(overrides: Partial<SurfReport> = {}): SurfReport {
  return {
    id: 'surf_cached_1',
    timestamp: new Date().toISOString(),
    location: 'st-augustine',
    report: 'Cached surf report body',
    conditions: {
      wave_height_ft: 3,
      wave_period_sec: 9,
      wind_speed_kts: 5,
      wind_direction_deg: 270,
      tide_state: 'Rising',
      weather_description: 'Clear',
      surfability_score: 70,
    },
    recommendations: {
      board_type: 'Shortboard',
      skill_level: 'intermediate',
      best_spots: ['Vilano Beach'],
      timing_advice: 'Go now',
    },
    cached_until: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  } as SurfReport;
}

describe('GET /api/surf-report', () => {
  const fetchMock = vi.fn();
  const originalBunServiceUrl = process.env.BUN_SERVICE_URL;

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    mockGetCachedReport.mockReset();
    mockSaveReport.mockReset().mockResolvedValue(undefined);
    mockEnsureInitialized.mockReset().mockResolvedValue(undefined);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalBunServiceUrl === undefined) delete process.env.BUN_SERVICE_URL;
    else process.env.BUN_SERVICE_URL = originalBunServiceUrl;
  });

  it('serves a fresh cached report without hitting any external service', async () => {
    const cached = makeCachedReport();
    mockGetCachedReport.mockResolvedValueOnce(cached);

    const req = new NextRequest('http://localhost:3000/api/surf-report?location=st-augustine');
    const res = await GET(req);
    const body = await res.json();

    expect(res.headers.get('X-Cache-Status')).toBe('hit');
    expect(body.id).toBe(cached.id);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockSaveReport).not.toHaveBeenCalled();
  });

  it('generates a fresh report via the Bun service on cache miss and saves it', async () => {
    process.env.BUN_SERVICE_URL = 'https://bun.example.com';
    mockGetCachedReport.mockResolvedValueOnce(null);

    const bunReport = makeCachedReport({ id: 'surf_bun_1', location: 'st-augustine' });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(surfabilityFixture)) // /api/surfability
      .mockResolvedValueOnce(jsonResponse({ success: true, report: bunReport })); // Bun AI service

    const req = new NextRequest('http://localhost:3000/api/surf-report?location=st-augustine');
    const res = await GET(req);
    const body = await res.json();

    expect(res.headers.get('X-Cache-Status')).toBe('miss');
    expect(res.headers.get('X-Data-Source')).toBe('bun-ai-service-with-compass');
    expect(body.id).toBe('surf_bun_1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockSaveReport).toHaveBeenCalledTimes(1);
  });

  it('falls back to the local template report when the Bun service is unavailable', async () => {
    delete process.env.BUN_SERVICE_URL;
    mockGetCachedReport.mockResolvedValueOnce(null);

    fetchMock.mockResolvedValueOnce(jsonResponse(surfabilityFixture)); // /api/surfability only

    const req = new NextRequest('http://localhost:3000/api/surf-report?location=st-augustine');
    const res = await GET(req);
    const body = await res.json();

    expect(res.headers.get('X-Data-Source')).toBe('local-fallback-with-compass');
    expect(body.generation_meta.backend).toBe('vercel-local-fallback');
    expect(body.report).toContain('St. Augustine');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockSaveReport).toHaveBeenCalledTimes(1);
  });

  // The Bun service carries its own deterministic template with night and lightning
  // handling; this one, used when that service is unreachable, had neither — at 2am it
  // described a surf session. The clock is pinned because the branch depends on it.
  describe('local fallback template, by time of day', () => {
    async function fallbackAt(iso: string, weather = 'Clear') {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(iso));
      delete process.env.BUN_SERVICE_URL;
      mockGetCachedReport.mockResolvedValueOnce(null);
      fetchMock.mockResolvedValueOnce(jsonResponse({
        ...surfabilityFixture,
        weather: { ...surfabilityFixture.weather, weather_description: weather },
      }));
      const res = await GET(new NextRequest('http://localhost:3000/api/surf-report?location=st-augustine'));
      return (await res.json()) as SurfReport;
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    // The 5:07 AM cron run that shipped "no surfing tonight ... check back tomorrow".
    it('at 5am, says it is too dark and points to sunrise later this morning', async () => {
      const body = await fallbackAt('2026-10-15T09:07:00Z');

      expect(body.report).toMatch(/Too dark to surf at St\. Augustine/);
      expect(body.report).toMatch(/later this morning \(~\d{1,2}:\d{2} AM\)/);
      expect(body.report).not.toMatch(/\b(tonight|tomorrow)\b/i);
      expect(body.report).not.toMatch(/head to|should find a way to produce rideable waves|get out there/);
      expect(body.recommendations.timing_advice).toMatch(/^Check back later this morning/);
    });

    it('before midnight, points to sunrise tomorrow morning', async () => {
      const body = await fallbackAt('2026-10-15T02:30:00Z'); // 10:30pm EDT, Oct 14

      expect(body.report).toMatch(/tomorrow morning \(~\d{1,2}:\d{2} AM\)/);
      expect(body.recommendations.timing_advice).toMatch(/^Check back tomorrow morning/);
    });

    it('during a thunderstorm, says to stay out of the water even in daylight', async () => {
      const body = await fallbackAt('2026-10-15T18:00:00Z', 'Thunderstorm');

      expect(body.report).toMatch(/ocean is unsafe right now/);
      expect(body.recommendations.timing_advice).toMatch(/storm to clear/);
    });

    it('in daylight, describes the session without phrases the model tiers are rejected for', async () => {
      const body = await fallbackAt('2026-10-15T18:00:00Z'); // 2pm EDT

      expect(body.report).toMatch(/St\. Augustine, FL surf check shows/);
      expect(body.report).not.toMatch(/worth the paddle out|unknown direction/i);
      expect(body.recommendations.timing_advice).toMatch(/rising tide/);
    });
  });

  it('rejects an unknown location slug', async () => {
    const req = new NextRequest('http://localhost:3000/api/surf-report?location=nowhereville');
    const res = await GET(req);

    expect(res.status).toBe(400);
    expect(mockGetCachedReport).not.toHaveBeenCalled();
  });
});
