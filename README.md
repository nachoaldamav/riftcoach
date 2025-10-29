# RiftCoach Hackathon Readme

## Overview
RiftCoach is a League of Legends coaching agent that pairs a data-rich ingestion pipeline with tailored AI explainability layers. Players trigger a scan from the web app, and the backend orchestrates Riot API crawls, aggregates MongoDB match histories, and streams insights back over WebSockets. The coaching surface focuses on actionable feedback—clear progress tracking, playstyle badges, and match-by-match breakdowns—so competitors get tournament-ready advice in minutes.

## Application Architecture
### Web experience (`apps/web`)
- **Modern React stack.** The UI is built with TanStack Router, Tailwind, and HeroUI components to deliver rich animations and responsive dashboards. Profile headers highlight AI-generated badges while shimmer states keep scans feeling alive.【F:apps/web/src/components/profile-header.tsx†L1-L119】
- **Client utilities.** Typed HTTP clients and local caching helpers simplify fetches to the API while Data Dragon providers resolve champion and item art on the fly.【F:apps/web/src/lib/data-dragon.ts†L1-L144】【F:apps/web/src/lib/indexeddb-cache.ts†L1-L138】

### API and agents (`apps/api`)
- **Hono-based API with WebSockets.** The API starts a Hono server, wires up CORS, and maintains WebSocket subscriptions so the UI can watch scan progress, badge availability, and other streaming events.【F:apps/api/src/index.ts†L1-L119】
- **Mongo-backed analytics.** We persist raw matches and timelines in MongoDB, which keeps ingestion cheap and responsive after abandoning Athena/S3 due to cost and latency issues.【F:packages/clients/mongodb/src/index.ts†L1-L16】
- **Dynamic Riot client.** A custom Bottleneck-powered Riot client enforces dual rate limits, region-aware routing, and exponential backoff so we can crawl accounts safely without wasting API quota.【F:packages/clients/riot/src/index.ts†L1-L213】
- **Region queues.** BullMQ queues fan jobs out per routing cluster (Americas, Europe, Asia, SEA, Esports) to keep scans fast even during global surges. Listing jobs feed match/timeline fetchers while Redis-backed counters expose progress for live dashboards.【F:packages/queues/src/index.ts†L1-L170】
- **Direct opponent comparisons.** Aggregations pair each player with their lane opponent so insights reflect practical matchup edges without requiring extra rank lookups for every summoner in the database.【F:apps/api/src/aggregations/playerOverviewWithOpponents.ts†L1-L117】

## Coaching Agent Strategy
- **Structured match insights.** Bedrock-hosted Claude agents receive trimmed timelines, validated tool outputs, and must emit JSON that captures summaries, key moments, macro focus, and drills—keeping recommendations actionable and schema compliant.【F:apps/api/src/services/match-insights.ts†L1-L123】
- **Playstyle and badge intelligence.** Additional agents interpret cohort statistics versus player role weights to surface strengths and leaks; cache layers ensure badges update instantly after scans without re-hitting the model unnecessarily.【F:apps/api/src/services/ai-service.ts†L1-L151】
- **Item literacy boosts.** To combat LLM confusion around item names, we inject DDragon metadata into prompts, mapping item IDs to readable tooltips and unique groups for context-aware guidance.【F:apps/api/src/utils/ddragon-items.ts†L1-L83】

## Data Sources
- **Riot APIs.** Match, timeline, summoner, and account data flows through the custom Riot client with per-region throttling.【F:packages/clients/riot/src/index.ts†L1-L213】
- **MongoDB.** Raw and enriched match documents live in Mongo for fast aggregations and reduced operational overhead versus Athena.【F:packages/clients/mongodb/src/index.ts†L1-L16】
- **Redis.** Cache utilities and queue telemetry run through Redis to share scan state between workers and the API.【F:packages/queues/src/index.ts†L1-L170】
- **Data Dragon.** Static champion and item catalogs feed both the web client and LLM prompts for clarity.【F:apps/api/src/utils/ddragon-items.ts†L1-L83】【F:apps/web/src/lib/data-dragon.ts†L1-L144】

## Development Learnings
- **Swapped Athena for MongoDB.** Athena’s cost and latency ballooned during early trials; Mongo delivered the predictable query times we needed for match lookups.【F:packages/clients/mongodb/src/index.ts†L1-L16】
- **Built a regional scan scheduler.** Crafting BullMQ queues per cluster let us throttle crawls intelligently instead of serializing everything through one global backlog.【F:packages/queues/src/index.ts†L1-L170】
- **Created a resilient Riot client.** Dynamic rate limiting and jittered backoff preserved tokens during spikes, something the stock SDK couldn’t handle.【F:packages/clients/riot/src/index.ts†L1-L213】
- **Tuned our agent roster.** Different prompts and models run per use case; we ultimately dropped heavier Claude Sonnet configurations when token costs spiked, leaning on slimmer prompts plus cached tool context.【F:apps/api/src/services/match-insights.ts†L19-L123】【F:apps/api/src/services/ai-service.ts†L1-L151】
- **Enhanced item understanding.** Injecting DDragon item metadata directly into prompts finally stabilized build advice across languages and patches.【F:apps/api/src/utils/ddragon-items.ts†L1-L83】

