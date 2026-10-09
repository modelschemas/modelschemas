# Kimi Coding native sources

The fixture was fetched on 2026-10-09 from
https://www.kimi.com/code/docs/en/kimi-code/models.html.
Production fetches that URL directly. Its Protocol table explicitly names both
`https://api.kimi.com/coding/v1` and `https://api.kimi.ai/coding/v1`.

The table states model IDs, context windows, media inputs and effort controls.
It does not state output modalities or per-model output limits; those remain null.
It states Thinking:ON for HighSpeed but no request control or off behavior;
only the reasoning capability is populated for that model.
No absence of `none` is interpreted as mandatory thinking.

Pricing stays null. The membership page at
https://www.kimi.com/code/docs/en/kimi-code/membership.html describes subscription
quota plus Extra Usage charged in RMB at rates shown in the authenticated
platform. Its example whole-request costs do not define per-token rates.
Do not copy Kimi Open Platform rates: the page says they are merely close.
Successful native reads explicitly clear stored quotes because this adapter cannot
verify any Coding-specific rate. This removes stale legacy prices instead of
presenting unrelated Open Platform rates as sourced Coding prices.

`fetchSpec` fetches and validates the native model table, records its URL/hash,
then explicitly skips because a complete Coding-owned request/response
schema has not been sourced. Protocol compatibility is not an owned schema.
No connect profile or generation binding is fabricated.
