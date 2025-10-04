export interface RoleStats {
  roleBucket: string;
  games: number;
  winRate: number | null;
  kpMean: number | null;
  visPerMinMean: number | null;
  wclearPerMinMean: number | null;
  dpgMean: number | null; // damage per minute
  cs10Mean: number | null;
  csfullMean: number | null;
  drakeParticipationMean: number | null;
  heraldParticipationMean: number | null;
  baronParticipationMean: number | null;
  avgObjectiveParticipation: number | null;
  avgLaningSurvivalRate: number | null;
  avgEarlyGameDeaths: number | null;
  killsNearEnemyTurretMean: number | null;
  killsUnderOwnTurretMean: number | null;
  deathsNearEnemyTurretMean: number | null;
  deathsUnderOwnTurretMean: number | null;
  avgDamagePerGold: number | null; // may be null (not provided by cohort rollup)
  avgKills: number | null;
  avgDeaths: number | null;
  avgAssists: number | null;
  avgKda: number | null;
  avgKillParticipationPct: number | null;
  avgKillParticipationProp: number | null;
  avgDamagePerMinute: number | null;
  avgTeamDamagePct: number | null; // NEW: now filled from cohorts rollup
  avgGoldPerMinute: number | null; // NEW: now filled from cohorts rollup
  avgVisionScorePerMinute: number | null;
  avgWardsCleared: number | null; // NEW: now filled from cohorts rollup
  avgWardsClearedEarly: number | null; // NEW: now filled from cohorts rollup
  avgSoloKills: number | null; // NEW: now filled from cohorts rollup
  avgScuttleKills: number | null; // NEW: now filled from cohorts rollup
  roleDistributionPct: { [role: string]: number } | null;
}

export interface PlaystyleStats {
  // Overall stats (from ALL role bucket)
  matchesPlayed: number;
  winRate: number | null;
  avgGameDurationMin: number | null;
  avgKills: number | null;
  avgDeaths: number | null;
  avgAssists: number | null;
  avgKda: number | null;
  avgKillParticipation: number | null;
  avgDamagePerMinute: number | null;
  avgTeamDamagePct: number | null;
  avgGoldPerMinute: number | null;
  avgCsPerMinute: number | null;
  avgCsAt10: number | null;
  avgVisionScorePerMinute: number | null;
  avgControlWards: number | null;
  avgWardsCleared: number | null;
  avgWardsClearedEarly: number | null;
  avgSoloKills: number | null;
  avgTurretTakedowns: number | null;
  avgInhibitorTakedowns: number | null;
  avgObjectiveTakedowns: number | null;
  avgScuttleKills: number | null;
  avgKillsNearEnemyTurret: number | null;
  avgKillsUnderOwnTurret: number | null;
  avgDeathsNearEnemyTurret: number | null;
  avgDeathsUnderOwnTurret: number | null;
  // New comprehensive metrics
  avgLaningSurvivalRate: number | null;
  avgEarlyGameDeaths: number | null;
  avgObjectiveParticipation: number | null;
  avgDragonParticipation: number | null;
  avgBaronParticipation: number | null;
  avgHeraldParticipation: number | null;
  roleDistribution: { [role: string]: number } | null;
  // Role-based breakdown
  roleStats: RoleStats[];
}

export interface PlaystyleQueryMeta {
  queryExecutionId: string;
  statistics?: {
    dataScannedInBytes?: number;
    engineExecutionTimeInMillis?: number;
  };
  sql: string;
  season?: number | null;
  queues?: number[];
}

export interface CohortStats {
  // Overall cohort stats (from ALL role bucket)
  season: number;
  totalPlayers: number;
  totalGames: number;
  seasonAvgKp: number | null;
  seasonAvgVisPerMin: number | null;
  seasonAvgWclearPerMin: number | null;
  seasonAvgDpg: number | null;
  seasonAvgCs10: number | null;
  seasonAvgCsfull: number | null;
  seasonAvgDrakeParticipation: number | null;
  seasonAvgHeraldParticipation: number | null;
  seasonAvgBaronParticipation: number | null;
  seasonAvgObjParticipation: number | null;
  seasonAvgLaningSurvivalRate: number | null;
  seasonAvgEarlyGameDeaths: number | null;
  seasonAvgKillsNearEnemyTurret: number | null;
  seasonAvgKillsUnderOwnTurret: number | null;
  seasonAvgDeathsNearEnemyTurret: number | null;
  seasonAvgDeathsUnderOwnTurret: number | null;
  seasonAvgDamagePerGold: number | null; // may be null (not produced by v2.2 rollup)
  seasonAvgWinRate: number | null;
  // Role-based breakdown
  roleStats: RoleStats[];
}

export interface CohortQueryResult {
  stats: CohortStats | null;
  meta: PlaystyleQueryMeta;
}

export interface PlaystyleQueryResult {
  stats: PlaystyleStats | null;
  meta: PlaystyleQueryMeta;
}

export interface BuildQueryOptions {
  puuid: string;
  season?: number;
  queues?: number[];
}

export interface CacheMetadata {
  cachedAt: string;
  expiresAt: string;
  version: string;
}

export interface CachedData<T> {
  data: T;
  metadata: CacheMetadata;
}

export interface AIBadgeResult {
  badges: Array<{
    name: string;
    description: string;
    confidence: number;
    reasoning: string;
  }>;
  summary: string;
  strengths: string[];
  improvements: string[];
}

export interface StatComparison {
  value: number;
  cohortAverage: number;
  percentageDifference: number;
  isAboveAverage: boolean;
  significance: 'much_higher' | 'higher' | 'similar' | 'lower' | 'much_lower';
  roleWeightedValue?: number;
  roleWeightedAverage?: number;
}

export interface EnhancedPlayerAnalysis {
  playerStats: PlaystyleStats;
  cohortStats: CohortStats;
  roleWeights: { [role: string]: number };
  primaryRole: string;
  secondaryRole?: string;
  comparisons: {
    killParticipation: StatComparison | null;
    visionScorePerMinute: StatComparison | null;
    damagePerMinute: StatComparison | null;
    teamDamagePercent: StatComparison | null;
    goldPerMinute: StatComparison | null;
    csPerMinute: StatComparison | null;
    winRate: StatComparison | null;
    kda: StatComparison | null;
    objectiveParticipation: StatComparison | null;
    laningSurvivalRate: StatComparison | null;
    earlyGameDeaths: StatComparison | null;
    soloKills: StatComparison | null;
    wardsCleared: StatComparison | null;
    dragonParticipation: StatComparison | null;
    baronParticipation: StatComparison | null;
    heraldParticipation: StatComparison | null;
  };
  roleSpecificInsights: {
    [role: string]: {
      gamesPlayed: number;
      percentage: number;
      keyStrengths: string[];
      keyWeaknesses: string[];
    };
  };
}

export interface FormattedStatLine {
  statName: string;
  role: string;
  playerValue: number;
  cohortValue: number;
  weight: number;
  percentageDiff: number;
  significance: 'much_higher' | 'higher' | 'similar' | 'lower' | 'much_lower';
}

export const DEFAULT_QUEUES = [420, 440, 400];

export const BADGE_CATALOG = [
  {
    name: 'Early Game Bully',
    focus:
      'High CS at 10 minutes, strong gold per minute, and frequent solo kills that indicate laning dominance across all roles.',
  },
  {
    name: 'Teamfight Anchor',
    focus:
      'Outstanding kill participation, damage share, and low deaths that show up big in coordinated fights.',
  },
  {
    name: 'Objective Captain',
    focus:
      'Secures dragons, barons, heralds, and structures consistently to convert leads into map control.',
  },
  {
    name: 'Vision Controller',
    focus:
      'Heavy vision investment with control wards and ward takedowns that keep the map lit and safe.',
  },
  {
    name: 'Macro Farmer',
    focus:
      'Top tier CS per minute and farming efficiency to stay rich and relevant deep into games.',
  },
  {
    name: 'Skirmish Specialist',
    focus:
      'Aggressive picks, skirmishes, and turret dives reflected by high solo kills and kills near enemy structures.',
  },
  {
    name: 'Defensive Bastion',
    focus:
      'Low deaths, turret defense, and kills under own turret that stabilize shaky games.',
  },
  {
    name: 'Objective Scout',
    focus:
      'Early vision clears and scuttle control to set up for neutral objectives and river dominance.',
  },
  {
    name: 'Lane Survivor',
    focus:
      'High survival rate during laning phase with minimal early game deaths, showing strong positioning and safety.',
  },
  {
    name: 'Versatile Player',
    focus:
      'Adapts playstyle across multiple roles while maintaining consistent performance metrics.',
  },
];
