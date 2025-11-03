import { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import consola from 'consola';
import { bedrockClient } from '../clients/bedrock.js';
import { BADGES_PROMPT } from '../prompts/badges.js';
import compareRoleStats, {
  type RoleComparison,
} from '../utils/compare-role-stats.js';

export type NormalizedBadge = {
  title: string;
  description: string;
  reason: string;
  polarity: 'good' | 'bad' | 'neutral';
};

export type NormalizedBadgesResponse = {
  badges: NormalizedBadge[];
};

const negativeTitles = new Set([
  'Vision Improvement Needed',
  'Early Game Struggles',
  'Objective Neglect',
  'Damage Output Gap',
  'Farm Efficiency Gap',
  'Tower Pressure Gap',
  'Death Discipline',
  'Low-Value Deaths',
  'Mid Game Dip',
  'Scaling Issues',
  'Team Contribution Gap',
  'Level Tempo Lag',
  'Experience Gap',
]);

type BadgeMetricCondition = {
  metric: string;
  comparison?: '>=' | '<=' | 'between' | 'abs<=' | '>';
  value?: number;
  min?: number;
  max?: number;
  thresholdByRole?: Record<string, number>;
  description?: string;
};

type BadgeThresholdBranch = {
  mustMeet: BadgeMetricCondition[];
  notes?: string;
};

type BadgeThresholdEntry = {
  name: string;
  polarity: 'good' | 'bad' | 'neutral';
  roleFocus: 'primary_role_diff' | 'any_role_diff' | 'absolute_value';
  description?: string;
  excludeRoles?: string[];
  preferNonUtility?: boolean;
  minGames?: number;
  requires?: string[];
  mustMeet?: BadgeMetricCondition[];
  anyOf?: BadgeThresholdBranch[];
  notes?: string;
};

const BADGE_THRESHOLD_SUMMARY: BadgeThresholdEntry[] = [
  {
    name: 'Objective Master',
    polarity: 'good',
    roleFocus: 'primary_role_diff',
    description: 'Superior participation in epic objectives.',
    anyOf: [
      {
        mustMeet: [
          {
            metric: 'objectiveParticipation.drakes.rate',
            comparison: '>=',
            value: 7,
            description: 'Diff ≥ +7 percentage points in drake participation.',
          },
          {
            metric: 'objectiveParticipation.herald.rate',
            comparison: '>=',
            value: 7,
            description:
              'Diff ≥ +7 percentage points in Rift Herald participation.',
          },
        ],
      },
      {
        mustMeet: [
          {
            metric: 'objectiveParticipation.drakes.rate',
            comparison: '>=',
            value: 7,
            description: 'Diff ≥ +7 percentage points in drake participation.',
          },
          {
            metric: 'objectiveParticipation.baron.rate',
            comparison: '>=',
            value: 7,
            description: 'Diff ≥ +7 percentage points in Baron participation.',
          },
        ],
      },
      {
        mustMeet: [
          {
            metric: 'objectiveParticipation.herald.rate',
            comparison: '>=',
            value: 7,
            description:
              'Diff ≥ +7 percentage points in Rift Herald participation.',
          },
          {
            metric: 'objectiveParticipation.baron.rate',
            comparison: '>=',
            value: 7,
            description: 'Diff ≥ +7 percentage points in Baron participation.',
          },
        ],
      },
    ],
    notes:
      'Award if any two epic objective participations show ≥+7pp diffs (0–100 scale).',
  },
  {
    name: 'Vision Expert',
    polarity: 'good',
    roleFocus: 'primary_role_diff',
    description: 'Exceptional vision control in the primary role.',
    mustMeet: [
      {
        metric: 'visionScorePerMin',
        comparison: '>=',
        value: 0.1,
        thresholdByRole: { UTILITY: 0.35 },
        description: 'Diff ≥ +0.1 for non-UTILITY; ≥ +0.35 for UTILITY.',
      },
    ],
    notes: 'Award for top ~25% of vision performances.',
  },
  {
    name: 'Early Game Dominator',
    polarity: 'good',
    roleFocus: 'primary_role_diff',
    description: 'Strong CS and gold leads by 10 minutes.',
    excludeRoles: ['UTILITY'],
    anyOf: [
      {
        mustMeet: [
          {
            metric: 'at10Min.cs',
            comparison: '>=',
            value: 15,
            description: 'Diff ≥ +15 CS at 10 minutes.',
          },
          {
            metric: 'at10Min.gold',
            comparison: '>=',
            value: 400,
            description: 'Diff ≥ +400 gold at 10 minutes.',
          },
        ],
      },
      {
        mustMeet: [
          {
            metric: 'at10Min.cs',
            comparison: '>=',
            value: 10,
            description: 'Diff ≥ +10 CS at 10 minutes.',
          },
          {
            metric: 'at10Min.gold',
            comparison: '>=',
            value: 600,
            description: 'Diff ≥ +600 gold at 10 minutes.',
          },
        ],
      },
    ],
    notes:
      'Award if either CS+gold are moderately high, or CS is modest but gold lead is bigger.',
  },
  {
    name: 'Late Game Carry',
    polarity: 'good',
    roleFocus: 'primary_role_diff',
    description: 'Excels after 25+ minutes with strong scaling.',
    anyOf: [
      {
        mustMeet: [
          {
            metric: 'at30Min.gold',
            comparison: '>=',
            value: 150,
            description: 'Diff ≥ +150 gold at 30 minutes.',
          },
          {
            metric: 'at30Min.xp',
            comparison: '>=',
            value: 200,
            description: 'Diff ≥ +200 XP at 30 minutes (if available).',
          },
        ],
      },
      {
        mustMeet: [
          {
            metric: 'at30Min.gold',
            comparison: '>=',
            value: 350,
            description: 'Diff ≥ +350 gold at 30 minutes.',
          },
        ],
      },
    ],
    notes: 'Award if combined gold+XP are solid, or gold alone is strong.',
  },
  {
    name: 'Tank Specialist',
    polarity: 'good',
    roleFocus: 'primary_role_diff',
    description: 'Frontline durability or survival advantage.',
    anyOf: [
      {
        mustMeet: [
          {
            metric: 'deathsPerMin',
            comparison: '<=',
            value: -0.02,
            description:
              'Player dies ≥0.02 fewer per minute (~≥0.5 fewer/game).',
          },
          {
            metric: 'damageTakenPerMin',
            comparison: '>=',
            value: 60,
            description: 'Also shows decent damage soak (≥ +60 per min).',
          },
        ],
      },
      {
        mustMeet: [
          {
            metric: 'damageTakenPerMin',
            comparison: '>=',
            value: 120,
            description: 'Player absorbs ≥120 more damage per minute.',
          },
          {
            metric: 'deathsPerMin',
            comparison: '<=',
            value: 0,
            description: 'Deaths not higher than opponent (≤ 0 diff).',
          },
        ],
      },
    ],
    notes:
      'Requires lower deaths with decent soak, or high soak without elevated deaths.',
  },
  {
    name: 'Tower Destroyer',
    polarity: 'good',
    roleFocus: 'primary_role_diff',
    description: 'High structural pressure via plates and towers.',
    anyOf: [
      {
        mustMeet: [
          {
            metric: 'objectiveParticipation.turretPlates.rate',
            comparison: '>=',
            value: 7,
            description:
              'Diff ≥ +7 percentage points in turret plate participation.',
          },
          {
            metric: 'objectiveParticipation.towers.rate',
            comparison: '>=',
            value: 7,
            description: 'Diff ≥ +7 percentage points in tower participation.',
          },
        ],
      },
      {
        mustMeet: [
          {
            metric: 'objectiveParticipation.turretPlates.rate',
            comparison: '>=',
            value: 10,
            description:
              'Diff ≥ +10 percentage points in turret plate participation.',
          },
        ],
      },
      {
        mustMeet: [
          {
            metric: 'objectiveParticipation.towers.rate',
            comparison: '>=',
            value: 10,
            description: 'Diff ≥ +10 percentage points in tower participation.',
          },
        ],
      },
    ],
  },
  {
    name: 'Damage Dealer',
    polarity: 'good',
    roleFocus: 'primary_role_diff',
    description: 'Higher damage per minute than lane opponent.',
    anyOf: [
      {
        mustMeet: [
          {
            metric: 'damageDealtPerMin',
            comparison: '>=',
            value: 80,
            description: 'Diff ≥ +80 damage per minute.',
          },
        ],
      },
      {
        mustMeet: [
          {
            metric: 'damageDealtPerMin',
            comparison: '>=',
            value: 60,
            description: 'Diff ≥ +60 damage per minute.',
          },
          {
            metric: 'deathsPerMin',
            comparison: '<=',
            value: -0.01,
            description: 'Deaths kept lower (≤ -0.01 per min).',
          },
        ],
      },
    ],
  },
  {
    name: 'Gold Farmer',
    polarity: 'good',
    roleFocus: 'primary_role_diff',
    description: 'Superior farming efficiency.',
    anyOf: [
      {
        mustMeet: [
          {
            metric: 'csPerMin',
            comparison: '>=',
            value: 0.25,
            description: 'Diff ≥ +0.25 CS per minute (~+7.5 CS over 30m).',
          },
          {
            metric: 'goldPerMin',
            comparison: '>=',
            value: 20,
            description: 'Diff ≥ +20 gold per minute.',
          },
        ],
      },
      {
        mustMeet: [
          {
            metric: 'csPerMin',
            comparison: '>=',
            value: 0.2,
            description: 'Diff ≥ +0.2 CS per minute (~+6 CS over 30m).',
          },
          {
            metric: 'goldPerMin',
            comparison: '>=',
            value: 30,
            description: 'Diff ≥ +30 gold per minute.',
          },
        ],
      },
    ],
  },
  {
    name: 'Kill Specialist',
    polarity: 'good',
    roleFocus: 'primary_role_diff',
    description: 'High kill pressure with efficient deaths.',
    anyOf: [
      {
        mustMeet: [
          {
            metric: 'killsPerMin',
            comparison: '>=',
            value: 0.03,
            description: 'Diff ≥ +0.03 kills per minute (~+1.0 kills/game).',
          },
        ],
      },
      {
        mustMeet: [
          {
            metric: 'killsPerMin',
            comparison: '>=',
            value: 0.02,
            description: 'Diff ≥ +0.02 kills per minute (~+0.6 kills/game).',
          },
          {
            metric: 'deathsPerMin',
            comparison: '<=',
            value: -0.02,
            description: 'Diff ≤ -0.02 deaths per minute (~≥0.5 fewer/game).',
          },
        ],
      },
    ],
  },
  {
    name: 'Bloodthirst',
    polarity: 'neutral',
    roleFocus: 'primary_role_diff',
    description: 'High aggression with both kills and deaths.',
    mustMeet: [
      {
        metric: 'killsPerMin',
        comparison: '>=',
        value: 0.02,
        description: 'Diff ≥ +0.02 kills per minute (~+0.6 kills/game).',
      },
      {
        metric: 'damageDealtPerMin',
        comparison: '>=',
        value: 50,
        description: 'Diff ≥ +50 damage per minute.',
      },
      {
        metric: 'deathsPerMin',
        comparison: '>=',
        value: 0.015,
        description: 'Diff ≥ +0.015 deaths per minute (~+0.45 deaths/game).',
      },
    ],
    notes:
      'Represents aggressive playstyle with high risk/reward - more kills and damage but also more deaths.',
  },
  {
    name: 'Void Hunter',
    polarity: 'good',
    roleFocus: 'primary_role_diff',
    description: 'Controls Voidgrubs and Rift Herald.',
    mustMeet: [
      {
        metric: 'objectiveParticipation.grubs.rate',
        comparison: '>=',
        value: 10,
        description: 'Diff ≥ +10 percentage points in Voidgrubs participation.',
      },
      {
        metric: 'objectiveParticipation.herald.rate',
        comparison: '>=',
        value: 10,
        description: 'Diff ≥ +10 percentage points in Herald participation.',
      },
    ],
  },
  {
    name: 'Team Player',
    polarity: 'good',
    roleFocus: 'primary_role_diff',
    description: 'Strong assist contribution with safe play.',
    preferNonUtility: true,
    mustMeet: [
      {
        metric: 'assistsPerMin',
        comparison: '>=',
        value: 0.05,
        description: 'Diff ≥ +0.05 assists per minute (~+1.5 assists/30m).',
      },
      {
        metric: 'deathsPerMin',
        comparison: '<=',
        value: -0.01,
        description: 'Diff ≤ -0.01 deaths per minute.',
      },
    ],
  },
  {
    name: 'Level Advantage',
    polarity: 'good',
    roleFocus: 'primary_role_diff',
    description: 'Level lead maintained at 15 or 20 minutes.',
    anyOf: [
      {
        mustMeet: [
          {
            metric: 'at15Min.level',
            comparison: '>=',
            value: 1,
            description: 'Diff ≥ +1 level at 15 minutes.',
          },
        ],
      },
      {
        mustMeet: [
          {
            metric: 'at20Min.level',
            comparison: '>=',
            value: 1,
            description: 'Diff ≥ +1 level at 20 minutes.',
          },
        ],
      },
    ],
  },
  {
    name: 'Consistent Performer',
    polarity: 'good',
    roleFocus: 'absolute_value',
    description: 'Low variance across percentile stats.',
    requires: ['percentile_stats'],
    notes:
      'Only award if percentile spreads (p90 - p50) are small across kills, deaths, assists, CS (e.g., <3).',
  },
  {
    name: 'High Win Rate Champion',
    polarity: 'good',
    roleFocus: 'absolute_value',
    description: 'Outstanding win rate over meaningful sample.',
    mustMeet: [
      {
        metric: 'win_rate_pct_estimate',
        comparison: '>=',
        value: 0.65,
        description: 'Absolute win rate ≥ 65%.',
      },
    ],
    minGames: 20,
    notes: 'Requires at least 20 games for reliability.',
  },
  {
    name: 'Atakhan Slayer',
    polarity: 'good',
    roleFocus: 'primary_role_diff',
    description: 'Secures Atakhan more often than opponents.',
    mustMeet: [
      {
        metric: 'objectiveParticipation.atakhan.rate',
        comparison: '>=',
        value: 30,
        description: 'Diff ≥ +30 percentage points in Atakhan participation.',
      },
    ],
  },
  {
    name: 'Experience Hoarder',
    polarity: 'good',
    roleFocus: 'primary_role_diff',
    description: 'Large XP leads through mid game.',
    mustMeet: [
      {
        metric: 'at15Min.xp',
        comparison: '>=',
        value: 500,
        description: 'Diff ≥ +500 XP at 15 minutes.',
      },
      {
        metric: 'at20Min.xp',
        comparison: '>=',
        value: 700,
        description: 'Diff ≥ +700 XP at 20 minutes.',
      },
    ],
  },
  {
    name: 'Mid Game Specialist',
    polarity: 'good',
    roleFocus: 'primary_role_diff',
    description: 'Momentum spike around 20 minutes.',
    mustMeet: [
      {
        metric: 'at15Min.gold',
        comparison: 'abs<=',
        value: 200,
        description:
          'Within ±200 gold at 15 minutes (diff between -200 and +200).',
      },
      {
        metric: 'at20Min.gold',
        comparison: '>=',
        value: 400,
        description: 'Diff ≥ +400 gold at 20 minutes.',
      },
    ],
    notes: 'Corroborate with level advantages at 20 minutes when available.',
  },
  {
    name: 'Damage Sponge',
    polarity: 'good',
    roleFocus: 'primary_role_diff',
    description: 'Absorbs heavy damage while staying alive.',
    mustMeet: [
      {
        metric: 'damageTakenPerMin',
        comparison: '>=',
        value: 100,
        description: 'Diff ≥ +100 damage taken per minute.',
      },
      {
        metric: 'deathsPerMin',
        comparison: '<=',
        value: -0.02,
        description: 'Diff ≤ -0.02 deaths per minute (~≥0.5 fewer/game).',
      },
    ],
  },
  {
    name: 'Scaling Monster',
    polarity: 'good',
    roleFocus: 'primary_role_diff',
    description: 'Dominant late-game farming and gold.',
    mustMeet: [
      {
        metric: 'at30Min.gold',
        comparison: '>=',
        value: 500,
        description: 'Diff ≥ +500 gold at 30 minutes.',
      },
      {
        metric: 'at30Min.cs',
        comparison: '>=',
        value: 30,
        description: 'Diff ≥ +30 CS at 30 minutes.',
      },
    ],
    notes: 'Allow early deficits if late thresholds are met.',
  },
  {
    name: 'Early Game Struggles',
    polarity: 'bad',
    roleFocus: 'primary_role_diff',
    description: 'Large early CS and gold deficits.',
    excludeRoles: ['UTILITY'],
    mustMeet: [
      {
        metric: 'at10Min.cs',
        comparison: '<=',
        value: -15,
        description: 'Diff ≤ -15 CS at 10 minutes.',
      },
      {
        metric: 'at10Min.gold',
        comparison: '<=',
        value: -400,
        description: 'Diff ≤ -400 gold at 10 minutes.',
      },
    ],
  },
  {
    name: 'Objective Neglect',
    polarity: 'bad',
    roleFocus: 'primary_role_diff',
    description: 'Low participation in early neutral objectives.',
    mustMeet: [
      {
        metric: 'objectiveParticipation.grubs.rate',
        comparison: '<=',
        value: -10,
        description: 'Diff ≤ -10 percentage points in Voidgrubs participation.',
      },
      {
        metric: 'objectiveParticipation.herald.rate',
        comparison: '<=',
        value: -10,
        description: 'Diff ≤ -10 percentage points in Herald participation.',
      },
    ],
  },
  {
    name: 'Damage Output Gap',
    polarity: 'bad',
    roleFocus: 'primary_role_diff',
    description: 'Player deals significantly less damage.',
    mustMeet: [
      {
        metric: 'damageDealtPerMin',
        comparison: '<=',
        value: -100,
        description: 'Diff ≤ -100 damage per minute.',
      },
    ],
  },
  {
    name: 'Farm Efficiency Gap',
    polarity: 'bad',
    roleFocus: 'primary_role_diff',
    description: 'Behind in CS and gold income.',
    mustMeet: [
      {
        metric: 'csPerMin',
        comparison: '<=',
        value: -0.3,
        description: 'Diff ≤ -0.3 CS per minute (~-9 CS over 30m).',
      },
      {
        metric: 'goldPerMin',
        comparison: '<=',
        value: -25,
        description: 'Diff ≤ -25 gold per minute.',
      },
    ],
  },
  {
    name: 'Tower Pressure Gap',
    polarity: 'bad',
    roleFocus: 'primary_role_diff',
    description: 'Lower structural pressure than opponents.',
    mustMeet: [
      {
        metric: 'objectiveParticipation.turretPlates.rate',
        comparison: '<=',
        value: -10,
        description:
          'Diff ≤ -10 percentage points in turret plate participation.',
      },
      {
        metric: 'objectiveParticipation.towers.rate',
        comparison: '<=',
        value: -10,
        description: 'Diff ≤ -10 percentage points in tower participation.',
      },
    ],
  },
  {
    name: 'Death Discipline',
    polarity: 'bad',
    roleFocus: 'primary_role_diff',
    description: 'Excess deaths relative to opponent.',
    mustMeet: [
      {
        metric: 'deathsPerMin',
        comparison: '>=',
        value: 0.03,
        description: 'Diff ≥ +0.03 deaths per minute (~≥0.9 deaths/game).',
      },
    ],
  },
  {
    name: 'Low-Value Deaths',
    polarity: 'bad',
    roleFocus: 'primary_role_diff',
    description: 'High deaths without soaking proportional damage.',
    mustMeet: [
      {
        metric: 'deathsPerMin',
        comparison: '>=',
        value: 0.02,
        description: 'Diff ≥ +0.02 deaths per minute (~≥0.6 deaths/game).',
      },
      {
        metric: 'damageTakenPerMin',
        comparison: '<=',
        value: 20,
        description: 'Diff ≤ +20 damage taken per minute (little extra soak).',
      },
    ],
  },
  {
    name: 'Mid Game Dip',
    polarity: 'bad',
    roleFocus: 'primary_role_diff',
    description: 'Loses momentum between 15 and 20 minutes.',
    mustMeet: [
      {
        metric: 'at15Min.gold',
        comparison: 'between',
        min: -150,
        max: 150,
        description: 'Diff within ±150 gold at 15 minutes.',
      },
      {
        metric: 'at20Min.gold',
        comparison: '<=',
        value: -300,
        description: 'Diff ≤ -300 gold at 20 minutes.',
      },
    ],
  },
  {
    name: 'Scaling Issues',
    polarity: 'bad',
    roleFocus: 'primary_role_diff',
    description: 'Fails to scale into late game despite even early game.',
    mustMeet: [
      {
        metric: 'at10Min.gold',
        comparison: '>',
        value: -200,
        description:
          'Early gold diff better than -200 (not heavily behind early).',
      },
      {
        metric: 'at10Min.cs',
        comparison: '>',
        value: -10,
        description:
          'Early CS diff better than -10 (not heavily behind early).',
      },
    ],
    anyOf: [
      {
        mustMeet: [
          {
            metric: 'at30Min.gold',
            comparison: '<=',
            value: -400,
            description: 'Diff ≤ -400 gold at 30 minutes.',
          },
        ],
      },
      {
        mustMeet: [
          {
            metric: 'at30Min.cs',
            comparison: '<=',
            value: -25,
            description: 'Diff ≤ -25 CS at 30 minutes.',
          },
        ],
      },
    ],
    notes: 'Ensure late deficits exist while early game was roughly even.',
  },
  {
    name: 'Team Contribution Gap',
    polarity: 'bad',
    roleFocus: 'primary_role_diff',
    description: 'Low assist contribution with higher deaths.',
    preferNonUtility: true,
    mustMeet: [
      {
        metric: 'assistsPerMin',
        comparison: '<=',
        value: -0.07,
        description: 'Diff ≤ -0.07 assists per minute (~-2.1 assists/30m).',
      },
      {
        metric: 'deathsPerMin',
        comparison: '>=',
        value: 0.01,
        description: 'Diff ≥ +0.01 deaths per minute (~≥0.3 deaths/game).',
      },
    ],
  },
  {
    name: 'Level Tempo Lag',
    polarity: 'bad',
    roleFocus: 'primary_role_diff',
    description: 'Behind in levels at key timings.',
    mustMeet: [
      {
        metric: 'at15Min.level',
        comparison: '<=',
        value: -1,
        description: 'Diff ≤ -1 level at 15 minutes.',
      },
      {
        metric: 'at20Min.level',
        comparison: '<=',
        value: -1,
        description: 'Diff ≤ -1 level at 20 minutes.',
      },
    ],
  },
  {
    name: 'Experience Gap',
    polarity: 'bad',
    roleFocus: 'primary_role_diff',
    description: 'Large XP deficits through mid game.',
    mustMeet: [
      {
        metric: 'at15Min.xp',
        comparison: '<=',
        value: -500,
        description: 'Diff ≤ -500 XP at 15 minutes.',
      },
      {
        metric: 'at20Min.xp',
        comparison: '<=',
        value: -700,
        description: 'Diff ≤ -700 XP at 20 minutes.',
      },
    ],
  },
  {
    name: 'Vision Improvement Needed',
    polarity: 'bad',
    roleFocus: 'primary_role_diff',
    description: 'Vision control behind lane opponent.',
    mustMeet: [
      {
        metric: 'visionScorePerMin',
        comparison: '<=',
        value: -0.1,
        thresholdByRole: { UTILITY: -0.25 },
        description: 'Diff ≤ -0.10 for non-UTILITY; ≤ -0.25 for UTILITY.',
      },
    ],
  },
];

type ConditionStatus = 'pass' | 'fail' | 'unknown';

type ConditionEvaluation = {
  metric: string;
  diff: number | null;
  comparison: string;
  threshold: string;
  status: ConditionStatus;
  detail: string;
  description?: string;
};

type BadgeEligibilityReportEntry = {
  name: string;
  polarity: 'good' | 'bad' | 'neutral';
  status: ConditionStatus;
  summary: string;
  metrics: ConditionEvaluation[];
  notes?: string;
};

const ROLE_FIELD_CANDIDATES = [
  'position',
  'role',
  'roleBucket',
  'teamPosition',
];
const GAME_FIELD_CANDIDATES = [
  'games',
  'totalGames',
  'matchCount',
  'matches',
  'rowsCount',
  'rows_count',
];

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function getGamesPlayed(row?: Record<string, unknown>): number | null {
  if (!row) return null;
  for (const key of GAME_FIELD_CANDIDATES) {
    const value = toNumber(row[key]);
    if (value != null) return value;
  }
  return null;
}

function findRoleRow(
  rows: Array<Record<string, unknown>>,
  role: string,
): Record<string, unknown> | undefined {
  return rows.find((row) => {
    for (const key of ROLE_FIELD_CANDIDATES) {
      const value = row[key];
      if (typeof value === 'string' && value.toUpperCase() === role) {
        return true;
      }
    }
    return false;
  });
}

function getDiffValue(
  stats: Record<string, unknown> | undefined,
  path: string,
): number | null {
  if (!stats) return null;
  const parts = path.split('.');
  let current: unknown = stats;
  for (const part of parts) {
    if (
      current &&
      typeof current === 'object' &&
      !Array.isArray(current) &&
      part in (current as Record<string, unknown>)
    ) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return null;
    }
  }
  return typeof current === 'number' && Number.isFinite(current)
    ? (current as number)
    : null;
}

function formatDiff(value: number | null): string {
  if (value === null) return 'N/A';
  const abs = Math.abs(value);
  const decimals = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  let rounded = Number(value.toFixed(decimals));
  if (Object.is(rounded, -0)) rounded = 0;
  const base = `${rounded > 0 ? '+' : rounded < 0 ? '' : ''}${rounded.toFixed(decimals)}`;
  if (Math.abs(value) <= 1) {
    let percent = Number((value * 100).toFixed(1));
    if (Object.is(percent, -0)) percent = 0;
    const percentStr = `${percent > 0 ? '+' : percent < 0 ? '' : ''}${percent.toFixed(1)}%`;
    return `${base} (${percentStr})`;
  }
  return base;
}

function mergeStatus(
  current: ConditionStatus,
  incoming: ConditionStatus,
): ConditionStatus {
  if (current === 'fail' || incoming === 'fail') return 'fail';
  if (current === 'unknown' || incoming === 'unknown') return 'unknown';
  return 'pass';
}

function evaluateCondition(
  condition: BadgeMetricCondition,
  stats: Record<string, unknown> | undefined,
  role: string | null,
): ConditionEvaluation {
  const diff = getDiffValue(stats, condition.metric);
  const comparison = condition.comparison ?? '>=';
  const roleAdjustedThreshold =
    role && condition.thresholdByRole && condition.thresholdByRole[role];
  const thresholdNumber =
    typeof roleAdjustedThreshold === 'number'
      ? roleAdjustedThreshold
      : typeof condition.value === 'number'
        ? condition.value
        : null;

  let status: ConditionStatus = 'unknown';
  let thresholdText = 'N/A';
  let detail = 'Threshold not evaluated.';

  const diffText = formatDiff(diff);

  const failDetail = (threshold: string) =>
    `diff ${diffText} fails threshold ${threshold}`;
  const passDetail = (threshold: string) =>
    `diff ${diffText} meets/exceeds threshold ${threshold}`;

  switch (comparison) {
    case '>=': {
      if (diff === null || thresholdNumber === null) {
        status = 'unknown';
        thresholdText =
          thresholdNumber === null
            ? '>= N/A'
            : `>= ${formatDiff(thresholdNumber)}`;
        detail =
          diff === null ? 'Metric unavailable.' : 'Threshold value missing.';
        break;
      }
      thresholdText = `>= ${formatDiff(thresholdNumber)}`;
      status = diff >= thresholdNumber ? 'pass' : 'fail';
      detail =
        status === 'pass'
          ? passDetail(thresholdText)
          : failDetail(thresholdText);
      break;
    }
    case '<=': {
      if (diff === null || thresholdNumber === null) {
        status = 'unknown';
        thresholdText =
          thresholdNumber === null
            ? '<= N/A'
            : `<= ${formatDiff(thresholdNumber)}`;
        detail =
          diff === null ? 'Metric unavailable.' : 'Threshold value missing.';
        break;
      }
      thresholdText = `<= ${formatDiff(thresholdNumber)}`;
      status = diff <= thresholdNumber ? 'pass' : 'fail';
      detail =
        status === 'pass'
          ? passDetail(thresholdText)
          : failDetail(thresholdText);
      break;
    }
    case '>': {
      if (diff === null || thresholdNumber === null) {
        status = 'unknown';
        thresholdText =
          thresholdNumber === null
            ? '> N/A'
            : `> ${formatDiff(thresholdNumber)}`;
        detail =
          diff === null ? 'Metric unavailable.' : 'Threshold value missing.';
        break;
      }
      thresholdText = `> ${formatDiff(thresholdNumber)}`;
      status = diff > thresholdNumber ? 'pass' : 'fail';
      detail =
        status === 'pass'
          ? passDetail(thresholdText)
          : failDetail(thresholdText);
      break;
    }
    case 'between': {
      const minVal = condition.min;
      const maxVal = condition.max;
      const minNum = typeof minVal === 'number' ? minVal : null;
      const maxNum = typeof maxVal === 'number' ? maxVal : null;
      if (diff === null || minNum === null || maxNum === null) {
        thresholdText = `[${formatDiff(minNum)}, ${formatDiff(maxNum)}]`;
        status = 'unknown';
        detail =
          diff === null ? 'Metric unavailable.' : 'Range bounds missing.';
        break;
      }
      thresholdText = `[${formatDiff(minNum)}, ${formatDiff(maxNum)}]`;
      status = diff >= minNum && diff <= maxNum ? 'pass' : 'fail';
      detail =
        status === 'pass'
          ? passDetail(thresholdText)
          : failDetail(thresholdText);
      break;
    }
    case 'abs<=': {
      if (diff === null || thresholdNumber === null) {
        status = 'unknown';
        thresholdText = `|diff| <= ${formatDiff(thresholdNumber)}`;
        detail =
          diff === null ? 'Metric unavailable.' : 'Threshold value missing.';
        break;
      }
      thresholdText = `|diff| <= ${formatDiff(thresholdNumber)}`;
      status = Math.abs(diff) <= thresholdNumber ? 'pass' : 'fail';
      detail =
        status === 'pass'
          ? passDetail(thresholdText)
          : failDetail(thresholdText);
      break;
    }
    default: {
      thresholdText = 'N/A';
      status = 'unknown';
      detail = `Unsupported comparison operator: ${comparison}`;
      break;
    }
  }

  consola.debug(
    '[evaluateCondition]',
    JSON.stringify({
      metric: condition.metric,
      comparison,
      diff,
      threshold: thresholdText,
      status,
      detail,
    }),
  );

  return {
    metric: condition.metric,
    diff,
    comparison,
    threshold: thresholdText,
    status,
    detail,
    description: condition.description,
  };
}

function evaluateBranch(
  branch: BadgeThresholdBranch,
  stats: Record<string, unknown> | undefined,
  role: string | null,
  branchIndex: number,
): {
  status: ConditionStatus;
  metrics: ConditionEvaluation[];
  message?: string;
} {
  const metrics: ConditionEvaluation[] = [];
  let status: ConditionStatus = 'pass';
  const issues: string[] = [];

  for (const condition of branch.mustMeet) {
    const result = evaluateCondition(condition, stats, role);
    metrics.push({
      ...result,
      detail: `Branch ${branchIndex + 1}: ${result.detail}`,
    });
    status = mergeStatus(status, result.status);
    if (result.status !== 'pass') {
      issues.push(result.detail);
    }
  }

  const message =
    status === 'pass'
      ? undefined
      : `Branch ${branchIndex + 1} ${status === 'fail' ? 'failed' : 'inconclusive'}: ${issues.join(' ')}`;

  return { status, metrics, message };
}

function finalizeBadgeEntry(
  entry: BadgeThresholdEntry,
  status: ConditionStatus,
  summaryParts: string[],
  metrics: ConditionEvaluation[],
): BadgeEligibilityReportEntry {
  const summary =
    summaryParts.length > 0
      ? summaryParts.join(' ')
      : status === 'pass'
        ? 'All mandatory thresholds satisfied.'
        : status === 'unknown'
          ? 'Insufficient data to evaluate thresholds.'
          : 'Failed required thresholds.';

  return {
    name: entry.name,
    polarity: entry.polarity,
    status,
    summary,
    metrics,
    notes: entry.notes,
  };
}

type BadgeEvaluationContext = {
  primaryRole: string | null;
  primaryComparison?: RoleComparison;
  primaryPlayerRow?: Record<string, unknown>;
  comparisonsByRole: Map<string, RoleComparison>;
};

function evaluateBadgeEntry(
  entry: BadgeThresholdEntry,
  context: BadgeEvaluationContext,
): BadgeEligibilityReportEntry {
  const metrics: ConditionEvaluation[] = [];
  const summaryParts: string[] = [];
  let status: ConditionStatus = 'pass';

  switch (entry.roleFocus) {
    case 'primary_role_diff': {
      const role = context.primaryRole;
      const comparison = context.primaryComparison;
      if (!role || !comparison) {
        summaryParts.push('Primary role diff data unavailable.');
        status = 'unknown';
        return finalizeBadgeEntry(entry, status, summaryParts, metrics);
      }

      if (entry.excludeRoles?.includes(role)) {
        status = 'fail';
        summaryParts.push(`Primary role ${role} is excluded for this badge.`);
      }

      if (entry.minGames && status !== 'fail') {
        const games = getGamesPlayed(context.primaryPlayerRow);
        if (games == null) {
          status = mergeStatus(status, 'unknown');
          summaryParts.push(
            `Unable to verify minimum games requirement (need ≥ ${entry.minGames}).`,
          );
        } else if (games < entry.minGames) {
          status = 'fail';
          summaryParts.push(
            `Only ${games} games for primary role; require ≥ ${entry.minGames}.`,
          );
        }
      }

      if (entry.requires?.length && status !== 'fail') {
        status = mergeStatus(status, 'unknown');
        summaryParts.push(
          `Requires additional data not provided: ${entry.requires.join(', ')}.`,
        );
      }

      if (entry.mustMeet) {
        for (const condition of entry.mustMeet) {
          const result = evaluateCondition(
            condition,
            comparison.stats as Record<string, unknown>,
            role,
          );
          metrics.push(result);
          status = mergeStatus(status, result.status);
        }
      }

      if (entry.anyOf && entry.anyOf.length > 0) {
        const branchStatuses: ConditionStatus[] = [];
        const branchMessages: string[] = [];

        entry.anyOf.forEach((branch, index) => {
          const evaluation = evaluateBranch(
            branch,
            comparison.stats as Record<string, unknown>,
            role,
            index,
          );
          metrics.push(...evaluation.metrics);
          branchStatuses.push(evaluation.status);
          if (evaluation.status !== 'pass' && evaluation.message) {
            branchMessages.push(evaluation.message);
          }
        });

        let combined: ConditionStatus;
        if (branchStatuses.some((s) => s === 'pass')) combined = 'pass';
        else if (branchStatuses.some((s) => s === 'unknown'))
          combined = 'unknown';
        else combined = 'fail';

        status = mergeStatus(status, combined);

        if (combined === 'pass') {
          summaryParts.push('At least one optional branch met the thresholds.');
        } else if (combined === 'fail') {
          summaryParts.push('All optional branches failed their thresholds.');
        } else if (combined === 'unknown') {
          summaryParts.push(
            'Optional branch evaluation was inconclusive due to missing metrics.',
          );
        }

        if (branchMessages.length > 0) {
          summaryParts.push(...branchMessages);
        }
      }

      // Debug: list missing metric paths for this role and badge
      const missing = metrics
        .filter((m) => m.diff === null)
        .map((m) => m.metric);
      if (missing.length > 0) {
        const statsObj = comparison.stats as
          | Record<string, unknown>
          | undefined;
        const topLevelKeys =
          statsObj && typeof statsObj === 'object' ? Object.keys(statsObj) : [];
        const missingDetail = missing.map((path) => {
          const parts = path.split('.');
          let node: unknown = statsObj;
          const matched: string[] = [];
          let nextMissing: string | null = null;
          for (const part of parts) {
            if (
              node &&
              typeof node === 'object' &&
              !Array.isArray(node) &&
              part in (node as Record<string, unknown>)
            ) {
              matched.push(part);
              node = (node as Record<string, unknown>)[part];
            } else {
              nextMissing = part;
              break;
            }
          }
          return { path, matched: matched.join('.'), nextMissing };
        });
        consola.debug(
          '[badge-metrics-missing]',
          JSON.stringify({
            badge: entry.name,
            role,
            missing,
            topLevelKeys,
            missingDetail,
          }),
        );
      }

      if (entry.preferNonUtility && role === 'UTILITY' && status === 'pass') {
        summaryParts.push(
          'Note: This badge prefers non-UTILITY roles; confirm narrative fit.',
        );
      }

      if (summaryParts.length === 0) {
        summaryParts.push(
          'All mandatory thresholds satisfied for the primary role.',
        );
      }

      return finalizeBadgeEntry(entry, status, summaryParts, metrics);
    }

    case 'absolute_value':
      summaryParts.push(
        'Requires absolute player metrics not provided in this dataset. Skip unless additional data is supplied.',
      );
      return finalizeBadgeEntry(entry, 'unknown', summaryParts, metrics);

    case 'any_role_diff':
      summaryParts.push(
        'Requires evaluation across multiple roles (not precomputed in this prompt).',
      );
      return finalizeBadgeEntry(entry, 'unknown', summaryParts, metrics);

    default:
      summaryParts.push('Unsupported badge evaluation mode.');
      return finalizeBadgeEntry(entry, 'unknown', summaryParts, metrics);
  }
}

function buildBadgeEligibilityReport(
  thresholds: BadgeThresholdEntry[],
  comparisons: RoleComparison[],
  myStats: Array<Record<string, unknown>>,
  primaryRole: string | null,
): BadgeEligibilityReportEntry[] {
  const comparisonsByRole = new Map<string, RoleComparison>();
  for (const comparison of comparisons) {
    comparisonsByRole.set(comparison.position, comparison);
  }

  const primaryComparison = primaryRole
    ? comparisonsByRole.get(primaryRole)
    : undefined;

  const primaryPlayerRow = primaryRole
    ? findRoleRow(myStats, primaryRole)
    : undefined;

  const context: BadgeEvaluationContext = {
    primaryRole,
    primaryComparison,
    primaryPlayerRow,
    comparisonsByRole,
  };

  const result = thresholds.map((entry) => evaluateBadgeEntry(entry, context));
  const counts = result.reduce(
    (acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    },
    {} as Record<ConditionStatus, number>,
  );
  consola.debug(
    '[buildBadgeEligibilityReport]',
    JSON.stringify({
      primaryRole,
      primaryComparisonPresent: !!primaryComparison,
      entries: result.length,
      statusCounts: counts,
      sample: result
        .slice(0, 2)
        .map((r) => ({ name: r.name, status: r.status, summary: r.summary })),
    }),
  );

  return result;
}

function buildBadgeStatusSummary(report: BadgeEligibilityReportEntry[]): {
  allowedBadges: Array<{ name: string; polarity: 'good' | 'bad' | 'neutral' }>;
  blockedBadges: Array<{
    name: string;
    polarity: 'good' | 'bad' | 'neutral';
    summary: string;
  }>;
  unknownBadges: Array<{
    name: string;
    polarity: 'good' | 'bad' | 'neutral';
    summary: string;
  }>;
} {
  const allowedBadges = report
    .filter((entry) => entry.status === 'pass')
    .map((entry) => ({ name: entry.name, polarity: entry.polarity }));

  const blockedBadges = report
    .filter((entry) => entry.status === 'fail')
    .map((entry) => ({
      name: entry.name,
      polarity: entry.polarity,
      summary: entry.summary,
    }));

  const unknownBadges = report
    .filter((entry) => entry.status === 'unknown')
    .map((entry) => ({
      name: entry.name,
      polarity: entry.polarity,
      summary: entry.summary,
    }));

  consola.debug(
    '[buildBadgeStatusSummary]',
    JSON.stringify({
      allowedCount: allowedBadges.length,
      blockedCount: blockedBadges.length,
      unknownCount: unknownBadges.length,
      allowedBadges,
      blockedBadges: blockedBadges.slice(0, 3),
      unknownBadges: unknownBadges.slice(0, 3),
    }),
  );

  return { allowedBadges, blockedBadges, unknownBadges };
}

export function normalizeBadgesResponse(
  input: unknown,
): NormalizedBadgesResponse {
  const out: NormalizedBadgesResponse = { badges: [] };
  if (!input || typeof input !== 'object') return out;
  const anyObj = input as Record<string, unknown>;
  const badgesRaw = anyObj.badges;
  if (!Array.isArray(badgesRaw)) return out;

  const normalizePolarity = (
    title: string,
    val: unknown,
  ): 'good' | 'bad' | 'neutral' => {
    const s = String(val ?? '')
      .toLowerCase()
      .trim();
    if (s === 'good' || s === 'bad' || s === 'neutral')
      return s as 'good' | 'bad' | 'neutral';
    return negativeTitles.has(title) ? 'bad' : 'good';
  };

  const mapped = badgesRaw
    .map((b: unknown) => {
      const obj = (b ?? {}) as Record<string, unknown>;
      const title = String(obj.title ?? obj.name ?? '').trim();
      const description = String(obj.description ?? '').trim();
      const reason = String(obj.reason ?? obj.reasoning ?? '').trim();
      const polarity = normalizePolarity(title, obj.polarity);
      if (!title && !description && !reason) return null;
      return {
        title: title || 'Badge',
        description: description || '',
        reason: reason || '',
        polarity,
      } as NormalizedBadge;
    })
    .filter(Boolean) as NormalizedBadge[];

  out.badges = mapped;
  return out;
}

export function computeRoleWeights(stats: Array<Record<string, unknown>>): {
  weights: Record<string, number>;
  primaryRole: string | null;
} {
  const counts: Record<string, number> = {};
  let total = 0;
  for (const row of stats) {
    const role = String(
      row.position ?? row.role ?? row.roleBucket ?? 'UNKNOWN',
    );
    const rc = Number(row.rowsCount ?? row.games ?? row.totalGames ?? 0) || 0;
    counts[role] = (counts[role] ?? 0) + rc;
    total += rc;
  }
  const weights: Record<string, number> = {};
  let primaryRole: string | null = null;
  let best = Number.NEGATIVE_INFINITY;
  for (const [role, rc] of Object.entries(counts)) {
    const pct = total > 0 ? Math.round((rc / total) * 10000) / 100 : 0;
    weights[role] = pct;
    if (rc > best) {
      best = rc;
      primaryRole = role;
    }
  }
  return { weights, primaryRole };
}

export function buildBadgesPromptFromStats(
  myStats: Array<Record<string, unknown>>,
  enemyStats: Array<Record<string, unknown>>,
): string {
  const comparisons = compareRoleStats(myStats, enemyStats);

  const header =
    "You are RiftCoach's League of Legends badge generator. Analyze the player's per-role performance versus direct opponents and award 2–5 badges that best fit their playstyle.";

  const rules =
    "Rules:\n- STRICT: Only output badges whose `status` is \"pass\" in either the BADGE ELIGIBILITY REPORT or the ALLOWED/BLOCKED summary. Treat `fail` or `unknown` as hard exclusions.\n- If `allowedBadges` is empty, respond with {\"badges\": []}. Never invent new badge names.\n- The 'Badge Threshold Summary' JSON explains each metric threshold. Use it for interpretation but do not override the eligibility results.\n- Treat the player's most-weighted role strictly as the provided 'Primary Role'. Do NOT infer or vary it.\n- You may award badges for other roles only if evidence is strong, but never label them as most-weighted.\n- Prioritize badges only when stats clearly exceed the thresholds; avoid marginal differences.\n- Output MUST be ONLY valid JSON with one top-level key: badges.\n- `badges` must be an array of 1–5 objects. Each object MUST have exactly: title, description, reason, polarity.\n- polarity must be one of: good | bad | neutral.\n- For each badge, include at least one explicit numeric value sourced from the metrics that define the selected badge. Do NOT invent or reuse numbers from unrelated metrics.\n- Use the catalog `name` as the badge title (match casing exactly).\n- Write the `reason` field in a helpful coaching voice while remaining factual.\n- Respect logical consistency: positive metrics (gold, CS, etc.) turning negative indicate worse performance, not better.\n- Quote numeric evidence exactly as provided. Participation diffs are in decimal form (0.10 = +10 percentage points); 0.04 is only +4 percentage points and does NOT clear a 0.10 requirement.\n- If required data is missing for a badge (per JSON `requires` hints), skip that badge rather than guessing.";

  const formatHint =
    'Input data format:\n- statComparisons: Pre-computed differences between player and opponent stats by role. Each metric is player minus opponent.\n- POSITIVE differences mean the player is ahead. NEGATIVE differences mean the player is behind.\n- Use these diffs directly—do NOT recalculate raw stats.\n- Participation metrics (e.g., avg_grubs_participation) are proportions (0-1). A diff of 0.10 equals +10 percentage points.\n- Gold/CS/XP diffs are raw values (e.g., +500 gold is +500 more gold at that timestamp).';

  const weightsAndPrimary = computeRoleWeights(myStats);
  const roleWeights = weightsAndPrimary.weights;
  const primaryRoleLabel = weightsAndPrimary.primaryRole ?? 'UNKNOWN';
  const normalizedPrimaryRole =
    primaryRoleLabel && primaryRoleLabel !== 'UNKNOWN'
      ? primaryRoleLabel
      : null;

  const diffPrimer = [
    '- All listed thresholds already encode the required direction. Example: `<= -400` means the player must trail by at least 400.',
    '- `mustMeet` conditions are mandatory. All listed metrics in the group must pass.',
    '- `anyOf` provides alternate branches; the player needs to satisfy one full branch.',
    '- When a condition uses `thresholdByRole`, apply the override for that specific role (e.g., UTILITY).',
    '- Skip badges where required data (e.g., percentile stats, champion diversity) is unavailable.',
  ].join('\n');

  const badgeEligibilityReport = buildBadgeEligibilityReport(
    BADGE_THRESHOLD_SUMMARY,
    comparisons,
    myStats,
    normalizedPrimaryRole,
  );
  const badgeStatusSummary = buildBadgeStatusSummary(badgeEligibilityReport);

  const badgeRulesJson = JSON.stringify(BADGE_THRESHOLD_SUMMARY, null, 2);
  const eligibilityJson = JSON.stringify(badgeEligibilityReport, null, 2);
  const statusJson = JSON.stringify(badgeStatusSummary, null, 2);

  return [
    header,
    '',
    '=== ROLE CONTEXT ===',
    'Player Role Weights (% share by rowsCount):',
    JSON.stringify(roleWeights),
    `Primary Role (most-weighted): ${String(primaryRoleLabel)}`,
    '',
    rules,
    '',
    formatHint,
    '',
    '=== BADGE THRESHOLD SUMMARY (AUTHORITATIVE) ===',
    diffPrimer,
    badgeRulesJson,
    '',
    '=== BADGE ELIGIBILITY REPORT (precomputed) ===',
    eligibilityJson,
    '',
    '=== ALLOWED/BLOCKED BADGES SUMMARY ===',
    statusJson,
    'Only badges listed under `allowedBadges` may be emitted. If `allowedBadges` is empty, respond with an empty array.',
    '',
    '=== FULL BADGE CATALOG & INSTRUCTIONS (for narrative context) ===',
    BADGES_PROMPT.trim(),
    '',
    '=== STATISTICAL COMPARISONS (Player vs Opponents — player minus opponent diffs) ===',
    JSON.stringify(comparisons, null, 2),
  ].join('\n');
}

export async function invokeBadgesModel(prompt: string): Promise<{
  badges: Array<{
    title?: string;
    name?: string;
    description?: string;
    reason?: string;
    reasoning?: string;
    polarity?: string;
  }>;
}> {
  const sanitizedPrompt =
    prompt.includes('```') || prompt.includes('"""')
      ? `${prompt}

IMPORTANT: Respond with ONLY raw JSON (no explanations, no markdown, no code fences, no preambles).`
      : prompt;

  // Use OpenAI GPT-OSS chat-style payload
  const payload = {
    model: 'openai.gpt-oss-120b-1:0',
    messages: [
      {
        role: 'system',
        content:
          'You are RiftCoach’s badge generator. Respond ONLY with a valid JSON object of the form {"badges": [...]}. No preamble, no markdown, no code fences, no extra keys.',
      },
      {
        role: 'user',
        content: sanitizedPrompt,
      },
    ],
    max_completion_tokens: 1500,
    temperature: 0.2,
    top_p: 0.9,
    stream: false,
  };

  const command = new InvokeModelCommand({
    modelId: 'openai.gpt-oss-120b-1:0',
    contentType: 'application/json',
    body: JSON.stringify(payload),
  });

  const response = await bedrockClient.send(command);
  if (!response.body) throw new Error('No response body from Bedrock');
  const responseBody = JSON.parse(new TextDecoder().decode(response.body));
  const aiText =
    responseBody?.choices?.[0]?.message?.content ??
    responseBody?.outputs?.[0]?.text ??
    '{}';

  let cleanedText = String(aiText);

  consola.info('Raw AI response:', cleanedText);

  // Remove any code fences or language hints that may slip in
  cleanedText = cleanedText
    .replace(/```json[\s\S]*?```/gi, (m) => m.replace(/```json|```/gi, ''))
    .replace(/```[\s\S]*?```/gi, (m) => m.replace(/```/g, ''))
    .replace(/^\s*json\s*/i, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
    .trim();

  // Try parsing directly; if it fails, try extracting first JSON object or array
  const tryParse = (text: string): unknown | null => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };

  let parsed: unknown | null = tryParse(cleanedText);

  if (!parsed) {
    const firstBrace = cleanedText.indexOf('{');
    const lastBrace = cleanedText.lastIndexOf('}');
    const firstBracket = cleanedText.indexOf('[');
    const lastBracket = cleanedText.lastIndexOf(']');

    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      parsed = tryParse(cleanedText.slice(firstBrace, lastBrace + 1));
    }

    // If still not parsed, try array slice and wrap as badges
    if (
      !parsed &&
      firstBracket !== -1 &&
      lastBracket !== -1 &&
      lastBracket > firstBracket
    ) {
      const arrParsed = tryParse(
        cleanedText.slice(firstBracket, lastBracket + 1),
      );
      if (Array.isArray(arrParsed)) {
        parsed = { badges: arrParsed };
      }
    }
  }

  const hasBadgesProp = (val: unknown): val is { badges: unknown } =>
    typeof val === 'object' && val !== null && 'badges' in val;

  try {
    if (!parsed) throw new Error('Unable to parse AI response as JSON');

    let badgesArray: unknown[] | null = null;

    if (Array.isArray(parsed)) {
      badgesArray = parsed;
    } else if (hasBadgesProp(parsed)) {
      const b = (parsed as { badges: unknown }).badges;
      if (Array.isArray(b)) {
        badgesArray = b;
      }
    }

    if (!badgesArray) {
      throw new Error('Invalid badge structure');
    }

    consola.debug(
      '[invokeBadgesModel] parsed badges length',
      badgesArray.length,
    );

    return {
      badges: badgesArray as Array<{
        title?: string;
        name?: string;
        description?: string;
        reason?: string;
        reasoning?: string;
        polarity?: string;
      }>,
    };
  } catch (error) {
    consola.error('Error parsing AI response:', aiText);
    consola.error('Cleaned text:', cleanedText);
    consola.error('Parse error:', error);

    return {
      badges: [
        {
          title: 'Consistent Player',
          description: 'Shows steady performance across matches',
          reason: 'Fallback badge due to AI generation failure',
          polarity: 'neutral',
        },
        {
          title: 'Team Player',
          description: 'Contributes effectively to team objectives',
          reason: 'Fallback badge due to AI generation failure',
          polarity: 'neutral',
        },
      ],
    };
  }
}
