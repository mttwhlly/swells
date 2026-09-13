'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'motion/react';
import { useSurfReportOptimized } from '../hooks/useSurfReportOptimized';
import { SurfReportCard } from './surf/SurfReportCard';
import { ErrorCard } from './ui/ErrorCard';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { SurfReport } from '../types/surf-report';
import { getLocation, LOCATIONS } from '../lib/locations';
import { describeWaveSize } from '@/lib/waveSize';

const STORAGE_KEY = 'surf_location';

function extractConditionFromReport(report: string): string {
  const conditionKeywords = {
    'Epic': ['epic', 'firing', 'going off', 'pumping', 'cranking'],
    'Good': ['good', 'solid', 'fun', 'decent', 'worth it'],
    'Fair': ['fair', 'okay', 'marginal', 'questionable'],
    'Poor': ['poor', 'flat', 'blown out', 'junk', 'small']
  };
  const lower = report.toLowerCase();
  for (const [condition, keywords] of Object.entries(conditionKeywords)) {
    if (keywords.some(k => lower.includes(k))) return condition;
  }
  return 'Current';
}

interface Props {
  initialReport?: SurfReport | null;
  locationSlug: string;
}

const widestLocationName = LOCATIONS.reduce(
  (a, b) => (b.name.length > a.length ? b.name : a),
  ''
);

function subscribeToStandalone(callback: () => void) {
  window.addEventListener('appinstalled', callback);
  return () => window.removeEventListener('appinstalled', callback);
}

function getStandaloneSnapshot(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    ('standalone' in navigator && (navigator as { standalone?: boolean }).standalone === true)
  );
}

function getStandaloneServerSnapshot(): boolean {
  return false;
}

function subscribeNoop() {
  return () => {};
}

function getPushSupportedSnapshot(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function getPushSupportedServerSnapshot(): boolean {
  return false;
}

function getIsIOSSnapshot(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

function getIsIOSServerSnapshot(): boolean {
  return false;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const output = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) output[i] = rawData.charCodeAt(i);
  return output;
}

export function SurfAppClient({ initialReport, locationSlug }: Props) {
  const router = useRouter();
  const location = getLocation(locationSlug);
  const locationName = location?.name ?? locationSlug;
  const [open, setOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<Event & { prompt: () => void; userChoice: Promise<{ outcome: string }> } | null>(null);
  const pushSupported = useSyncExternalStore(subscribeNoop, getPushSupportedSnapshot, getPushSupportedServerSnapshot);
  const [pushState, setPushState] = useState<'idle' | 'subscribing' | 'subscribed' | 'unsubscribing'>('idle');
  const [notifyFormOpen, setNotifyFormOpen] = useState(false);
  const [iosHintOpen, setIosHintOpen] = useState(false);
  const isIOS = useSyncExternalStore(subscribeNoop, getIsIOSSnapshot, getIsIOSServerSnapshot);
  const [notifyMinHeight, setNotifyMinHeight] = useState('1');
  const [notifyMaxHeight, setNotifyMaxHeight] = useState('3');
  const [notifyMinPeriod, setNotifyMinPeriod] = useState('10');
  const isStandalone = useSyncExternalStore(subscribeToStandalone, getStandaloneSnapshot, getStandaloneServerSnapshot);
  const [audioState, setAudioState] = useState<'idle' | 'loading' | 'playing'>('idle');
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [suggestState, setSuggestState] = useState<'idle' | 'form' | 'submitting' | 'done'>('idle');
  const [suggestSpotName, setSuggestSpotName] = useState('');
  const [suggestCityState, setSuggestCityState] = useState('');
  const [suggestEmail, setSuggestEmail] = useState('');
  const [suggestHoneypot, setSuggestHoneypot] = useState('');

  function resetSuggestForm() {
    setSuggestState('idle');
    setSuggestSpotName('');
    setSuggestCityState('');
    setSuggestEmail('');
    setSuggestHoneypot('');
  }

  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (!open) resetSuggestForm();
  }

  const { report: surfReport, loading: reportLoading, error: reportError } =
    useSurfReportOptimized({ initialData: initialReport, locationSlug });

  useEffect(() => {
    if (surfReport && !reportLoading) {
      const condition = extractConditionFromReport(surfReport.report);
      // Body scale rather than feet — see [slug]/page.tsx for why.
      const size = surfReport.conditions.size_descriptor
        ?? describeWaveSize(surfReport.conditions.wave_height_ft, surfReport.conditions.wave_period_sec).size_descriptor;
      document.title = `${condition} Surf - ${size} | Swells`;
    } else if (!reportLoading) {
      document.title = `Swells - ${locationName}`;
    }
  }, [surfReport, reportLoading, locationName]);

  useEffect(() => {
    if (!open && !sourcesOpen && !notifyFormOpen && !iosHintOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); setSourcesOpen(false); setNotifyFormOpen(false); setIosHintOpen(false); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, sourcesOpen, notifyFormOpen, iosHintOpen]);

  useEffect(() => {
    const onPrompt = (e: Event) => { e.preventDefault(); setInstallPrompt(e as typeof installPrompt); };
    const onInstalled = () => setInstallPrompt(null);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    // iOS treats a home-screen-installed app and a regular Safari tab as
    // separate storage partitions, each with its own SW registration. A
    // Safari tab that isn't fully reloaded often can sit on a stale SW
    // indefinitely (the browser's own update check is lazy), so force a
    // check on register and whenever the tab regains focus.
    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => reg.update().catch(() => {}))
      .catch(() => {});

    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      navigator.serviceWorker.getRegistration('/sw.js').then((reg) => reg?.update().catch(() => {}));
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  useEffect(() => {
    if (!pushSupported) return;
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setPushState(sub ? 'subscribed' : 'idle'))
      .catch(() => {});
  }, [pushSupported]);

  async function handleInstall() {
    if (!installPrompt) return;
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    if (outcome === 'accepted') setInstallPrompt(null);
  }

  const showInstall = !isStandalone && !!installPrompt && !!surfReport && !reportLoading;
  const showListen = !!surfReport && !reportLoading;
  const showNotify = pushSupported && !!surfReport && !reportLoading;
  const showIOSHint = isIOS && !isStandalone && !showInstall && !showNotify && !!surfReport && !reportLoading;

  async function handleListen() {
    if (audioState === 'playing') {
      audioRef.current?.pause();
      setAudioState('idle');
      return;
    }
    if (!surfReport || audioState === 'loading') return;

    setAudioState('loading');
    try {
      const res = await fetch('/api/audio-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: surfReport.report }),
      });
      if (!res.ok) throw new Error('Audio generation failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.playbackRate = 1.1;
      audioRef.current = audio;
      const cleanup = () => { setAudioState('idle'); URL.revokeObjectURL(url); };
      audio.onended = cleanup;
      audio.onerror = cleanup;
      await new Promise<void>((resolve) => {
        audio.addEventListener('canplay', () => resolve(), { once: true });
        audio.load();
      });
      setAudioState('playing');
      audio.play();
    } catch {
      setAudioState('idle');
    }
  }

  async function handleNotify() {
    if (pushState === 'subscribed') {
      setPushState('unsubscribing');
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          await sub.unsubscribe();
          await fetch('/api/push-subscription', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint: sub.endpoint }),
          });
        }
        setPushState('idle');
      } catch {
        setPushState('subscribed');
      }
      return;
    }

    if (pushState !== 'idle') return;
    setNotifyFormOpen((v) => !v);
  }

  async function handleNotifySubmit(e: React.FormEvent) {
    e.preventDefault();
    setPushState('subscribing');
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setPushState('idle');
        return;
      }
      const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
      if (!vapidPublicKey) throw new Error('Missing VAPID public key');

      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      });

      const criteria = {
        min_wave_height_ft: notifyMinHeight ? Number(notifyMinHeight) : undefined,
        max_wave_height_ft: notifyMaxHeight ? Number(notifyMaxHeight) : undefined,
        min_wave_period_sec: notifyMinPeriod ? Number(notifyMinPeriod) : undefined,
      };

      const res = await fetch('/api/push-subscription', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON(), location: locationSlug, criteria }),
      });
      if (!res.ok) throw new Error('Subscribe request failed');
      setPushState('subscribed');
      setNotifyFormOpen(false);
    } catch {
      setPushState('idle');
    }
  }

  function handleLocationChange(slug: string) {
    localStorage.setItem(STORAGE_KEY, slug);
    setOpen(false);
    router.push(`/${slug}`);
  }

  async function handleSuggestSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (suggestState === 'submitting' || !suggestSpotName.trim() || !suggestCityState.trim()) return;

    setSuggestState('submitting');
    try {
      const res = await fetch('/api/location-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          spotName: suggestSpotName.trim(),
          cityState: suggestCityState.trim(),
          email: suggestEmail.trim() || undefined,
          company: suggestHoneypot,
        }),
      });
      if (!res.ok) throw new Error('Request failed');
      setSuggestState('done');
    } catch {
      setSuggestState('form');
    }
  }

  return (
    <>
      <motion.div
        className="flex flex-col items-center justify-start min-h-screen pb-28"
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: 'easeOut' }}
      >
        <div className="mt-8">
          <Image src="/wave-logo.svg" alt="Swells Logo" width={64} height={64} priority className="dark:hidden" />
          <Image src="/wave-logo-dark.svg" alt="Swells Logo" width={64} height={64} priority className="hidden dark:block" />
        </div>

        <div className="mt-6 px-4 max-w-3xl w-full">
          <SurfReportCard report={surfReport} loading={reportLoading} timezone={location?.timezone} />
          {reportError && <ErrorCard message={reportError} />}
        </div>

        <div className="mx-auto max-w-3xl w-full px-4 mt-6">
          <div className="text-sm font-mono text-gray-400 dark:text-neutral-400 mx-auto whitespace-pre-wrap pt-2 pb-3 px-4 border-gray-200 dark:border-neutral-700 border-1 border-dashed rounded-xl">
            <span className="mr-2 font-bold">Heads up!</span>
            {'This AI surf report uses '}
            <span className="relative inline-block">
              <button
                onClick={() => setSourcesOpen(o => !o)}
                className="underline underline-offset-2 decoration-dashed hover:text-gray-600 dark:hover:text-neutral-200 transition-colors cursor-pointer"
              >
                real ocean and weather data
              </button>
              <AnimatePresence>
                {sourcesOpen && (
                  <motion.div
                    className="absolute bottom-full left-1/2 mb-3 w-64 bg-white dark:bg-neutral-800 border border-gray-200 dark:border-neutral-700 rounded-xl shadow-xl overflow-hidden z-50"
                    style={{ translateX: '-50%', transformOrigin: 'bottom center' }}
                    initial={{ opacity: 0, scale: 0.92, y: 6 }}
                    animate={{ opacity: 1, scale: 1,    y: 0 }}
                    exit={{    opacity: 0, scale: 0.92, y: 6 }}
                    transition={{ type: 'spring', stiffness: 480, damping: 32, mass: 0.7 }}
                  >
                    <div className="px-4 py-3 border-b border-gray-100 dark:border-neutral-700">
                      <span className="block text-xs font-mono font-semibold uppercase tracking-widest text-gray-400 dark:text-neutral-400">Data sources</span>
                    </div>
                    {[
                      { label: 'Open-Meteo Marine', detail: 'Waves, swell, sea temp', href: 'https://open-meteo.com/en/docs/marine-weather-api' },
                      { label: 'Open-Meteo Weather', detail: 'Wind, air temp, conditions', href: 'https://open-meteo.com/en/docs' },
                      { label: 'NOAA Tides & Currents', detail: 'Tide height & predictions', href: 'https://tidesandcurrents.noaa.gov' },
                    ].map(({ label, detail, href }) => (
                      <a
                        key={href}
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex flex-col px-4 py-2.5 hover:bg-gray-50 dark:hover:bg-neutral-700 transition-colors border-b border-gray-50 dark:border-neutral-700 last:border-0"
                      >
                        <span className="text-sm font-medium font-mono text-gray-800 dark:text-neutral-100">{label}</span>
                        <span className="text-xs font-mono text-gray-400 dark:text-neutral-400">{detail}</span>
                      </a>
                    ))}
                    <div className="px-4 py-3 bg-gray-50 dark:bg-neutral-900/50 border-t border-gray-100 dark:border-neutral-700">
                      <span className="block text-xs font-mono font-semibold uppercase tracking-widest text-gray-400 dark:text-neutral-400 mb-1.5">
                        How size is measured
                      </span>
                      <p className="text-xs font-mono text-gray-500 dark:text-neutral-400 leading-relaxed">
                        Forecasts report significant wave height offshore, which is smaller than the
                        wave face you actually ride. Sizes here are described in body scale, adjusted
                        against the nearest NOAA buoy.{' '}
                        <Link
                          href="/about"
                          className="underline underline-offset-2 decoration-dashed hover:text-gray-700 dark:hover:text-neutral-200 transition-colors"
                        >
                          more
                        </Link>
                      </p>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </span>
            {', however, it can make mistakes so always check conditions yourself before paddling out.'}
          </div>
        </div>

        <div className="mx-auto max-w-3xl w-full px-4 mt-4 text-center">
          <p className="text-xs font-mono text-gray-400 dark:text-neutral-400">
            {'Built by '}
            <a
              href="https://mattwhalley.com"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 decoration-dashed hover:text-gray-600 dark:hover:text-neutral-200 transition-colors"
            >
              Matt Whalley
            </a>
            {' · '}
            <a
              href="https://github.com/mttwhlly/swells"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 decoration-dashed hover:text-gray-600 dark:hover:text-neutral-200 transition-colors"
            >
              source
            </a>
            {' · '}
            <Link href="/about" className="underline underline-offset-2 decoration-dashed hover:text-gray-600 dark:hover:text-neutral-200 transition-colors">
              about
            </Link>
            {' · '}
            <Link href="/privacy" className="underline underline-offset-2 decoration-dashed hover:text-gray-600 dark:hover:text-neutral-200 transition-colors">
              privacy
            </Link>
          </p>
        </div>
      </motion.div>

      {/* Transparent scrim captures outside clicks for any open popover */}
      <AnimatePresence>
        {(open || sourcesOpen || notifyFormOpen || iosHintOpen) && (
          <motion.div
            className="fixed inset-0 z-40"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => { setOpen(false); setSourcesOpen(false); setNotifyFormOpen(false); setIosHintOpen(false); }}
          />
        )}
      </AnimatePresence>

      {/* Dock bar */}
      <div className="fixed bottom-6 inset-x-0 flex justify-center z-50 pointer-events-none">
        <div className="pointer-events-auto flex items-center bg-white dark:bg-neutral-800 border border-gray-200 dark:border-neutral-700 rounded-2xl shadow-lg">
          {/* Location dock item */}
          <div className="relative">
            <motion.button
              onClick={() => setOpen(o => !o)}
              whileTap={{ scale: 0.93 }}
              className={`flex items-center gap-2 px-3 sm:px-5 py-3 rounded-l-2xl text-sm font-medium font-mono transition-colors ${
                open ? 'text-gray-900 dark:text-white bg-gray-100 dark:bg-neutral-700' : 'text-gray-700 dark:text-neutral-200 hover:bg-gray-50 dark:hover:bg-neutral-700'
              }`}
              aria-label="Change location"
              aria-expanded={open}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/>
                <circle cx="12" cy="9" r="2.5"/>
              </svg>
              {/* Ghost establishes fixed width = widest name; visible span sits on top */}
              <span className="relative whitespace-nowrap">
                <span className="invisible select-none">{widestLocationName}</span>
                <span className="absolute inset-0 flex items-center justify-center">{locationName}</span>
              </span>
              <motion.div
                animate={{ rotate: open ? 180 : 0 }}
                transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                className="shrink-0"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 9l6 6 6-6"/>
                </svg>
              </motion.div>
            </motion.button>

            {/* Location menu */}
            <AnimatePresence>
              {open && (
                <motion.div
                  layout
                  className="absolute bottom-full left-0 mb-2 bg-white dark:bg-neutral-800 border border-gray-200 dark:border-neutral-700 rounded-xl shadow-xl overflow-hidden"
                  style={{ transformOrigin: 'bottom left', minWidth: '100%' }}
                  initial={{ opacity: 0, scale: 0.92, y: 8 }}
                  animate={{ opacity: 1, scale: 1,    y: 0 }}
                  exit={{    opacity: 0, scale: 0.92, y: 8 }}
                  transition={{ type: 'spring', stiffness: 480, damping: 32, mass: 0.7 }}
                >
                  <motion.div
                    initial="hidden"
                    animate="visible"
                    exit="hidden"
                    variants={{
                      visible: { transition: { staggerChildren: 0.04, delayChildren: 0.04 } },
                      hidden:  {},
                    }}
                  >
                    {LOCATIONS.map((loc) => (
                      <motion.button
                        key={loc.slug}
                        variants={{
                          visible: { opacity: 1, x: 0 },
                          hidden:  { opacity: 0, x: -4 },
                        }}
                        transition={{ type: 'spring', stiffness: 500, damping: 32 }}
                        onClick={() => handleLocationChange(loc.slug)}
                        className={`w-full text-left px-4 py-2.5 text-sm font-mono whitespace-nowrap transition-colors ${
                          loc.slug === locationSlug
                            ? 'bg-gray-100 dark:bg-neutral-700 text-gray-900 dark:text-white font-semibold'
                            : 'text-gray-700 dark:text-neutral-200 hover:bg-gray-50 dark:hover:bg-neutral-700'
                        }`}
                      >
                        {loc.name}
                      </motion.button>
                    ))}
                  </motion.div>

                  <div className="border-t border-gray-100 dark:border-neutral-700">
                    {suggestState === 'idle' && (
                      <button
                        onClick={() => setSuggestState('form')}
                        className="w-full text-left px-4 py-2.5 text-sm font-mono text-gray-400 dark:text-neutral-400 hover:bg-gray-50 dark:hover:bg-neutral-700 hover:text-gray-600 dark:hover:text-neutral-200 transition-colors whitespace-nowrap flex items-center gap-2"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                          <path d="M12 5v14M5 12h14" />
                        </svg>
                        Suggest a spot
                      </button>
                    )}

                    {(suggestState === 'form' || suggestState === 'submitting') && (
                      <form onSubmit={handleSuggestSubmit} className="w-64 px-4 py-3 space-y-2">
                        <input
                          autoFocus
                          type="text"
                          required
                          value={suggestSpotName}
                          onChange={(e) => setSuggestSpotName(e.target.value)}
                          placeholder="Spot name"
                          className="w-full text-sm font-mono px-2 py-1.5 border border-gray-200 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 dark:placeholder-neutral-400 rounded-lg focus:outline-none focus:border-gray-400 dark:focus:border-neutral-400"
                        />
                        <input
                          type="text"
                          required
                          value={suggestCityState}
                          onChange={(e) => setSuggestCityState(e.target.value)}
                          placeholder="City, State"
                          className="w-full text-sm font-mono px-2 py-1.5 border border-gray-200 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 dark:placeholder-neutral-400 rounded-lg focus:outline-none focus:border-gray-400 dark:focus:border-neutral-400"
                        />
                        <input
                          type="email"
                          value={suggestEmail}
                          onChange={(e) => setSuggestEmail(e.target.value)}
                          placeholder="Email (optional)"
                          className="w-full text-sm font-mono px-2 py-1.5 border border-gray-200 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 dark:placeholder-neutral-400 rounded-lg focus:outline-none focus:border-gray-400 dark:focus:border-neutral-400"
                        />
                        <input
                          type="text"
                          value={suggestHoneypot}
                          onChange={(e) => setSuggestHoneypot(e.target.value)}
                          tabIndex={-1}
                          autoComplete="off"
                          aria-hidden="true"
                          className="hidden"
                        />
                        <div className="flex justify-end">
                          <button
                            type="submit"
                            disabled={suggestState === 'submitting'}
                            className="shrink-0 p-1.5 rounded-lg bg-gray-900 dark:bg-neutral-100 text-white dark:text-neutral-800 hover:bg-gray-700 dark:hover:bg-neutral-200 transition-colors disabled:opacity-50 disabled:cursor-wait"
                            aria-label="Submit spot suggestion"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M22 2 11 13" />
                              <path d="M22 2 15 22l-4-9-9-4 20-7Z" />
                            </svg>
                          </button>
                        </div>
                      </form>
                    )}

                    {suggestState === 'done' && (
                      <div className="px-4 py-2.5 text-sm font-mono text-gray-500 dark:text-neutral-300 whitespace-nowrap">
                        Got it — thanks!
                      </div>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <AnimatePresence>
            {showListen && (
              <motion.div
                className="flex items-center"
                initial={{ opacity: 0, width: 0 }}
                animate={{ opacity: 1, width: 'auto' }}
                exit={{ opacity: 0, width: 0 }}
                transition={{ type: 'spring', stiffness: 480, damping: 32, mass: 0.7 }}
                style={{ overflow: 'hidden' }}
              >
                <div className="w-px h-6 bg-gray-200 dark:bg-neutral-600 shrink-0" />
                <motion.button
                  onClick={handleListen}
                  whileTap={{ scale: 0.93 }}
                  disabled={audioState === 'loading'}
                  className="flex items-center gap-2 px-3 sm:px-4 py-3 text-sm font-mono text-gray-500 dark:text-neutral-300 hover:text-gray-800 dark:hover:text-neutral-100 hover:bg-gray-50 dark:hover:bg-neutral-700 transition-colors whitespace-nowrap disabled:cursor-wait"
                  title={audioState === 'playing' ? 'Pause' : 'Listen to surf report'}
                >
                  {audioState === 'idle' && (
                    <>
                      <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                        <polygon points="5,3 19,12 5,21" />
                      </svg>
                      <span className="hidden sm:inline">Listen</span>
                    </>
                  )}
                  {audioState === 'loading' && (
                    <>
                      <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="animate-spin">
                        <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
                        <path d="M12 2a10 10 0 0 1 10 10" />
                      </svg>
                      <span className="hidden sm:inline">Loading…</span>
                    </>
                  )}
                  {audioState === 'playing' && (
                    <>
                      <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                        <rect x="6" y="4" width="4" height="16" rx="1" />
                        <rect x="14" y="4" width="4" height="16" rx="1" />
                      </svg>
                      <span className="hidden sm:inline">Playing</span>
                    </>
                  )}
                </motion.button>
              </motion.div>
            )}
          </AnimatePresence>

          <AnimatePresence>
            {showInstall && (
              <motion.div
                className="flex items-center"
                initial={{ opacity: 0, width: 0 }}
                animate={{ opacity: 1, width: 'auto' }}
                exit={{ opacity: 0, width: 0 }}
                transition={{ type: 'spring', stiffness: 480, damping: 32, mass: 0.7 }}
                style={{ overflow: 'hidden' }}
              >
                <div className="w-px h-6 bg-gray-200 dark:bg-neutral-600 shrink-0" />
                <motion.button
                  onClick={handleInstall}
                  whileTap={{ scale: 0.93 }}
                  className="flex items-center gap-2 px-3 sm:px-4 py-3 text-sm font-mono text-gray-500 dark:text-neutral-300 hover:text-gray-800 dark:hover:text-neutral-100 hover:bg-gray-50 dark:hover:bg-neutral-700 rounded-r-2xl transition-colors whitespace-nowrap"
                  title="Add to Home Screen"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 16V4M8 12l4 4 4-4"/>
                    <path d="M20 16v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2"/>
                  </svg>
                  <span className="hidden sm:inline">Install</span>
                </motion.button>
              </motion.div>
            )}
          </AnimatePresence>

          <AnimatePresence>
            {showIOSHint && (
              <motion.div
                className="relative flex items-center"
                initial={{ opacity: 0, width: 0 }}
                animate={{ opacity: 1, width: 'auto' }}
                exit={{ opacity: 0, width: 0 }}
                transition={{ type: 'spring', stiffness: 480, damping: 32, mass: 0.7 }}
                style={{ overflow: iosHintOpen ? 'visible' : 'hidden' }}
              >
                <div className="w-px h-6 bg-gray-200 dark:bg-neutral-600 shrink-0" />
                <motion.button
                  onClick={() => setIosHintOpen((v) => !v)}
                  whileTap={{ scale: 0.93 }}
                  className="flex items-center gap-2 px-3 sm:px-4 py-3 text-sm font-mono text-gray-500 dark:text-neutral-300 hover:text-gray-800 dark:hover:text-neutral-100 hover:bg-gray-50 dark:hover:bg-neutral-700 rounded-r-2xl transition-colors whitespace-nowrap"
                  title="Add to Home Screen to install and enable notifications"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 16V4M8 12l4 4 4-4"/>
                    <path d="M20 16v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2"/>
                  </svg>
                  <span className="hidden sm:inline">Install</span>
                </motion.button>

                <AnimatePresence>
                  {iosHintOpen && (
                    <motion.div
                      className="absolute bottom-full right-0 mb-2 bg-white dark:bg-neutral-800 border border-gray-200 dark:border-neutral-700 rounded-xl shadow-xl overflow-hidden z-50"
                      style={{ transformOrigin: 'bottom right' }}
                      initial={{ opacity: 0, scale: 0.92, y: 8 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.92, y: 8 }}
                      transition={{ type: 'spring', stiffness: 480, damping: 32, mass: 0.7 }}
                    >
                      <p className="w-64 px-4 py-3 text-xs font-mono text-gray-500 dark:text-neutral-300 whitespace-normal leading-relaxed">
                        Tap{' '}
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="inline align-text-bottom mx-0.5">
                          <path d="M12 2v13M8 6l4-4 4 4" />
                          <rect x="5" y="10" width="14" height="11" rx="2" />
                        </svg>{' '}
                        Share, then <strong className="text-gray-700 dark:text-neutral-200">Add to Home Screen</strong> to install Swells and turn on notifications.
                      </p>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            )}
          </AnimatePresence>

          <AnimatePresence>
            {showNotify && (
              <motion.div
                className="relative flex items-center"
                initial={{ opacity: 0, width: 0 }}
                animate={{ opacity: 1, width: 'auto' }}
                exit={{ opacity: 0, width: 0 }}
                transition={{ type: 'spring', stiffness: 480, damping: 32, mass: 0.7 }}
                style={{ overflow: notifyFormOpen ? 'visible' : 'hidden' }}
              >
                <div className="w-px h-6 bg-gray-200 dark:bg-neutral-600 shrink-0" />
                <motion.button
                  onClick={handleNotify}
                  whileTap={{ scale: 0.93 }}
                  disabled={pushState === 'subscribing' || pushState === 'unsubscribing'}
                  className="flex items-center gap-2 px-3 sm:px-4 py-3 text-sm font-mono text-gray-500 dark:text-neutral-300 hover:text-gray-800 dark:hover:text-neutral-100 hover:bg-gray-50 dark:hover:bg-neutral-700 rounded-r-2xl transition-colors whitespace-nowrap disabled:cursor-wait"
                  title={pushState === 'subscribed' ? `Turn off notifications for ${locationName}` : `Get notified about ${locationName}`}
                >
                  {pushState === 'subscribed' ? (
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                      <path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4a1.5 1.5 0 0 0-3 0v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/>
                    </svg>
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/>
                      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>
                    </svg>
                  )}
                  <span className="hidden sm:inline">{pushState === 'subscribed' ? 'Notified' : 'Notify'}</span>
                </motion.button>

                <AnimatePresence>
                  {notifyFormOpen && (
                    <motion.div
                      className="absolute bottom-full right-0 mb-2 bg-white dark:bg-neutral-800 border border-gray-200 dark:border-neutral-700 rounded-xl shadow-xl overflow-hidden z-50"
                      style={{ transformOrigin: 'bottom right' }}
                      initial={{ opacity: 0, scale: 0.92, y: 8 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.92, y: 8 }}
                      transition={{ type: 'spring', stiffness: 480, damping: 32, mass: 0.7 }}
                    >
                      <form onSubmit={handleNotifySubmit} className="w-64 px-4 py-3 space-y-2">
                        <p className="text-xs font-mono text-gray-400 dark:text-neutral-400 whitespace-normal">
                          Notify me about {locationName} when:
                        </p>
                        <div className="flex items-center gap-1.5">
                          <input
                            type="number"
                            step="0.5"
                            min="0"
                            value={notifyMinHeight}
                            onChange={(e) => setNotifyMinHeight(e.target.value)}
                            placeholder="Min"
                            className="w-16 text-sm font-mono px-2 py-1.5 border border-gray-200 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 dark:placeholder-neutral-400 rounded-lg focus:outline-none focus:border-gray-400 dark:focus:border-neutral-400"
                          />
                          <span className="text-xs font-mono text-gray-400 dark:text-neutral-400">–</span>
                          <input
                            type="number"
                            step="0.5"
                            min="0"
                            value={notifyMaxHeight}
                            onChange={(e) => setNotifyMaxHeight(e.target.value)}
                            placeholder="Max"
                            className="w-16 text-sm font-mono px-2 py-1.5 border border-gray-200 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 dark:placeholder-neutral-400 rounded-lg focus:outline-none focus:border-gray-400 dark:focus:border-neutral-400"
                          />
                          <span className="text-xs font-mono text-gray-400 dark:text-neutral-400">ft</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <input
                            type="number"
                            step="1"
                            min="0"
                            value={notifyMinPeriod}
                            onChange={(e) => setNotifyMinPeriod(e.target.value)}
                            placeholder="Min"
                            className="w-16 text-sm font-mono px-2 py-1.5 border border-gray-200 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 dark:placeholder-neutral-400 rounded-lg focus:outline-none focus:border-gray-400 dark:focus:border-neutral-400"
                          />
                          <span className="text-xs font-mono text-gray-400 dark:text-neutral-400">sec+ period</span>
                        </div>
                        <div className="flex justify-end">
                          <button
                            type="submit"
                            disabled={pushState === 'subscribing'}
                            className="shrink-0 p-1.5 rounded-lg bg-gray-900 dark:bg-neutral-100 text-white dark:text-neutral-800 hover:bg-gray-700 dark:hover:bg-neutral-200 transition-colors disabled:opacity-50 disabled:cursor-wait"
                            aria-label="Subscribe to notifications"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M22 2 11 13" />
                              <path d="M22 2 15 22l-4-9-9-4 20-7Z" />
                            </svg>
                          </button>
                        </div>
                      </form>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </>
  );
}
