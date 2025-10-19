import { Card, CardBody, Chip, Progress } from '@heroui/react';
import { motion } from 'framer-motion';
import { TrendingUp, Target, Zap, Trophy, Coins, Swords } from 'lucide-react';
import { AnalyticsIcon } from '@/components/icons/CustomIcons';
import { useQuery } from '@tanstack/react-query';
import { http } from '@/clients/http';

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
}

interface OverviewCardProps {
  region: string;
  name: string;
  tag: string;
}

export function OverviewCard({ region, name, tag }: OverviewCardProps) {
  const { data, isLoading } = useQuery({
    queryKey: ['player-overview', region, name, tag],
    queryFn: async () => {
      const res = await http.get<OverviewData>(
        `/v1/${encodeURIComponent(region)}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}/overview`,
      );
      return res.data;
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
  if (isLoading || !data) {
    return (
      <Card className="h-full">
        <CardBody className="p-6">
          <div className="animate-pulse space-y-4">
            <div className="h-6 bg-gray-300 rounded w-3/4" />
            <div className="space-y-2">
              <div className="h-4 bg-gray-300 rounded" />
              <div className="h-4 bg-gray-300 rounded w-5/6" />
              <div className="h-4 bg-gray-300 rounded w-4/6" />
            </div>
          </div>
        </CardBody>
      </Card>
    );
  }

  const getWinRateColor = (winRate: number) => {
    if (winRate >= 60) return 'success';
    if (winRate >= 50) return 'warning';
    return 'danger';
  };

  const getKdaColor = (kda: number) => {
    if (kda >= 2.5) return 'success';
    if (kda >= 1.5) return 'warning';
    return 'danger';
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
          <div className="flex items-center gap-4 mb-6">
            <div className="p-3 bg-gradient-to-br from-accent-blue-900/30 to-accent-emerald-900/30 rounded-xl">
              <AnalyticsIcon className="w-6 h-6 text-accent-blue-400" />
            </div>
            <div>
              <h3 className="text-xl font-display font-bold text-neutral-50">Performance Overview</h3>
              <p className="text-sm text-neutral-400">Season statistics</p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-6 mb-8">
            <div className="text-center p-4 bg-accent-emerald-950/20 rounded-xl border border-accent-emerald-800">
              <div className="text-3xl font-bold text-accent-emerald-400 mb-1">{data.wins}</div>
              <div className="text-sm font-medium text-neutral-400">Wins</div>
            </div>
            <div className="text-center p-4 bg-red-950/20 rounded-xl border border-red-800">
              <div className="text-3xl font-bold text-red-400 mb-1">{data.losses}</div>
              <div className="text-sm font-medium text-neutral-400">Losses</div>
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex justify-between items-center p-3 bg-neutral-800/50 rounded-lg">
              <span className="text-sm font-medium text-neutral-300">Win Rate</span>
              <Chip color={getWinRateColor(data.winRate)} variant="flat" size="sm" className="font-semibold">
                {data.winRate}%
              </Chip>
            </div>

            <div className="flex justify-between items-center p-3 bg-neutral-800/50 rounded-lg">
              <span className="text-sm font-medium text-neutral-300">Average KDA</span>
              <Chip color={getKdaColor(data.avgKda)} variant="flat" size="sm" className="font-semibold">
                {data.avgKda}
              </Chip>
            </div>

            <div className="flex justify-between items-center p-3 bg-neutral-800/50 rounded-lg">
              <span className="text-sm font-medium text-neutral-300">CS/min</span>
              <span className="text-sm font-bold text-neutral-100">{data.avgCsPerMin}</span>
            </div>

            <div className="flex justify-between items-center p-3 bg-neutral-800/50 rounded-lg">
              <span className="text-sm font-medium text-neutral-300">Gold/min</span>
              <span className="text-sm font-bold text-neutral-100">{data.avgGoldPerMin.toLocaleString()}</span>
            </div>
          </div>

          {(data.multikills.pentaKills > 0 || data.multikills.quadraKills > 0) && (
            <div className="mt-6 pt-6 border-t border-neutral-700">
              <div className="flex items-center gap-3 mb-3">
                <div className="p-2 bg-accent-purple-900/30 rounded-lg">
                  <Zap className="w-4 h-4 text-accent-purple-400" />
                </div>
                <span className="text-sm font-semibold text-neutral-300">Multikills</span>
              </div>
              <div className="flex gap-2 flex-wrap">
                {data.multikills.pentaKills > 0 && (
                  <Chip color="danger" variant="flat" size="sm" className="font-medium">
                    {data.multikills.pentaKills} Penta
                  </Chip>
                )}
                {data.multikills.quadraKills > 0 && (
                  <Chip color="warning" variant="flat" size="sm" className="font-medium">
                    {data.multikills.quadraKills} Quadra
                  </Chip>
                )}
              </div>
            </div>
          )}
        </CardBody>
      </Card>
    </motion.div>
  );
}