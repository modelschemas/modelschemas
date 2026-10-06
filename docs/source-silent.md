# Source-silent ledger

Facts a provider does not publish in any native source (listing, docs, or
spec). `bun run gap:report` leaves these out of that provider's score and
lists them under `silent`. We never fill them from another catalog.

One entry per list line: `- <provider>: <fact> — <why, with the issue>`.
The fact is a gap-report key (`contextWindow`, `maxOutput`, `modalities`,
`priced`, `cacheRead`, `capabilities`, `reasoning`, `efforts`, `requestMap`,
`endpoint`). Remove an entry when the provider starts publishing the fact.

## Entries

- grok: maxOutput — xAI's spec states only a 128k default, no per-model cap (#75, checked 2026-09-26)
- mistral: maxOutput — Mistral caps output by the context length and publishes no separate limit (#75, checked 2026-09-26)
- moonshotai-cn: maxOutput — kimi-k2.7-code, kimi-k2.7-code-highspeed and kimi-k2.6 cap output at `256*1024 - prompt_tokens` and publish no separate limit; kimi-k3's stated 1048576 is filled, https://platform.kimi.com/docs/guide/troubleshooting.md, checked 2026-10-06
