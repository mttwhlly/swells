import { NextRequest, NextResponse } from 'next/server';
import { getCachedReport } from '@/lib/db';
import { getLocation } from '@/lib/locations';
import { describeSurfStatus } from '@/lib/surfStatus';

export const dynamic = 'force-dynamic';

// Public, read-only status line for mattwhalley.com: "…where the waves are [status]."
// Reads the latest stored St. Augustine row and nothing else — no surfability fetch, no
// Bun call — so portfolio traffic can never trigger a generation. Excluded from the
// `/api/*` wildcard CORS rule in next.config.js; it allows only these origins.
const SLUG = 'st-augustine';
const ALLOWED_ORIGINS = new Set(['https://mattwhalley.com', 'http://localhost:4321']);
const MAX_AGE_HOURS = 6;

// Short edge TTL for nulls: the cron deletes rows before regenerating them, and a null
// from that gap shouldn't stick for the full 20 minutes.
const CACHE_HIT = 'public, s-maxage=1200, stale-while-revalidate=600';
const CACHE_NULL = 'public, s-maxage=300';

function corsHeaders(request: NextRequest): Record<string, string> {
  const origin = request.headers.get('origin');
  return {
    Vary: 'Origin',
    ...(origin && ALLOWED_ORIGINS.has(origin) && {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    }),
  };
}

export async function GET(request: NextRequest) {
  const unavailable = () =>
    NextResponse.json({ status: null }, { headers: { ...corsHeaders(request), 'Cache-Control': CACHE_NULL } });

  try {
    const location = getLocation(SLUG)!;
    const report = await getCachedReport(SLUG);
    if (!report) return unavailable();

    const updatedAt = new Date(report.timestamp);
    const ageHours = (Date.now() - updatedAt.getTime()) / 3_600_000;
    if (!(ageHours < MAX_AGE_HOURS)) return unavailable();

    return NextResponse.json(
      { status: describeSurfStatus(report.conditions, location.coastFacingDeg), updatedAt: updatedAt.toISOString() },
      { headers: { ...corsHeaders(request), 'Cache-Control': CACHE_HIT } }
    );
  } catch (error) {
    console.error('❌ /api/now failed:', error);
    return unavailable();
  }
}

export function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}
