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
import ms from 'ms';
import { v5 } from 'uuid';
import z from 'zod';
import { enemyStatsByRolePUUID } from '../../aggregations/enemyStatsByRolePUUID.js';
import { statsByRolePUUID } from '../../aggregations/statsByRolePUUID.js';
import { redis } from '../../clients/redis.js';
import { BADGES_PROMPT } from '../../prompts/badges.js';
import compareRoleStats from '../../utils/compare-role-stats.js';

const UUID_NAMESPACE = '76ac778b-c771-4136-8637-44c5faa11286';

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
  // Note: Stats objects are grouped by role under `position` and include per-minute metrics,
  // early/late snapshots, and objective participation. The model should compute diffs itself.
  const header =
    "You are RiftCoach's League of Legends badge generator. Analyze the player's per-role performance versus direct opponents and award 2–4 badges that best fit their playstyle.";

  const rules =
    "Rules:\n- Use the following badge catalog and instructions.\n- Treat the player's most-weighted role strictly as the provided 'Primary Role'. Do NOT infer or vary it.\n- You may award badges for other roles if evidence is strong, but never call other roles 'most-weighted'.\n- Prioritize badges only when stats clearly support them; avoid contradictory picks.\n- Output MUST be ONLY valid JSON with one top-level key: badges.\n- badges must be an array of 2–4 objects.\n- Each badge object MUST have keys exactly: title, description, reason.\n- Use the catalog 'name' as the badge title.\n- CRITICAL REASONING STYLE: Write the 'reason' field in a conversational, engaging tone that feels like a coach talking to the player. Avoid robotic statistical reporting.\n- Include specific numbers but weave them into natural language that celebrates achievements or explains performance patterns.\n- GOOD reasoning example: 'You consistently outfarmed your lane opponents, averaging 71.7 CS at 10 minutes compared to their 65.4 - that extra 6+ minions per game translates to real gold advantages that fuel your item spikes.'\n- BAD reasoning example: 'Player avgCSAt10 is 71.7 vs opponents 65.4 showing higher CS advantage.'\n- Make it personal and motivational while being factually accurate with the statistics.\n- CRITICAL: When stating comparisons, ensure logical consistency - if player has LOWER values in positive metrics (CS, gold, etc.), they are performing WORSE, not better.";

  const formatHint =
    "Input data format:\n- myStats: array of role aggregates for the player (fields like kills/deaths/assists per minute, cs/gold/vision per minute, damage taken, CS@10, Gold@10, XP@10, late-game @30 snapshots, objective participation for dragons/herald/baron/towers/plates, etc.).\n- enemyStats: same structure for opponents in lane/role.\n\nCRITICAL COMPARISON RULES:\n- HIGHER is BETTER for: kills, assists, cs, gold, vision, damage dealt, objective participation rates, CS@10/15/20/30, Gold@10/15/20/30, XP@10/15/20/30\n- LOWER is BETTER for: deaths, damage taken\n- When comparing player vs opponent stats, calculate: (player_value - opponent_value)\n- Positive differences mean player is BETTER, negative differences mean player is WORSE\n- Example: Player CS/min=1.02, Opponent CS/min=1.55 → Difference = 1.02-1.55 = -0.53 (player is WORSE at CS)\n\nREASONING TONE GUIDELINES:\n- Address the player directly using 'you' and 'your'\n- Use encouraging language that highlights their strengths\n- Transform dry statistics into meaningful insights about their playstyle\n- Example transformations:\n  * 'avgCSAt10: 71.7 vs 65.4' → 'You consistently outfarm your opponents early, securing 71.7 CS by 10 minutes while they only manage 65.4'\n  * 'goldPerMin: +45 advantage' → 'Your efficient farming translates to an extra 45 gold per minute, giving you faster item completions'\n  * 'visionScorePerMin: 1.2 vs 0.8' → 'You light up the map with 50% more vision than your opponents, giving your team crucial information advantages'\n- Focus on what the numbers mean for their gameplay impact, not just the raw comparison.";

  const catalog = BADGES_PROMPT;

  const jsonOnly =
    'CRITICAL OUTPUT FORMAT:\n- Respond with ONLY valid JSON\n- NO reasoning chains, NO <reasoning> tags, NO explanations\n- NO markdown formatting, NO code blocks\n- Start immediately with \'{\' and end with \'}\'\n- Structure: { "badges": [{"title": "...", "description": "...", "reason": "..."}] }\n- Must contain exactly 2-4 badge objects\n- Each badge must have all three fields: title, description, reason';

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
    'Player Data (myStats):',
    JSON.stringify(myStats),
    '',
    'Opponent Data (enemyStats):',
    JSON.stringify(enemyStats),
  ].join('\n');
}

async function invokeBadgesModel(prompt: string): Promise<{
  badges: Array<{
    title?: string;
    name?: string;
    description?: string;
    reason?: string;
    reasoning?: string;
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
      parsed.badges.length >= 2 &&
      parsed.badges.length <= 4
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
        },
        {
          title: 'Team Player',
          description: 'Contributes effectively to team objectives',
          reason: 'Fallback badge due to AI generation failure',
        },
      ],
    };
  }
}

// Normalize any AI response shape into the required { badges: [{ title, description, reason }] }
function normalizeBadgesResponse(input: unknown): {
  badges: Array<{ title: string; description: string; reason: string }>;
} {
  const out: {
    badges: Array<{ title: string; description: string; reason: string }>;
  } = { badges: [] };
  if (!input || typeof input !== 'object') return out;
  const anyObj = input as Record<string, unknown>;
  const badgesRaw = anyObj.badges;
  if (!Array.isArray(badgesRaw)) return out;
  const mapped = badgesRaw
    .map((b) => {
      const obj = (b ?? {}) as Record<string, unknown>;
      const title = String(obj.title ?? obj.name ?? '').trim();
      const description = String(obj.description ?? '').trim();
      const reason = String(obj.reason ?? obj.reasoning ?? '').trim();
      if (!title && !description && !reason) return null;
      return {
        title: title || 'Badge',
        description: description || '',
        reason: reason || '',
      };
    })
    .filter(Boolean) as Array<{
    title: string;
    description: string;
    reason: string;
  }>;
  out.badges = mapped;
  return out;
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
    // Ensure reasons include numeric evidence; if missing, enrich from comparisons
    const comparisonsForEvidence = compareRoleStats(myStats, enemyStats);
    function flattenAllComparisons(
      cs: typeof comparisonsForEvidence,
    ): Array<{ path: string; diff: number }> {
      const out: Array<{ path: string; diff: number }> = [];
      for (const cmp of cs) {
        const stats = cmp.stats as Record<string, unknown>;
        const stack: Array<{ prefix: string; obj: Record<string, unknown> }> = [
          { prefix: cmp.position, obj: stats },
        ];
        while (stack.length) {
          const { prefix, obj } = stack.pop() as {
            prefix: string;
            obj: Record<string, unknown>;
          };
          for (const [k, v] of Object.entries(obj)) {
            const path = `${prefix}.${k}`;
            if (typeof v === 'number' && Number.isFinite(v)) {
              out.push({ path, diff: v });
            } else if (v && typeof v === 'object' && !Array.isArray(v)) {
              stack.push({ prefix: path, obj: v as Record<string, unknown> });
            }
          }
        }
      }
      return out;
    }
    const diffsAll = flattenAllComparisons(comparisonsForEvidence).sort(
      (a, b) => Math.abs(b.diff) - Math.abs(a.diff),
    );
    const evidence = diffsAll
      .slice(0, 3)
      .map(
        (d) =>
          `${d.diff > 0 ? '+' : ''}${Math.round(d.diff * 100) / 100} ${d.path}`,
      )
      .join(', ');
    if (evidence) {
      normalized = {
        badges: normalized.badges.map((b) => {
          const hasNumber = /\d/.test(b.reason ?? '');
          const newReason = hasNumber
            ? b.reason
            : b.reason
              ? `${b.reason} | evidence: ${evidence}`
              : `evidence: ${evidence}`;
          return { ...b, reason: newReason };
        }),
      };
    }
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
        })),
      };
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
    }> = [];
    if (topPos) {
      badges.push({
        title: `Standout Role: ${topPos.role}`,
        description:
          'Largest positive diffs versus lane opponents across key metrics',
        reason: buildRoleReason(topPos.role, topPos.stats),
      });
    }
    if (topNeg && (!topPos || topNeg.role !== topPos.role)) {
      badges.push({
        title: `Improvement Role: ${topNeg.role}`,
        description:
          'Largest negative diffs versus lane opponents indicate improvement opportunities',
        reason: buildRoleReason(topNeg.role, topNeg.stats),
      });
    }
    if (badges.length === 0) {
      badges.push({
        title: 'Role Comparison Available',
        description:
          'AI generation failed; returning numerical role comparison overview',
        reason: 'No diffs detected to highlight',
      });
    }
    return c.json({ badges });
  }
});

export { app };
