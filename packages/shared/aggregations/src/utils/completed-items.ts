import { DDragon, type RiotAPITypes } from '@fightmegg/riot-api';

type Item = RiotAPITypes.DDragon.DDragonItemDTO & { id: string };

let cachedCompletedItemIds: number[] | null = null;
let lastFetched = 0;

const CACHE_TTL_MS = 1000 * 60 * 60; // 1 hour

function isCompletedItem(item: RiotAPITypes.DDragon.DDragonItemDTO): boolean {
  if (!item.from?.length) return false;
  const consumed = (item as { consumed?: boolean }).consumed;
  if (consumed) return false;
  if (item.tags?.includes('Boots')) {
    return (item.depth ?? 0) >= 2;
  }
  return (item.depth ?? 0) >= 3 || !item.into?.length;
}

export async function getCompletedItemIds(): Promise<number[]> {
  if (
    Array.isArray(cachedCompletedItemIds) &&
    cachedCompletedItemIds.length > 0 &&
    Date.now() - lastFetched < CACHE_TTL_MS
  ) {
    return cachedCompletedItemIds;
  }

  const ddragon = new DDragon();
  const itemsRaw = await ddragon.items();
  const items: Item[] = Object.entries(itemsRaw.data).map(([id, data]) => ({
    ...(data as RiotAPITypes.DDragon.DDragonItemDTO),
    id,
  }));

  cachedCompletedItemIds = items
    .filter((item) => isCompletedItem(item))
    .map((item) => Number(item.id));
  lastFetched = Date.now();

  return cachedCompletedItemIds;
}
