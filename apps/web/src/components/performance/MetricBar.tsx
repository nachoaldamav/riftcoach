'use client';

import { cn } from '@/lib/utils';

type MetricBarProps = {
  label: string;
  valueDisplay: string;
  value?: number | null;
  baseline?: number | null;
  invert?: boolean;
  percent?: boolean;
  p50?: number | null;
  p75?: number | null;
  p90?: number | null;
};

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

export function MetricBar({
  label,
  valueDisplay,
  value,
  invert,
  percent,
  p50,
  p75,
  p90,
}: MetricBarProps) {
  const normalized = (() => {
    if (value == null || p90 == null) return null;
    const v = percent ? value * 100 : value;
    const p90Val = percent ? p90 * 100 : p90;
    const ratio = invert
      ? p90Val / Math.max(1e-6, v)
      : v / Math.max(1e-6, p90Val);
    return clamp01(ratio);
  })();

  const calculatePercentilePosition = (
    percentileValue: number | null | undefined,
  ) => {
    if (percentileValue == null || p90 == null) return null;
    const v = percent ? percentileValue * 100 : percentileValue;
    const p90Val = percent ? p90 * 100 : p90;
    const ratio = invert
      ? p90Val / Math.max(1e-6, v)
      : v / Math.max(1e-6, p90Val);
    return clamp01(ratio) * 100;
  };

  const p50Position = calculatePercentilePosition(p50);
  const p75Position = calculatePercentilePosition(p75);
  const p90Position = calculatePercentilePosition(p90);

  const hasPercentiles =
    p50Position != null || p75Position != null || p90Position != null;

  // Determine color based on performance relative to p50
  const getBarColor = () => {
    if (normalized == null) return 'bg-neutral-700/50';
    const normalizedPercent = normalized * 100;

    if (p50Position != null && normalizedPercent >= p50Position) {
      return 'bg-green-600'; // Muted green - Better than p50
    }
    return 'bg-amber-700'; // Muted red - Worse than p50
  };

  return (
    <div className="space-y-1 group">
      <div className="flex items-center justify-between text-xs">
        <span className="text-neutral-400">{label}</span>
        <span className="text-neutral-200 font-medium">{valueDisplay}</span>
      </div>
      <div className="relative h-2 bg-neutral-800/60 rounded-full overflow-visible border border-neutral-700/50">
        <div
          className={cn(
            'h-full rounded-full transition-colors duration-300',
            getBarColor(),
          )}
          style={{ width: `${Math.round((normalized ?? 0) * 100)}%` }}
        />
        {hasPercentiles && (
          <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
            {p50Position != null && (
              <>
                <div
                  className="absolute top-0 bottom-0 w-0.5 bg-neutral-400"
                  style={{ left: `${p50Position}%` }}
                />
                <div
                  className="absolute top-full mt-1 text-[11px] text-neutral-300 whitespace-nowrap"
                  style={{
                    left: `${p50Position}%`,
                    transform: 'translateX(-50%)',
                  }}
                >
                  {Math.round(
                    percent ? (p50 ?? 0) * 100 : (p50 ?? 0),
                  ).toLocaleString()}
                </div>
              </>
            )}
            {p75Position != null && (
              <>
                <div
                  className="absolute top-0 bottom-0 w-0.5 bg-neutral-400"
                  style={{ left: `${p75Position}%` }}
                />
                <div
                  className="absolute top-full mt-1 text-[11px] text-neutral-300 whitespace-nowrap"
                  style={{
                    left: `${p75Position}%`,
                    transform: 'translateX(-50%)',
                  }}
                >
                  {Math.round(
                    percent ? (p75 ?? 0) * 100 : (p75 ?? 0),
                  ).toLocaleString()}
                </div>
              </>
            )}
            {p90Position != null && (
              <>
                <div
                  className="absolute top-0 bottom-0 w-0.5 bg-neutral-400"
                  style={{ left: `${p90Position}%` }}
                />
                <div
                  className="absolute top-full mt-1 text-[11px] text-neutral-300 whitespace-nowrap"
                  style={{
                    left: `${p90Position}%`,
                    transform: 'translateX(-50%)',
                  }}
                >
                  {Math.round(
                    percent ? (p90 ?? 0) * 100 : (p90 ?? 0),
                  ).toLocaleString()}
                </div>
              </>
            )}
            <div className="absolute top-full mt-1 left-0 text-[11px] text-neutral-300 whitespace-nowrap">
              {Math.round(percent ? 0 : 0).toLocaleString()}
            </div>
            <div className="absolute top-full mt-1 right-0 text-[11px] text-neutral-300 whitespace-nowrap">
              {Math.round(
                percent ? (p90 ?? 0) * 100 : (p90 ?? 0),
              ).toLocaleString()}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
