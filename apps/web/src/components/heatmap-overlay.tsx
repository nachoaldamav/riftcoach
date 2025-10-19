import { useMemo } from 'react';

// ===== Types =====
export type HeatmapPoint = {
  xBin: number;
  yBin: number;
  count: number;
  grid: number;
};
export type HeatmapMode = 'kills' | 'deaths';

type RGB = { r: number; g: number; b: number };
type RampStop = { t: number; rgb: RGB };
export type ColorStop = { t: number; color: string };

// ===== Preset ramps (high-contrast) =====
export const RAMP_KILLS: ColorStop[] = [
  { t: 0.0, color: '#0b1020' }, // near-black to keep lows subtle
  { t: 0.35, color: '#0ea5e9' }, // cyan
  { t: 0.55, color: '#22c55e' }, // green
  { t: 0.75, color: '#fde047' }, // yellow
  { t: 0.9, color: '#fb923c' }, // orange
  { t: 1.0, color: '#ef4444' }, // red
];

export const RAMP_DEATHS: ColorStop[] = [
  { t: 0.0, color: '#0b1020' },
  { t: 0.35, color: '#6366f1' }, // indigo
  { t: 0.55, color: '#a855f7' }, // purple
  { t: 0.75, color: '#f472b6' }, // pink
  { t: 0.9, color: '#fb7185' }, // rose
  { t: 1.0, color: '#f43f5e' }, // deep rose
];

// ===== Component =====
export function HeatmapOverlay({
  data,
  mode,
  className = 'absolute inset-0 w-full h-full',
  blur = 0.75,
  opacity = 1,
  colorRamp,
  darkenBackground = true,
  blend = 'screen', // 'screen' | 'overlay' | 'lighten'
  darkenAmount = 0.35, // 0..1
}: {
  data: HeatmapPoint[] | null | undefined;
  mode: HeatmapMode;
  className?: string;
  blur?: number;
  opacity?: number;
  colorRamp?: ColorStop[];
  darkenBackground?: boolean;
  blend?: 'screen' | 'overlay' | 'lighten';
  darkenAmount?: number;
}) {
  const ramp: ColorStop[] =
    colorRamp ?? (mode === 'kills' ? RAMP_KILLS : RAMP_DEATHS);

  const maxCount = useMemo(() => {
    if (!data || data.length === 0) return 1;
    return Math.max(...data.map((d) => d.count), 1);
  }, [data]);

  // Helper function to get color from ramp based on normalized value
  const getColorFromRamp = (normalizedValue: number): string => {
    const t = clamp01(normalizedValue);
    
    // Find the appropriate color stops
    const sortedRamp = ramp.slice().sort((a, b) => a.t - b.t);
    
    if (t <= sortedRamp[0].t) return sortedRamp[0].color;
    if (t >= sortedRamp[sortedRamp.length - 1].t) return sortedRamp[sortedRamp.length - 1].color;
    
    // Find the two stops to interpolate between
    let i = 0;
    while (i < sortedRamp.length - 1 && sortedRamp[i + 1].t < t) i++;
    
    const stop1 = sortedRamp[i];
    const stop2 = sortedRamp[i + 1];
    
    // Interpolate between the two colors
    const factor = (t - stop1.t) / (stop2.t - stop1.t || 1);
    
    const rgb1 = hexToRgb(stop1.color);
    const rgb2 = hexToRgb(stop2.color);
    
    if (!rgb1 || !rgb2) return stop1.color;
    
    const r = Math.round(lerp(rgb1.r, rgb2.r, factor));
    const g = Math.round(lerp(rgb1.g, rgb2.g, factor));
    const b = Math.round(lerp(rgb1.b, rgb2.b, factor));
    
    return `rgb(${r}, ${g}, ${b})`;
  };

  if (!data || data.length === 0) return null;

  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: overlay
    <svg
      className={className}
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid meet"
      style={{ mixBlendMode: blend, opacity }}
    >
      <defs>
        <filter
          id="heat-blur"
          filterUnits="objectBoundingBox"
          x="-20%"
          y="-20%"
          width="140%"
          height="140%"
        >
          <feGaussianBlur stdDeviation={blur} />
        </filter>
      </defs>

      {darkenBackground && (
        <rect
          x={0}
          y={0}
          width={100}
          height={100}
          fill={`rgba(0,0,0,${clamp01(darkenAmount)})`}
          style={{ mixBlendMode: 'multiply' }}
        />
      )}

      <g filter="url(#heat-blur)">
        {data.map((p) => {
          const cell = 100 / p.grid;
          const x = p.xBin * cell;
          const y = 100 - (p.yBin + 1) * cell; // invert Y
          const normalizedValue = p.count / maxCount;
          const color = getColorFromRamp(normalizedValue);
          const alpha = Math.max(0.1, normalizedValue); // Ensure minimum visibility
          
          return (
            <rect
              key={`${p.xBin}-${p.yBin}`}
              x={x}
              y={y}
              width={cell}
              height={cell}
              fill={color}
              opacity={alpha}
              shapeRendering="crispEdges"
            />
          );
        })}
      </g>

      <Legend colorRamp={ramp} mode={mode} />
    </svg>
  );
}

function Legend({
  colorRamp,
  mode,
}: { colorRamp: ColorStop[]; mode: HeatmapMode }) {
  const id = useMemo(
    () => `grad-${Math.random().toString(36).slice(2)}`,
    [
      /* once */
    ],
  );
  return (
    <g transform="translate(80,95)">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="0">
          {colorRamp.map((s, i) => (
            <stop
              // biome-ignore lint/suspicious/noArrayIndexKey: legend is static
              key={i}
              offset={`${clamp01(s.t) * 100}%`}
              stopColor={s.color}
            />
          ))}
        </linearGradient>
      </defs>
      <rect
        x={0}
        y={0}
        width={18}
        height={2}
        rx={0.2}
        ry={0.2}
        fill={`url(#${id})`}
        stroke="rgba(255,255,255,0.4)"
        strokeWidth={0.1}
      />
      <text x={0} y={-0.8} fontSize={1.8} fill="rgba(255,255,255,0.85)">
        {mode === 'kills' ? 'Kills' : 'Deaths'}
      </text>
      <text x={0} y={4} fontSize={1.5} fill="rgba(255,255,255,0.6)">
        low
      </text>
      <text
        x={16}
        y={4}
        textAnchor="end"
        fontSize={1.5}
        fill="rgba(255,255,255,0.6)"
      >
        high
      </text>
    </g>
  );
}

// ===== Helpers (fully typed; no `any`) =====
export function buildColorTransferTables(ramp: ColorStop[]) {
  const stops: RampStop[] = ramp
    .slice()
    .sort((a, b) => a.t - b.t)
    .map((s) => {
      const rgb = hexToRgb(s.color);
      return rgb ? { t: clamp01(s.t), rgb } : null;
    })
    .filter((x): x is RampStop => x !== null);

  const samples = 256;
  const r: number[] = [];
  const g: number[] = [];
  const b: number[] = [];
  const a: number[] = [];
  for (let i = 0; i < samples; i++) {
    const t = i / (samples - 1);
    const { r: rr, g: gg, b: bb } = sampleRamp(stops, t);
    r.push(rr / 255);
    g.push(gg / 255);
    b.push(bb / 255);
    a.push(t); // alpha follows density
  }
  return { r: r.join(' '), g: g.join(' '), b: b.join(' '), a: a.join(' ') };
}

function sampleRamp(stops: RampStop[], t: number): RGB {
  if (stops.length === 0) return { r: 255, g: 255, b: 255 };
  if (t <= stops[0].t) return stops[0].rgb;
  if (t >= stops[stops.length - 1].t) return stops[stops.length - 1].rgb;
  let i = 0;
  while (i < stops.length - 1 && stops[i + 1].t < t) i++;
  const a = stops[i];
  const b = stops[i + 1];
  const u = (t - a.t) / (b.t - a.t || 1);
  return {
    r: Math.round(lerp(a.rgb.r, b.rgb.r, u)),
    g: Math.round(lerp(a.rgb.g, b.rgb.g, u)),
    b: Math.round(lerp(a.rgb.b, b.rgb.b, u)),
  };
}

function hexToRgb(hex: string): RGB | null {
  const s = hex.trim().replace('#', '');
  if (!(s.length === 3 || s.length === 6)) return null;
  const vals =
    s.length === 3
      ? s.split('').map((c) => Number.parseInt(c + c, 16))
      : [
          Number.parseInt(s.slice(0, 2), 16),
          Number.parseInt(s.slice(2, 4), 16),
          Number.parseInt(s.slice(4, 6), 16),
        ];
  if (vals.some((n) => Number.isNaN(n))) return null;
  const [r, g, b] = vals as [number, number, number];
  return { r, g, b };
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}
function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

// ===== Tiny self-tests =====
export function runHeatmapOverlaySelfTest(): {
  ok: boolean;
  failures: string[];
} {
  const failures: string[] = [];
  const rgb = hexToRgb('#ff00aa');
  if (!rgb || rgb.r !== 255 || rgb.g !== 0 || rgb.b !== 170)
    failures.push('hexToRgb failed');
  const tables = buildColorTransferTables([
    { t: 0, color: '#000000' },
    { t: 1, color: '#ffffff' },
  ]);
  const n = tables.r.split(' ').length;
  if (n !== 256) failures.push('transfer table size != 256');
  const a = tables.a.split(' ').map(Number.parseFloat);
  for (let i = 1; i < a.length; i++)
    if (a[i] < a[i - 1]) {
      failures.push('alpha not monotonic');
      break;
    }
  return { ok: failures.length === 0, failures };
}
