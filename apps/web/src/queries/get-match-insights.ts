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
});
