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
  imageType: 'square' | 'loading' | 'splash' | 'centered' = 'square',
): string => {
  const championKey =
    typeof championId === 'number' ? championId.toString() : championId;

  const correctChampionKey = (key: string) => {
    if (key === 'Nunu') return 'NunuAndWillump';
    if (key === 'RekSai') return 'RekSai';
    if (key === 'FiddleSticks') return 'Fiddlesticks';
    return key;
  };

  switch (imageType) {
    case 'square':
      return `${DATA_DRAGON_BASE_URL}/cdn/${version}/img/champion/${correctChampionKey(championKey)}.png`;
    case 'loading':
      return `${DATA_DRAGON_BASE_URL}/cdn/img/champion/loading/${correctChampionKey(championKey)}_0.jpg`;
    case 'splash':
      return `${DATA_DRAGON_BASE_URL}/cdn/img/champion/splash/${correctChampionKey(championKey)}_0.jpg`;
    case 'centered':
      return `${DATA_DRAGON_BASE_URL}/cdn/img/champion/centered/${correctChampionKey(championKey)}_0.jpg`;
    default:
      return `${DATA_DRAGON_BASE_URL}/cdn/${version}/img/champion/${correctChampionKey(championKey)}.png`;
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

// Summoner Spell icon URL from id -> key mapping
export const getSummonerSpellIconUrl = (
  spellId: number | undefined,
  version: string | null,
  spellKeyById: Record<number, string> | undefined,
): string => {
  if (!spellId || !version || !spellKeyById) return '';
  const key = spellKeyById[spellId];
  if (!key) return '';
  return `${DATA_DRAGON_BASE_URL}/cdn/${version}/img/spell/${key}.png`;
};

// Rune style icon URL mapping (uses Data Dragon)
const RUNE_STYLE_MAPPING: Record<number, string> = {
  8000: '7201_Precision', // Precision
  8100: '7200_Domination', // Domination
  8200: '7202_Sorcery', // Sorcery
  8300: '7203_Whimsy', // Inspiration
  8400: '7204_Resolve', // Resolve
};

export const getRuneStyleIconUrl = (styleId: number | undefined): string => {
  if (!styleId || !RUNE_STYLE_MAPPING[styleId]) return '';
  return `https://ddragon.leagueoflegends.com/cdn/img/perk-images/Styles/${RUNE_STYLE_MAPPING[styleId]}.png`;
};

// Rune perk icon URL mapping (uses Data Dragon with rune name paths)
// This is a simplified mapping for common keystones - in a full implementation,
// you'd fetch this from runesReforged.json and build the mapping dynamically
const RUNE_PERK_MAPPING: Record<number, { style: string; name: string }> = {
  // Precision keystones
  8005: { style: 'Precision', name: 'PressTheAttack' },
  8008: { style: 'Precision', name: 'LethalTempoTemp' },
  8021: { style: 'Precision', name: 'FleetFootwork' },
  8010: { style: 'Precision', name: 'Conqueror' },

  // Domination keystones
  8112: { style: 'Domination', name: 'Electrocute' },
  8124: { style: 'Domination', name: 'Predator' },
  8128: { style: 'Domination', name: 'DarkHarvest' },
  9923: { style: 'Domination', name: 'HailOfBlades' },

  // Sorcery keystones
  8214: { style: 'Sorcery', name: 'SummonAery' },
  8229: { style: 'Sorcery', name: 'ArcaneComet' },
  8230: { style: 'Sorcery', name: 'PhaseRush' },

  // Resolve keystones
  8437: { style: 'Resolve', name: 'GraspOfTheUndying' },
  8439: { style: 'Resolve', name: 'VeteranAftershock' },
  8465: { style: 'Resolve', name: 'Guardian' },

  // Inspiration keystones
  8351: { style: 'Inspiration', name: 'GlacialAugment' },
  8360: { style: 'Inspiration', name: 'UnsealedSpellbook' },
  8369: { style: 'Inspiration', name: 'FirstStrike' },
};

export const getRunePerkIconUrl = (perkId: number | undefined): string => {
  if (!perkId || !RUNE_PERK_MAPPING[perkId]) return '';
  const { style, name } = RUNE_PERK_MAPPING[perkId];

  // Special case for LethalTempoTemp - use LethalTempo folder but LethalTempoTemp filename
  if (name === 'LethalTempoTemp') {
    return `https://ddragon.leagueoflegends.com/cdn/img/perk-images/Styles/${style}/LethalTempo/${name}.png`;
  }

  return `https://ddragon.leagueoflegends.com/cdn/img/perk-images/Styles/${style}/${name}/${name}.png`;
};
