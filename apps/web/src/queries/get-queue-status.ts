import { http } from '@/clients/http';
import { queryOptions } from '@tanstack/react-query';

export interface QueueStatus {
  jobId: string;
  position: number;
  state: string;
  pagesDone_420: number;
  pagesDone_440: number;
  idsFound: number;
  matchesFetched: number;
  timelinesFetched: number;
  startedAt: number;
  updatedAt: number;
  resultKey: unknown;
  jobMapping: JobMapping;
}

export interface JobMapping {
  scope: string;
  region: string;
  puuid: string;
  originalId: string;
}

export const getQueueStatusQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ['queue-status', id],
    queryFn: () =>
      http.get<QueueStatus>(`/rewind/${id}/status`).then((res) => res.data),
    refetchInterval: 1000,
    refetchIntervalInBackground: true,
  });
