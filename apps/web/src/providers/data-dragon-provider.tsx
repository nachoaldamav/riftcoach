import {
  getIconImageUrl as _getIconImageUrl,
  getItemImageUrl as _getItemImageUrl,
  getProfileIconUrl as _getProfileIconUrl,
  getRunePerkIconUrl as _getRunePerkIconUrl,
  getRuneStyleIconUrl as _getRuneStyleIconUrl,
  getSummonerSpellIconUrl as _getSummonerSpellIconUrl,
  championDataQueryOptions,
  getChampionImageUrl as getImageUrl,
  versionsQueryOptions,
} from '@/lib/data-dragon';
import type { Champion, DataDragonContextType } from '@/types/data-dragon';
import { useQuery } from '@tanstack/react-query';
import { createContext, useContext, useMemo } from 'react';

const DataDragonContext = createContext<DataDragonContextType | null>(null);

interface DataDragonProviderProps {
  children: React.ReactNode;
}

export const DataDragonProvider = ({ children }: DataDragonProviderProps) => {
  // Fetch the latest version
  const {
    data: version,
    isLoading: isVersionLoading,
    error: versionError,
  } = useQuery(versionsQueryOptions);

  // Fetch champion data using the latest version
  const {
    data: championData,
    isLoading: isChampionLoading,
    error: championError,
  } = useQuery(championDataQueryOptions(version || ''));

  // Summoner Spells mapping (id -> key)
  const { data: spellKeyById } = useQuery<{ [id: number]: string }>({
    queryKey: ['ddragon-spells', version],
    enabled: Boolean(version),
    queryFn: async () => {
      const res = await fetch(
        `https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/summoner.json`,
      );
      const json = await res.json();
      const map: Record<number, string> = {};
      for (const key of Object.keys(json.data)) {
        const s = json.data[key];
        map[Number(s.key)] = s.id; // key is numeric id; id is spell filename base
      }
      return map;
    },
    staleTime: 1000 * 60 * 60 * 24,
  });

  // Memoize the context value to prevent unnecessary re-renders
  const contextValue = useMemo<DataDragonContextType>(() => {
    const champions = championData?.data || null;
    const isLoading = isVersionLoading || isChampionLoading;
    const error = versionError || championError || null;

    // Function to get champion by ID (key)
    const getChampionById = (id: string | number): Champion | null => {
      if (!champions) return null;

      const normalizeChampionName = (name: string) => {
        switch (name) {
          case 'FiddleSticks':
            return 'Fiddlesticks';
          default:
            return name;
        }
      };

      const championKey = typeof id === 'number' ? id.toString() : id;

      // First try direct lookup by key
      const championByKey = Object.values(champions).find(
        (champion) => champion.key === normalizeChampionName(championKey),
      );

      if (championByKey) return championByKey;

      // Fallback: try lookup by id (name)
      return champions[normalizeChampionName(championKey)] || null;
    };

    // Function to get champion image URL
    const getChampionImageUrl = (
      championId: string | number,
      imageType: 'square' | 'loading' | 'splash' = 'square',
    ): string => {
      if (!version) return '';

      const champion = getChampionById(championId);
      if (!champion) return '';

      // Use the champion's id (name) for the image URL, not the key
      return getImageUrl(champion.id, version, imageType);
    };

    // Function to get profile icon URL
    const getProfileIconUrl = (profileIconId: number): string => {
      if (!version) return '';
      return _getProfileIconUrl(profileIconId, version);
    };

    // Function to get item image URL
    const getItemImageUrl = (itemId: number): string => {
      if (!version) return '';
      return _getItemImageUrl(itemId, version);
    };

    // Function to get item icon URL
    const getIconImageUrl = (iconId: number): string => {
      if (!version) return '';
      return _getIconImageUrl(iconId, version);
    };

    // Function to get summoner spell icon URL from id
    const getSummonerSpellIconUrl = (spellId?: number): string => {
      return _getSummonerSpellIconUrl(
        spellId,
        version || null,
        spellKeyById || undefined,
      );
    };

    // Function to get rune primary/sub style icon URL
    const getRuneStyleIconUrl = (styleId?: number): string => {
      return _getRuneStyleIconUrl(styleId);
    };

    // Function to get rune keystone/perk icon URL
    const getRunePerkIconUrl = (perkId?: number): string => {
      return _getRunePerkIconUrl(perkId);
    };

    return {
      champions,
      version: version || null,
      isLoading,
      error: error as Error | null,
      getChampionById,
      getChampionImageUrl,
      getProfileIconUrl,
      getIconImageUrl,
      getItemImageUrl,
      getSummonerSpellIconUrl,
      getRuneStyleIconUrl,
      getRunePerkIconUrl,
    };
  }, [
    championData,
    version,
    isVersionLoading,
    isChampionLoading,
    versionError,
    championError,
    spellKeyById,
  ]);

  return (
    <DataDragonContext.Provider value={contextValue}>
      {children}
    </DataDragonContext.Provider>
  );
};

// Custom hook to use the Data Dragon context
export const useDataDragon = (): DataDragonContextType => {
  const context = useContext(DataDragonContext);
  if (!context) {
    throw new Error('useDataDragon must be used within a DataDragonProvider');
  }
  return context;
};

// Custom hook to get a specific champion by ID
export const useChampion = (
  championId: string | number | null | undefined,
): Champion | null => {
  const { getChampionById } = useDataDragon();

  return useMemo(() => {
    if (!championId) return null;
    return getChampionById(championId);
  }, [championId, getChampionById]);
};

// Custom hook to get champion image URL
export const useChampionImage = (
  championId: string | number | null | undefined,
  imageType: 'square' | 'loading' | 'splash' = 'square',
): string => {
  const { getChampionImageUrl } = useDataDragon();

  return useMemo(() => {
    if (!championId) return '';
    return getChampionImageUrl(championId, imageType);
  }, [championId, imageType, getChampionImageUrl]);
};
