import { BentoGrid, BentoItem } from '@/components/bento/BentoGrid';
import { ChampionInsightsCard } from '@/components/bento/ChampionInsightsCard';
import { ChampionMasteryCard } from '@/components/bento/ChampionMasteryCard';
import { HeatmapCard } from '@/components/bento/HeatmapCard';
import { OverviewCard } from '@/components/bento/OverviewCard';
import { RecentMatchesCard } from '@/components/bento/RecentMatchesCard';
import { Navbar } from '@/components/navbar';
import { ProfileHeader } from '@/components/profile-header';
import { ScanStatusBox } from '@/components/scan-status-box';
import type { RewindStatusResponse } from '@/routes/$region/$name/$tag';
import { motion } from 'framer-motion';

interface SummonerSummary {
  id: string;
  name: string;
  profileIconId: number;
  summonerLevel: number;
}

interface BadgeItem {
  title: string;
  reason: string;
  polarity?: 'good' | 'bad' | 'neutral';
}

interface ProfileLayoutProps {
  summoner: SummonerSummary;
  region: string;
  name: string;
  tag: string;
  badges?: BadgeItem[];
  isBadgesLoading?: boolean;
  isBadgesFetching?: boolean;
  isIdle?: boolean;
  showScanBox?: boolean;
  status?: RewindStatusResponse | null;
  wsConnected?: boolean;
  onClose?: () => void;
}

export function ProfileLayout({
  summoner,
  region,
  name,
  tag,
  badges,
  isBadgesLoading,
  isBadgesFetching,
  isIdle,
  showScanBox,
  status,
  wsConnected,
  onClose,
}: ProfileLayoutProps) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-neutral-950 via-neutral-900 to-neutral-800 relative">
      <Navbar />
      <div className="container mx-auto px-6 py-12 max-w-7xl">
        <div className="space-y-8">
          <ProfileHeader
            summoner={summoner}
            region={region}
            name={name}
            tag={tag}
            badges={badges}
            isBadgesLoading={isBadgesLoading}
            isBadgesFetching={isBadgesFetching}
            isIdle={isIdle}
          />

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
        </div>
      </div>

      {showScanBox && status ? (
        <ScanStatusBox
          status={status}
          wsConnected={wsConnected ?? false}
          onClose={onClose}
        />
      ) : null}
    </div>
  );
}
