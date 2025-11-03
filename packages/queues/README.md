# Riftcoach Queues — Cohorts Preprocessing

This package defines BullMQ queues and workers for Riot API ingestion and nightly cohort preprocessing. The cohorts flow computes percentile aggregates per champion and role to speed up API responses and AI analyses.

## Architecture

- `cohorts` queue: Independent BullMQ queue dedicated to cohort jobs.
- Job types:
  - `cohort-orchestrate`: Schedules one `cohort-process` job per champion × role for a given year.
  - `cohort-process`: Runs MongoDB aggregation to compute percentiles for a single champion × role and caches the result in Redis.
- Worker:
  - Orchestrate mode batches `cohort-process` jobs using `addBulk`, with dedup via deterministic `jobId`.
  - Process mode executes the cohort aggregation pipeline against `collections.matches` and persists results to Redis.
- Scheduler:
  - Daily cron at `03:00 UTC` triggers `cohort-orchestrate` for `COHORT_YEAR`.
  - Catch-up: if the last orchestrate is older than 36h, a one-off catch-up job is enqueued.

## Data Flow

1. Orchestrate picks champion names from DDragon and iterates `ROLES`.
2. Creates `cohort-process` jobs with `jobId=cohort:process:{year}:{championName}:{role}`.
3. Process builds a MongoDB aggregation pipeline (mirrors `apps/api`), executes against `matches`, and caches output:
   - Redis key: `cache:cohort:percentiles:v5:{champion}:{role}:{year}:limit10000` (7 days TTL).
4. Metrics keys updated in Redis for monitoring.

## Key Redis Metrics

- `metrics:cohorts:scheduled`: Count of `cohort-process` jobs scheduled.
- `metrics:cohorts:last_orchestrate`: Timestamp of last orchestrate run.
- `metrics:cohorts:processed`: Count of successful process jobs.
- `metrics:cohorts:skipped`: Count of process jobs with no data.
- `metrics:cohorts:jobs_completed` / `metrics:cohorts:jobs_failed`: Worker event counters.

## Environment Variables

- `COHORT_WORKER_CONCURRENCY` — default `3` in prod, `1` in dev.
- `COHORT_SAMPLE_LIMIT` — default `10000` in prod, `3000` in dev.
- `COHORT_YEAR` — default `current UTC year`.
- `ENABLE_COHORT_SCHEDULER` — set to `true` (default) to enable cron scheduling.

## Running

- Worker setup: called from `setupWorkers()` in `src/index.ts`.
- Scheduler: `scheduleCohortsDaily(3)` is invoked during worker setup when enabled.
- Monitoring: `monitorQueues()` reports per-cluster and `cohorts` queue activity.

## Failure Handling & Retries

- `attempts:3` with exponential backoff; completion/failure events are logged and counted.
- Missed orchestrations are detected via `last_orchestrate` and auto-caught up.

## Notes

- Champion list and completed item IDs are fetched from DDragon; results are cached (Redis for champions, memory for items) to reduce load.
- Aggregations use `$percentile` and require MongoDB 7.x.