import { http } from '@/clients/http';
import { queryOptions } from '@tanstack/react-query';

// Types for the profile response
export interface RewindProfile {
  puuid: string;
  profileIconId: number;
  revisionDate: number;
  summonerLevel: number;
  gameName: string;
  tagLine: string;
}

// Fetch profile information for a rewind job
export const fetchRewindProfile = async (
  jobId: string,
): Promise<RewindProfile> => {
  const response = await http.get<RewindProfile>(`/rewind/${jobId}/profile`);
  return response.data;
};

// TanStack Query options for rewind profile
export const rewindProfileQueryOptions = (jobId: string) =>
  queryOptions({
    queryKey: ['rewind', 'profile', jobId],
    queryFn: () => fetchRewindProfile(jobId),
    staleTime: 1000 * 60 * 5, // 5 minutes
    gcTime: 1000 * 60 * 30, // 30 minutes
    retry: 3,
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
    enabled: !!jobId, // Only fetch if jobId is available
  });
