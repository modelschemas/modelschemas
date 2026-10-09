# Ant Ling native sources

Checked 2026-10-09. Production sync fetches public provider-owned pages; fixtures
capture their article contents for offline regression tests. There is no static
model registry, reseller pricing source, credential requirement or generation
request in the adapter.

- https://developer.ant-ling.com/en/docs/api-reference/openai/ — request address,
  model options, parameter types, required fields, defaults, bounds, role options,
  model-scoped reasoning and thinking controls, and multimodal applicability.
- https://developer.ant-ling.com/en/docs/api-reference/ — hosted context lengths
  and text-conversation scope. Hosted Ling-2.6-1T is 256K; the weights-page 1M
  context is not substituted for the hosted API context.
- https://developer.ant-ling.com/en/docs/models/price/ — only the first direct
  Model Pricing table, explicitly CNY per million tokens. Crossed-out historical
  amounts are removed before parsing current sale amounts. Later OpenRouter and
  ZenMux USD tables are excluded. All three current Ling-3.1-flash direct prices
  are explicitly zero; the card is free only while all three parsed prices are
  zero. The source's promotion duration is not converted into a guessed deadline.
- https://developer.ant-ling.com/en/docs/models/ling/ — model selection contexts
  absent from the hosted API overview, and native model-specific capabilities.
- https://developer.ant-ling.com/en/docs/models/ring/ and
  https://developer.ant-ling.com/en/docs/tutorials/effort/ — native Ring provenance
  and agreement on the model using high/xhigh effort. Mandatory reasoning remains
  unknown because a mandatory flag is not published.

The catalog is the union of native API model options and direct CNY price IDs.
Currently it contains eight rows, including newer Ling-3.1-flash and AntAngelMed.
The API options lag the pricing page: model options are retained as source
annotations rather than a closed schema allowlist that would reject the newer
provider-published ID. New IDs and changes from free to paid are tested by changing
source documents, without changing production code.

The source-silent ledger exempts only maxOutput. Other gaps remain real: native
pricing is not published for AntAngelMed or Ling-3.0-tiny; tiny/AntAngelMed context
is unknown; Ling-3.1-flash is not yet in the API-scoped options and its request map
and API modalities stay null. Its hosted activity also remains unknown; direct price IDs do not imply chat. Only native API-options models are bound to the
published request schema; pricing-only rows keep schemaEndpointId null. Missing
per-model native quotes explicitly clear prior unsourced prices after a successful
source read. Effort is supported only for its native scoped
model. No provider-wide exemption masks these partial gaps, and this change does
not assert the issue's requested gap score of 1.

The OpenAI page publishes request tables and response examples, but no formal
response field schema. The adapter emits a sourced input schema and leaves output
schema absent. Its formal messages.content table says string, while a separate
model note describes VL image/video content blocks. We retain the formal declaration
as an annotation, and leave messages.content type unknown (x-source-type: null)
because the same native API page explicitly accepts VL image/video content
blocks. No generic OpenAI content-part shape is constructed; validation does not
reject the native documented multimodal content arrays. No max_tokens field is added from another protocol.

Malformed pages, missing sections/cells, unknown native types and unreadable
current amounts throw. Historical prices, reseller prices and handmade facts are
never substituted. The rate-card evaluator accepts a literal source-published
zero (including a CNY currency wrapper), while retaining its rejection of paid
formulas that evaluate to zero and all negative results.
