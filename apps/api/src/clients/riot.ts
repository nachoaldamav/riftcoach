import { RiotAPI, RiotAPITypes } from "@fightmegg/riot-api";
import ms from "ms";

const riotAPI = new RiotAPI(process.env.RIOT_API_KEY as string, {
  debug: true,
  cache: {
    cacheType: "ioredis",
    client: process.env.REDIS_URI as string,
    ttls: {
      byMethod: {
        [RiotAPITypes.METHOD_KEY.ACCOUNT.GET_BY_RIOT_ID]: ms("1d"),
        [RiotAPITypes.METHOD_KEY.SUMMONER.GET_BY_PUUID]: ms("1h"),
        [RiotAPITypes.METHOD_KEY.MATCH_V5.GET_MATCH_BY_ID]: ms("1d"),
        [RiotAPITypes.METHOD_KEY.MATCH_V5.GET_MATCH_TIMELINE_BY_ID]: ms("1d"),
        [RiotAPITypes.METHOD_KEY.LEAGUE.GET_ENTRIES_BY_PUUID]: ms("15m"),
      },
    },
  },
});

export { riotAPI };
