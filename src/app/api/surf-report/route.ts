import { NextRequest, NextResponse } from 'next/server';
import { getCachedReport, saveReport, ensureInitialized } from '@/lib/db';
import { getLocation, DEFAULT_LOCATION_SLUG, type Location } from '@/lib/locations';
import type { SurfReport } from '@/types/surf-report';
import { describeWaveSize } from '@/lib/waveSize';

export const dynamic = 'force-dynamic';

// Shape of the JSON returned by GET /api/surfability — the only fields this route reads.
interface SurfabilityData {
  location: string;
  score: number;
  details: {
    /** Significant wave height (Hs) offshore — measured, not the wave face. */
    wave_height_ft: number;
    wave_height_basis?: string;
    /** Estimated breaking face height. Derived — see lib/waveSize.ts. */
    face_height_ft?: number;
    /** Body-scale size band. Preferred for user-facing prose. */
    size_descriptor?: string;
    wave_period_sec: number;
    swell_direction_deg: number;
    swell_direction_compass: string;
    swell_direction_text: string;
    swell_direction_description: string;
    wind_direction_deg: number;
    wind_direction_compass: string;
    wind_direction_text: string;
    wind_direction_description: string;
    wind_speed_kts: number;
    tide_state: string;
    tide_height_ft: number;
  };
  weather: {
    water_temperature_c: number;
    water_temperature_f: number;
    air_temperature_c: number;
    air_temperature_f: number;
    weather_description: string;
  };
}

export async function GET(request: NextRequest) {
  const startTime = Date.now();
  const isDebug = request.headers.get('X-Debug') === 'true';

  try {
    const slug = request.nextUrl.searchParams.get('location') ?? DEFAULT_LOCATION_SLUG;
    const location = getLocation(slug);

    if (!location) {
      return NextResponse.json({ error: `Unknown location: ${slug}` }, { status: 400 });
    }

    console.log('🎯 SURF REPORT REQUEST:', { location: location.name, timestamp: new Date().toISOString(), isDebug });

    // STEP 1: CHECK CACHE FIRST
    const cachedReport = await getCachedReport(slug);

    if (cachedReport) {
      const reportAge = Date.now() - new Date(cachedReport.timestamp).getTime();
      const ageHours = reportAge / (1000 * 60 * 60);
      const responseTime = Date.now() - startTime;

      if (ageHours < 8) {
        const cacheStatus = ageHours < 1 ? 'fresh' : ageHours < 4 ? 'good' : 'stale-but-usable';
        console.log(`✅ CACHE HIT: ${cacheStatus.toUpperCase()} (${location.name})`);

        return NextResponse.json(cachedReport, {
          headers: {
            'X-Data-Source': `cache-${cacheStatus}`,
            'X-Cache-Status': 'hit',
            'X-Response-Time': `${responseTime}ms`,
            'X-Report-Age-Hours': `${Math.round(ageHours * 10) / 10}`,
            'X-Cache-Valid-Until': cachedReport.cached_until,
            'X-API-Calls-Made': '0',
            'Cache-Control': 'public, max-age=1800, stale-while-revalidate=3600'
          }
        });
      }
    }

    // STEP 2: CACHE MISS — GENERATE FRESH
    console.log(`🚨 GENERATING FRESH REPORT for ${location.name} - THIS SHOULD BE RARE!`);
    return await generateFreshReportViaBun(request, startTime, location);

  } catch (error) {
    console.error('❌ SURF REPORT ERROR:', error);

    // Emergency fallback — serve any cached report regardless of age
    try {
      const slug = request.nextUrl.searchParams.get('location') ?? DEFAULT_LOCATION_SLUG;
      const emergencyCache = await getCachedReport(slug);
      if (emergencyCache) {
        console.log('🆘 Using emergency cache fallback');
        return NextResponse.json({
          ...emergencyCache,
          _fallback: true,
          _error: 'Fresh generation failed, using emergency cache'
        }, {
          headers: {
            'X-Data-Source': 'emergency-cache-fallback',
            'X-Error': error instanceof Error ? error.message : 'Unknown error'
          }
        });
      }
    } catch (fallbackError) {
      console.error('❌ Even emergency fallback failed:', fallbackError);
    }

    return NextResponse.json(
      {
        error: 'Failed to generate surf report',
        details: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      },
      { status: 500 }
    );
  }
}

function enhanceReportWithCompassDirections(report: SurfReport, surfData: SurfabilityData): SurfReport {
  report.conditions = {
    ...report.conditions,
    swell_direction_deg: surfData.details.swell_direction_deg,
    swell_direction_compass: surfData.details.swell_direction_compass,
    swell_direction_text: surfData.details.swell_direction_text,
    swell_direction_description: surfData.details.swell_direction_description,
    wind_direction_compass: surfData.details.wind_direction_compass,
    wind_direction_text: surfData.details.wind_direction_text,
    wind_direction_description: surfData.details.wind_direction_description,
    face_height_ft: waveSizeFor(surfData).face_height_ft,
    size_descriptor: waveSizeFor(surfData).size_descriptor,
    tide_height_ft: surfData.details.tide_height_ft,
    water_temperature_c: surfData.weather.water_temperature_c,
    water_temperature_f: surfData.weather.water_temperature_f,
    air_temperature_c: surfData.weather.air_temperature_c,
    air_temperature_f: surfData.weather.air_temperature_f
  };
  return report;
}

async function generateFreshReportViaBun(request: NextRequest, startTime: number, location: Location) {
  try {
    await ensureInitialized();

    const baseUrl = process.env.NEXT_PUBLIC_API_URL ||
      (request.headers.get('host') ? `https://${request.headers.get('host')}` : 'http://localhost:3000');

    const surfDataStart = Date.now();
    const surfDataResponse = await fetch(
      `${baseUrl}/api/surfability?location=${location.slug}&nocache=${Date.now()}`,
      {
        cache: 'no-store',
        headers: { 'User-Agent': 'SurfLab-AI/1.0', 'X-Force-Fresh': 'true' },
        signal: AbortSignal.timeout(15000)
      }
    );
    const surfDataTime = Date.now() - surfDataStart;

    if (!surfDataResponse.ok) {
      throw new Error(`Failed to fetch surf conditions: ${surfDataResponse.status}`);
    }

    const surfData: SurfabilityData = await surfDataResponse.json();
    console.log(`📊 Fresh surf data: ${surfData.location}, wave ${surfData.details.wave_height_ft}ft`);

    const bunServiceUrl = process.env.BUN_SERVICE_URL;

    const aiStart = Date.now();
    let report: SurfReport;
    let aiTime: number;
    let dataSource = 'bun-ai-service-with-compass';

    try {
      if (!bunServiceUrl) throw new Error('BUN_SERVICE_URL not configured — using local fallback');
      const aiResponse = await fetch(`${bunServiceUrl}/generate-surf-report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'SurfLab-Vercel/1.0' },
        body: JSON.stringify({
          surfData,
          apiKey: process.env.BUN_API_SECRET,
          // The Bun prompt must not read wave_height_ft as a face height. Pass the
          // translation explicitly so it can describe size the way surfers do.
          sizeGuidance: {
            significant_height_ft: surfData.details.wave_height_ft,
            significant_height_note:
              'Offshore significant wave height (Hs). This is NOT the height of the wave face — do not quote it to the reader as the size of the surf.',
            face_height_ft: waveSizeFor(surfData).face_height_ft,
            size_descriptor: waveSizeFor(surfData).size_descriptor,
            preferred_phrasing:
              'Describe the size using size_descriptor (body scale, e.g. "chest to shoulder high"). Avoid quoting a height in feet.',
          },
          localKnowledge: location.localKnowledge,
          voiceDescriptor: location.voiceDescriptor,
          bestSpots: location.bestSpots,
          locationName: location.name,
          lat: location.lat,
          lon: location.lon,
          timezone: location.timezone,
        }),
        signal: AbortSignal.timeout(30000)
      });

      aiTime = Date.now() - aiStart;

      if (!aiResponse.ok) throw new Error(`Bun AI service failed: ${aiResponse.status}`);

      const aiResult = await aiResponse.json();
      if (!aiResult.success || !aiResult.report) throw new Error('Bun AI service returned invalid response');

      report = aiResult.report;
      // Ensure the location field uses the slug as cache key
      report.location = location.slug;
      console.log('✅ Got successful Bun AI response');

    } catch (bunError) {
      console.error('⚠️ Bun AI service failed, using local fallback:', bunError);

      const windMph = Math.round(surfData.details.wind_speed_kts * 1.15078);
      const fallbackReport = createDetailedFallbackReport(surfData, windMph, location);

      report = {
        id: `surf_fallback_${location.slug}_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
        timestamp: new Date().toISOString(),
        location: location.slug,
        report: fallbackReport,
        conditions: {
          wave_height_ft: surfData.details.wave_height_ft,
          face_height_ft: waveSizeFor(surfData).face_height_ft,
          size_descriptor: waveSizeFor(surfData).size_descriptor,
          wave_period_sec: surfData.details.wave_period_sec,
          wind_speed_kts: surfData.details.wind_speed_kts,
          wind_direction_deg: surfData.details.wind_direction_deg,
          tide_state: surfData.details.tide_state,
          weather_description: surfData.weather.weather_description,
          surfability_score: surfData.score
        },
        recommendations: {
          board_type: waveSizeFor(surfData).face_height_ft >= 4 ? 'Shortboard' : 'Longboard',
          wetsuit_thickness: surfData.weather.water_temperature_f < 65 ? '3/2mm' : surfData.weather.water_temperature_f < 72 ? 'Spring suit' : undefined,
          skill_level: surfData.score >= 65 ? 'intermediate' : 'beginner',
          best_spots: location.bestSpots,
          timing_advice: 'Check conditions regularly as they change throughout the day'
        },
        cached_until: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
        generation_meta: {
          backend: 'vercel-local-fallback',
          model: 'hardcoded',
          report_length: fallbackReport.length,
          word_count: fallbackReport.split(' ').length,
          paragraphs: 2,
          prompt_version: 'n/a',
        }
      };

      aiTime = Date.now() - aiStart;
      dataSource = 'local-fallback-with-compass';
    }

    report = enhanceReportWithCompassDirections(report, surfData);

    await saveReport(report);
    console.log(`✅ Report saved: ${report.id} (${location.name})`);

    const totalTime = Date.now() - startTime;

    return NextResponse.json(report, {
      headers: {
        'X-Data-Source': dataSource,
        'X-Cache-Status': 'miss',
        'X-Response-Time': `${totalTime}ms`,
        'X-Surf-Data-Time': `${surfDataTime}ms`,
        'X-AI-Generation-Time': `${aiTime}ms`,
        'X-Cache-Valid-Until': report.cached_until,
        'X-API-Calls-Made': '2',
        'X-Location': location.slug,
      }
    });

  } catch (error) {
    console.error('❌ Fresh generation via Bun failed:', error);
    throw error;
  }
}

/**
 * Size fields for a surfability payload. /api/surfability supplies these directly, but
 * the payload arrives over HTTP and older shapes may predate them, so recompute from Hs
 * when they are absent rather than falling back to reporting Hs as though it were a face.
 */
function waveSizeFor(surfData: SurfabilityData) {
  const { face_height_ft, size_descriptor, wave_height_ft, wave_period_sec } = surfData.details;
  if (face_height_ft !== undefined && size_descriptor !== undefined) {
    return { face_height_ft, size_descriptor };
  }
  return describeWaveSize(wave_height_ft, wave_period_sec);
}

function createDetailedFallbackReport(surfData: SurfabilityData, windMph: number, location: Location): string {
  const condition = surfData.score >= 70 ? 'good' : surfData.score >= 50 ? 'fair' : 'poor';
  // Speak in body scale, not in feet: the underlying number is offshore significant wave
  // height, which reads as face height to a surfer and is meaningfully smaller than one.
  const size = waveSizeFor(surfData);
  const swellCompass = surfData.details.swell_direction_compass || 'unknown direction';
  const windCompass = surfData.details.wind_direction_compass || 'variable';
  const primarySpot = location.bestSpots[0] || location.name;
  const secondarySpot = location.bestSpots[1] || location.name;

  const paragraph1 = `${location.name} surf check shows ${size.size_descriptor} waves at ${surfData.details.wave_period_sec} seconds from ${swellCompass} direction, delivering ${surfData.details.wave_period_sec >= 10 ? 'decent power with some long rides' : 'quicker, choppier waves with less push'}. Wind is ${windMph} mph from the ${windCompass} which ${windMph < 10 ? 'is light enough for clean conditions' : 'is creating some texture and bump on the water'}. Tide is ${surfData.details.tide_state.toLowerCase()} and water temp is ${surfData.weather.water_temperature_f}°F.`;

  const paragraph2 = `${size.face_height_ft >= 4 ? `Grab your shortboard and head to ${primarySpot} where the waves should have some punch` : `${primarySpot} or ${secondarySpot} should find a way to produce rideable waves on a day like this`}. ${surfData.weather.water_temperature_f < 65 ? 'You\'ll want a 3/2mm or thicker wetsuit for that cold water' : surfData.weather.water_temperature_f < 72 ? 'A spring suit should be fine' : 'Boardshorts or spring suit territory — comfortable water temps'}. ${condition === 'good' ? 'Definitely worth the paddle out today!' : condition === 'fair' ? 'Surfable if you need your wave fix.' : 'Might be better for a beach walk, but conditions can change quickly.'}`;

  return `${paragraph1}\n\n${paragraph2}`;
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}
