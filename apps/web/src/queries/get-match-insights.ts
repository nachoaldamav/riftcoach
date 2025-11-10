import { http } from '@/clients/http';
import type { RiotAPITypes } from '@fightmegg/riot-api';
import { queryOptions } from '@tanstack/react-query';

// Match insights interfaces
export interface MatchInsights {
  summary: string;
  roleFocus: string;
  keyMoments: KeyMoment[];
  macro: Macro;
  drills: string[];
  confidence: number;
}

export interface KeyMoment {
  ts: number;
  title: string;
  insight: string;
  suggestion: string;
  coordinates: Coordinate[];
  zone: string;
  enemyHalf: boolean;
}

export interface Coordinate {
  x: number;
  y: number;
}

export interface Macro {
  objectives: string[];
  rotations: string[];
  vision: string[];
}

// Build suggestions interfaces from API
export interface ItemSuggestion {
  action: string;
  targetSlot?: string;
  suggestedItemId?: string;
  suggestedItemName?: string;
  replaceItemId?: string;
  replaceItemName?: string;
  reasoning: string;
}

export interface MatchBuildSuggestionsResponse {
  buildOrder: Array<{
    order: number;
    itemId: number;
    itemName: string;
    reasoning: string;
  }>;
  suggestions: ItemSuggestion[];
  overallAnalysis: string;
}

export interface MatchProgressEntry {
  matchId: string;
  gameCreation: number;
  gameEndTimestamp?: number;
  gameDuration: number;
  queueId: number;
  championName: string;
  role: string;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  csPerMin: number | null;
  damagePerMin: number | null;
  goldPerMin: number | null;
  visionPerMin: number | null;
  killParticipation: number | null;
  kda: number | null;
}

export interface MatchProgressResponse {
  championName: string;
  role: string;
  matches: MatchProgressEntry[];
  limit: number;
}

// Query options for match data
export const getMatchDataQueryOptions = (
  region: string,
  name: string,
  tag: string,
  matchId: string,
) =>
  queryOptions({
    queryKey: ['match-data', region, name, tag, matchId],
    queryFn: () =>
      http
        .get<RiotAPITypes.MatchV5.MatchDTO>(
          `/v1/${encodeURIComponent(region)}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}/match/${matchId}/match`,
        )
        .then((res) => res.data),
    staleTime: 1000 * 60 * 10, // 10 minutes
  });

// Query options for timeline data
export const getTimelineDataQueryOptions = (
  region: string,
  name: string,
  tag: string,
  matchId: string,
) =>
  queryOptions({
    queryKey: ['timeline-data', region, name, tag, matchId],
    queryFn: () =>
      http
        .get<RiotAPITypes.MatchV5.MatchTimelineDTO>(
          `/v1/${encodeURIComponent(region)}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}/match/${matchId}/timeline`,
        )
        .then((res) => res.data),
    staleTime: 1000 * 60 * 10, // 10 minutes
  });

// Query options for match insights
export const getMatchInsightsQueryOptions = (
  region: string,
  name: string,
  tag: string,
  matchId: string,
) =>
  queryOptions({
    queryKey: ['match-insights', region, name, tag, matchId],
    queryFn: () =>
      http
        .get<MatchInsights>(
          `/v1/${encodeURIComponent(region)}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}/match/${matchId}/insights`,
          {
            timeout: 100_000,
          },
        )
        .then((res) => res.data),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });

// Query options for build suggestions (requires authenticated API)
export const getMatchBuildSuggestionsQueryOptions = (
  region: string,
  name: string,
  tag: string,
  matchId: string,
) =>
  queryOptions({
    queryKey: ['match-builds', region, name, tag, matchId],
    queryFn: () =>
      http
        .get<MatchBuildSuggestionsResponse>(
          `/v1/${encodeURIComponent(region)}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}/match/${matchId}/builds`,
          { timeout: 120_000 },
        )
        .then((res) => res.data),
    staleTime: 1000 * 60 * 10,
  });

export const getMatchProgressQueryOptions = (
  region: string,
  name: string,
  tag: string,
  matchId: string,
) =>
  queryOptions({
    queryKey: ['match-progress', region, name, tag, matchId],
    queryFn: () =>
      http
        .get<MatchProgressResponse>(
          `/v1/${encodeURIComponent(region)}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}/match/${matchId}/progress`,
        )
        .then((res) => res.data),
    staleTime: 1000 * 60 * 10,
  });

// Combined query options for all match data
export const getAllMatchDataQueryOptions = (
  region: string,
  name: string,
  tag: string,
  matchId: string,
) => ({
  match: getMatchDataQueryOptions(region, name, tag, matchId),
  timeline: getTimelineDataQueryOptions(region, name, tag, matchId),
  insights: getMatchInsightsQueryOptions(region, name, tag, matchId),
  builds: getMatchBuildSuggestionsQueryOptions(region, name, tag, matchId),
  progress: getMatchProgressQueryOptions(region, name, tag, matchId),
});

// Champion-role detail (player vs cohort) used for match-level comparisons
export interface ChampionRolePercentiles {
  p50: Record<string, number>;
  p75: Record<string, number>;
  p90: Record<string, number>;
  p95: Record<string, number>;
}

export interface ChampionRoleDetailResponse {
  championName: string;
  role: string;
  aiScore: number | null;
  reasoning?: string;
  stats: {
    avgCspm: number;
    avgGoldAt10: number;
    avgCsAt10: number;
    avgGoldAt15: number;
    avgCsAt15: number;
    avgDpm: number;
    avgDtpm: number;
    avgKpm: number;
    avgApm: number;
    avgDeathsPerMin: number;
  };
  cohort: {
    championName: string;
    role: string;
    percentiles: ChampionRolePercentiles;
  } | null;
  playerPercentiles?: {
    championName: string;
    role: string;
    percentiles: ChampionRolePercentiles;
  } | null;
  insights: {
    summary: string;
    strengths: string[];
    weaknesses: string[];
  };
}

export const getChampionRoleDetailQueryOptions = (
  region: string,
  name: string,
  tag: string,
  championName: string,
  role: string,
) =>
  queryOptions({
    queryKey: [
      'champion-role-detail',
      region,
      name,
      tag,
      championName,
      role,
    ],
    queryFn: () =>
      http
        .get<ChampionRoleDetailResponse>(
          `/v1/${encodeURIComponent(region)}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}/champions/${encodeURIComponent(
            championName,
          )}/${encodeURIComponent(role)}`,
        )
        .then((res) => res.data),
    staleTime: 1000 * 60 * 10,
  });
