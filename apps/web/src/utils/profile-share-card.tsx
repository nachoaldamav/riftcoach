/** @jsxImportSource react */
import satori from 'satori';

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

async function loadFont(url: string): Promise<ArrayBuffer> {
  if (fontCache.has(url)) {
    const cached = fontCache.get(url);
    if (cached) {
      return cached;
    }
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load font from ${url}`);
  }

  const buffer = await response.arrayBuffer();
  fontCache.set(url, buffer);
  return buffer;
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function loadImageAsDataUrl(url: string): Promise<string> {
  if (imageCache.has(url)) {
    const cached = imageCache.get(url);
    if (cached) {
      return cached;
    }
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load image from ${url}`);
  }

  const contentType = response.headers.get('content-type') ?? 'image/png';
  const buffer = await response.arrayBuffer();
  const base64 = arrayBufferToBase64(buffer);
  const dataUrl = `data:${contentType};base64,${base64}`;
  imageCache.set(url, dataUrl);
  return dataUrl;
}

function formatMetricValue(value: number, suffix?: string) {
  const formatted = Math.abs(value) >= 100
    ? Math.round(value).toString()
    : value.toFixed(1);
  return suffix ? `${formatted}${suffix}` : formatted;
}

export async function generateProfileShareCard(
  options: ProfileShareCardOptions,
): Promise<{ svg: string; pngBlob: Blob }> {
  const [interRegular, interSemiBold] = await Promise.all([
    loadFont('/fonts/Inter-Regular.ttf'),
    loadFont('/fonts/Inter-SemiBold.ttf'),
  ]);

  const [profileIcon, backgroundImage, championSplash] = await Promise.all([
    loadImageAsDataUrl(options.profileIconUrl),
    loadImageAsDataUrl(options.backgroundUrl),
    loadImageAsDataUrl(options.champion.splashUrl),
  ]);

  const svg = await satori(
    (
      <div
        style={{
          width: CANVAS_WIDTH,
          height: CANVAS_HEIGHT,
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
          backgroundColor: '#05070f',
          color: '#f8fafc',
          fontFamily: 'Inter',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
          }}
        >
          <img
            src={backgroundImage}
            alt="background"
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              filter: 'blur(8px) brightness(0.65)',
              transform: 'scale(1.05)',
            }}
          />
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background:
                'linear-gradient(135deg, rgba(5,7,15,0.92) 0%, rgba(15,23,42,0.88) 40%, rgba(30,41,59,0.85) 100%)',
            }}
          />
        </div>

        <div
          style={{
            position: 'absolute',
            right: -120,
            bottom: -60,
            opacity: 0.45,
            filter: 'drop-shadow(0px 18px 40px rgba(15,23,42,0.35))',
          }}
        >
          <img
            src={championSplash}
            alt={options.champion.name}
            style={{
              height: 720,
              width: 720,
              objectFit: 'cover',
              mixBlendMode: 'screen',
              borderRadius: 360,
              border: '3px solid rgba(148,163,184,0.25)',
            }}
          />
        </div>

        <div
          style={{
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
            flex: 1,
            padding: '64px 72px',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 48,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 28 }}>
              <div
                style={{
                  position: 'relative',
                  width: 120,
                  height: 120,
                  borderRadius: 28,
                  overflow: 'hidden',
                  border: '4px solid rgba(96,165,250,0.6)',
                  boxShadow: '0 20px 35px rgba(30,64,175,0.35)',
                }}
              >
                <img
                  src={profileIcon}
                  alt={`${options.playerName} icon`}
                  style={{ width: '100%', height: '100%' }}
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <span
                  style={{
                    fontSize: 48,
                    fontWeight: 700,
                    letterSpacing: '-0.02em',
                  }}
                >
                  {options.playerName}
                  <span style={{ color: 'rgba(148,163,184,0.9)' }}>#{options.tagLine}</span>
                </span>
                <span
                  style={{
                    fontSize: 20,
                    color: 'rgba(148,163,184,0.9)',
                    marginTop: 6,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
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
                }}
              >
                Featured Champion
              </span>
              <span
                style={{
                  fontSize: 36,
                  fontWeight: 700,
                  color: '#f8fafc',
                  letterSpacing: '-0.01em',
                }}
              >
                {options.champion.name}
              </span>
              <div
                style={{
                  display: 'flex',
                  gap: 18,
                  fontSize: 18,
                  color: 'rgba(148,163,184,0.9)',
                }}
              >
                <span>{options.champion.games} games</span>
                <span>· {Math.round(options.champion.winRate)}% WR</span>
                <span>· {options.champion.kda.toFixed(2)} KDA</span>
              </div>
            </div>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1.5fr 1fr',
              gap: 32,
              flex: 1,
            }}
          >
            <div
              style={{
                background: 'rgba(15,23,42,0.72)',
                borderRadius: 28,
                padding: 32,
                border: '1px solid rgba(94,234,212,0.12)',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                boxShadow: '0 24px 48px rgba(15,118,110,0.18)',
              }}
            >
              <div>
                <span
                  style={{
                    fontSize: 20,
                    color: 'rgba(45,212,191,0.95)',
                    letterSpacing: '0.15em',
                    textTransform: 'uppercase',
                  }}
                >
                  Cohort Comparison
                </span>
                <span
                  style={{
                    display: 'block',
                    marginTop: 12,
                    fontSize: 32,
                    fontWeight: 600,
                    letterSpacing: '-0.01em',
                  }}
                >
                  Performance Metrics
                </span>
              </div>
              <div style={{ marginTop: 28, display: 'flex', flexDirection: 'column', gap: 20 }}>
                {options.metrics.map((metric) => {
                  const diff = metric.player - metric.cohort;
                  return (
                    <div
                      key={metric.label}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        background: 'rgba(15,118,110,0.12)',
                        borderRadius: 18,
                        padding: '16px 20px',
                        border: '1px solid rgba(94,234,212,0.16)',
                      }}
                    >
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <span
                          style={{
                            fontSize: 18,
                            color: 'rgba(190,242,255,0.95)',
                            letterSpacing: '0.04em',
                            textTransform: 'uppercase',
                          }}
                        >
                          {metric.label}
                        </span>
                        <span style={{ fontSize: 26, fontWeight: 600 }}>
                          {formatMetricValue(metric.player, metric.suffix)}
                          <span style={{
                            fontSize: 18,
                            color: 'rgba(148,163,184,0.85)',
                            marginLeft: 12,
                          }}>
                            vs {formatMetricValue(metric.cohort, metric.suffix)} cohort
                          </span>
                        </span>
                      </div>
                      <div
                        style={{
                          fontSize: 22,
                          fontWeight: 600,
                          color: diff >= 0 ? 'rgba(52,211,153,0.95)' : 'rgba(248,113,113,0.95)',
                          letterSpacing: '0.05em',
                        }}
                      >
                        {diff >= 0 ? '▲' : '▼'} {formatMetricValue(Math.abs(diff), metric.suffix)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div
              style={{
                background: 'rgba(15,23,42,0.68)',
                borderRadius: 28,
                padding: 32,
                border: '1px solid rgba(96,165,250,0.18)',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                gap: 24,
                boxShadow: '0 24px 48px rgba(30,64,175,0.25)',
              }}
            >
              <div>
                <span
                  style={{
                    fontSize: 20,
                    letterSpacing: '0.18em',
                    textTransform: 'uppercase',
                    color: 'rgba(96,165,250,0.95)',
                  }}
                >
                  Playstyle Traits
                </span>
                <span
                  style={{
                    display: 'block',
                    marginTop: 12,
                    fontSize: 30,
                    fontWeight: 600,
                    letterSpacing: '-0.015em',
                  }}
                >
                  AI-Identified Highlights
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {(options.badges?.length ? options.badges : ['Strategic Shotcaller', 'Mechanical Specialist', 'Team Backbone']).slice(0, 3).map((badge) => (
                  <div
                    key={badge}
                    style={{
                      background: 'rgba(30,64,175,0.22)',
                      borderRadius: 999,
                      padding: '12px 20px',
                      border: '1px solid rgba(147,197,253,0.3)',
                      fontSize: 20,
                      fontWeight: 600,
                      color: 'rgba(219,234,254,0.95)',
                      letterSpacing: '0.03em',
                    }}
                  >
                    {badge}
                  </div>
                ))}
              </div>
              <div
                style={{
                  marginTop: 'auto',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  fontSize: 16,
                  color: 'rgba(148,163,184,0.8)',
                }}
              >
                <span>Generated with Riftcoach.ai</span>
                <span>Season Insights • Personalized Analytics</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    ),
    {
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT,
      fonts: [
        {
          name: 'Inter',
          data: interRegular,
          weight: 400,
          style: 'normal',
        },
        {
          name: 'Inter',
          data: interSemiBold,
          weight: 600,
          style: 'normal',
        },
      ],
    },
  );

  const { Resvg } = await import('@resvg/resvg-js');
  const resvg = new Resvg(svg, {
    fitTo: {
      mode: 'width',
      value: CANVAS_WIDTH,
    },
  });

  const pngData = resvg.render().asPng();
  const pngBlob = new Blob([pngData], { type: 'image/png' });

  return { svg, pngBlob };
}
