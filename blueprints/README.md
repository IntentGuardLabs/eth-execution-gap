# Blueprints

Source of truth for all design decisions. Agents read these before writing code.

| Blueprint | Status | Last Updated | Description |
|-----------|--------|-------------|-------------|
| [01-pipeline-orchestration.md](01-pipeline-orchestration.md) | Active | 2026-04-11 | Execution order, concurrency, retries, progress events |
| [02-data-contracts.md](02-data-contracts.md) | Active | 2026-04-11 | Module input/output schemas |
| [03-api-contracts/](03-api-contracts/) | Active | 2026-04-11 | External API request/response shapes |
| [04-edge-cases.md](04-edge-cases.md) | Active | 2026-04-11 | Failure modes and resolutions |
| [05-database-schema.md](05-database-schema.md) | Active | 2026-04-11 | Cache tables, TTLs, query patterns |
| [06-ui-states.md](06-ui-states.md) | Active | 2026-04-11 | What the user sees at each stage |

## Reading Order

- **Pipeline module work**: 02 → 03 → 04 → 05
- **UI work**: 06 → 02
- **Debugging**: 04 → relevant 03 file
