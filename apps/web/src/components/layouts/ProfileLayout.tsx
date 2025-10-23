import { BentoGrid, BentoItem } from '@/components/bento/BentoGrid';
import { ChampionInsightsCard } from '@/components/bento/ChampionInsightsCard';
import { ChampionMasteryCard } from '@/components/bento/ChampionMasteryCard';
import { HeatmapCard } from '@/components/bento/HeatmapCard';
import { OverviewCard } from '@/components/bento/OverviewCard';
import { RecentMatchesCard } from '@/components/bento/RecentMatchesCard';
import { motion } from 'framer-motion';

interface SummonerSummary {
  id: string;
  name: string;
  profileIconId: number;
  summonerLevel: number;
}

interface ProfileLayoutProps {
  summoner: SummonerSummary;
  region: string;
  name: string;
  tag: string;
}

export function ProfileLayout({ region, name, tag }: ProfileLayoutProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 30 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, delay: 0.1 }}
      className="space-y-8"
    >
      <BentoGrid className="max-w-none">
        <BentoItem span="md">
          <OverviewCard region={region} name={name} tag={tag} />
        </BentoItem>
        <BentoItem span="md">
          <ChampionMasteryCard region={region} name={name} tag={tag} />
          <ChampionInsightsCard region={region} name={name} tag={tag} />
        </BentoItem>
        <BentoItem span="md">
          <HeatmapCard region={region} name={name} tag={tag} />
        </BentoItem>
        <BentoItem span="md">
          <RecentMatchesCard region={region} name={name} tag={tag} />
        </BentoItem>
      </BentoGrid>
    </motion.div>
  );
}
