import { http } from '@/clients/http';
import { SpiderChart } from '@/components/charts/SpiderChart';
import { AnalyticsIcon } from '@/components/icons/CustomIcons';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { Target } from 'lucide-react';
import { useState } from 'react';

interface OverviewData {
  totalGames: number;
  wins: number;
  losses: number;
  winRate: number;
  avgKda: number;
  avgKills: number;
  avgDeaths: number;
  avgAssists: number;
  avgCsPerMin: number;
  avgGoldPerMin: number;
  avgDamagePerMin: number;
  avgVisionPerMin: number;
  avgGameDuration: number;
  multikills: {
    pentaKills: number;
    quadraKills: number;
    tripleKills: number;
    doubleKills: number;
  };
  achievements: {
    firstBloodKills: number;
    soloKills: number;
    largestKillingSpree: number;
    largestMultiKill: number;
  };
  spiderChartData: Array<{
    metric: string;
    player: number;
    opponent: number;
    playerActual: number;
    opponentActual: number;
    fullMark: number;
  }>;
}

interface OverviewCardProps {
  region: string;
  name: string;
  tag: string;
}

export function OverviewCard({ region, name, tag }: OverviewCardProps) {
  // Position state and roles configuration
  const [selectedPosition, setSelectedPosition] = useState<string>('ALL');

  const roles = [
    { key: 'ALL', label: 'All', icon: '🎯' },
    { key: 'TOP', label: 'Top', icon: '⚔️' },
    { key: 'JUNGLE', label: 'Jungle', icon: '🌲' },
    { key: 'MIDDLE', label: 'Middle', icon: '🏰' },
    { key: 'BOTTOM', label: 'Bottom', icon: '🏹' },
    { key: 'UTILITY', label: 'Support', icon: '🛡️' },
  ];

  // Role icon from Community Dragon (neutral icon)
  const getRoleIconUrl = (roleKey: string) => {
    // unselected
    if (roleKey === 'ALL')
      return 'https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-clash/global/default/assets/images/position-selector/positions/icon-position-fill.png';
    return `https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-clash/global/default/assets/images/position-selector/positions/icon-position-${roleKey.toLowerCase()}.png`;
  };

  const { data, isLoading } = useQuery({
    queryKey: ['player-overview', region, name, tag, selectedPosition],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (selectedPosition !== 'ALL') {
        params.set('position', selectedPosition);
      }
      const queryString = params.toString();
      const url = `/v1/${encodeURIComponent(region)}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}/overview${queryString ? `?${queryString}` : ''}`;

      const res = await http.get<OverviewData>(url);
      return res.data;
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
  if (isLoading || !data) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="h-full"
      >
        <Card className="h-full bg-neutral-900/90 backdrop-blur-sm border border-neutral-700/60 shadow-soft-lg hover:shadow-soft-xl transition-all duration-200">
          <CardBody className="p-8">
            <div className="animate-pulse">
              {/* Header section */}
              <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 bg-neutral-700 rounded-xl" />
                  <div>
                    <div className="h-6 bg-neutral-700 rounded w-40 mb-2" />
                    <div className="h-4 bg-neutral-700 rounded w-24" />
                  </div>
                </div>
                <div className="w-32 h-8 bg-neutral-700 rounded" />
              </div>

              {/* Win/Loss grid */}
              <div className="grid grid-cols-2 gap-6 mb-8">
                <div className="text-center p-4 bg-neutral-800/50 rounded-xl">
                  <div className="h-8 bg-neutral-700 rounded w-12 mx-auto mb-1" />
                  <div className="h-4 bg-neutral-700 rounded w-8 mx-auto" />
                </div>
                <div className="text-center p-4 bg-neutral-800/50 rounded-xl">
                  <div className="h-8 bg-neutral-700 rounded w-12 mx-auto mb-1" />
                  <div className="h-4 bg-neutral-700 rounded w-12 mx-auto" />
                </div>
              </div>

              {/* Statistics list */}
              <div className="space-y-4">
                <div className="flex justify-between items-center p-3 bg-neutral-800/50 rounded-lg">
                  <div className="h-4 bg-neutral-700 rounded w-16" />
                  <div className="h-6 bg-neutral-700 rounded w-12" />
                </div>
                <div className="flex justify-between items-center p-3 bg-neutral-800/50 rounded-lg">
                  <div className="h-4 bg-neutral-700 rounded w-20" />
                  <div className="h-6 bg-neutral-700 rounded w-10" />
                </div>
                <div className="flex justify-between items-center p-3 bg-neutral-800/50 rounded-lg">
                  <div className="h-4 bg-neutral-700 rounded w-12" />
                  <div className="h-4 bg-neutral-700 rounded w-8" />
                </div>
                <div className="flex justify-between items-center p-3 bg-neutral-800/50 rounded-lg">
                  <div className="h-4 bg-neutral-700 rounded w-16" />
                  <div className="h-4 bg-neutral-700 rounded w-12" />
                </div>
              </div>

              {/* Opponent Comparison section */}
              <div className="mt-6 pt-6 border-t border-neutral-700">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-8 h-8 bg-neutral-700 rounded-lg" />
                  <div className="h-4 bg-neutral-700 rounded w-32" />
                </div>
                <div className="h-64 bg-neutral-800/50 rounded-lg" />
              </div>
            </div>
          </CardBody>
        </Card>
      </motion.div>
    );
  }

  const getWinRateTone = (winRate: number): 'success' | 'warning' | 'danger' => {
    if (winRate >= 60) return 'success';
    if (winRate >= 50) return 'warning';
    return 'danger';
  };

  const getKdaTone = (kda: number): 'success' | 'warning' | 'danger' => {
    if (kda >= 2.5) return 'success';
    if (kda >= 1.5) return 'warning';
    return 'danger';
  };

  const badgeToneClasses: Record<'success' | 'warning' | 'danger', string> = {
    success:
      'bg-emerald-500/10 text-emerald-300 border border-emerald-500/60 hover:bg-emerald-500/15',
    warning:
      'bg-amber-500/10 text-amber-300 border border-amber-500/60 hover:bg-amber-500/15',
    danger:
      'bg-red-500/10 text-red-300 border border-red-500/60 hover:bg-red-500/15',
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="h-full"
    >
      <Card className="h-full bg-neutral-900/90 backdrop-blur-sm border border-neutral-700/60 shadow-soft-lg hover:shadow-soft-xl transition-all duration-200">
        <CardBody className="p-8">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-4">
              <div className="p-3 bg-gradient-to-br from-accent-blue-900/30 to-accent-emerald-900/30 rounded-xl">
                <AnalyticsIcon className="w-6 h-6 text-accent-blue-400" />
              </div>
              <div>
                <h3 className="text-xl font-display font-bold text-neutral-50">
                  Performance Overview
                </h3>
                <p className="text-sm text-neutral-400">Season statistics</p>
              </div>
            </div>

            {/* Position Select */}
            <Select
              value={selectedPosition}
              onValueChange={(value) => {
                setSelectedPosition(value);
              }}
            >
              <SelectTrigger className="h-10 w-32 border-neutral-700 bg-neutral-800/70 text-neutral-100">
                {(() => {
                  const role = roles.find((r) => r.key === selectedPosition);
                  if (!role) {
                    return <SelectValue placeholder="Select role" />;
                  }
                  const iconUrl = getRoleIconUrl(role.key);
                  return (
                    <div className="flex items-center gap-2">
                      {iconUrl ? (
                        <img src={iconUrl} alt={role.label} className="h-4 w-4" />
                      ) : (
                        <span className="text-sm">{role.icon}</span>
                      )}
                      <span className="text-sm font-medium">{role.label}</span>
                    </div>
                  );
                })()}
              </SelectTrigger>
              <SelectContent className="bg-neutral-900 text-neutral-100">
                {roles.map((role) => {
                  const iconUrl = getRoleIconUrl(role.key);
                  return (
                    <SelectItem key={role.key} value={role.key}>
                      <div className="flex items-center gap-2">
                        {iconUrl ? (
                          <img src={iconUrl} alt={role.label} className="h-4 w-4" />
                        ) : (
                          <span className="text-sm">{role.icon}</span>
                        )}
                        <span>{role.label}</span>
                      </div>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-6 mb-8">
            <div className="text-center p-4 bg-accent-emerald-950/20 rounded-xl border border-accent-emerald-800">
              <div className="text-3xl font-bold text-accent-emerald-400 mb-1">
                {data.wins}
              </div>
              <div className="text-sm font-medium text-neutral-400">Wins</div>
            </div>
            <div className="text-center p-4 bg-red-950/20 rounded-xl border border-red-800">
              <div className="text-3xl font-bold text-red-400 mb-1">
                {data.losses}
              </div>
              <div className="text-sm font-medium text-neutral-400">Losses</div>
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex justify-between items-center p-3 bg-neutral-800/50 rounded-lg">
              <span className="text-sm font-medium text-neutral-300">
                Win Rate
              </span>
              <Badge
                className={`font-semibold ${badgeToneClasses[getWinRateTone(data.winRate)]}`}
              >
                {data.winRate}%
              </Badge>
            </div>

            <div className="flex justify-between items-center p-3 bg-neutral-800/50 rounded-lg">
              <span className="text-sm font-medium text-neutral-300">
                Average KDA
              </span>
              <Badge
                className={`font-semibold ${badgeToneClasses[getKdaTone(data.avgKda)]}`}
              >
                {data.avgKda}
              </Badge>
            </div>

            <div className="flex justify-between items-center p-3 bg-neutral-800/50 rounded-lg">
              <span className="text-sm font-medium text-neutral-300">
                CS/min
              </span>
              <span className="text-sm font-bold text-neutral-100">
                {data.avgCsPerMin}
              </span>
            </div>

            <div className="flex justify-between items-center p-3 bg-neutral-800/50 rounded-lg">
              <span className="text-sm font-medium text-neutral-300">
                Gold/min
              </span>
              <span className="text-sm font-bold text-neutral-100">
                {data.avgGoldPerMin.toLocaleString()}
              </span>
            </div>
          </div>

          {/* Opponent Comparison */}
          <div className="mt-6 pt-6 border-t border-neutral-700">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-accent-purple-900/30 rounded-lg">
                <Target className="w-4 h-4 text-accent-purple-400" />
              </div>
              <span className="text-sm font-semibold text-neutral-300">
                vs Direct Opponents
              </span>
            </div>

            {data.spiderChartData && data.spiderChartData.length > 0 ? (
              <div className="h-64">
                <SpiderChart data={data.spiderChartData} />
              </div>
            ) : (
              <div className="text-xs text-neutral-500 text-center py-8">
                No opponent comparison data available
              </div>
            )}
          </div>
        </CardBody>
      </Card>
    </motion.div>
  );
}
