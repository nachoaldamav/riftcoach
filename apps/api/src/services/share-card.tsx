/** @jsxImportSource react */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';
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
  role?: string;
}

const CANVAS_WIDTH = 1200;
const CANVAS_HEIGHT = 630;

const fontCache = new Map<string, ArrayBuffer>();
const imageCache = new Map<string, string>();

function fontPath(rel: string): string {
  // Resolve fonts from web public assets so production/dev both work
  // apps/api -> apps/web/public/fonts
  return path.resolve(process.cwd(), '../web/public/fonts', rel);
}

async function loadFontFromFS(
  rel: string,
  cacheKey: string,
): Promise<ArrayBuffer | null> {
  const cached = fontCache.get(cacheKey);
  if (cached) return cached;
  try {
    const p = fontPath(rel);
    const data = await readFile(p);
    // Ensure we return a plain ArrayBuffer (not SharedArrayBuffer union)
    const ab = new ArrayBuffer(data.byteLength);
    new Uint8Array(ab).set(data);
    fontCache.set(cacheKey, ab);
    return ab;
  } catch (err) {
    console.warn('[share-card] failed to read font', cacheKey, err);
    return null;
  }
}

async function fetchImageAsDataUrl(url: string): Promise<string> {
  const cached = imageCache.get(url);
  if (cached) return cached;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch image: ${url}`);
  const ct = res.headers.get('content-type') || 'image/jpeg';
  const buf = await res.arrayBuffer();
  const b64 = Buffer.from(buf).toString('base64');
  const dataUrl = `data:${ct};base64,${b64}`;
  imageCache.set(url, dataUrl);
  return dataUrl;
}

export async function renderShareCard(
  options: ProfileShareCardOptions,
): Promise<Uint8Array> {
  const [interRegular, interBold, interItalic, interBoldItalic] =
    await Promise.all([
      loadFontFromFS('inter/Inter-Regular.ttf', 'inter-regular'),
      loadFontFromFS('inter/Inter-Bold.ttf', 'inter-bold'),
      loadFontFromFS('inter/Inter-Italic.ttf', 'inter-italic'),
      loadFontFromFS('inter/Inter-BoldItalic.ttf', 'inter-bold-italic'),
    ]);

  const [notoKrRegular, notoKrBold] = await Promise.all([
    loadFontFromFS('noto-sans-kr/NotoSansKR-Regular.ttf', 'noto-kr-400'),
    loadFontFromFS('noto-sans-kr/NotoSansKR-Bold.ttf', 'noto-kr-700'),
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

  // Korean/Hangul fallback (no italic variant)
  if (notoKrRegular) {
    fontsConfig.push({
      name: 'Noto Sans KR',
      data: notoKrRegular,
      weight: 400 as Weight,
      style: 'normal',
    });
  }
  if (notoKrBold) {
    fontsConfig.push({
      name: 'Noto Sans KR',
      data: notoKrBold,
      weight: 700 as Weight,
      style: 'normal',
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
        fontFamily: 'Inter, "Noto Sans KR", ui-sans-serif',
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
          // Satori has stricter radial-gradient parsing; use circle with explicit stops
          background:
            'radial-gradient(circle at 1000px 315px, rgba(30,64,175,0.5) 0%, transparent 70%)',
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
                alt={`${options.playerName} icon`}
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
                  letterSpacing: '0.02em',
                  color: 'rgba(148,163,184,0.85)',
                  display: 'flex',
                }}
              >
                Riftcoach Year in Review
              </span>
            </div>
          </div>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              gap: 6,
            }}
          >
            <span
              style={{
                fontSize: 16,
                fontWeight: 600,
                letterSpacing: '0.18em',
                color: 'rgba(148,163,184,0.85)',
              }}
            >
              CHAMPION HIGHLIGHT
            </span>
            <span
              style={{
                fontSize: 40,
                fontWeight: 700,
                letterSpacing: '-0.01em',
                color: '#FFFFFF',
              }}
            >
              {options.champion.name}
            </span>
            {options.role ? (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <div
                  style={{
                    display: 'flex',
                    padding: '6px 10px',
                    borderRadius: 9999,
                    backgroundColor: 'rgba(23,37,84,0.6)',
                    border: '1px solid rgba(147,197,253,0.5)',
                    color: 'rgba(219,234,254,0.95)',
                    fontSize: 16,
                    fontWeight: 600,
                    letterSpacing: '0.02em',
                  }}
                >
                  {options.role.toUpperCase()}
                </div>
              </div>
            ) : null}
            <div style={{ display: 'flex', gap: 12 }}>
              <span style={{ fontSize: 16, color: 'rgba(148,163,184,0.9)' }}>
                Games:{' '}
                <span
                  style={{ color: 'rgba(219,234,254,0.95)', fontWeight: 700 }}
                >
                  {options.champion.games}
                </span>
              </span>
              <span style={{ fontSize: 16, color: 'rgba(148,163,184,0.9)' }}>
                Win Rate:{' '}
                <span
                  style={{ color: 'rgba(219,234,254,0.95)', fontWeight: 700 }}
                >
                  {options.champion.winRate.toFixed(1)}%
                </span>
              </span>
              <span style={{ fontSize: 16, color: 'rgba(148,163,184,0.9)' }}>
                KDA:{' '}
                <span
                  style={{ color: 'rgba(219,234,254,0.95)', fontWeight: 700 }}
                >
                  {options.champion.kda.toFixed(2)}
                </span>
              </span>
            </div>
          </div>
        </div>

        {/* Content */}
        <div style={{ display: 'flex', gap: 24 }}>
          <div style={{ display: 'flex', flex: 1 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
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
                const max =
                  m.suffix === '%' ? 100 : Math.max(m.player, m.cohort, 1);
                const scale = 220; // px
                const playerW = Math.max(
                  0,
                  Math.min(scale, Math.round((m.player / max) * scale)),
                );
                const cohortW = Math.max(
                  0,
                  Math.min(scale, Math.round((m.cohort / max) * scale)),
                );
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
                    }}
                  >
                    <div
                      style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                    >
                      <span
                        style={{
                          fontSize: 18,
                          fontWeight: 600,
                          letterSpacing: '0.03em',
                          color: mc.accent,
                          display: 'flex',
                        }}
                      >
                        {m.label}
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
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 6,
                        marginTop: 4,
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          width: scale,
                          height: 8,
                          borderRadius: 9999,
                          backgroundColor: 'rgba(30,41,59,0.6)',
                          border: '1px solid rgba(147,197,253,0.3)',
                          overflow: 'hidden',
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            width: playerW,
                            height: '100%',
                            backgroundColor: 'rgba(59,130,246,0.85)',
                          }}
                        />
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          width: scale,
                          height: 8,
                          borderRadius: 9999,
                          backgroundColor: 'rgba(30,41,59,0.6)',
                          border: '1px solid rgba(147,197,253,0.3)',
                          overflow: 'hidden',
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            width: cohortW,
                            height: '100%',
                            backgroundColor: 'rgba(148,163,184,0.85)',
                          }}
                        />
                      </div>
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
              alt="champion"
              style={{
                width: '100%',
                height: '100%',
                display: 'flex',
                objectFit: 'cover',
              }}
            />
          </div>
        </div>

        {/* Badges */}
        {options.badges && options.badges.length > 0 ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            {options.badges.map((rawBadge) => {
              const [type, labelParts] = rawBadge.split(':');
              const label = labelParts ? labelParts.trim() : rawBadge;
              const palette: Record<
                string,
                { bg: string; border: string; color: string }
              > = {
                support: {
                  bg: 'rgba(30,64,175,0.2)',
                  border: 'rgba(30,64,175,0.5)',
                  color: 'rgba(219,234,254,0.95)',
                },
                top: {
                  bg: 'rgba(59,130,246,0.2)',
                  border: 'rgba(59,130,246,0.5)',
                  color: 'rgba(219,234,254,0.95)',
                },
                jungle: {
                  bg: 'rgba(16,185,129,0.2)',
                  border: 'rgba(16,185,129,0.5)',
                  color: 'rgba(219,234,254,0.95)',
                },
                mid: {
                  bg: 'rgba(147,51,234,0.2)',
                  border: 'rgba(147,51,234,0.5)',
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
                streak: {
                  bg: 'rgba(234,88,12,0.2)',
                  border: 'rgba(234,88,12,0.5)',
                  color: 'rgba(254,240,138,0.95)',
                },
                consistency: {
                  bg: 'rgba(34,197,94,0.2)',
                  border: 'rgba(34,197,94,0.5)',
                  color: 'rgba(219,234,254,0.95)',
                },
                aggressive: {
                  bg: 'rgba(220,38,38,0.2)',
                  border: 'rgba(220,38,38,0.5)',
                  color: 'rgba(254,202,202,0.95)',
                },
                vision: {
                  bg: 'rgba(2,132,199,0.2)',
                  border: 'rgba(2,132,199,0.5)',
                  color: 'rgba(219,234,254,0.95)',
                },
                objective: {
                  bg: 'rgba(234,179,8,0.2)',
                  border: 'rgba(234,179,8,0.5)',
                  color: 'rgba(219,234,254,0.95)',
                },
                carry: {
                  bg: 'rgba(59,130,246,0.2)',
                  border: 'rgba(59,130,246,0.5)',
                  color: 'rgba(219,234,254,0.95)',
                },
                teamfight: {
                  bg: 'rgba(139,92,246,0.2)',
                  border: 'rgba(139,92,246,0.5)',
                  color: 'rgba(219,234,254,0.95)',
                },
                macro: {
                  bg: 'rgba(99,102,241,0.2)',
                  border: 'rgba(99,102,241,0.5)',
                  color: 'rgba(219,234,254,0.95)',
                },
                micro: {
                  bg: 'rgba(56,189,248,0.2)',
                  border: 'rgba(56,189,248,0.5)',
                  color: 'rgba(219,234,254,0.95)',
                },
                early: {
                  bg: 'rgba(6,182,212,0.2)',
                  border: 'rgba(6,182,212,0.5)',
                  color: 'rgba(219,234,254,0.95)',
                },
                late: {
                  bg: 'rgba(168,85,247,0.2)',
                  border: 'rgba(168,85,247,0.5)',
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
        ) : null}
        <div
          style={{
            position: 'absolute',
            right: 24,
            bottom: 20,
            fontSize: 16,
            color: 'rgba(148,163,184,0.7)',
            letterSpacing: '0.06em',
            display: 'flex',
          }}
        >
          riftcoach.dev
        </div>
      </div>
    </div>,
    {
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT,
      fonts: fontsConfig,
    },
  );

  const resvg = new Resvg(svg, { fitTo: { mode: 'zoom', value: 2 } });
  const pngData = resvg.render().asPng();
  return pngData;
}
