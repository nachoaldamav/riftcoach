Here’s a crisp hand-off you can paste into the new chat. It’s split into ✅ “we have” and 🛠️ “to do”, ordered by impact.

# ✅ What we already have

## Data lake & ingestion

- S3 bucket `riftcoach` (eu-central-1) with Bronze layout:

  - `raw/matches/season=YYYY/patch=X.Y/queue=QQQ/matchId=…jsonl.gz`
  - `raw/timelines/season=YYYY/patch=X.Y/queue=QQQ/matchId=…jsonl.gz`

- Working Mongo → S3 exporter (Bit component) that:

  - filters allowed queues (420, 440, 400),
  - normalizes season/patch,
  - writes compressed JSONL,
  - (optionally) fetches missing timelines via your GraphQL and stores them.

- Timelines **rich schema** in Athena/Glue (typed `frames` and `events` with soul/monster/team fields).

## Query layer (Athena/Glue)

- `lol.raw_matches` external table (JsonSerDe).
- `lol.raw_timelines` external table with extended typed frame/event structs.
- View: `lol.match_team_dragons` — per match & team:

  - elemental drakes taken, distinct types, count, **soul_type** (explicit from `DRAGON_SOUL_GIVEN` or inferred as 4th elemental), elders excluded from elemental counts.

- Cohort CTAS (snapshot) design:

  - `lol.cohorts_role_champ_snap` (Parquet, partitioned by `season, patch, queue`).
  - Metrics implemented/validated in queries: KP (mean/p50/p75/p95), vision-score/min, ward-clears/min, damage per gold, **CS\@10 from timelines**, and base role/champ slicing.

- Sanity queries for:

  - CS\@10 extraction,
  - cohort rollups,
  - event classification (plates, drakes, herald, baron).

## Product framing

- Year Recap spec (per role & top-5 champs):

  - weighted KPIs by role (farming, fighting, vision, objectives, roaming).
  - show cohort deltas vs player + **tips** using pro/LEC reference lines.

- Post-game spec:

  - reuse the same metrics filtered to the single match + season context.

- Infra choices:

  - EU region baseline (eu-west-1), Athena/Glue/S3 set.
  - Model/tooling plan discussed (AWS Bedrock: Nova Micro/Lite + tool-use; OpenSearch for vector/RAG optional).

---

# 🛠️ What’s left to ship (actionable checklist)

## 0) Fix the snapshot table schema (so you see the new columns)

- Rebuild via temp → swap (no `IF NOT EXISTS`):

  - Create `lol.cohorts_role_champ_snap_tmp` with **full SELECT** (includes: `vis_per_min_p50/p75/p95`, `wclear_per_min_p75/p95`, `csfull_mean/p75/p95`, **objective participation** cols).
  - `DESCRIBE` tmp; if OK → `DROP TABLE lol.cohorts_role_champ_snap;`
  - `ALTER TABLE lol.cohorts_role_champ_snap_tmp RENAME TO cohorts_role_champ_snap;`

## 1) Complete the snapshot metrics

- Add to the CTAS (if not already):

  - **Objective participation**: `drake/herald/baron` per player vs team totals + overall objective participation mean.
  - **Full-match CS/min** (lane + jungle over time played) with p75/p95.
  - (Optional) **p95** lines for KPIs you’ll showcase as “best of the best”.

- Partition hygiene:

  - Ensure `season, patch, queue` are **the last columns** and MSCK after loads.

## 2) Extend objective analytics (for insights)

- View: `lol.timelines_events_long` (typed) — keep; add columns if needed:

  - `objective_kind` (we have),
  - `soul_name_raw` (from `e.name`) already exposed.

- New view: `lol.match_team_objectives` (if you want herald/baron/grubs detail per team).
- WR by **soul type** and by **# distinct drake types**:

  - Finalize two queries that join `raw_matches.teams.win` with `match_team_dragons`.

## 3) Items / builds data

- Bit component `data/ddragon-export`:

  - Pull latest DDragon `item.json`, `runesReforged.json`, `champion.json`.
  - Land to S3 `ref/ddragon/patch=X.Y/*.json`.
  - Glue table `lol.ref_items` (flattened: id, name, tags, stats, `grievous_wounds` flag, components/into arrays).

- Build-path extraction (Phase 1):

  - From timelines: item purchase/upgrade/sell events → build sequence per participant.
  - CTAS `lol.player_item_paths_snap` (per season/patch/queue, role/champ → common paths, % popularity, win%).
  - Minimal needed now: anti-heal adoption rate vs enemy healing (for Mundo-style insights).

## 4) Player-centric joins (for Year Recap & Post-game)

- `lol.player_matches_snap` CTAS:

  - For a given `puuid`, season/patch/queue → per match metrics (KPIs, obj involvement, cs10, csfull, build flags, map deaths if you add them).
  - Enables fast recap & post-game without re-scanning Bronze.

- (Optional) **death map heuristics**:

  - From events: `CHAMPION_KILL` where player is **victim** → position, side, time.
  - Flags: “deaths past river pre-plates” (overextension), “solo deaths without vision”, “post-herald deaths for bot”.

## 5) AI layer (Bedrock)

- Tooling contracts:

  - `getCohortBenchmarks(role, championId, season, patch, queue)` → returns cohort medians/p75/p95 from `cohorts_role_champ_snap`.
  - `getPlayerSeasonStats(puuid, role, championId, season, patch, queue)` → from `player_matches_snap`.
  - `getItemInfo(itemId)` / `searchItems(tag|effect)` → from `ref_items`.
  - `getDrakeContext(matchId|puuid)` → from `match_team_dragons`.

- Prompting:

  - Year Recap: feed **facts** (not raw tables). Ask Nova to rank top 3 areas to improve per role, with quick “why” and **1 actionable tip** each. Include **pro/LEC reference** line from p95 when helpful.
  - Post-game: same but scoped to a single match; link to concrete events (e.g., “you died bot river at 12:40 without vision; place ward earlier or hover tower when wave state = slow push against you”).

## 6) API & monorepo wiring (Bit + Node/TS)

- Packages (suggested names):

  - `@riftcoach/shared.constants` (already done).
  - `@riftcoach/data.mongodb-export` (done).
  - `@riftcoach/data.ddragon-export` (items/runes/champs to S3).
  - `@riftcoach/athena.client` (typed query helpers, retries, pagination).
  - `@riftcoach/agg.cohorts` (materializers for CTAS/refresh orchestration).
  - `@riftcoach/agg.player-snap` (player per-match snapshot).
  - `@riftcoach/api` (GraphQL w/ Apollo, resolvers call Athena).
  - `@riftcoach/ai.orchestrator` (Bedrock client + tool schemas).
  - `@riftcoach/web` (Next.js app).

## 7) Schedules & orchestration

- Nightly (UTC 03:00) in EU:

  - Mongo → S3 exporter (new/updated).
  - MSCK repair both raw tables.
  - Rebuild snapshots (CTAS temp → swap).
  - DDragon exporter (if patch bumps).

- Use EventBridge Scheduler + Lambda (Node 20) or Step Functions for DAG (export → repair → CTAS).

## 8) Frontend slices (Year Recap & Post-game)

- Year Recap:

  - Filters: season, queues, roles.
  - For each role + top 5 champs:

    - radar/score bars for KPIs (player vs cohort mean/p75/p95),
    - callouts (e.g., “below p50 vision at 0.38/min; supports average 0.65/min”),
    - objective & soul context (“+10% WR when your team got Chemtech Soul”).

- Post-game:

  - match header, timeline mini-map with death markers,
  - “3 wins in 4 when you rushed anti-heal vs heavy healing — today: no anti-heal built”,
  - suggested drills/tips.

## 9) Cost & perf quick wins

- Use Parquet for all snapshots (done).
- Keep scans narrow: **SELECT columns you need**; always filter by `season/patch/queue`.
- Cache heavy cohort outputs in S3 as JSON (`/cache/cohorts/…`) for API speed.
- Set Athena workgroup with per-query scan guardrails (e.g., 2 GB).

## 🔮 Stretch (nice to have)

- Add **grubs**/Atakhan control rates per role/champ.
- **Roaming index** (lane presence vs kills elsewhere).
- **Wave states** (needs lane CS deltas + position bands).
- **Live pro line**: ingest LEC averages into a tiny `ref_pro_benchmarks` table per role/champ.

---

## Copy-paste sanity commands

Describe schemas:

```sql
DESCRIBE lol.raw_timelines;
DESCRIBE lol.cohorts_role_champ_snap;
```

Quick cohort check:

```sql
SELECT role, championid, players, games, cs10_mean, csfull_mean, vis_per_min_mean
FROM lol.cohorts_role_champ_snap
WHERE season=2025 AND patch LIKE '15.%' AND queue IN (420,440)
  AND role='BOTTOM' AND championid=523
LIMIT 5;
```

Dragons + soul (single match):

```sql
SELECT * FROM lol.match_team_dragons
WHERE matchid='EUW1_7528723317';
```

---

If you want, I can also draft the **EventBridge + Lambda** infra (CDK) to run the nightly jobs and a tiny `@riftcoach/athena.client` helper with typed runners next.
