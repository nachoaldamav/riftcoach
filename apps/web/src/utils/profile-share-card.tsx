import { Resvg, initWasm } from '@resvg/resvg-wasm';
import resvgWasmUrl from '@resvg/resvg-wasm/index_bg.wasm?url';
/** @jsxImportSource react */
import satori, { type SatoriOptions } from 'satori';

type FontOptions = SatoriOptions['fonts'][0];
type Weight = FontOptions['weight'];

export interface ShareMetric {
  label: string;
  player: number;
  cohort: number;
  suffix?: string;
}

export interface ChampionHighlight {
  name: string;
  games: number;
  winRate: number;
  kda: number;
  splashUrl: string;
}

export interface ProfileShareCardOptions {
  playerName: string;
  tagLine: string;
  profileIconUrl: string;
  backgroundUrl: string;
  champion: ChampionHighlight;
  metrics: ShareMetric[];
  badges?: string[];
}

const CANVAS_WIDTH = 1200;
const CANVAS_HEIGHT = 630;

const fontCache = new Map<string, ArrayBuffer>();
const imageCache = new Map<string, string>();
const resultCache = new Map<string, { svg: string; pngBlob: Blob }>();

// Ensure Resvg WASM is initialized only once per runtime
let wasmInitPromise: Promise<void> | null = null;
let wasmInitialized = false;
async function ensureResvgWasmInitialized(): Promise<void> {
  if (wasmInitialized) return;
  if (!wasmInitPromise) {
    // Assign the promise synchronously to avoid race conditions
    wasmInitPromise = (async () => {
      try {
        const wasmBinary = await fetch(resvgWasmUrl).then((r) =>
          r.arrayBuffer(),
        );
        await initWasm(wasmBinary);
        wasmInitialized = true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // If WASM is already initialized (e.g., HMR or prior init), mark as initialized and proceed
        if (msg.includes('Already initialized')) {
          wasmInitialized = true;
          return;
        }
        // Reset the promise to allow future retries if initialization fails
        wasmInitPromise = null;
        throw e;
      }
    })();
  }
  return wasmInitPromise;
}

async function fetchArrayBuffer(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch: ${url}`);
  return res.arrayBuffer();
}

async function fetchImageAsDataUrl(url: string): Promise<string> {
  const cached = imageCache.get(url);
  if (cached) return cached;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch image: ${url}`);
  const blob = await res.blob();
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === 'string') {
        imageCache.set(url, reader.result);
        resolve(reader.result);
      } else {
        reject(new Error('Failed to convert image to data URL'));
      }
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function loadFont(
  url: string,
  cacheKey: string,
): Promise<ArrayBuffer | null> {
  const cached = fontCache.get(cacheKey);
  if (cached) return cached;
  try {
    const data = await fetchArrayBuffer(url);
    fontCache.set(cacheKey, data);
    return data;
  } catch (err) {
    console.warn(`[share-card] font fetch failed for ${cacheKey}:`, err);
    return null;
  }
}

const interRegularUrl = '/fonts/inter/Inter-Regular.ttf';
const interBoldUrl = '/fonts/inter/Inter-Bold.ttf';
const interItalicUrl = '/fonts/inter/Inter-Italic.ttf';
const interBoldItalicUrl = '/fonts/inter/Inter-BoldItalic.ttf';

export async function generateProfileShareCard(options: {
  playerName: string;
  tagLine: string;
  profileIconUrl: string;
  backgroundUrl: string;
  champion: ChampionHighlight;
  metrics: ShareMetric[];
  badges?: string[];
}): Promise<{ svg: string; pngBlob: Blob }> {
  // Use a deterministic cache key to avoid recomputing identical cards
  const cacheKey = JSON.stringify({
    playerName: options.playerName,
    tagLine: options.tagLine,
    profileIconUrl: options.profileIconUrl,
    backgroundUrl: options.backgroundUrl,
    champion: options.champion,
    metrics: options.metrics,
    badges: options.badges ?? [],
  });
  const cached = resultCache.get(cacheKey);
  if (cached) return cached;
  const [interRegular, interBold, interItalic, interBoldItalic] =
    await Promise.all([
      loadFont(interRegularUrl, 'inter-regular'),
      loadFont(interBoldUrl, 'inter-bold'),
      loadFont(interItalicUrl, 'inter-italic'),
      loadFont(interBoldItalicUrl, 'inter-bold-italic'),
    ]);

  const profileIcon = await fetchImageAsDataUrl(options.profileIconUrl);
  const backgroundImage = await fetchImageAsDataUrl(options.backgroundUrl);

  const fontsConfig: FontOptions[] = [];
  if (interRegular) {
    fontsConfig.push({
      name: 'Inter',
      data: interRegular,
      weight: 400 as Weight,
      style: 'normal',
    });
  }
  if (interBold) {
    fontsConfig.push({
      name: 'Inter',
      data: interBold,
      weight: 700 as Weight,
      style: 'normal',
    });
  }
  if (interItalic) {
    fontsConfig.push({
      name: 'Inter',
      data: interItalic,
      weight: 400 as Weight,
      style: 'italic',
    });
  }
  if (interBoldItalic) {
    fontsConfig.push({
      name: 'Inter',
      data: interBoldItalic,
      weight: 700 as Weight,
      style: 'italic',
    });
  }

  const svg = await satori(
    <div
      style={{
        width: CANVAS_WIDTH,
        height: CANVAS_HEIGHT,
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: '#0B1220',
        position: 'relative',
      }}
    >
      <img
        src={backgroundImage}
        alt="background"
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          opacity: 0.2,
          filter: 'blur(12px)',
          display: 'flex',
        }}
      />

      <div
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'radial-gradient(1200px 630px at 1000px 315px, rgba(30,64,175,0.5), transparent)',
          display: 'flex',
        }}
      />

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          height: '100%',
          padding: 40,
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
            <div
              style={{
                display: 'flex',
                width: 72,
                height: 72,
                borderRadius: 16,
                overflow: 'hidden',
                border: '2px solid rgba(147,197,253,0.5)',
                backgroundColor: 'rgba(30,41,59,0.6)',
              }}
            >
              <img
                src={profileIcon}
                alt={`${options.playerName} icon}`}
                style={{ width: '100%', height: '100%', display: 'flex' }}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span
                  style={{
                    fontSize: 48,
                    fontWeight: 700,
                    letterSpacing: '-0.02em',
                    display: 'flex',
                    color: '#FFFFFF',
                  }}
                >
                  {options.playerName}
                </span>
                <span
                  style={{
                    fontSize: 48,
                    fontWeight: 700,
                    letterSpacing: '-0.02em',
                    color: 'rgba(148,163,184,0.9)',
                    display: 'flex',
                  }}
                >
                  #{options.tagLine}
                </span>
              </div>
              <span
                style={{
                  fontSize: 20,
                  color: 'rgba(148,163,184,0.9)',
                  marginTop: 6,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  display: 'flex',
                }}
              >
                Riftcoach Performance Snapshot
              </span>
            </div>
          </div>

          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-end',
              gap: 8,
            }}
          >
            <span
              style={{
                fontSize: 18,
                color: 'rgba(148,163,184,0.8)',
                textTransform: 'uppercase',
                letterSpacing: '0.2em',
                display: 'flex',
              }}
            >
              Champion Highlight
            </span>
            <span
              style={{
                fontSize: 26,
                fontWeight: 700,
                color: 'rgba(219,234,254,0.95)',
                display: 'flex',
              }}
            >
              {options.champion.name}
            </span>
            <div style={{ display: 'flex', gap: 16 }}>
              <div
                style={{
                  display: 'flex',
                  gap: 6,
                  alignItems: 'baseline',
                  color: 'rgba(148,163,184,0.9)',
                }}
              >
                <span style={{ display: 'flex' }}>Games:</span>
                <span
                  style={{
                    color: 'rgba(219,234,254,0.95)',
                    fontWeight: 700,
                    display: 'flex',
                  }}
                >
                  {options.champion.games}
                </span>
              </div>
              <div
                style={{
                  display: 'flex',
                  gap: 6,
                  alignItems: 'baseline',
                  color: 'rgba(148,163,184,0.9)',
                }}
              >
                <span style={{ display: 'flex' }}>Win Rate:</span>
                <span
                  style={{
                    color: 'rgba(219,234,254,0.95)',
                    fontWeight: 700,
                    display: 'flex',
                  }}
                >
                  {options.champion.winRate}%
                </span>
              </div>
              <div
                style={{
                  display: 'flex',
                  gap: 6,
                  alignItems: 'baseline',
                  color: 'rgba(148,163,184,0.9)',
                }}
              >
                <span style={{ display: 'flex' }}>KDA:</span>
                <span
                  style={{
                    color: 'rgba(219,234,254,0.95)',
                    fontWeight: 700,
                    display: 'flex',
                  }}
                >
                  {options.champion.kda.toFixed(2)}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Middle content */}
        <div style={{ display: 'flex', gap: 24 }}>
          <div style={{ display: 'flex', flex: 1 }}>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 16,
              }}
            >
              {options.metrics.map((m) => {
                const diff = m.player - m.cohort;
                const comparison =
                  diff > 0 ? 'better' : diff < 0 ? 'worse' : 'even';
                const metricPalette: Record<
                  string,
                  { bg: string; border: string; accent: string }
                > = {
                  better: {
                    bg: 'rgba(16,185,129,0.18)',
                    border: 'rgba(16,185,129,0.45)',
                    accent: 'rgba(16,185,129,0.9)',
                  },
                  worse: {
                    bg: 'rgba(244,63,94,0.18)',
                    border: 'rgba(244,63,94,0.45)',
                    accent: 'rgba(244,63,94,0.9)',
                  },
                  even: {
                    bg: 'rgba(23,37,84,0.6)',
                    border: 'rgba(147,197,253,0.3)',
                    accent: 'rgba(148,163,184,0.9)',
                  },
                };
                const mc = metricPalette[comparison];
                return (
                  <div
                    key={m.label}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                      padding: 16,
                      borderRadius: 12,
                      backgroundColor: mc.bg,
                      border: `1px solid ${mc.border}`,
                      width: '50%',
                      boxSizing: 'border-box',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                      }}
                    >
                      <span
                        style={{
                          fontSize: 16,
                          color: 'rgba(148,163,184,0.9)',
                          letterSpacing: '0.08em',
                          textTransform: 'uppercase',
                          display: 'flex',
                        }}
                      >
                        {m.label}
                      </span>
                      <span
                        style={{
                          fontSize: 14,
                          fontWeight: 700,
                          color: mc.accent,
                          display: 'flex',
                          alignItems: 'center',
                          letterSpacing: '0.04em',
                        }}
                      >
                        {comparison === 'better'
                          ? '▲ Better'
                          : comparison === 'worse'
                            ? '▼ Worse'
                            : '▬ Even'}
                      </span>
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'baseline',
                        gap: 8,
                      }}
                    >
                      <span
                        style={{
                          fontSize: 42,
                          fontWeight: 700,
                          color: 'rgba(219,234,254,0.95)',
                          display: 'flex',
                        }}
                      >
                        {m.player.toFixed(1)}
                        {m.suffix ?? ''}
                      </span>
                      <span
                        style={{
                          fontSize: 18,
                          color: 'rgba(148,163,184,0.8)',
                          display: 'flex',
                        }}
                      >
                        Cohort: {m.cohort.toFixed(1)}
                        {m.suffix ?? ''}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div
            style={{
              display: 'flex',
              width: 480,
              height: 270,
              borderRadius: 16,
              overflow: 'hidden',
              border: '2px solid rgba(147,197,253,0.5)',
              backgroundColor: 'rgba(23,37,84,0.6)',
            }}
          >
            <img
              src={backgroundImage}
              alt="champion splash"
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                display: 'flex',
              }}
            />
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          {options.badges && options.badges.length > 0 && (
            <div style={{ display: 'flex', gap: 12 }}>
              {options.badges.slice(0, 3).map((rawBadge) => {
                const [type, label] = rawBadge.includes(':')
                  ? [
                      rawBadge.split(':')[0].trim().toLowerCase(),
                      rawBadge.split(':').slice(1).join(':').trim(),
                    ]
                  : [rawBadge.trim().toLowerCase(), rawBadge.trim()];
                const palette: Record<
                  string,
                  { bg: string; border: string; color: string }
                > = {
                  mvp: {
                    bg: 'rgba(24,119,242,0.2)',
                    border: 'rgba(24,119,242,0.5)',
                    color: 'rgba(219,234,254,0.95)',
                  },
                  carry: {
                    bg: 'rgba(16,185,129,0.2)',
                    border: 'rgba(16,185,129,0.5)',
                    color: 'rgba(219,234,254,0.95)',
                  },
                  support: {
                    bg: 'rgba(99,102,241,0.2)',
                    border: 'rgba(99,102,241,0.5)',
                    color: 'rgba(219,234,254,0.95)',
                  },
                  vision: {
                    bg: 'rgba(168,85,247,0.2)',
                    border: 'rgba(168,85,247,0.5)',
                    color: 'rgba(219,234,254,0.95)',
                  },
                  clutch: {
                    bg: 'rgba(245,158,11,0.2)',
                    border: 'rgba(245,158,11,0.5)',
                    color: 'rgba(219,234,254,0.95)',
                  },
                  kda: {
                    bg: 'rgba(244,63,94,0.2)',
                    border: 'rgba(244,63,94,0.5)',
                    color: 'rgba(219,234,254,0.95)',
                  },
                  wr: {
                    bg: 'rgba(37,99,235,0.2)',
                    border: 'rgba(37,99,235,0.5)',
                    color: 'rgba(219,234,254,0.95)',
                  },
                  top: {
                    bg: 'rgba(99,102,241,0.2)',
                    border: 'rgba(99,102,241,0.5)',
                    color: 'rgba(219,234,254,0.95)',
                  },
                  jungle: {
                    bg: 'rgba(34,197,94,0.2)',
                    border: 'rgba(34,197,94,0.5)',
                    color: 'rgba(219,234,254,0.95)',
                  },
                  mid: {
                    bg: 'rgba(59,130,246,0.2)',
                    border: 'rgba(59,130,246,0.5)',
                    color: 'rgba(219,234,254,0.95)',
                  },
                  adc: {
                    bg: 'rgba(245,158,11,0.2)',
                    border: 'rgba(245,158,11,0.5)',
                    color: 'rgba(219,234,254,0.95)',
                  },
                  aram: {
                    bg: 'rgba(75,85,99,0.2)',
                    border: 'rgba(75,85,99,0.5)',
                    color: 'rgba(219,234,254,0.95)',
                  },
                  ranked: {
                    bg: 'rgba(30,64,175,0.2)',
                    border: 'rgba(30,64,175,0.5)',
                    color: 'rgba(219,234,254,0.95)',
                  },
                };
                const colors = palette[type] ?? {
                  bg: 'rgba(23,37,84,0.6)',
                  border: 'rgba(147,197,253,0.3)',
                  color: 'rgba(219,234,254,0.95)',
                };
                return (
                  <div
                    key={rawBadge}
                    style={{
                      display: 'flex',
                      padding: '10px 16px',
                      borderRadius: 9999,
                      backgroundColor: colors.bg,
                      border: `1px solid ${colors.border}`,
                      fontSize: 20,
                      fontWeight: 600,
                      color: colors.color,
                      letterSpacing: '0.03em',
                    }}
                  >
                    {label}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>,
    {
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT,
      fonts: fontsConfig,
    },
  );
  // Yield to the browser to paint the UI before heavy WASM work
  await new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(() => resolve(), 0);
    }
  });
  await ensureResvgWasmInitialized();
  const resvg = new Resvg(svg, {
    fitTo: {
      mode: 'zoom',
      value: 2,
    },
  });

  const pngData = resvg.render().asPng();
  // Construct Blob from a true ArrayBuffer to satisfy DOM BlobPart typing
  const ab = new ArrayBuffer(pngData.byteLength);
  const abView = new Uint8Array(ab);
  abView.set(pngData);
  const pngBlob = new Blob([ab], { type: 'image/png' });
  const result = { svg, pngBlob };
  resultCache.set(cacheKey, result);
  return result;
}
