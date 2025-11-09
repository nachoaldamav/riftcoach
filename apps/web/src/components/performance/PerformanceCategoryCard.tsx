'use client';

import { Card, CardBody } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { ArcGauge } from './ArcGauge';
import { MetricBar } from './MetricBar';

export type CategoryMetric = {
  key: string;
  label: string;
  value: number | null;
  valueDisplay: string;
  baseline?: number | null;
  invert?: boolean;
  percent?: boolean;
  p50?: number | null;
  p75?: number | null;
  p90?: number | null;
};

type PerformanceCategoryCardProps = {
  title: string;
  score: number;
  bgImageUrl?: string;
  metrics: CategoryMetric[];
  className?: string;
};

export function PerformanceCategoryCard({
  title,
  score,
  bgImageUrl,
  metrics,
  className,
}: PerformanceCategoryCardProps) {
  return (
    <Card
      className={cn(
        'relative overflow-hidden bg-neutral-900/80 border border-neutral-700/60 backdrop-blur-sm',
        className,
      )}
      style={
        bgImageUrl
          ? {
              backgroundImage: `url(${bgImageUrl})`,
              backgroundSize: 'cover',
              backgroundPosition: '10% center',
              backgroundRepeat: 'no-repeat',
            }
          : undefined
      }
    >
      {bgImageUrl ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-gradient-to-r from-neutral-900/100 via-neutral-900/95 to-neutral-900/70"
        />
      ) : null}
      <CardBody className="relative z-10 p-4 w-full">
        <div className="items-center gap-4 flex flex-col w-full">
          <ArcGauge value={score} label={title} />
          <div className="flex flex-col gap-2 w-full">
            {metrics.map((m) => (
              <MetricBar
                key={m.key}
                label={m.label}
                valueDisplay={m.valueDisplay}
                value={m.value ?? null}
                baseline={m.baseline ?? null}
                invert={m.invert}
                percent={m.percent}
                p50={m.p50}
                p75={m.p75}
                p90={m.p90}
              />
            ))}
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
