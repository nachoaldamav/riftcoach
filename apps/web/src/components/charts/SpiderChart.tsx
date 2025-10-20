import {
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  Tooltip,
} from 'recharts';

import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
} from '@/components/ui/chart';

interface SpiderChartData {
  metric: string;
  player: number;
  opponent: number;
  playerActual: number;
  opponentActual: number;
  fullMark: number;
}

interface SpiderChartProps {
  data: SpiderChartData[];
  className?: string;
}

const chartConfig = {
  player: {
    label: 'You',
    color: '#10B981', // Emerald green for player
  },
  opponent: {
    label: 'Opponents',
    color: '#F59E0B', // Amber/orange for opponents
  },
} satisfies ChartConfig;

export function SpiderChart({ data, className = '' }: SpiderChartProps) {
  return (
    <div className={`w-full h-72 ${className}`}>
      <ChartContainer
        config={chartConfig}
        className="mx-auto aspect-square max-h-[320px] h-72"
      >
        <RadarChart data={data}>
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload || payload.length === 0) return null;

              return (
                <div className="bg-background border border-border rounded-lg p-3 shadow-lg">
                  <p className="font-medium text-foreground mb-2">{label}</p>
                  {payload.map((entry) => {
                    const actualKey =
                      entry.dataKey === 'player'
                        ? 'playerActual'
                        : 'opponentActual';
                    const actualValue = entry.payload?.[actualKey];
                    const displayName =
                      entry.dataKey === 'player' ? 'You' : 'Opponents';
                    const color =
                      entry.dataKey === 'player' ? '#10B981' : '#F59E0B';

                    return (
                      <div
                        key={`${entry.dataKey}-${actualValue}`}
                        className="flex items-center gap-2"
                      >
                        <div
                          className="w-3 h-3 rounded-full"
                          style={{ backgroundColor: color }}
                        />
                        <span className="text-sm text-muted-foreground">
                          {displayName}:
                        </span>
                        <span className="text-sm font-medium text-foreground">
                          {actualValue}
                        </span>
                      </div>
                    );
                  })}
                </div>
              );
            }}
          />
          <PolarGrid className="fill-[--color-player] opacity-75" />
          <PolarAngleAxis dataKey="metric" />
          <PolarRadiusAxis
            angle={90}
            domain={[0, 'dataMax']}
            tick={false}
            tickCount={4}
          />
          <Radar
            dataKey="player"
            fill="var(--color-player)"
            fillOpacity={0.2}
            stroke="var(--color-player)"
            strokeWidth={2}
          />
          <Radar
            dataKey="opponent"
            fill="var(--color-opponent)"
            fillOpacity={0.1}
            stroke="var(--color-opponent)"
            strokeWidth={2}
          />
          <ChartLegend className="mt-8" content={<ChartLegendContent />} />
        </RadarChart>
      </ChartContainer>
    </div>
  );
}
