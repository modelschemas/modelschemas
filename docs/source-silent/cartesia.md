# cartesia spec sync

Cartesia's Stainless `.stats.yml` no longer publishes `openapi_spec_url`
(the file is `configured_endpoints` only). The previous GCS object returns
403, and the OpenAPI URLs listed on https://docs.cartesia.ai/llms.txt
(`/latest.yml`, `/2026-03-01/api.yml`) redirect to
`play.cartesia.ai/docs-auth-login`. `CARTESIA_API_KEY` does not pass that
gate. `cartesia-python` and `cartesia-js` do not bundle a mock spec.
Spec sync therefore throws and keeps the last stored schema versions
(issue #523). Checked 2026-10-29.

This file is a note, not a scored silence entry. The documents exist behind
login. They are not unpublished, so no gap-report fact is exempted.
