import { http } from '@/clients/http';
import { Card, CardBody } from '@heroui/react';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { Brain, TrendingUp, Target, Sparkles } from 'lucide-react';

interface ChampionInsightsCardProps {
  region: string;
  name: string;
  tag: string;
}

interface ChampionInsight {
  type: 'trend' | 'recommendation' | 'strength' | 'improvement';
  title: string;
  description: string;
  confidence: number;
}

export function ChampionInsightsCard({
  region,
  name,
  tag,
}: ChampionInsightsCardProps) {
  const { data: insights, isLoading } = useQuery({
    queryKey: ['champion-insights', region, name, tag],
    queryFn: async (): Promise<ChampionInsight[]> => {
      // For now, return mock data - will integrate with AWS Bedrock later
      return [
        {
          type: 'trend',
          title: 'Rising Performance',
          description: 'Your ADC performance has improved 23% over the last month, particularly with scaling champions.',
          confidence: 87
        },
        {
          type: 'recommendation',
          title: 'Champion Pool Expansion',
          description: 'Consider adding Jinx or Aphelios to complement your current champion pool strengths.',
          confidence: 92
        },
        {
          type: 'strength',
          title: 'Late Game Excellence',
          description: 'You excel in games lasting 30+ minutes with a 68% win rate in extended matches.',
          confidence: 95
        },
        {
          type: 'improvement',
          title: 'Early Game Focus',
          description: 'Improving early game aggression could increase your overall win rate by an estimated 8%.',
          confidence: 78
        }
      ];
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
  });

  const getInsightIcon = (type: ChampionInsight['type']) => {
    switch (type) {
      case 'trend':
        return <TrendingUp className="w-4 h-4" />;
      case 'recommendation':
        return <Target className="w-4 h-4" />;
      case 'strength':
        return <Sparkles className="w-4 h-4" />;
      case 'improvement':
        return <Brain className="w-4 h-4" />;
    }
  };

  const getInsightColor = (type: ChampionInsight['type']) => {
    switch (type) {
      case 'trend':
        return 'text-blue-400';
      case 'recommendation':
        return 'text-purple-400';
      case 'strength':
        return 'text-emerald-400';
      case 'improvement':
        return 'text-amber-400';
    }
  };

  const getConfidenceColor = (confidence: number) => {
    if (confidence >= 90) return 'text-emerald-400';
    if (confidence >= 75) return 'text-blue-400';
    if (confidence >= 60) return 'text-amber-400';
    return 'text-red-400';
  };

  if (isLoading) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.3 }}
        className="h-full"
      >
        <Card className="h-full bg-neutral-900/90 backdrop-blur-sm border border-neutral-700/60 shadow-soft-lg">
          <CardBody className="p-8 h-full flex flex-col">
            <div className="flex items-center gap-4 mb-6">
              <div className="p-3 bg-gradient-to-br from-accent-purple-900/30 to-accent-blue-900/30 rounded-xl">
                <Brain className="w-6 h-6 text-accent-purple-400 animate-pulse" />
              </div>
              <div>
                <h3 className="text-xl font-display font-bold text-neutral-50">
                  AI Champion Insights
                </h3>
                <p className="text-sm text-neutral-400">
                  Analyzing your performance...
                </p>
              </div>
            </div>
            
            <div className="space-y-4 flex-1">
              {[1, 2, 3].map((i) => (
                <div key={i} className="animate-pulse">
                  <div className="h-4 bg-neutral-700/50 rounded mb-2" />
                  <div className="h-3 bg-neutral-800/50 rounded w-3/4" />
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: 0.3 }}
      className="h-full"
    >
      <Card className="h-full bg-neutral-900/90 backdrop-blur-sm border border-neutral-700/60 shadow-soft-lg hover:shadow-soft-xl transition-all duration-200">
        <CardBody className="p-8 h-full flex flex-col">
          <div className="flex items-center gap-4 mb-6 shrink-0">
            <div className="p-3 bg-gradient-to-br from-accent-purple-900/30 to-accent-blue-900/30 rounded-xl">
              <Brain className="w-6 h-6 text-accent-purple-400" />
            </div>
            <div>
              <h3 className="text-xl font-display font-bold text-neutral-50">
                AI Champion Insights
              </h3>
              <p className="text-sm text-neutral-400">
                Powered by advanced analytics
              </p>
            </div>
          </div>

          <div className="flex-1 space-y-4 min-h-0">
            {insights?.slice(0, 3).map((insight) => (
              <div
                key={`${insight.type}-${insight.title}`}
                className="p-4 bg-neutral-800/40 rounded-lg border border-neutral-700/30 hover:border-neutral-600/50 transition-colors"
              >
                <div className="flex items-start gap-3">
                  <div className={`${getInsightColor(insight.type)} mt-0.5`}>
                    {getInsightIcon(insight.type)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <h4 className="text-sm font-semibold text-neutral-200 truncate">
                        {insight.title}
                      </h4>
                      <span className={`text-xs font-medium ${getConfidenceColor(insight.confidence)}`}>
                        {insight.confidence}%
                      </span>
                    </div>
                    <p className="text-xs text-neutral-400 leading-relaxed">
                      {insight.description}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 pt-4 border-t border-neutral-700/50 shrink-0">
            <div className="flex items-center justify-between text-xs">
              <span className="text-neutral-500">
                Powered by AWS Bedrock
              </span>
              <span className="text-neutral-500">
                Updated 2 min ago
              </span>
            </div>
          </div>
        </CardBody>
      </Card>
    </motion.div>
  );
}