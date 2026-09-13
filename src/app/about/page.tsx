import { Metadata } from 'next';
import Link from 'next/link';
import { LOCATIONS } from '../lib/locations';

export const metadata: Metadata = {
  title: 'About',
  description: 'What Swells is, how the AI surf reports are generated, and which spots are covered.',
};

export default function AboutPage() {
  return (
    <div className="mx-auto max-w-2xl w-full px-4 py-12 font-mono text-gray-800 dark:text-neutral-100">
      <Link href="/" className="text-sm underline underline-offset-2 decoration-dashed hover:text-gray-600 dark:hover:text-neutral-200 transition-colors">
        ← Back to Swells
      </Link>

      <h1 className="mt-6 text-2xl font-bold">About Swells</h1>

      <p className="mt-4 leading-relaxed">
        Swells is a real-time, AI-generated surf report for a handful of surf spots across the
        US. Every few hours it pulls live wave, wind, and tide data — wave height and period,
        swell direction, wind speed and direction, tide state, and water temperature — from
        Open-Meteo&apos;s Marine and Weather APIs and NOAA&apos;s Tides &amp; Currents API, and
        hands that data to an AI model that writes a short, plain-language report in the voice
        of a local who knows the break.
      </p>

      <p className="mt-4 leading-relaxed">
        Reports are cached and refreshed automatically about four times a day, so what you see
        is close to current conditions rather than a stale forecast — but it&apos;s still an AI
        summary of sensor data, not a lifeguard or a local surfer standing on the beach. Always
        check conditions yourself before paddling out.
      </p>

      <h2 className="mt-8 text-lg font-bold">How wave size is measured</h2>

      <p className="mt-4 leading-relaxed">
        Wave forecasts and ocean buoys report <strong>significant wave height</strong> — the
        average height of the biggest third of waves, measured in open water, well offshore.
        Surfers mean something different by &ldquo;size&rdquo;: the face of the individual wave
        they ride, at the beach, as it breaks. The face is reliably the bigger of the two. Waves
        grow as they move into shallow water before they break, and the waves worth describing
        are the sets, not the average of everything including the lulls.
      </p>

      <p className="mt-4 leading-relaxed">
        That gap is why a forecast can say three feet on a day that looks chest-high in the
        water. So reports here describe size the way surfers actually talk — waist high, head
        high, overhead — rather than quoting a number that invites the wrong comparison. The
        underlying significant wave height is still what gets measured; the body-scale
        description is an estimate derived from it and the swell period, and it is approximate
        by design.
      </p>

      <p className="mt-4 leading-relaxed">
        The forecast model is also corrected per spot. Global wave models resolve open ocean
        rather than the sandbars and shoaling each of these beaches sits behind, so they run
        consistently small at some spots and large at others — around 40% low at St. Augustine
        and 25% high on Oahu&apos;s North Shore, when checked against the nearest NOAA buoy over
        a month of readings. Each spot carries its own correction factor fitted against that
        buoy. These are refitted periodically, since they drift with the seasons.
      </p>

      <h2 className="mt-8 text-lg font-bold">Spots covered</h2>
      <ul className="mt-3 space-y-1">
        {LOCATIONS.map(loc => (
          <li key={loc.slug}>
            <Link
              href={`/${loc.slug}`}
              className="underline underline-offset-2 decoration-dashed hover:text-gray-600 dark:hover:text-neutral-200 transition-colors"
            >
              {loc.name}
            </Link>
          </li>
        ))}
      </ul>

      <h2 className="mt-8 text-lg font-bold">Who built this</h2>
      <p className="mt-3 leading-relaxed">
        Swells is an independent, open-source project built by{' '}
        <a
          href="https://mattwhalley.com"
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2 decoration-dashed hover:text-gray-600 dark:hover:text-neutral-200 transition-colors"
        >
          Matt Whalley
        </a>
        . The source is on{' '}
        <a
          href="https://github.com/mttwhlly/swells"
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2 decoration-dashed hover:text-gray-600 dark:hover:text-neutral-200 transition-colors"
        >
          GitHub
        </a>
        . See the{' '}
        <Link href="/contact" className="underline underline-offset-2 decoration-dashed hover:text-gray-600 dark:hover:text-neutral-200 transition-colors">
          contact page
        </Link>{' '}
        to reach out, or the{' '}
        <Link href="/privacy" className="underline underline-offset-2 decoration-dashed hover:text-gray-600 dark:hover:text-neutral-200 transition-colors">
          privacy page
        </Link>{' '}
        for what data is collected.
      </p>
    </div>
  );
}
