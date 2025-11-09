import { cn } from '@/lib/utils';
import { useId } from 'react';

type ArcGaugeProps = {
  value: number;
  size?: number;
  thickness?: number;
  className?: string;
  label?: string;
  bgImageUrl?: string;
  color?: string;
  p50?: number | null;
  p75?: number | null;
  p90?: number | null;
};

export function ArcGauge({
  value,
  size = 140,
  thickness = 10,
  className,
  label,
  bgImageUrl,
  color,
}: ArcGaugeProps) {
  const clamped = Math.max(0, Math.min(100, Math.round(value)));

  // Determine color based on performance relative to p50
  const getGaugeColor = () => {
    if (color) return color; // Use provided color if specified

    if (value >= 50) {
      return '#16a34acc'; // Muted green (green-600 with 80% opacity) - Better than p50
    }
    return '#dc2626cc'; // Muted red (red-600 with 80% opacity) - Worse than p50
  };

  const gaugeColor = getGaugeColor();
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - clamped / 100);
  const titleId = useId();
  const titleText = label ? `${label} score ${clamped}` : 'Performance gauge';

  return (
    <div
      className={cn(
        'relative flex items-center justify-center',
        'rounded-xl overflow-hidden',
        className,
      )}
      style={{ width: size, height: size }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="absolute inset-0"
        role="img"
        aria-labelledby={titleId}
      >
        <title id={titleId}>{titleText}</title>
        <defs>
          <linearGradient id="arc-gauge-gradient" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={gaugeColor} />
            <stop offset="100%" stopColor={gaugeColor} stopOpacity="0.7" />
          </linearGradient>
        </defs>
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            stroke="rgba(255,255,255,0.08)"
            strokeWidth={thickness}
            fill="none"
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            stroke="url(#arc-gauge-gradient)"
            strokeWidth={thickness}
            strokeLinecap="round"
            strokeDasharray={`${circumference} ${circumference}`}
            strokeDashoffset={dashOffset}
            fill="none"
          />
        </g>
      </svg>
      <div
        className={cn(
          'pointer-events-none absolute inset-2 rounded-full border border-neutral-800 overflow-hidden',
          'bg-transparent',
        )}
        style={
          bgImageUrl
            ? {
                backgroundImage: `url(${bgImageUrl})`,
                backgroundSize: 'cover',
                backgroundPosition: 'center',
              }
            : undefined
        }
      />
      <div className="relative z-10 text-center">
        <div className="text-4xl font-bold text-neutral-100 leading-none">
          {clamped}
        </div>
        {label ? (
          <div className="text-xs text-neutral-300 mt-1">{label}</div>
        ) : null}
      </div>
    </div>
  );
}
