# modelschemas catalog data

A read-only mirror of the [modelschemas](https://github.com/modelschemas/modelschemas)
catalog, refreshed hourly from `GET /v1/admin/export`. D1 behind
https://modelschemas.openstory.workers.dev stays the source of truth.

- `providers/<provider>.json`
- `models/<provider>/<modelId>.json`
- `schemas/<provider>/<endpointId>.json` (current input and output schema)
- `latest-change.json`: the newest `/v1/changes` row these files include

Each commit message lists the `/v1/changes` ids it covers. Fields that move
on every poll (such as `lastSeenAt`) are left out, so a commit is a real change.

**Pull requests here are overwritten by the next run.** A wrong fact is an
adapter fix, not a data edit: open an issue on
[modelschemas/modelschemas](https://github.com/modelschemas/modelschemas/issues).
