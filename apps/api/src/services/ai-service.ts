import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import chalk from 'chalk';
import { consola } from 'consola';
import { getCachedData, setCachedData } from './cache-utils.js';
import type {
  AIBadgeResult,
  CohortStats,
  EnhancedPlayerAnalysis,
  FormattedStatLine,
  PlaystyleStats,
  RoleStats,
  StatComparison,
} from './types.js';
import { BADGE_CATALOG } from './types.js';

const bedrockClient = new BedrockRuntimeClient({
  region: process.env.AWS_REGION || 'eu-west-1',
});

function normalizePercentish(v: number | null | undefined): number | null {
  if (v == null) return null;
  return v > 1 ? v / 100 : v;
}

function toDisplayPercent(v: number | null | undefined, digits = 1): string {
  if (v == null) return 'N/A';
  return `${(v * 100).toFixed(digits)}%`;
}

function calculateSignificance(
  percentageDifference: number,
): 'much_higher' | 'higher' | 'similar' | 'lower' | 'much_lower' {
  if (percentageDifference >= 25) return 'much_higher';
  if (percentageDifference >= 10) return 'higher';
  if (percentageDifference >= -10) return 'similar';
  if (percentageDifference >= -25) return 'lower';
  return 'much_lower';
}

function createStatComparison(
  playerValue: number | null,
  cohortValue: number | null,
  roleWeightedPlayerValue?: number | null,
  roleWeightedCohortValue?: number | null,
): StatComparison | null {
  if (playerValue === null || cohortValue === null || cohortValue === 0) {
    return null;
  }

  const percentageDifference =
    ((playerValue - cohortValue) / cohortValue) * 100;
  const isAboveAverage = playerValue > cohortValue;
  const significance = calculateSignificance(percentageDifference);

  return {
    value: playerValue,
    cohortAverage: cohortValue,
    percentageDifference: Math.round(percentageDifference * 100) / 100,
    isAboveAverage,
    significance,
    roleWeightedValue: roleWeightedPlayerValue || undefined,
    roleWeightedAverage: roleWeightedCohortValue || undefined,
  };
}

function calculateRoleWeights(
  roleDistribution: { [role: string]: number } | null,
): { [role: string]: number } {
  if (!roleDistribution) {
    return { ALL: 1.0 };
  }

  const weights: { [role: string]: number } = {};
  const totalPercentage = Object.values(roleDistribution).reduce(
    (sum, pct) => sum + pct,
    0,
  );

  for (const [role, percentage] of Object.entries(roleDistribution)) {
    weights[role] = percentage / totalPercentage;
  }

  return weights;
}

function getRoleWeightedValue(
  playerStats: PlaystyleStats,
  cohortStats: CohortStats,
  statName: keyof RoleStats,
  roleWeights: { [role: string]: number },
): { playerWeighted: number; cohortWeighted: number } | null {
  let playerWeightedSum = 0;
  let cohortWeightedSum = 0;
  let totalWeight = 0;

  for (const [role, weight] of Object.entries(roleWeights)) {
    if (role === 'ALL') continue;
    const p = playerStats.roleStats.find((rs) => rs.roleBucket === role);
    const c = cohortStats.roleStats.find((rs) => rs.roleBucket === role);
    if (!p || !c) continue;

    let pv = p[statName] as number | null;
    let cv = c[statName] as number | null;

    // Normalize percent-ish metrics to proportions
    const percentish: (keyof RoleStats)[] = [
      'kpMean',
      'winRate',
      'avgTeamDamagePct',
    ];
    if (percentish.includes(statName)) {
      pv = normalizePercentish(pv);
      cv = normalizePercentish(cv);
    }

    if (pv != null && cv != null) {
      playerWeightedSum += pv * weight;
      cohortWeightedSum += cv * weight;
      totalWeight += weight;
    }
  }

  if (totalWeight === 0) return null;
  return {
    playerWeighted: playerWeightedSum / totalWeight,
    cohortWeighted: cohortWeightedSum / totalWeight,
  };
}

function createEnhancedPlayerAnalysis(
  playerStats: PlaystyleStats,
  cohortStats: CohortStats,
): EnhancedPlayerAnalysis {
  const roleWeights = calculateRoleWeights(playerStats.roleDistribution);
  const sortedRoles = Object.entries(roleWeights)
    .filter(([role]) => role !== 'ALL')
    .sort(([, a], [, b]) => b - a);

  const primaryRole = sortedRoles[0]?.[0] || 'ALL';
  const secondaryRole = sortedRoles[1]?.[0];

  // Get role-weighted values for key stats
  const killParticipationWeighted = getRoleWeightedValue(
    playerStats,
    cohortStats,
    'kpMean',
    roleWeights,
  );
  const visionWeighted = getRoleWeightedValue(
    playerStats,
    cohortStats,
    'visPerMinMean',
    roleWeights,
  );
  const damageWeighted = getRoleWeightedValue(
    playerStats,
    cohortStats,
    'dpgMean',
    roleWeights,
  );

  const comparisons = {
    killParticipation: createStatComparison(
      normalizePercentish(playerStats.avgKillParticipation),
      normalizePercentish(cohortStats.seasonAvgKp),
      normalizePercentish(killParticipationWeighted?.playerWeighted ?? null),
      normalizePercentish(killParticipationWeighted?.cohortWeighted ?? null),
    ),
    visionScorePerMinute: createStatComparison(
      playerStats.avgVisionScorePerMinute,
      cohortStats.seasonAvgVisPerMin,
      visionWeighted?.playerWeighted,
      visionWeighted?.cohortWeighted,
    ),
    damagePerMinute: createStatComparison(
      playerStats.avgDamagePerMinute,
      cohortStats.seasonAvgDpg,
      damageWeighted?.playerWeighted,
      damageWeighted?.cohortWeighted,
    ),
    teamDamagePercent: createStatComparison(
      normalizePercentish(playerStats.avgTeamDamagePct),
      normalizePercentish(
        cohortStats.roleStats.find((rs) => rs.roleBucket === 'ALL')
          ?.avgTeamDamagePct ?? null,
      ),
    ),
    goldPerMinute: createStatComparison(
      playerStats.avgGoldPerMinute,
      cohortStats.roleStats.find((rs) => rs.roleBucket === 'ALL')
        ?.avgGoldPerMinute || null,
    ),
    csPerMinute: createStatComparison(
      playerStats.avgCsPerMinute,
      cohortStats.seasonAvgCsfull,
    ),
    winRate: createStatComparison(
      normalizePercentish(playerStats.winRate),
      normalizePercentish(cohortStats.seasonAvgWinRate),
    ),
    kda: createStatComparison(
      playerStats.avgKda,
      cohortStats.roleStats.find((rs) => rs.roleBucket === 'ALL')?.avgKda ||
        null,
    ),
    objectiveParticipation: createStatComparison(
      normalizePercentish(playerStats.avgObjectiveParticipation),
      normalizePercentish(cohortStats.seasonAvgObjParticipation),
    ),
    laningSurvivalRate: createStatComparison(
      normalizePercentish(playerStats.avgLaningSurvivalRate),
      normalizePercentish(cohortStats.seasonAvgLaningSurvivalRate),
    ),
    earlyGameDeaths: createStatComparison(
      playerStats.avgEarlyGameDeaths,
      cohortStats.seasonAvgEarlyGameDeaths,
    ),
    soloKills: createStatComparison(
      playerStats.avgSoloKills,
      cohortStats.roleStats.find((rs) => rs.roleBucket === 'ALL')
        ?.avgSoloKills || null,
    ),
    wardsCleared: createStatComparison(
      playerStats.avgWardsCleared,
      cohortStats.roleStats.find((rs) => rs.roleBucket === 'ALL')
        ?.avgWardsCleared || null,
    ),
    dragonParticipation: createStatComparison(
      normalizePercentish(playerStats.avgDragonParticipation),
      normalizePercentish(cohortStats.seasonAvgDrakeParticipation),
    ),
    baronParticipation: createStatComparison(
      normalizePercentish(playerStats.avgBaronParticipation),
      normalizePercentish(cohortStats.seasonAvgBaronParticipation),
    ),
    heraldParticipation: createStatComparison(
      normalizePercentish(playerStats.avgHeraldParticipation),
      normalizePercentish(cohortStats.seasonAvgHeraldParticipation),
    ),
  };

  // Create role-specific insights
  const roleSpecificInsights: {
    [role: string]: {
      gamesPlayed: number;
      percentage: number;
      keyStrengths: string[];
      keyWeaknesses: string[];
    };
  } = {};

  for (const [role, weight] of Object.entries(roleWeights)) {
    if (role === 'ALL' || weight < 0.05) continue; // Skip roles with less than 5% play time

    const playerRoleStats = playerStats.roleStats.find(
      (rs) => rs.roleBucket === role,
    );
    const cohortRoleStats = cohortStats.roleStats.find(
      (rs) => rs.roleBucket === role,
    );

    if (playerRoleStats && cohortRoleStats) {
      const keyStrengths: string[] = [];
      const keyWeaknesses: string[] = [];

      // Analyze key metrics for this role
      const roleComparisons = [
        {
          name: 'Kill Participation',
          player: playerRoleStats.kpMean,
          cohort: cohortRoleStats.kpMean,
        },
        {
          name: 'Vision Score/Min',
          player: playerRoleStats.visPerMinMean,
          cohort: cohortRoleStats.visPerMinMean,
        },
        {
          name: 'Damage/Min',
          player: playerRoleStats.dpgMean,
          cohort: cohortRoleStats.dpgMean,
        },
        {
          name: 'CS/Min',
          player: playerRoleStats.csfullMean,
          cohort: cohortRoleStats.csfullMean,
        },
        {
          name: 'Win Rate',
          player: playerRoleStats.winRate,
          cohort: cohortRoleStats.winRate,
        },
      ];

      for (const comp of roleComparisons) {
        if (comp.player !== null && comp.cohort !== null) {
          const diff = ((comp.player - comp.cohort) / comp.cohort) * 100;
          if (diff >= 15) {
            keyStrengths.push(`${comp.name} (+${diff.toFixed(1)}%)`);
          } else if (diff <= -15) {
            keyWeaknesses.push(`${comp.name} (${diff.toFixed(1)}%)`);
          }
        }
      }

      roleSpecificInsights[role] = {
        gamesPlayed: playerRoleStats.games,
        percentage: Math.round(weight * 100),
        keyStrengths,
        keyWeaknesses,
      };
    }
  }

  return {
    playerStats,
    cohortStats,
    roleWeights,
    primaryRole,
    secondaryRole,
    comparisons,
    roleSpecificInsights,
  };
}

function formatStatsForAI(analysis: EnhancedPlayerAnalysis): string[] {
  const formattedLines: string[] = [];

  // Get all roles except 'ALL' and sort by weight (highest first)
  const rolesByWeight = Object.entries(analysis.roleWeights)
    .filter(([role]) => role !== 'ALL')
    .sort(([, a], [, b]) => b - a);

  // Key stats to analyze per role
  const keyStats: Array<{
    statKey: keyof RoleStats;
    displayName: string;
    isPercentage?: boolean;
  }> = [
    {
      statKey: 'kpMean',
      displayName: 'Kill Participation',
      isPercentage: true,
    },
    { statKey: 'visPerMinMean', displayName: 'Vision Score/Min' },
    { statKey: 'dpgMean', displayName: 'Damage/Min' },
    { statKey: 'csfullMean', displayName: 'CS/Min' },
    { statKey: 'winRate', displayName: 'Win Rate', isPercentage: true },
    { statKey: 'avgKda', displayName: 'KDA' },
    {
      statKey: 'avgTeamDamagePct',
      displayName: 'Team Damage %',
      isPercentage: true,
    },
    { statKey: 'avgGoldPerMinute', displayName: 'Gold/Min' },
    { statKey: 'avgSoloKills', displayName: 'Solo Kills' },
    { statKey: 'avgWardsCleared', displayName: 'Wards Cleared' },
  ];

  // Process each role
  for (const [role, weight] of rolesByWeight) {
    if (weight < 0.05) continue; // Skip roles with less than 5% play time

    const playerRoleStats = analysis.playerStats.roleStats.find(
      (rs) => rs.roleBucket === role,
    );
    const cohortRoleStats = analysis.cohortStats.roleStats.find(
      (rs) => rs.roleBucket === role,
    );

    if (!playerRoleStats || !cohortRoleStats) continue;

    // Process each stat for this role
    for (const stat of keyStats) {
      const playerValue = playerRoleStats[stat.statKey] as number | null;
      const cohortValue = cohortRoleStats[stat.statKey] as number | null;

      if (playerValue === null || cohortValue === null || cohortValue === 0)
        continue;

      // For percent-ish metrics, compute on normalized proportions
      let pForMath = playerValue;
      let cForMath = cohortValue;
      if (stat.isPercentage) {
        pForMath = normalizePercentish(playerValue) || 0;
        cForMath = normalizePercentish(cohortValue) || 0;
      }
      const percentageDiff = ((pForMath - cForMath) / cForMath) * 100;
      const significance = calculateSignificance(percentageDiff);

      // Only include significant differences or high-weight roles
      if (Math.abs(percentageDiff) >= 10 || weight >= 0.3) {
        const playerDisplay = stat.isPercentage
          ? toDisplayPercent(pForMath)
          : pForMath.toFixed(2);
        const cohortDisplay = stat.isPercentage
          ? toDisplayPercent(cForMath)
          : cForMath.toFixed(2);

        formattedLines.push(
          `${stat.displayName}:${role} | ${playerDisplay} - ${cohortDisplay} | ${(weight * 100).toFixed(0)}% (${percentageDiff >= 0 ? '+' : ''}${percentageDiff.toFixed(1)}%, ${significance})`,
        );
      }
    }
  }

  // Add overall weighted averages for key metrics
  const overallStats = [
    {
      name: 'Overall Kill Participation',
      comparison: analysis.comparisons.killParticipation,
    },
    {
      name: 'Overall Vision Score/Min',
      comparison: analysis.comparisons.visionScorePerMinute,
    },
    {
      name: 'Overall Damage/Min',
      comparison: analysis.comparisons.damagePerMinute,
    },
    {
      name: 'Overall Win Rate',
      comparison: analysis.comparisons.winRate,
    },
  ];

  formattedLines.push(''); // Separator
  formattedLines.push('=== WEIGHTED OVERALL PERFORMANCE ===');

  for (const stat of overallStats) {
    if (
      stat.comparison &&
      Math.abs(stat.comparison.percentageDifference) >= 5
    ) {
      const weightedInfo =
        stat.comparison.roleWeightedValue && stat.comparison.roleWeightedAverage
          ? ` | Weighted: ${stat.comparison.roleWeightedValue.toFixed(2)} - ${stat.comparison.roleWeightedAverage.toFixed(2)}`
          : '';

      formattedLines.push(
        `${stat.name} | ${stat.comparison.value.toFixed(2)} - ${stat.comparison.cohortAverage.toFixed(2)} | (${stat.comparison.percentageDifference >= 0 ? '+' : ''}${stat.comparison.percentageDifference.toFixed(1)}%, ${stat.comparison.significance})${weightedInfo}`,
      );
    }
  }

  return formattedLines;
}

function createRoleSpecificInsights(
  analysis: EnhancedPlayerAnalysis,
): string[] {
  const insights: string[] = [];

  const rolesByWeight = Object.entries(analysis.roleWeights)
    .filter(([role]) => role !== 'ALL')
    .sort(([, a], [, b]) => b - a);

  insights.push('=== ROLE-SPECIFIC ANALYSIS ===');

  for (const [role, weight] of rolesByWeight) {
    if (weight < 0.05) continue;

    const roleInsight = analysis.roleSpecificInsights[role];
    if (!roleInsight) continue;

    insights.push(
      `\n${role.toUpperCase()} (${roleInsight.percentage}% of games, ${roleInsight.gamesPlayed} matches):`,
    );

    if (roleInsight.keyStrengths.length > 0) {
      insights.push(`  Strengths: ${roleInsight.keyStrengths.join(', ')}`);
    }

    if (roleInsight.keyWeaknesses.length > 0) {
      insights.push(`  Weaknesses: ${roleInsight.keyWeaknesses.join(', ')}`);
    }
  }

  return insights;
}

function buildEnhancedPlaystyleBadgePrompt(
  analysis: EnhancedPlayerAnalysis,
): string {
  // Generate formatted statistics for AI
  const formattedStats = formatStatsForAI(analysis);
  const roleInsights = createRoleSpecificInsights(analysis);

  return `You are an expert League of Legends analyst tasked with generating personalized playstyle badges for a player based on their performance data and cohort comparisons.

## CRITICAL STATISTICAL INTERPRETATIONS

**ALWAYS verify the logical consistency of your badge assignments:**

1. **High values are GOOD for:** Kill Participation, Vision Score/Min, Damage/Min, CS/Min, Win Rate, KDA, Team Damage %, Gold/Min, Solo Kills, Wards Cleared, Objective Participation, Laning Survival Rate
2. **Low values are GOOD for:** Early Game Deaths, Deaths Near Enemy Turret
3. **Context matters:** A "Defensive Bastion" should have LOW deaths and HIGH survival rates, not the opposite

## BADGE ASSIGNMENT RULES

**Before assigning any badge, verify:**
- The player's stats actually support the badge's theme
- There are no contradictory statistics (e.g., low survival + "Defensive" badge)
- The reasoning aligns with the statistical evidence
- Focus on role-weighted performance, not overall averages

## FORMATTED PLAYER STATISTICS

**Format:** <Stat>:<Role> | <Player Value> - <Cohort Average> | <Role Weight>% (<Percentage Difference>, <Significance>)

${formattedStats.join('\n')}

${roleInsights.join('\n')}

## COMMON BADGE PATTERNS

**Early Game Bully:** High CS@10, Gold/Min, Solo Kills + Low Early Deaths
**Teamfight Anchor:** High KP, Team Damage%, KDA + Low Deaths
**Objective Captain:** High Dragon/Baron/Herald Participation + High Win Rate
**Vision Controller:** High Vision Score/Min, Wards Cleared + Strategic impact
**Macro Farmer:** High CS/Min, Gold/Min + Consistent performance
**Skirmish Specialist:** High Solo Kills, Kills Near Enemy Turret + Aggressive stats
**Defensive Bastion:** HIGH Survival Rate, LOW Deaths, Kills Under Own Turret
**Objective Scout:** High Early Ward Clears, Scuttle Control + Vision impact
**Lane Survivor:** HIGH Laning Survival Rate, LOW Early Game Deaths
**Versatile Player:** Consistent performance across multiple roles

## AVAILABLE BADGES
${BADGE_CATALOG.map((badge) => `- **${badge.name}**: ${badge.focus}`).join('\n')}

## TASK
Analyze this player's performance using the formatted statistics above. Focus on role-weighted performance and ignore overall averages. Generate 2-4 badges that accurately reflect their playstyle.

**CRITICAL:** 
- Use the formatted statistics to understand actual performance vs cohort
- Pay attention to role weights - higher weight roles are more representative
- Double-check that your badge reasoning matches the actual statistics
- If a stat shows "lower" or "much_lower", it means the player performs WORSE than average

CRITICAL: You MUST respond with ONLY valid JSON. Do not include any explanatory text, introductions, or conclusions. Start your response immediately with the opening brace "{" and end with the closing brace "}".

Return your analysis as a JSON object with this exact structure:
{
  "badges": [
    {
      "name": "Badge Name",
      "description": "Brief description of what this badge represents for this player",
      "confidence": 85,
      "reasoning": "Specific statistical evidence supporting this badge (cite actual numbers from the formatted stats)"
    }
  ],
  "summary": "2-3 sentence overview of the player's overall playstyle and key characteristics",
  "strengths": ["List of 2-3 key strengths based on the data"],
  "improvements": ["List of 2-3 areas for improvement based on the data"]
}`;
}

function getStatInterpretation(
  statName: string,
  isAbove: boolean,
  significance: string,
): string {
  const interpretations: { [key: string]: { above: string; below: string } } = {
    killParticipation: {
      above: '→ Strong teamfighter',
      below: '→ Plays alone/splitpush style',
    },
    visionScorePerMinute: {
      above: '→ Good map awareness',
      below: '→ Poor vision control',
    },
    damagePerMinute: {
      above: '→ High damage output',
      below: '→ Low damage contribution',
    },
    earlyGameDeaths: {
      above: '→ Dies too much early (weakness)',
      below: '→ Survives early game well (strength)',
    },
    laningSurvivalRate: {
      above: '→ Survives lane well (strength)',
      below: '→ Dies frequently in lane (weakness)',
    },
    soloKills: {
      above: '→ Strong 1v1 player',
      below: '→ Avoids duels',
    },
    objectiveParticipation: {
      above: '→ Good at securing objectives',
      below: '→ Misses objectives',
    },
    winRate: {
      above: '→ Performs well overall',
      below: '→ Struggles to win games',
    },
    teamDamagePercent: {
      above: '→ High damage share',
      below: '→ Low damage share',
    },
    goldPerMinute: {
      above: '→ Good resource generation',
      below: '→ Poor resource generation',
    },
    csPerMinute: {
      above: '→ Good farming',
      below: '→ Poor farming',
    },
    kda: {
      above: '→ Good KDA ratio',
      below: '→ Poor KDA ratio',
    },
    wardsCleared: {
      above: '→ Good vision denial',
      below: '→ Poor vision denial',
    },
    dragonParticipation: {
      above: '→ Good at dragon fights',
      below: '→ Misses dragon fights',
    },
    baronParticipation: {
      above: '→ Good at baron fights',
      below: '→ Misses baron fights',
    },
    heraldParticipation: {
      above: '→ Good at herald fights',
      below: '→ Misses herald fights',
    },
  };

  const stat = interpretations[statName];
  if (!stat) return '';

  return isAbove ? stat.above : stat.below;
}

export function buildPlaystyleBadgePrompt(stats: PlaystyleStats): string {
  const statsForPrompt = {
    ...stats,
  };
  const statsJson = JSON.stringify(statsForPrompt, null, 2);
  const catalog = BADGE_CATALOG.map(
    (badge, idx) => `${idx + 1}. ${badge.name} – ${badge.focus}`,
  ).join('\n');

  return [
    "You are RiftCoach's playstyle scout. Review the aggregated ranked match metrics across all roles and pick the three badges that best describe the player's comprehensive playstyle.",
    'Badge catalog:',
    catalog,
    'Analysis guidelines:',
    '- Consider metrics across all roles the player has played, not just one specific role.',
    '- Pay special attention to new comprehensive metrics like laning survival rate, early game deaths, objective participation, and role distribution.',
    '- Prioritise badges where the relevant metrics clearly stand out versus typical player averages.',
    '- Use the roleDistribution data to understand if the player is versatile across multiple roles.',
    '- Consider survival metrics (avgLaningSurvivalRate, avgEarlyGameDeaths) for defensive playstyles.',
    '- Evaluate objective participation metrics (avgDragonParticipation, avgBaronParticipation, avgHeraldParticipation) for macro-focused playstyles.',
    '- Never fabricate stats; use only what is provided.',
    '- Prefer variety: avoid picking badges that describe the exact same behaviour unless the stats overwhelmingly point to a single archetype.',
    'Output JSON with this shape: {"badges": [{"name": string, "summary": string, "confidence": number, "supportingStats": string[]}], "notes": string }.',
    '- confidence is a 0-100 score based on how strongly the metrics support the badge.',
    '- supportingStats should reference specific metric names and values that justify the badge.',
    "- notes should explain any interesting patterns in the player's cross-role performance.",
    'Player comprehensive stats (JSON):',
    statsJson,
  ].join('\n\n');
}

export async function generateAIBadges(
  stats: PlaystyleStats,
  cohortStats?: CohortStats,
): Promise<AIBadgeResult> {
  try {
    let enhancedPrompt: string;

    if (cohortStats) {
      // Create enhanced analysis with proper comparisons
      const analysis = createEnhancedPlayerAnalysis(stats, cohortStats);
      enhancedPrompt = buildEnhancedPlaystyleBadgePrompt(analysis);
    } else {
      consola.warn('No cohort stats available for enhanced analysis');
      // Fallback to basic prompt if no cohort data
      enhancedPrompt = buildPlaystyleBadgePrompt(stats);
    }

    enhancedPrompt += `\n\nPlease analyze this player's performance and provide:
1. Top 3-5 most fitting badges from the catalog with confidence scores (0-100)
2. A brief summary of their playstyle
3. Key strengths (2-3 points)
4. Areas for improvement (2-3 points)

Respond in JSON format:
{
  "badges": [
    {
      "name": "Badge Name",
      "description": "Why this badge fits",
      "confidence": 85,
      "reasoning": "Specific stats that support this badge"
    }
  ],
  "summary": "Overall playstyle description",
  "strengths": ["Strength 1", "Strength 2"],
  "improvements": ["Improvement 1", "Improvement 2"]
}`;

    const payload = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 2000,
      messages: [
        {
          role: 'user',
          content: enhancedPrompt,
        },
      ],
    };

    const command = new InvokeModelCommand({
      modelId: 'anthropic.claude-3-haiku-20240307-v1:0', // Using Claude 3 Haiku for cost efficiency
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });

    consola.debug(chalk.blue('Invoking AI model for badge generation...'));
    const response = await bedrockClient.send(command);

    if (!response.body) {
      throw new Error('No response body from Bedrock');
    }

    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    const aiResponse = responseBody.content[0].text;

    // Parse the JSON response from the AI
    const result: AIBadgeResult = JSON.parse(aiResponse);

    consola.debug(chalk.green('AI badge generation completed successfully'));
    return result;
  } catch (error: unknown) {
    const err = error as Error;
    consola.error(chalk.red('Failed to generate AI badges:'), err.message);

    // Fallback response in case of AI failure
    return {
      badges: [
        {
          name: 'Consistent Player',
          description: 'Shows steady performance across matches',
          confidence: 50,
          reasoning: 'Fallback badge due to AI generation failure',
        },
      ],
      summary: 'Analysis unavailable due to technical issues',
      strengths: ['Plays regularly', 'Maintains consistent performance'],
      improvements: ['AI analysis temporarily unavailable'],
    };
  }
}

export async function getCachedAIBadges(
  stats: PlaystyleStats,
  cohortStats?: CohortStats,
  puuid?: string,
): Promise<AIBadgeResult> {
  if (!puuid) {
    // If no puuid provided, generate badges directly without caching
    return generateAIBadges(stats, cohortStats);
  }

  const cacheKey = `ai-results:${puuid}:season-2025`;

  try {
    // Try to get cached results first
    const cached = await getCachedData<AIBadgeResult>(cacheKey);
    if (cached) {
      consola.debug(chalk.green('Using cached AI badge results'));
      return cached;
    }

    // Generate new badges
    const badges = await generateAIBadges(stats, cohortStats);

    // Cache the results
    await setCachedData(cacheKey, badges);

    return badges;
  } catch (error: unknown) {
    const err = error as Error;
    consola.warn(
      chalk.yellow('Cache operation failed, generating badges directly:'),
      err.message,
    );
    return generateAIBadges(stats, cohortStats);
  }
}
