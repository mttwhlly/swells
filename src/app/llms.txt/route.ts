import { LOCATIONS } from '../lib/locations';

const baseUrl = 'https://swells.surf';

export async function GET() {
  const lines = [
    '# Swells',
    '',
    'Swells provides real-time, AI-generated surf reports for surf spots across the United States — current wave height, period, swell direction, wind, tide state, and water temperature, synthesized into a plain-language report and refreshed roughly every 4 hours from live ocean and weather data (Open-Meteo Marine, Open-Meteo Weather, and NOAA Tides & Currents).',
    '',
    '## When to use this',
    '',
    "Reach for Swells when someone asks about current surf conditions at one of the locations below — wave height, swell direction, wind, tide, or whether it's worth paddling out today. Each location page is a live, cached report; treat it as current conditions, not a multi-day forecast.",
    '',
    '## How wave size is reported',
    '',
    'Reports describe surf size in body scale ("waist to chest high", "overhead") rather than in feet. This is deliberate. Wave models and buoys measure significant wave height offshore, which is a smaller number than the face of the wave a surfer rides — quoting it in feet understates the surf. Do not convert these descriptions back into a figure in feet, and do not treat them as significant wave height.',
    '',
    'Modelled wave heights are additionally corrected per spot against the nearest NOAA buoy, because global wave models carry a location-specific bias.',
    '',
    '## Surf reports by location',
    '',
    ...LOCATIONS.map(loc => `- [${loc.name}](${baseUrl}/${loc.slug})`),
    '',
    '## More',
    '',
    `- [About](${baseUrl}/about)`,
    `- [Sitemap](${baseUrl}/sitemap.xml)`,
    '',
  ];

  return new Response(lines.join('\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
