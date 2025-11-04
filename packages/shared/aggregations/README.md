# @riftcoach/packages.shared.aggregations

Shared MongoDB aggregation pipelines used across Riftcoach services. This package centralizes cohort and player percentiles aggregations for reuse.

## Development

- Build: `pnpm --filter @riftcoach/packages.shared.aggregations run compile`
- Test: `pnpm --filter @riftcoach/packages.shared.aggregations test`

## Exports

- `cohortChampionRolePercentilesAggregation(params)`
- `playerChampRolePercentilesAggregation(puuid, championName, role, options)`