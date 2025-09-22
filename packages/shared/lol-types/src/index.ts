import { RiotAPITypes } from "@fightmegg/riot-api";

export type Champion = RiotAPITypes.DDragon.DDragonChampionDTO;

export type Item = RiotAPITypes.DDragon.DDragonItemDTO;

export type Match = RiotAPITypes.MatchV5.MatchDTO;

export type MatchTimeline = RiotAPITypes.MatchV5.MatchTimelineDTO;

export type Role = "TOP" | "JUNGLE" | "MIDDLE" | "BOTTOM" | "UTILITY";
