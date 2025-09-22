// ---- Queues ---------------------------------------------------------------
export const ALLOWED_QUEUE_IDS = [440, 420, 400] as const; // FLEX, SOLO, NORMALS
export type AllowedQueueId = (typeof ALLOWED_QUEUE_IDS)[number];
export const ALLOWED_QUEUE_ID_SET = new Set<AllowedQueueId>(ALLOWED_QUEUE_IDS);

export const QUEUE_NAME_BY_ID: Record<number, string> = {
  420: "RANKED_SOLO_5x5",
  440: "RANKED_FLEX",
  400: "NORMAL_DRAFT",
};

export const RANKED_QUEUE_IDS = [420, 440] as const;
export const RANKED_QUEUE_ID_SET = new Set<number>(RANKED_QUEUE_IDS);

// ---- Versions / patches ----------------------------------------------------

export const ALLOWED_MAJOR_VERSIONS = ["15", "14"] as const;
export type MajorVersion = (typeof ALLOWED_MAJOR_VERSIONS)[number];

export const PATCH_RE = /^(\d+)\.(\d+)(?:\.(\d+))?/; // capture first 2–3 numeric segments

/**
 * Parse Riot gameVersion loosely.
 * "15.18.1"            -> { major:"15", minor:"18", micro:"1" }
 * "15.18.531.8881"     -> { major:"15", minor:"18", micro:null }  // extra segments ignored
 * "15.18"              -> { major:"15", minor:"18", micro:null }
 * "LOL-15.18.1-foo"    -> { major:"15", minor:"18", micro:"1" }   // as long as it starts with digits.digits
 */
export function parsePatch(patch: string | null | undefined) {
  if (!patch) return null;
  const m = PATCH_RE.exec(patch.trim());
  if (!m) return null;
  const [, major, minor, micro] = m;
  return { major, minor, micro: micro ?? null };
}

/** "15.18.1" -> "15.18" (useful for bucketing) */
export function patchBucket(patch: string) {
  const p = parsePatch(patch);
  return p ? `${p.major}.${p.minor}` : patch;
}

export function isAllowedMajor(patch: string) {
  const p = parsePatch(patch);
  return (
    !!p &&
    (ALLOWED_MAJOR_VERSIONS as readonly string[]).includes(p.major as string)
  );
}

// ---- Teams / Sides ---------------------------------------------------------

export const TEAMS = {
  100: "BLUE",
  200: "RED",
} as const;
export type TeamId = keyof typeof TEAMS; // 100 | 200
export type TeamSide = (typeof TEAMS)[TeamId]; // "BLUE" | "RED"

export const BLUE_TEAM_ID: TeamId = 100;
export const RED_TEAM_ID: TeamId = 200;

// ---- Roles / Lanes ---------------------------------------------------------
export const ROLES = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_SET = new Set<Role>(ROLES);

export const LANES = ["TOP", "JUNGLE", "MID", "BOT", "SUP"] as const;
export type Lane = (typeof LANES)[number];

// Optional mapping if you need to normalize
export const LANE_TO_ROLE: Record<Lane, Role> = {
  TOP: "TOP",
  JUNGLE: "JUNGLE",
  MID: "MIDDLE",
  BOT: "BOTTOM",
  SUP: "UTILITY",
};

// ---- Objectives / Events ---------------------------------------------------
export const OBJECTIVES = [
  "HERALD",
  "DRAGON",
  "BARON",
  "TURRET",
  "ATHAKAN",
] as const;
export type Objective = (typeof OBJECTIVES)[number];

export const DRAGON_TYPES = [
  "INFERNAL",
  "MOUNTAIN",
  "OCEAN",
  "CLOUD",
  "HEXTECH",
  "CHEMTECH",
  "ELDER",
] as const;
export type DragonType = (typeof DRAGON_TYPES)[number];

// ---- Time / Windows --------------------------------------------------------
export const SECONDS = {
  MINUTE: 60,
  FIVE_MIN: 300,
  TEN_MIN: 600,
  FIFTEEN_MIN: 900,
  THIRTY_MIN: 1800,
} as const;

export const GAME_PHASES = {
  EARLY_END: 14 * SECONDS.MINUTE, // 14:00 – common early/laning cutoff
  MID_START: 14 * SECONDS.MINUTE,
  MID_END: 25 * SECONDS.MINUTE, // tweak as needed
  LATE_START: 25 * SECONDS.MINUTE,
} as const;

// Windows used by detectors (feel free to tune)
export const CONTEXT_WINDOWS = {
  proximityWindowSec: 2.5,
  objectiveLookaheadSec: 120,
  visionRecentSec: 90,
  nearbyRadiusUnits: 2500, // common LoL analysis radius
} as const;

// ---- DDragon / Data paths --------------------------------------------------
export const DDRAGON_DEFAULT_PATCH = "15.18.1"; // fallback; you’ll usually inject this at runtime
export const DDRAGON_BASE_S3_PREFIX = "ddragon"; // e.g., s3://your-bucket/ddragon/{patch}/...

export const S3_PREFIX = {
  RAW_MATCHES: "raw/matches", // raw/season=YYYY/patch=15.x/queue=420/...
  FLAT: "flat", // flattened participant/events if you create them
  COHORTS: "cohorts", // aggregates
  PLAYER_AGG: "player-agg",
  FACT_SHEETS: "facts", // KB docs
  RAW_TIMELINES: "raw/timelines", // raw timelines
} as const;

// ---- Items / Mechanics -----------------------------------------------------
export const ITEM_GROUPS = {
  GRIEVOUS_WOUNDS: new Set<number>([
    3123, // Executioner's Calling
    3033, // Mortal Reminder
    3076, // Bramble Vest
    3075, // Thornmail
    3916, // Oblivion Orb
    3165, // Morellonomicon
    3222, // Chemtech Putrifier
    6609, // Chempunk Chainsword
  ]),
  VISION_CONTROL: new Set<number>([
    2055, // Control Wards
    2056, // Stealth Wards
    3363, // Farsight Alteration
  ]),
} as const;

// ---- Utilities -------------------------------------------------------------
export const isAllowedQueue = (queueId: number): queueId is AllowedQueueId =>
  ALLOWED_QUEUE_ID_SET.has(queueId as AllowedQueueId);

export const teamSide = (teamId: number): TeamSide | "UNKNOWN" =>
  (TEAMS as Record<string, TeamSide>)[String(teamId)] ?? "UNKNOWN";
