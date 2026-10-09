# Source-silent ledger

Facts a provider does not publish in any native source (listing, docs, or
spec). `bun run gap:report` leaves these out of that provider's score and
lists them under `silent`. We never fill them from another catalog.

One file per provider, `<provider>.md`, so two branches never edit the same
file. One entry per list line: `- <provider>: <fact> — <why, with the issue>`.
The fact is a gap-report key (`contextWindow`, `maxOutput`, `modalities`,
`priced`, `cacheRead`, `capabilities`, `reasoning`, `efforts`, `requestMap`,
`endpoint`). Remove an entry when the provider starts publishing the fact.

For a fact missing only on particular models, use the exact native raw model id:
`- provider/maker/model-id: fact — why, https://provider.example/model, checked YYYY-MM-DD`.
The first slash separates the provider; the rest is the raw id, including any
slashes, `@`, or colons. Backticks may surround the entire scope. No aliases,
slug normalization, family prefixes, or wildcard matching are applied. A scoped
entry never exempts sibling models. Do not use a provider-wide entry for a
partially sourced fact.

`replayReasoningContent` is a separate gap-report key for the
`requestMap.replayReasoningContent` leaf. It applies to rows whose native facts
state reasoning support. A sourced `true` or `false` fills it; null remains
unknown. A ledger entry adds read-time evidence at
`factSources.requestMapFields.replayReasoningContent`, never a boolean or a
request map. Populated facts and their provenance are preserved.

The report retains raw `have`/`need` totals and provider-wide `silent` keys.
`modelSilent` counts applicable missing rows with exact-model exceptions; these
counts are subtracted from the scoring denominator and displayed explicitly in
the table. Entries for facts that have become populated do not remove those
facts from the model-scoped score. Remove obsolete entries after sourcing them.
Recorded URLs and checked dates are copied literally into API evidence; omitted
metadata is not invented. Entries require verified native silence, not merely a
failed fetch, a missing credential, or an upstream model maker's claim.
