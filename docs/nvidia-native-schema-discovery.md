# NVIDIA native schema discovery (#269)

Checked 2026-10-09. Production fetches native public listing, model cards, reference
indexes and schema documents. Failed complete or partial discovery cannot prove
that a contract is unpublished. Fixtures capture provider-owned responses only.
Production never reads fixtures. No models.dev source, handcrafted catalog,
upstream model-maker schema or generic borrowed schema is used.

The reference tables omit newer IDs. The native sitemap publishes their infer
pages. Names select candidate pages only: each binding requires one exact native
model ID from the structured request model selector, or a native title when no
selector is published. The title prefix `NVIDIA NIM API for` is a wrapper, not part of the raw ID. Conflicting
identities are rejected. Cached bindings are checked against current candidate
IDs. URL normalization never supplies model facts.

Discovery sources:

- https://docs.api.nvidia.com/sitemap.xml
- https://docs.api.nvidia.com/nim/reference/llm-apis.md

Verified hosted controls:

- https://docs.api.nvidia.com/nim/reference/google-gemma-4-31b-it-infer.md — schema
  states both enable_thinking positions; optional toggle.
- https://docs.api.nvidia.com/nim/reference/diffusiongemma-26b-a4b-it-infer.md — own
  schema states both enable_thinking positions; optional toggle.
- https://docs.api.nvidia.com/nim/reference/meta-muse-glimmer-30b-infer.md — native
  reasoning_effort enum none, minimal, low, medium, high, max. The enum alone does not state disabling semantics; mandatory remains null.

These complete hosted schemas, joined by schema IDs or exact native reference-table rows, publish no
normative effort/budget/toggle control. Model cards separately state reasoning
capability. Prompt-encoding controls and request examples alone cannot supply an
accepted hosted control; reasoning objects remain null:

- https://docs.api.nvidia.com/nim/reference/nvidia-deepseek-v4_1-flash-infer.md —
  deepseek-ai/deepseek-v4.1-flash.
- https://docs.api.nvidia.com/nim/reference/poolside-laguna-xs-2-1-infer.md —
  poolside/laguna-xs-2.1.

Source selection is deterministic and uses native index/sitemap candidates.
An exact-identity healthy ReadMe contract remains primary. NVIDIA Build's own
canonical model page is selected only when the published ReadMe contract states
conflicting model identities, or native discovery publishes no ReadMe contract.
The Build `openAPISpec` is read directly as JSON from React Flight data. Its
exact native request model selector identity must succeed before use. A ReadMe network,
authentication or malformed-content error never triggers Build recovery.
Rejected competing identities are recorded as schema-fetch warnings; if no
healthy selected contract exists, the model reports a docs failure. Cached
primary documents are revalidated against the current exact model ID. Successful
HTTP reads and local content validation have separate failure accounting, so an
identity conflict cannot spend a healthy renderer request's latency on the
network failure budget. Native 404 Build pages mean no published Build contract.

Native JSON can contain Markdown fences inside response examples. Both native
embedded JSON and Markdown schema documents are parsed without truncating those
examples or evaluating page scripts. Healthy exact ReadMe Gemma and Nemotron
controls remain sourced even when competing Build schemas omit those fields.

https://build.nvidia.com/nvidia/nemotron-3.5-content-safety publishes the exact
`nvidia/nemotron-3.5-content-safety` title and request model default. Its nested
`chat_template_kwargs.enable_thinking` boolean publishes both toggle positions.
The conflicting ReadMe page still names Nano, but is not selected when the
healthy complete Build contract is primary. No Nano facts are borrowed.

Per-model presentation IDs preserve the real native wire path. The captured
ContentSafety contract publishes server `https://integrate.api.nvidia.com/v1`
and path `/chat/completions`; the route is not `/nvidia/<model>`. Request and
response schemas are included only when published. NVIDIA has no configured
connect profile, and stored endpoints have no native server metadata, so
assembled `/v1/openapi/nvidia?model=...` remains a missing-connect error. This
change does not fabricate a base URL or authentication profile.

Native request selectors take precedence over API display titles. OpenAPI's
`info.title` names the API, not a model identifier. Guard's own request model
default is the dotted catalog ID despite its underscore API title; Parse's own
request model default is the versioned catalog ID despite its older API title.
These contracts bind directly through their native literal request identifiers;
no alias is normalized or invented. Conflicting request `const`, `enum` or
`default` identifiers remain errors. Only a document without request selectors
uses its API title or an explicit own reference-index binding for identity.

Request-map fields now come from the selected native schema: token field names,
closed role enums, accepted effort values and native boolean thinking fields.
Missing fields remain null. An unbound row has no request map; the previous
provider-wide max_tokens/developerRole recipe is removed. Card negatives require
explicit unsupported labels and retain card URL/hash provenance. Missing labels
do not imply false. A positive schema contradicting a native card's explicit
negative produces a visible source failure. Enum names such as `none` alone do
not prove disabling semantics. Always-on prose must be positive and outside
code fences.

Malformed source failures are visible. Unmatched models receive no invented
binding, control, replay requirement or negative fact. This change does not claim
to verify reasoning_content replay requirements. No ledger entries are added.
