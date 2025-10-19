import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import {
  PlatformId,
  type RiotAPITypes,
  regionToCluster,
} from '@fightmegg/riot-api';
import { collections } from '@riftcoach/clients.mongodb';
import { type Platform, type Region, riot } from '@riftcoach/clients.riot';
import { queues } from '@riftcoach/queues';
import chalk from 'chalk';
import consola from 'consola';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import ms from 'ms';
import { v5 } from 'uuid';
import z from 'zod';
import { championInsights } from '../../aggregations/championInsights.js';
import { championMastery } from '../../aggregations/championMastery.js';
import { enemyStatsByRolePUUID } from '../../aggregations/enemyStatsByRolePUUID.js';
import { playerChampsByRole } from '../../aggregations/playerChampsByRole.js';
import { playerHeatmap } from '../../aggregations/playerHeatmap.js';
import { playerOverview } from '../../aggregations/playerOverview.js';
import { playerOverviewWithOpponents } from '../../aggregations/playerOverviewWithOpponents.js';
import { recentMatches } from '../../aggregations/recentMatches.js';
import { statsByRolePUUID } from '../../aggregations/statsByRolePUUID.js';
import { redis } from '../../clients/redis.js';
import { BADGES_PROMPT } from '../../prompts/badges.js';
import compareRoleStats from '../../utils/compare-role-stats.js';

const UUID_NAMESPACE = '76ac778b-c771-4136-8637-44c5faa11286';

// Normalize any AI response shape into the required { badges: [{ title, description, reason, polarity }] }
function normalizeBadgesResponse(input: unknown): {
  badges: Array<{
    title: string;
    description: string;
    reason: string;
    polarity: 'good' | 'bad' | 'neutral';
  }>;
} {
  const out: {
    badges: Array<{
      title: string;
      description: string;
      reason: string;
      polarity: 'good' | 'bad' | 'neutral';
    }>;
  } = { badges: [] };
  if (!input || typeof input !== 'object') return out;
  const anyObj = input as Record<string, unknown>;
  const badgesRaw = anyObj.badges;
  if (!Array.isArray(badgesRaw)) return out;

  const negativeTitles = new Set([
    'Vision Improvement Needed',
    'Early Game Struggles',
    'Objective Neglect',
    'Damage Output Gap',
    'Farm Efficiency Gap',
    'Tower Pressure Gap',
    'Death Discipline',
    'Positioning Cleanup',
    'Mid Game Dip',
    'Scaling Issues',
    'Team Contribution Gap',
    'Level Tempo Lag',
    'Experience Gap',
  ]);

  const normalizePolarity = (
    title: string,
    val: unknown,
  ): 'good' | 'bad' | 'neutral' => {
    const s = String(val ?? '')
      .toLowerCase()
      .trim();
    if (s === 'good' || s === 'bad' || s === 'neutral') return s as any;
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
      };
    })
    .filter(Boolean) as Array<{
    title: string;
    description: string;
    reason: string;
    polarity: 'good' | 'bad' | 'neutral';
  }>;
  out.badges = mapped;
  return out;
}

const accountMiddleware = createMiddleware<{
  Variables: {
    region: RiotAPITypes.LoLRegion;
    cluster: RiotAPITypes.Cluster;
    account: RiotAPITypes.Account.AccountDTO;
    summoner: RiotAPITypes.Summoner.SummonerDTO;
    internalId: string;
  };
}>(async (c, next) => {
  const tagName = c.req.param('tagName');
  const tagLine = c.req.param('tagLine');
  const accountCacheKey = `cache:accounts:${tagName}:${tagLine}:${c.var.region}`;

  if (!tagName || !tagLine) {
    return c.json(
      {
        message: 'Tag name and tag line are required',
      },
      400,
    );
  }

  let account: RiotAPITypes.Account.AccountDTO | null = null;

  const cachedAccountExists = await redis.exists(accountCacheKey);

  if (cachedAccountExists) {
    const cachedAccount = await redis.get(accountCacheKey);
    if (cachedAccount) {
      account = JSON.parse(cachedAccount);
    } else {
      account = await riot
        .getAccountByRiotId(c.var.cluster as Region, tagName, tagLine)
        .catch((error) => {
          console.error(error);
          return null;
        });
    }
  } else {
    account = await riot
      .getAccountByRiotId(c.var.cluster as Region, tagName, tagLine)
      .catch((error) => {
        console.error(error);
        return null;
      });
  }

  if (!account) {
    return c.json(
      {
        message: 'Account not found',
      },
      404,
    );
  }

  c.set('account', account);

  if (!cachedAccountExists) {
    await redis.set(accountCacheKey, JSON.stringify(account), 'EX', ms('1h'));
  }

  let summoner: RiotAPITypes.Summoner.SummonerDTO | null = null;

  const summonerCacheKey = `cache:summoners:${account.puuid}:${c.var.region}`;

  const cachedSummoner = await redis.get(summonerCacheKey);
  if (cachedSummoner) {
    summoner = JSON.parse(cachedSummoner);
  } else {
    summoner = await riot
      .summonerByPuuid(c.var.region as Platform, account.puuid)
      .catch((error) => {
        console.error(error);
        return null;
      });

    if (summoner) {
      await redis.set(
        summonerCacheKey,
        JSON.stringify(summoner),
        'EX',
        ms('1h'),
      );
    }
  }

  if (!summoner) {
    return c.json(
      {
        message: 'Summoner not found',
      },
      404,
    );
  }

  c.set('summoner', summoner);
  c.set('internalId', v5(account.puuid, UUID_NAMESPACE));
  await next();
});

const app = new Hono<{
  Variables: {
    region: RiotAPITypes.LoLRegion;
    cluster: RiotAPITypes.Cluster;
    account: RiotAPITypes.Account.AccountDTO;
    summoner: RiotAPITypes.Summoner.SummonerDTO;
    internalId: string;
  };
}>();

// Minimal Bedrock client scoped to this route file
const bedrockClient = new BedrockRuntimeClient({
  region: process.env.AWS_REGION || 'eu-west-1',
});

// Compute role weights and primary role from rowsCount
function computeRoleWeights(stats: Array<Record<string, unknown>>): {
  weights: Record<string, number>;
  primaryRole: string | null;
} {
  const counts: Record<string, number> = {};
  let total = 0;
  for (const row of stats) {
    const role = String(row.position ?? 'UNKNOWN');
    const rc = Number(row.rowsCount ?? 0) || 0;
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

// Build a concise, JSON-only prompt using player vs opponent role stats
function buildBadgesPromptFromStats(
  myStats: Array<Record<string, unknown>>,
  enemyStats: Array<Record<string, unknown>>,
): string {
  // Compute the differences using compareRoleStats for accurate comparisons
  const comparisons = compareRoleStats(myStats, enemyStats);

  const header =
    "You are RiftCoach's League of Legends badge generator. Analyze the player's per-role performance versus direct opponents and award 1–5 badges that best fit their playstyle.";

  const rules =
    "Rules:\n- Use the following badge catalog and instructions.\n- Treat the player's most-weighted role strictly as the provided 'Primary Role'. Do NOT infer or vary it.\n- You may award badges for other roles if evidence is strong, but never call other roles 'most-weighted'.\n- Prioritize badges only when stats clearly support them; avoid contradictory picks.\n- Output MUST be ONLY valid JSON with one top-level key: badges.\n- badges must be an array of 1–5 objects.\n- Each badge object MUST have keys exactly: title, description, reason, polarity.\n- polarity must be one of: good | bad | neutral\n- For each badge, the 'reason' MUST include at least one explicit numeric value from the metrics that define the selected badge. Cite numbers strictly from that badge’s AI instructions; do NOT pull in unrelated stats (e.g., gold/XP/timepoint metrics) unless the badge explicitly references them. Avoid generic words like 'higher' or 'lower' without numbers.\n- Use the catalog 'name' as the badge title.\n- CRITICAL REASONING STYLE: Write the 'reason' field in a conversational, engaging tone that feels like a coach talking to the player. Avoid robotic statistical reporting.\n- Include specific numbers but weave them into natural language that celebrates achievements or explains performance patterns.\n- GOOD reasoning example: 'You consistently outfarmed your lane opponents, with a +6.3 CS advantage at 10 minutes - that extra farming translates to real gold advantages that fuel your item spikes.'\n- BAD reasoning example: 'Player avgCSAt10 is 71.7 vs opponents 65.4 showing higher CS advantage.'\n- Make it personal and motivational while being factually accurate with the statistics.\n- CRITICAL: When stating comparisons, ensure logical consistency - if player has LOWER values in positive metrics (CS, gold, etc.), they are performing WORSE, not better.";

  const formatHint =
    "Input data format:\n- statComparisons: Pre-computed differences between player and opponent stats by role. Each role contains nested stats where numeric values represent the difference (player - opponent).\n- POSITIVE differences mean player is BETTER, NEGATIVE differences mean player is WORSE\n- Use these pre-computed differences directly - DO NOT manually calculate differences from raw stats\n- Example: if avgCSAt10 shows +6.3, the player averages 6.3 more CS at 10 minutes than opponents\n- Example: if avgGoldAt10 shows +265, the player averages 265 more gold at 10 minutes than opponents\n- Example: if deathsPerMin shows -0.05, the player dies 0.05 less per minute than opponents (BETTER)\n\nREASONING TONE GUIDELINES:\n- Address the player directly using 'you' and 'your'\n- Use encouraging language that highlights their strengths\n- Transform dry statistics into meaningful insights about their playstyle\n- Example transformations:\n  * 'avgCSAt10: +6.3' → 'You consistently outfarm your opponents early, securing an extra 6.3 CS by 10 minutes'\n  * 'goldPerMin: +0.45' → 'Your efficient farming translates to an extra 45 gold per minute advantage'\n  * 'visionScorePerMin: +0.4' → 'You light up the map with 40% more vision than your opponents'\n- Focus on what the numbers mean for their gameplay impact, not just the raw comparison.";

  const catalog = BADGES_PROMPT;

  const jsonOnly =
    'CRITICAL OUTPUT FORMAT:\n- Respond with ONLY valid JSON\n- NO reasoning chains, NO <reasoning> tags, NO explanations\n- NO markdown formatting, NO code blocks\n- Start immediately with \'{\' and end with \'}\'\n- Structure: { "badges": [{"title": "...", "description": "...", "reason": "...", "polarity": "good|bad|neutral"}] }\n- Must contain 1-5 badge objects\n- Each badge must have all four fields: title, description, reason, polarity';

  const weightsAndPrimary = computeRoleWeights(myStats);
  const roleWeights = weightsAndPrimary.weights;
  const primaryRole = weightsAndPrimary.primaryRole ?? 'UNKNOWN';

  return [
    header,
    '',
    'Player Role Weights (% by rowsCount):',
    JSON.stringify(roleWeights),
    '',
    `Primary Role (most-weighted): ${String(primaryRole)}`,
    '',
    rules,
    '',
    formatHint,
    '',
    'Badge Catalog & Instructions:',
    catalog,
    '',
    jsonOnly,
    '',
    'Statistical Comparisons (Player vs Opponents - Pre-computed Differences):',
    JSON.stringify(comparisons, null, 2),
  ].join('\n');
}

async function invokeBadgesModel(prompt: string): Promise<{
  badges: Array<{
    title?: string;
    name?: string;
    description?: string;
    reason?: string;
    reasoning?: string;
    polarity?: string;
  }>;
}> {
  // Mistral instruct models provide optimal results when
  // embedding the prompt into the following template:
  const instruction = `<s>[INST] ${prompt} [/INST]`;

  const payload = {
    prompt: instruction,
    max_tokens: 1500,
    temperature: 0.1,
    top_p: 0.9,
    top_k: 50,
  };

  const command = new InvokeModelCommand({
    modelId: 'mistral.mixtral-8x7b-instruct-v0:1',
    contentType: 'application/json',
    body: JSON.stringify(payload),
  });

  const response = await bedrockClient.send(command);
  if (!response.body) throw new Error('No response body from Bedrock');
  const responseBody = JSON.parse(new TextDecoder().decode(response.body));
  const aiText = responseBody.outputs?.[0]?.text || '{}';

  // Clean the response by removing reasoning chains and extracting JSON
  let cleanedText = aiText;

  // Remove reasoning tags if present
  cleanedText = cleanedText.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '');

  // Remove any text before the first { and after the last }
  const firstBrace = cleanedText.indexOf('{');
  const lastBrace = cleanedText.lastIndexOf('}');

  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleanedText = cleanedText.slice(firstBrace, lastBrace + 1);
  }

  // Ensure JSON-only
  try {
    const parsed = JSON.parse(cleanedText);
    // Validate structure
    if (
      parsed.badges &&
      Array.isArray(parsed.badges) &&
      parsed.badges.length >= 1 &&
      parsed.badges.length <= 5
    ) {
      return parsed;
    }
    throw new Error('Invalid badge structure');
  } catch (error) {
    consola.error('Error parsing AI response:', aiText);
    consola.error('Cleaned text:', cleanedText);
    consola.error('Parse error:', error);

    // Fallback minimal JSON
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

// AI Insights Generation Function
async function generateChampionInsights(
  championData: Array<{
    championId: number;
    championName: string;
    totalGames: number;
    winRate: number;
    recentWinRate: number;
    avgKda: number;
    consistencyScore: number;
    performanceTrend: unknown;
    roles: string[];
    daysSinceLastPlayed: number;
  }>,
): Promise<{
  summary: string;
  trends: Array<{
    type: 'improvement' | 'decline' | 'stable';
    metric: string;
    description: string;
    confidence: number;
  }>;
  recommendations: Array<{
    category: 'champion_pool' | 'playstyle' | 'focus_areas';
    title: string;
    description: string;
    priority: 'high' | 'medium' | 'low';
  }>;
  confidence: number;
}> {
  // Prepare data for AI analysis
  const topChampions = championData.slice(0, 5);
  const analysisData = {
    totalChampions: championData.length,
    topPerformers: topChampions.map((champ) => ({
      name: champ.championName,
      games: champ.totalGames,
      winRate: champ.winRate,
      recentWinRate: champ.recentWinRate,
      avgKda: champ.avgKda,
      consistencyScore: champ.consistencyScore,
      trends: champ.performanceTrend,
      roles: champ.roles,
      daysSinceLastPlayed: champ.daysSinceLastPlayed,
    })),
    overallStats: {
      totalGames: championData.reduce(
        (sum, champ) => sum + champ.totalGames,
        0,
      ),
      avgWinRate:
        championData.reduce(
          (sum, champ) => sum + champ.winRate * champ.totalGames,
          0,
        ) / championData.reduce((sum, champ) => sum + champ.totalGames, 0),
      avgKda:
        championData.reduce(
          (sum, champ) => sum + champ.avgKda * champ.totalGames,
          0,
        ) / championData.reduce((sum, champ) => sum + champ.totalGames, 0),
    },
  };

  const prompt = `Analyze this League of Legends player's champion performance data and provide insights:

${JSON.stringify(analysisData, null, 2)}

Based on this data, provide a JSON response with:
1. A brief summary of the player's champion performance
2. Performance trends (improvement/decline/stable) for key metrics
3. Actionable recommendations for champion pool, playstyle, and focus areas
4. Overall confidence score (0-100)

Focus on:
- Recent performance trends vs overall performance
- Champion diversity and specialization
- Consistency across different champions
- Areas for improvement based on the data

Respond with valid JSON only in this exact format:
{
  "summary": "Brief overview of player's champion performance",
  "trends": [
    {
      "type": "improvement|decline|stable",
      "metric": "metric name",
      "description": "trend description",
      "confidence": 85
    }
  ],
  "recommendations": [
    {
      "category": "champion_pool|playstyle|focus_areas",
      "title": "recommendation title",
      "description": "detailed recommendation",
      "priority": "high|medium|low"
    }
  ],
  "confidence": 85
}`;

  const instruction = `<s>[INST] ${prompt} [/INST]`;

  const payload = {
    prompt: instruction,
    max_tokens: 2000,
    temperature: 0.3,
    top_p: 0.9,
    top_k: 50,
  };

  const command = new InvokeModelCommand({
    modelId: 'mistral.mixtral-8x7b-instruct-v0:1',
    contentType: 'application/json',
    body: JSON.stringify(payload),
  });

  const response = await bedrockClient.send(command);
  if (!response.body) throw new Error('No response body from Bedrock');

  const responseBody = JSON.parse(new TextDecoder().decode(response.body));
  const aiText = responseBody.outputs?.[0]?.text || '{}';

  // Clean and parse the response
  let cleanedText = aiText;

  // Remove any text before the first { and after the last }
  const firstBrace = cleanedText.indexOf('{');
  const lastBrace = cleanedText.lastIndexOf('}');

  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleanedText = cleanedText.slice(firstBrace, lastBrace + 1);
  }

  try {
    const parsed = JSON.parse(cleanedText);

    // Validate and normalize the response
    return {
      summary: parsed.summary || 'Analysis of champion performance completed.',
      trends: Array.isArray(parsed.trends) ? parsed.trends.slice(0, 5) : [],
      recommendations: Array.isArray(parsed.recommendations)
        ? parsed.recommendations.slice(0, 4)
        : [],
      confidence: Math.min(Math.max(parsed.confidence || 75, 0), 100),
    };
  } catch (error) {
    consola.error('Error parsing AI insights response:', error);

    // Fallback response based on data analysis
    const fallbackInsights = generateFallbackInsights(championData);
    return fallbackInsights;
  }
}

// Fallback insights generation when AI fails
function generateFallbackInsights(
  championData: Array<{
    championName: string;
    totalGames: number;
    winRate: number;
    daysSinceLastPlayed: number;
  }>,
) {
  const topChamp = championData[0];
  const recentlyPlayed = championData.filter(
    (champ) => champ.daysSinceLastPlayed <= 7,
  );

  return {
    summary: `Analysis of ${championData.length} champions shows ${topChamp?.championName || 'your top champion'} as your strongest performer with ${topChamp?.winRate || 0}% win rate.`,
    trends: [
      {
        type: 'stable' as const,
        metric: 'Champion Performance',
        description: 'Consistent performance across your champion pool',
        confidence: 70,
      },
    ],
    recommendations: [
      {
        category: 'champion_pool' as const,
        title: 'Focus on Main Champions',
        description: `Continue playing ${topChamp?.championName || 'your best champions'} to maintain your current performance level.`,
        priority: 'medium' as const,
      },
    ],
    confidence: 70,
  };
}

const regionSchema = z.object({
  region: z.enum([
    PlatformId.BR1,
    PlatformId.EUNE1,
    PlatformId.EUW1,
    PlatformId.JP1,
    PlatformId.KR,
    PlatformId.LA1,
    PlatformId.LA2,
    PlatformId.NA1,
    PlatformId.ME1,
    PlatformId.OC1,
    PlatformId.RU,
    PlatformId.TR1,
    PlatformId.PH2,
    PlatformId.SG2,
    PlatformId.TH2,
    PlatformId.TW2,
    PlatformId.VN2,
  ]),
});

app.use(
  '/:region/*',
  createMiddleware(async (c, next) => {
    const region = c.req.param('region')?.toLowerCase() as
      | RiotAPITypes.LoLRegion
      | undefined;

    if (!region) {
      return c.json(
        {
          message: 'Region is required',
        },
        400,
      );
    }

    const result = regionSchema.safeParse({ region });

    if (!result.success) {
      return c.json(
        {
          message: 'Invalid region',
        },
        400,
      );
    }

    c.set('region', region);
    c.set('cluster', regionToCluster(region));
    await next();
  }),
);

app.get('/:region/:tagName/:tagLine', accountMiddleware, async (c) => {
  const summoner = c.var.summoner;
  return c.json({
    ...summoner,
    id: c.var.internalId,
  });
});

app.post('/:region/:tagName/:tagLine/rewind', accountMiddleware, async (c) => {
  const rewindId = c.var.internalId;
  await redis.set(`rewind:${rewindId}:matches`, 0);
  await redis.set(`rewind:${rewindId}:listing`, 1);
  await redis.set(`rewind:${rewindId}:total`, 0);
  await redis.set(`rewind:${rewindId}:status`, 'listing');
  await redis.set(`rewind:${rewindId}:processed`, 0);

  consola.info(chalk.blue(`Rewind ${rewindId} started`));

  queues[c.var.cluster].add(
    `list-matches-${c.var.account.puuid}-0`,
    {
      type: 'list-matches',
      puuid: c.var.account.puuid,
      start: 0,
      rewindId,
      region: c.var.region,
    },
    {
      delay: ms('1s'),
    },
  );

  // Add to visual queue (sorted by enqueue time)
  await redis.zadd(`rewind:queue:${c.var.cluster}`, Date.now(), rewindId);

  return c.json({
    rewindId,
  });
});

app.get('/:region/:tagName/:tagLine/rewind', accountMiddleware, async (c) => {
  const rewindId = c.var.internalId;
  const [matches, listing, status, total, processed] = await Promise.all([
    redis.get(`rewind:${rewindId}:matches`),
    redis.get(`rewind:${rewindId}:listing`),
    redis.get(`rewind:${rewindId}:status`),
    redis.get(`rewind:${rewindId}:total`),
    redis.get(`rewind:${rewindId}:processed`),
  ]);
  // Visual position from Redis zset (cluster-scoped)
  const queueKey = `rewind:queue:${c.var.cluster}`;
  const rank = await redis.zrank(queueKey, rewindId);
  const position = rank !== null ? Number(rank) + 1 : null;

  return c.json({
    rewindId,
    matches: Number(matches),
    listing: Number(listing),
    total: Number(total),
    processed: Number(processed),
    status,
    position,
  });
});

app.get('/:region/:tagName/:tagLine/badges', accountMiddleware, async (c) => {
  const account = c.var.account;
  const statsCacheKey = `cache:stats:${c.var.internalId}`;
  const aiCacheKey = `cache:ai-badges:${c.var.internalId}`;

  // Return cached AI badges if available
  const cachedAI = await redis.get(aiCacheKey);
  if (cachedAI) {
    try {
      const parsed = JSON.parse(cachedAI);
      const normalized = normalizeBadgesResponse(parsed);
      return c.json(normalized);
    } catch {
      // ignore and recompute
    }
  }

  // Load stats from cache or compute
  let myStats: Array<Record<string, unknown>> | null = null;
  let enemyStats: Array<Record<string, unknown>> | null = null;
  const cachedStats = await redis.get(statsCacheKey);
  if (cachedStats) {
    try {
      const parsed = JSON.parse(cachedStats);
      if (Array.isArray(parsed.myStats) && Array.isArray(parsed.enemyStats)) {
        myStats = parsed.myStats as Array<Record<string, unknown>>;
        enemyStats = parsed.enemyStats as Array<Record<string, unknown>>;
      }
    } catch {
      // fall through to recompute
    }
  }

  if (!myStats || !enemyStats) {
    const stats = await Promise.all([
      collections.matches.aggregate(statsByRolePUUID(account.puuid)).toArray(),
      collections.matches
        .aggregate(enemyStatsByRolePUUID(account.puuid))
        .toArray(),
    ]);
    myStats = stats[0] as Array<Record<string, unknown>>;
    enemyStats = stats[1] as Array<Record<string, unknown>>;
    await redis.set(
      statsCacheKey,
      JSON.stringify({ myStats, enemyStats }),
      'EX',
      ms('1d'),
    );
  }

  // Guard against missing stats before invoking AI
  if (!myStats || !enemyStats) {
    return c.json({ message: 'Failed to compute player/opponent stats' }, 500);
  }

  // Build prompt and invoke Bedrock
  try {
    const prompt = buildBadgesPromptFromStats(myStats, enemyStats);
    consola.info(
      chalk.blue(
        `Generating AI badges for ${account.gameName}#${account.tagLine}`,
      ),
    );
    const aiJson = await invokeBadgesModel(prompt);
    let normalized = normalizeBadgesResponse(aiJson);
    // Correct any AI text that mislabels the most-weighted role
    const pr = computeRoleWeights(myStats).primaryRole;
    if (pr) {
      const mr = String(pr);
      const fixText = (txt?: string): string => {
        if (!txt) return '';
        return txt
          .replace(
            /most[-\s]weighted role[:,]?\s*[A-Za-z ]+/gi,
            `most-weighted role, ${mr}`,
          )
          .replace(/primary role[:,]?\s*[A-Za-z ]+/gi, `primary role, ${mr}`)
          .replace(
            /most[-\s]played role[:,]?\s*[A-Za-z ]+/gi,
            `most-played role, ${mr}`,
          );
      };
      normalized = {
        badges: normalized.badges.map((b) => ({
          title: b.title,
          description: fixText(b.description),
          reason: fixText(b.reason),
          polarity: b.polarity || 'neutral',
        })),
      };
    }

    // Ensure each reason includes explicit numbers; otherwise append top diffs for primary role
    try {
      const comparisons = compareRoleStats(myStats, enemyStats);
      const roleKey = pr ? String(pr) : null;
      const roleEntry = roleKey
        ? (comparisons as any[]).find((c) => c.position === roleKey)
        : (comparisons as any[])[0];
      if (roleEntry && roleEntry.stats) {
        const flattenNumericDiffs = (
          obj: Record<string, unknown>,
          prefix = '',
        ): Array<{ path: string; diff: number }> => {
          const out: Array<{ path: string; diff: number }> = [];
          for (const [key, val] of Object.entries(obj)) {
            const path = prefix ? `${prefix}.${key}` : key;
            if (typeof val === 'number' && Number.isFinite(val)) {
              out.push({ path, diff: val });
            } else if (val && typeof val === 'object' && !Array.isArray(val)) {
              out.push(
                ...flattenNumericDiffs(val as Record<string, unknown>, path),
              );
            }
          }
          return out;
        };
        const getPath = (root: any, path: string): unknown =>
          path
            .split('.')
            .reduce(
              (acc: any, key: string) =>
                acc && typeof acc === 'object' ? (acc as any)[key] : undefined,
              root,
            );
        const getDiff = (paths: string[]): number | null => {
          for (const p of paths) {
            const v = getPath(roleEntry.stats, p);
            if (typeof v === 'number' && Number.isFinite(v)) return v as number;
          }
          return null;
        };

        // Apply threshold checks to prevent trivial or contradictory badges
        const primaryRole = pr ? String(pr) : 'UNKNOWN';
        const checks: Record<string, () => boolean> = {
          'Vision Expert': () => {
            const d = getDiff(['visionScorePerMin', 'vision_score_per_min']);
            if (d == null) return true;
            return (
              (primaryRole !== 'UTILITY' && d >= 0.35) ||
              (primaryRole === 'UTILITY' && d >= 0.5)
            );
          },
          'Vision Improvement Needed': () => {
            const d = getDiff(['visionScorePerMin', 'vision_score_per_min']);
            if (d == null) return true;
            return (
              (primaryRole !== 'UTILITY' && d <= -0.35) ||
              (primaryRole === 'UTILITY' && d <= -0.5)
            );
          },
          'Early Game Dominator': () => {
            if (primaryRole === 'UTILITY') return false;
            const cs = getDiff(['avg_cs_at10', 'avgCSAt10']);
            const gold = getDiff(['avg_gold_at10', 'avgGoldAt10']);
            if (cs == null || gold == null) return true;
            return cs >= 20 && gold >= 500;
          },
          'Early Game Struggles': () => {
            if (primaryRole === 'UTILITY') return false;
            const cs = getDiff(['avg_cs_at10', 'avgCSAt10']);
            const gold = getDiff(['avg_gold_at10', 'avgGoldAt10']);
            if (cs == null || gold == null) return true;
            return cs <= -15 && gold <= -400;
          },
          'Tower Destroyer': () => {
            const plates = getDiff(['avg_turret_plates_participation']);
            const towers = getDiff(['avg_towers_participation']);
            if (plates == null || towers == null) return true;
            return plates >= 0.1 && towers >= 0.1;
          },
          'Tower Pressure Gap': () => {
            const plates = getDiff(['avg_turret_plates_participation']);
            const towers = getDiff(['avg_towers_participation']);
            if (plates == null || towers == null) return true;
            return plates <= -0.1 && towers <= -0.1;
          },
          'Void Hunter': () => {
            const grubs = getDiff(['avg_grubs_participation']);
            const herald = getDiff(['avg_herald_participation']);
            if (grubs == null || herald == null) return true;
            return grubs >= 0.1 && herald >= 0.1;
          },
          'Objective Neglect': () => {
            const grubs = getDiff(['avg_grubs_participation']);
            const herald = getDiff(['avg_herald_participation']);
            if (grubs == null || herald == null) return true;
            return grubs <= -0.1 && herald <= -0.1;
          },
          'Damage Dealer': () => {
            const dpm = getDiff(['avg_dpm', 'avgDpm']);
            if (dpm == null) return true;
            return dpm >= 100;
          },
          'Damage Output Gap': () => {
            const dpm = getDiff(['avg_dpm', 'avgDpm']);
            if (dpm == null) return true;
            return dpm <= -100;
          },
          'Gold Farmer': () => {
            const cs = getDiff(['avg_cs_total', 'avgCSTotal']);
            const gpm = getDiff(['avg_gpm', 'avgGpm']);
            if (cs == null || gpm == null) return true;
            return cs >= 10 && gpm >= 25;
          },
          'Farm Efficiency Gap': () => {
            const cs = getDiff(['avg_cs_total', 'avgCSTotal']);
            const gpm = getDiff(['avg_gpm', 'avgGpm']);
            if (cs == null || gpm == null) return true;
            return cs <= -10 && gpm <= -25;
          },
          'Team Player': () => {
            const assists = getDiff(['avg_assists', 'avgAssists']);
            const deaths = getDiff(['avg_deaths', 'avgDeaths']);
            if (assists == null || deaths == null) return true;
            return assists >= 2.0 && deaths <= -0.5;
          },
          'Team Contribution Gap': () => {
            const assists = getDiff(['avg_assists', 'avgAssists']);
            const deaths = getDiff(['avg_deaths', 'avgDeaths']);
            if (assists == null || deaths == null) return true;
            return assists <= -2.0 && deaths >= 0.3;
          },
          'Level Advantage': () => {
            const l15 = getDiff(['avg_level_at15', 'avgLevelAt15']);
            const l20 = getDiff(['avg_level_at20', 'avgLevelAt20']);
            if (l15 == null || l20 == null) return true;
            return l15 >= 1.0 && l20 >= 1.0;
          },
          'Level Tempo Lag': () => {
            const l15 = getDiff(['avg_level_at15', 'avgLevelAt15']);
            const l20 = getDiff(['avg_level_at20', 'avgLevelAt20']);
            if (l15 == null || l20 == null) return true;
            return l15 <= -1.0 && l20 <= -1.0;
          },
          'Experience Hoarder': () => {
            const x15 = getDiff(['avg_xp_at15', 'avgXPAt15']);
            const x20 = getDiff(['avg_xp_at20', 'avgXPAt20']);
            if (x15 == null || x20 == null) return true;
            return x15 >= 500 && x20 >= 700;
          },
          'Experience Gap': () => {
            const x15 = getDiff(['avg_xp_at15', 'avgXPAt15']);
            const x20 = getDiff(['avg_xp_at20', 'avgXPAt20']);
            if (x15 == null || x20 == null) return true;
            return x15 <= -500 && x20 <= -700;
          },
          'Tank Specialist': () => {
            const deaths = getDiff(['avg_deaths', 'avgDeaths']);
            const dmgTaken = getDiff([
              'avg_dmg_taken_per_min',
              'avgDmgTakenPerMin',
            ]);
            if (deaths == null && dmgTaken == null) return true;
            return (
              (deaths != null && deaths <= -0.5) ||
              (dmgTaken != null && dmgTaken >= 40)
            );
          },
          'Positioning Cleanup': () => {
            const deaths = getDiff(['avg_deaths', 'avgDeaths']);
            const dmgTaken = getDiff([
              'avg_dmg_taken_per_min',
              'avgDmgTakenPerMin',
            ]);
            if (deaths == null || dmgTaken == null) return true;
            return deaths >= 0.5 && dmgTaken <= 20;
          },
          'Mid Game Specialist': () => {
            const g15 = getDiff(['avg_gold_at15', 'avgGoldAt15']);
            const g20 = getDiff(['avg_gold_at20', 'avgGoldAt20']);
            if (g15 == null || g20 == null) return true;
            return Math.abs(g15) <= 200 && g20 >= 400;
          },
          'Mid Game Dip': () => {
            const g15 = getDiff(['avg_gold_at15', 'avgGoldAt15']);
            const g20 = getDiff(['avg_gold_at20', 'avgGoldAt20']);
            if (g15 == null || g20 == null) return true;
            return Math.abs(g15) <= 150 && g20 <= -300;
          },
          'Late Game Carry': () => {
            const g30 = getDiff(['avg_gold_at30', 'avgGoldAt30']);
            if (g30 == null) return true;
            return g30 >= 200;
          },
          'Scaling Monster': () => {
            const g30 = getDiff(['avg_gold_at30', 'avgGoldAt30']);
            const cs30 = getDiff(['avg_cs_at30', 'avgCSAt30']);
            if (g30 == null || cs30 == null) return true;
            return g30 >= 500 && cs30 >= 30;
          },
        };

        const filtered = {
          badges: normalized.badges.filter((b) => {
            const fn = checks[b.title];
            return fn ? fn() : true;
          }),
        };
        if (filtered.badges.length > 0) {
          normalized = filtered;
        }

        // Append only badge-relevant numbers; skip unrelated metrics entirely
        const metricAliases: Record<string, string[]> = {
          visionScorePerMin: ['visionScorePerMin', 'vision_score_per_min'],
          avg_cs_at10: ['avg_cs_at10', 'avgCSAt10'],
          avg_gold_at10: ['avg_gold_at10', 'avgGoldAt10'],
          avg_turret_plates_participation: ['avg_turret_plates_participation'],
          avg_towers_participation: ['avg_towers_participation'],
          avg_grubs_participation: ['avg_grubs_participation'],
          avg_herald_participation: ['avg_herald_participation'],
          avg_drakes_participation: ['avg_drakes_participation'],
          avg_baron_participation: ['avg_baron_participation'],
          avg_atakhan_participation: ['avg_atakhan_participation'],
          avg_dpm: ['avg_dpm', 'avgDpm'],
          avg_cs_total: ['avg_cs_total', 'avgCSTotal'],
          avg_gpm: ['avg_gpm', 'avgGpm'],
          avg_assists: ['avg_assists', 'avgAssists'],
          avg_kills: ['avg_kills', 'avgKills'],
          avg_deaths: ['avg_deaths', 'avgDeaths'],
          avg_level_at15: ['avg_level_at15', 'avgLevelAt15'],
          avg_level_at20: ['avg_level_at20', 'avgLevelAt20'],
          avg_xp_at15: ['avg_xp_at15', 'avgXPAt15'],
          avg_xp_at20: ['avg_xp_at20', 'avgXPAt20'],
          avg_dmg_taken_per_min: ['avg_dmg_taken_per_min', 'avgDmgTakenPerMin'],
          avg_gold_at15: ['avg_gold_at15', 'avgGoldAt15'],
          avg_gold_at20: ['avg_gold_at20', 'avgGoldAt20'],
          avg_gold_at30: ['avg_gold_at30', 'avgGoldAt30'],
          avg_cs_at30: ['avg_cs_at30', 'avgCSAt30'],
        };
        const allowedMetricsByTitle: Record<string, string[]> = {
          'Vision Expert': ['visionScorePerMin'],
          'Vision Improvement Needed': ['visionScorePerMin'],
          'Early Game Dominator': ['avg_cs_at10', 'avg_gold_at10'],
          'Early Game Struggles': ['avg_cs_at10', 'avg_gold_at10'],
          'Tower Destroyer': [
            'avg_turret_plates_participation',
            'avg_towers_participation',
          ],
          'Tower Pressure Gap': [
            'avg_turret_plates_participation',
            'avg_towers_participation',
          ],
          'Objective Master': [
            'avg_drakes_participation',
            'avg_herald_participation',
            'avg_baron_participation',
          ],
          'Void Hunter': [
            'avg_grubs_participation',
            'avg_herald_participation',
          ],
          'Objective Neglect': [
            'avg_grubs_participation',
            'avg_herald_participation',
          ],
          'Atakhan Slayer': ['avg_atakhan_participation'],
          'Damage Dealer': ['avg_dpm'],
          'Damage Output Gap': ['avg_dpm'],
          'Gold Farmer': ['avg_cs_total', 'avg_gpm'],
          'Farm Efficiency Gap': ['avg_cs_total', 'avg_gpm'],
          'Kill Specialist': ['avg_kills', 'avg_deaths'],
          'Team Player': ['avg_assists', 'avg_deaths'],
          'Team Contribution Gap': ['avg_assists', 'avg_deaths'],
          'Level Advantage': ['avg_level_at15', 'avg_level_at20'],
          'Level Tempo Lag': ['avg_level_at15', 'avg_level_at20'],
          'Experience Hoarder': ['avg_xp_at15', 'avg_xp_at20'],
          'Experience Gap': ['avg_xp_at15', 'avg_xp_at20'],
          'Tank Specialist': ['avg_deaths', 'avg_dmg_taken_per_min'],
          'Positioning Cleanup': ['avg_deaths', 'avg_dmg_taken_per_min'],
          'Mid Game Specialist': [
            'avg_gold_at15',
            'avg_gold_at20',
            'avg_level_at15',
            'avg_level_at20',
          ],
          'Mid Game Dip': ['avg_gold_at15', 'avg_gold_at20'],
          'Late Game Carry': ['avg_gold_at30', 'avg_cs_at30'],
          'Scaling Monster': ['avg_gold_at30', 'avg_cs_at30'],
        };
        function format(val: number): string {
          const sign = val > 0 ? '+' : '';
          return `${sign}${Math.round(val * 100) / 100}`;
        }
        normalized = {
          badges: normalized.badges.map((b) => {
            const allowed = allowedMetricsByTitle[b.title] || [];
            if (allowed.length === 0) return b;
            const numbers: string[] = [];
            for (const canonical of allowed) {
              const aliases = metricAliases[canonical] || [canonical];
              const d = getDiff(aliases);
              if (d != null) {
                numbers.push(`${format(d)} ${canonical}`);
              }
            }
            if (numbers.length === 0) return b;
            const hasNumber = /\d/.test(b.reason);
            return hasNumber
              ? b
              : {
                  ...b,
                  reason: `${b.reason ? `${b.reason} ` : ''}Key numbers: ${numbers.join(', ')}`,
                };
          }),
        };
      }
    } catch {
      // ignore enrichment errors
    }
    await redis.set(aiCacheKey, JSON.stringify(normalized), 'EX', ms('12h'));
    return c.json(normalized);
  } catch (err) {
    consola.error(chalk.red('Failed to generate AI badges via Bedrock'), err);
    // As a fallback, return the structural comparison (non-AI), but keep JSON shape similar
    const comparisons = compareRoleStats(myStats, enemyStats);
    // Helper to flatten numeric diffs for reason strings
    function flattenNumericDiffs(
      obj: Record<string, unknown>,
      prefix = '',
    ): Array<{ path: string; diff: number }> {
      const out: Array<{ path: string; diff: number }> = [];
      for (const [key, val] of Object.entries(obj)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (typeof val === 'number' && Number.isFinite(val)) {
          out.push({ path, diff: val });
        } else if (val && typeof val === 'object' && !Array.isArray(val)) {
          out.push(
            ...flattenNumericDiffs(val as Record<string, unknown>, path),
          );
        }
      }
      return out;
    }
    function formatDiff(d: number): string {
      const sign = d > 0 ? '+' : '';
      return `${sign}${Math.round(d * 100) / 100}`;
    }
    function buildRoleReason(
      role: string,
      stats: Record<string, unknown>,
      limit = 3,
    ): string {
      const diffs = flattenNumericDiffs(stats);
      if (diffs.length === 0) return `role=${role}: no numeric diffs available`;
      diffs.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
      const top = diffs
        .slice(0, limit)
        .map((d) => `${formatDiff(d.diff)} ${d.path}`);
      return `role=${role}: ${top.join(', ')}`;
    }
    // Determine standout and improvement roles
    let topPos: {
      role: string;
      sum: number;
      stats: Record<string, unknown>;
    } | null = null;
    let topNeg: {
      role: string;
      sum: number;
      stats: Record<string, unknown>;
    } | null = null;
    for (const cmp of comparisons) {
      const diffs = flattenNumericDiffs(cmp.stats);
      const sum = diffs.reduce((acc, d) => acc + d.diff, 0);
      if (!topPos || sum > topPos.sum)
        topPos = {
          role: cmp.position,
          sum,
          stats: cmp.stats as Record<string, unknown>,
        };
      if (!topNeg || sum < topNeg.sum)
        topNeg = {
          role: cmp.position,
          sum,
          stats: cmp.stats as Record<string, unknown>,
        };
    }
    const badges: Array<{
      title: string;
      description: string;
      reason: string;
      polarity: 'good' | 'bad' | 'neutral';
    }> = [];
    if (topPos) {
      badges.push({
        title: `Standout Role: ${topPos.role}`,
        description:
          'Largest positive diffs versus lane opponents across key metrics',
        reason: buildRoleReason(topPos.role, topPos.stats),
        polarity: 'good',
      });
    }
    if (topNeg && (!topPos || topNeg.role !== topPos.role)) {
      badges.push({
        title: `Improvement Role: ${topNeg.role}`,
        description:
          'Largest negative diffs versus lane opponents indicate improvement opportunities',
        reason: buildRoleReason(topNeg.role, topNeg.stats),
        polarity: 'bad',
      });
    }
    if (badges.length === 0) {
      badges.push({
        title: 'Role Comparison Available',
        description:
          'AI generation failed; returning numerical role comparison overview',
        reason: 'No diffs detected to highlight',
        polarity: 'neutral',
      });
    }
    return c.json({ badges });
  }
});

app.get(
  '/:region/:tagName/:tagLine/champions',
  accountMiddleware,
  async (c) => {
    const puuid = c.var.account.puuid;
    const champs = await collections.matches
      .aggregate(playerChampsByRole(puuid))
      .toArray();
    return c.json(champs);
  },
);

app.get('/:region/:tagName/:tagLine/heatmap', accountMiddleware, async (c) => {
  const puuid = c.var.account.puuid;
  const { role, championId, mode } = c.req.query();
  if (!role) {
    throw new HTTPException(400, { message: 'role is required', cause: role });
  }
  const aggregation = playerHeatmap({
    puuid,
    role: role.toUpperCase() || 'BOTTOM',
    championId: championId ? Number(championId) : null,
    mode: mode as 'kills' | 'deaths' | undefined,
  });
  const heatmap = await collections.matches
    .aggregate(aggregation, {
      allowDiskUse: true,
    })
    .toArray();
  return c.json(heatmap);
});

app.get('/:region/:tagName/:tagLine/overview', accountMiddleware, async (c) => {
  const puuid = c.var.account.puuid;
  const { position } = c.req.query();
  const cacheKey = `cache:overview:${c.var.internalId}:${position || 'all'}`;

  const cached = await redis.get(cacheKey);
  if (cached) {
    return c.json(JSON.parse(cached));
  }

  const overview = await collections.matches
    .aggregate(playerOverviewWithOpponents(puuid, position?.toUpperCase()))
    .toArray();

  const result = overview[0] || null;
  await redis.set(cacheKey, JSON.stringify(result), 'EX', ms('1h'));
  return c.json(result);
});

app.get(
  '/:region/:tagName/:tagLine/recent-matches',
  accountMiddleware,
  async (c) => {
    const puuid = c.var.account.puuid;
    const { limit } = c.req.query();
    const matchLimit = limit ? Number(limit) : 10;

    const cacheKey = `cache:recent-matches:${c.var.internalId}:${matchLimit}`;

    const cached = await redis.get(cacheKey);
    if (cached) {
      return c.json(JSON.parse(cached));
    }

    const matches = await collections.matches
      .aggregate(recentMatches(puuid, matchLimit))
      .toArray();

    await redis.set(cacheKey, JSON.stringify(matches), 'EX', ms('10m'));
    return c.json(matches);
  },
);

app.get(
  '/:region/:tagName/:tagLine/champion-insights',
  accountMiddleware,
  async (c) => {
    const puuid = c.var.account.puuid;

    const cacheKey = `cache:champion-insights:${c.var.internalId}`;

    const cached = await redis.get(cacheKey);
    if (cached) {
      return c.json(JSON.parse(cached));
    }

    const insights = (await collections.matches
      .aggregate(championInsights(puuid))
      .toArray()) as Array<{
      championId: number;
      championName: string;
      totalGames: number;
      winRate: number;
      recentWinRate: number;
      avgKda: number;
      consistencyScore: number;
      performanceTrend: unknown;
      roles: string[];
      daysSinceLastPlayed: number;
    }>;

    // Filter out champions with insufficient data or invalid values
    const validInsights = insights.filter((champion) => {
      // Require at least 3 games for meaningful insights
      if (champion.totalGames < 3) return false;

      // Filter out champions with invalid or NaN values
      if (
        Number.isNaN(champion.winRate) ||
        Number.isNaN(champion.avgKda) ||
        Number.isNaN(champion.consistencyScore) ||
        champion.winRate < 0 ||
        champion.winRate > 100 ||
        champion.avgKda < 0 ||
        champion.consistencyScore < 0 ||
        champion.consistencyScore > 100
      ) {
        return false;
      }

      return true;
    });

    // Generate AI insights using AWS Bedrock
    let aiInsights = null;
    if (validInsights.length > 0) {
      try {
        aiInsights = await generateChampionInsights(validInsights);
      } catch (error) {
        consola.error('Error generating AI insights:', error);
        // Continue without AI insights if generation fails
      }
    }

    const result = {
      championData: validInsights,
      aiInsights: aiInsights || {
        summary: 'Unable to generate AI insights at this time.',
        trends: [],
        recommendations: [],
        confidence: 0,
      },
    };

    await redis.set(cacheKey, JSON.stringify(result), 'EX', ms('30m'));
    return c.json(result);
  },
);

app.get(
  '/:region/:tagName/:tagLine/champion-mastery',
  accountMiddleware,
  async (c) => {
    const puuid = c.var.account.puuid;
    const { limit } = c.req.query();
    const champLimit = limit ? Number(limit) : 5;

    const cacheKey = `cache:champion-mastery:v2:${c.var.internalId}:${champLimit}`;

    const cached = await redis.get(cacheKey);
    if (cached) {
      return c.json(JSON.parse(cached));
    }

    const mastery = await collections.matches
      .aggregate(championMastery(puuid, champLimit))
      .toArray();

    await redis.set(cacheKey, JSON.stringify(mastery), 'EX', ms('1h'));
    return c.json(mastery);
  },
);

export { app };
