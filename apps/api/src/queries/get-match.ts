import type { RiotAPITypes } from "@fightmegg/riot-api";
import { riotAPI } from "../clients/riot.js";

export const getMatch = async (
  matchId: string,
  cluster: string
): Promise<RiotAPITypes.MatchV5.MatchDTO> => {
  return await fetch(
    `https://${cluster.toLowerCase()}.api.riotgames.com/lol/match/v5/matches/${matchId}`,
    {
      headers: {
        "X-Riot-Token": riotAPI.token,
      },
    }
  ).then((res) => res.json());
};

export const getMatchTimeline = async (
  matchId: string,
  cluster: string
): Promise<RiotAPITypes.MatchV5.MatchTimelineDTO> => {
  return await fetch(
    `https://${cluster.toLowerCase()}.api.riotgames.com/lol/match/v5/matches/${matchId}/timeline`,
    {
      headers: {
        "X-Riot-Token": riotAPI.token,
      },
    }
  ).then((res) => res.json());
};
