# NVIDIA native schema discovery (#269)

Checked 2026-10-09. Production fetches native public listing, model cards, reference
indexes and schema documents. Fixtures capture provider-owned responses only.
Production never reads fixtures. No models.dev source, handcrafted catalog,
upstream model-maker schema or generic borrowed schema is used.

The reference tables omit newer IDs. The native sitemap publishes their infer
pages. Names select candidate pages only: each binding requires one exact native
model ID from the structured schema model field or its native title. The title
prefix `NVIDIA NIM API for` is a wrapper, not part of the raw ID. Conflicting
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

Verified source conflict:
https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-5-content-safety-infer.md
embeds OpenAPI identifying nvidia/nemotron-3-nano-omni-30b-a3b-reasoning. It cannot be
assigned to nvidia/nemotron-3.5-content-safety. Discovery reports docsFailures (or
schema-fetch warnings), including expected and stated IDs. Affected schema-derived
facts are unavailable; no nano facts are borrowed. This is not source silence.

Two further reference pages state multiple identities and are also rejected:

- https://docs.api.nvidia.com/nim/reference/nvidia-llama-3_1-nemotron-safety-guard-8b-v3-infer.md
  states both `nvidia/llama-3_1-nemotron-safety-guard-8b-v3` and
  `nvidia/llama-3.1-nemotron-safety-guard-8b-v3`.
- https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-parse-2_0-infer.md
  states both `nvidia/nemotron-parse` and `nvidia/nemotron-parse-2.0`.

Malformed source failures are visible. Unmatched models receive no invented
binding, control, replay requirement or negative fact. This change does not claim
to verify reasoning_content replay requirements. No ledger entries are added.
