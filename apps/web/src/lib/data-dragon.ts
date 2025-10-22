import type { ChampionData } from '@/types/data-dragon';
import { queryOptions } from '@tanstack/react-query';

// Data Dragon API endpoints
const DATA_DRAGON_BASE_URL = 'https://ddragon.leagueoflegends.com';
const VERSIONS_ENDPOINT = `${DATA_DRAGON_BASE_URL}/api/versions.json`;

// Fetch the latest version
export const fetchLatestVersion = async (): Promise<string> => {
  const response = await fetch(VERSIONS_ENDPOINT);
  if (!response.ok) {
    throw new Error(`Failed to fetch versions: ${response.statusText}`);
  }
  const versions: string[] = await response.json();
  return versions[0]; // First version is the latest
};

// Fetch champion data for a specific version
export const fetchChampionData = async (
  version: string,
): Promise<ChampionData> => {
  const championDataUrl = `${DATA_DRAGON_BASE_URL}/cdn/${version}/data/en_US/champion.json`;
  const response = await fetch(championDataUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch champion data: ${response.statusText}`);
  }
  return response.json();
};

// TanStack Query options for versions
export const versionsQueryOptions = queryOptions({
  queryKey: ['data-dragon', 'versions'],
  queryFn: fetchLatestVersion,
  staleTime: 1000 * 60 * 60 * 24, // 24 hours - versions don't change often
  gcTime: 1000 * 60 * 60 * 24 * 7, // 7 days
  retry: 3,
  retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
});

// TanStack Query options for champion data
export const championDataQueryOptions = (version: string) =>
  queryOptions({
    queryKey: ['data-dragon', 'champions', version],
    queryFn: () => fetchChampionData(version),
    staleTime: 1000 * 60 * 60 * 24, // 24 hours
    gcTime: 1000 * 60 * 60 * 24 * 7, // 7 days
    retry: 3,
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
    enabled: !!version, // Only fetch if version is available
  });

// Helper function to get champion image URL
export const getChampionImageUrl = (
  championId: string | number,
  version: string,
  imageType: 'square' | 'loading' | 'splash' = 'square',
): string => {
  const championKey =
    typeof championId === 'number' ? championId.toString() : championId;

  switch (imageType) {
    case 'square':
      return `${DATA_DRAGON_BASE_URL}/cdn/${version}/img/champion/${championKey}.png`;
    case 'loading':
      return `${DATA_DRAGON_BASE_URL}/cdn/img/champion/loading/${championKey}_0.jpg`;
    case 'splash':
      return `${DATA_DRAGON_BASE_URL}/cdn/img/champion/splash/${championKey}_0.jpg`;
    default:
      return `${DATA_DRAGON_BASE_URL}/cdn/${version}/img/champion/${championKey}.png`;
  }
};

export const getIconImageUrl = (iconId: number, version: string): string => {
  return `${DATA_DRAGON_BASE_URL}/cdn/${version}/img/item/${iconId}.png`;
};

// Helper function to get item image URL
export const getItemImageUrl = (itemId: number, version: string): string => {
  return `${DATA_DRAGON_BASE_URL}/cdn/${version}/img/item/${itemId}.png`;
};

// Helper function to get profile icon URL
export const getProfileIconUrl = (
  profileIconId: number,
  version: string,
): string => {
  return `${DATA_DRAGON_BASE_URL}/cdn/${version}/img/profileicon/${profileIconId}.png`;
};
