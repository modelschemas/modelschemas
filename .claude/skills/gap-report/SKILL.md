---
name: gap-report
description: Run the modelschemas gap report and say which chat facts `@tanstack/ai-models` still lacks per provider. Use when asked for the gap report, what a provider is missing, whether a provider is done, or which provider to fill next.
---

# Gap report

`bun run gap:report` scores each provider on the chat facts
`@tanstack/ai-models` needs. It makes one `GET /v1/models` request and
changes nothing.

## Run it

```bash
bun run gap:report --table                              # every provider, worst first
bun run gap:report                                      # JSON, for reading with jq
bun run gap:report --base http://localhost:3100         # a local dev server
bun run gap:report --check --providers grok,mistral     # exit 1 if either is below 1
bun run gap:report --check --providers grok --target 0.9
```

The default base is production (`https://modelschemas.com`). Use `--base`
with the local server to check work that is not deployed yet.

One provider's gaps, as `fact: have/need`:

```bash
bun run gap:report | jq '.providers[] | select(.provider == "grok")
  | .silent as $s | {score, silent, gaps: (.facts | with_entries(
      select(.value.have < .value.need and (.key | IN($s[]) | not))))}'
```

## Read it

- `score` is filled facts over needed facts, from 0 to 1, over chat rows only.
- A provider with rows and `chat: 0` scores 0. Its gap is the missing
  `activity`, shown by `noActivity`, not the facts.
- `reasoning` and `efforts` have a smaller `need` than `chat`: they count
  only the rows that claim reasoning, or that use an effort or adaptive mode.
- A fact under `silent` is one the provider does not publish. It is left out
  of the score. The ledger is `docs/source-silent/`, one file per provider.
- `fromModelsDev` rows have a price sourced from models.dev. They do not
  count as `priced` or `cacheRead`.

## Report it

Lead with the score and the facts below `need`, as `have/need`. Name the
silent facts apart from the gaps. Say which base URL the numbers came from.

## Fill a gap

The report only measures. When filling what it finds:

- Take each fact from the provider's own listing, docs, or spec. Never copy
  it from OpenRouter or any other catalog.
- If no native source states the fact, add a line to
  `docs/source-silent/<provider>.md` with the reason and the issue number. Do not
  invent a value.
- The provider is done when `--check --providers <id>` exits 0 against a
  base that serves the new data.
