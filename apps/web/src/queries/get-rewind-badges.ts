import { http } from '@/clients/http';
import { queryOptions } from '@tanstack/react-query';

export interface RewindProfileBadges {
  badges: Badge[];
  summary: string;
  strengths: string[];
  improvements: string[];
  playerPerRole: PlayerPerRole[];
  cohortPerRole: CohortPerRole[];
}

export interface Badge {
  name: string;
  description: string;
  confidence: number;
  reasoning: string;
}

export interface PlayerPerRole {
  role: string;
  games: number;
  win_rate_pct_estimate: number;
  kill_participation_pct_est: number;
  avg_vision_score_per_min: number;
  avg_dpm: number;
  avg_cs_at10: number;
  avg_cs_total: number;
  avg_dragon_participation: number;
  avg_herald_participation: number;
  avg_baron_participation: number;
  avg_early_deaths: number;
  avg_early_kills_near_enemy_tower: number;
  avg_early_kills_near_ally_tower: number;
  avg_early_deaths_near_ally_tower: number;
  avg_kills: number;
  avg_deaths: number;
  avg_assists: number;
  avg_kda: number;
  avg_team_dmg_pct: number;
  avg_gpm: number;
  avg_wards_killed: number;
  avg_early_solo_kills: number;
}

export interface CohortPerRole {
  role: string;
  games: number;
  win_rate_pct_estimate: number;
  kill_participation_pct_est: number;
  avg_vision_score_per_min: number;
  avg_dpm: number;
  avg_cs_at10: number;
  avg_cs_total: number;
  avg_dragon_participation: number;
  avg_herald_participation: number;
  avg_baron_participation: number;
  avg_early_deaths: number;
  avg_early_kills_near_enemy_tower: number;
  avg_early_kills_near_ally_tower: number;
  avg_early_deaths_near_ally_tower: number;
  avg_kills: number;
  avg_deaths: number;
  avg_assists: number;
  avg_kda: number;
  avg_team_dmg_pct: number;
  avg_gpm: number;
  avg_wards_killed: number;
  avg_early_solo_kills: number;
}

// Fetch playstyle badges for a rewind job
export const fetchRewindBadges = async (
  jobId: string,
): Promise<RewindProfileBadges> => {
  const response = await http.get<RewindProfileBadges>(
    `/rewind/${jobId}/playstyle-badges`,
  );
  return response.data;
};

// TanStack Query options for rewind badges
export const rewindBadgesQueryOptions = (jobId: string) =>
  queryOptions({
    queryKey: ['rewind', 'badges', jobId],
    queryFn: () => fetchRewindBadges(jobId),
    staleTime: 1000 * 60 * 10, // 10 minutes - badges don't change frequently
    gcTime: 1000 * 60 * 60, // 1 hour
    retry: 3,
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
    enabled: !!jobId, // Only fetch if jobId is available
  });
