# Provider pricing verification (#272)

These observations verify the disputed rows against each serving provider. They are review evidence, not a production model or price registry. Production values continue to be parsed on each source refresh. Prices below are per million tokens and were checked against current provider sources on 2026-10-09.

## Amazon Bedrock

[AWS pricing](https://aws.amazon.com/bedrock/pricing/) publishes separate Global and Geo/in-Region tables. Its dynamic tokens resolve through the [native metered price map](https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/bedrockfoundationmodels/USD/current/bedrockfoundationmodels.json), including the current encoded `public/...` token paths.

Claude Opus 5.5 Global input/output/cache-read are USD 4/20/0.20; Geo/in-Region input/output/cache-read are 4.40/22/0.22. The [native Opus 5.5 card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-5-5.md) explicitly publishes the base model and US/EU/AU/JP/Global profile identifiers. They represent separate catalog rows and do not inherit base prices or aliases. Global rows use their own card quote, or an explicitly Global quote in the AWS pricing page.

The [native Nova Lite card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-lite.md) publishes the EU profile ID, but that identifier does not identify a billed AWS region. AWS offers quote different regional rates: [US East](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/us-east-1/index.json) 0.06/0.24; [Ireland](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/eu-west-1/index.json) 0.069/0.276; [Frankfurt](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/eu-central-1/index.json) 0.078/0.312. A single EU quote cannot be assigned from its ID alone. Geo profile pricing remains null and explicitly clears an inherited base quote. The native `ListInferenceProfiles` API returned `403 AccessDeniedException` with the configured credentials in both US East and Ireland, so card rows do not claim complete API inventory.

## Mistral

The [native pricing table](https://docs.mistral.ai/inference/pricing) and [Large 4 model widget](https://docs.mistral.ai/models/mistral-large-4-0) both publish a current launch-discount price of USD 0.68 input / 2.09 output / 0.07 cache-read. Historical crossed-out prices and widget `originalPrice` must never replace the current billed price. Missing or unreadable sale/widget prices throw.

The authenticated [native model API](https://api.mistral.ai/v1/models) maps `magistral-medium-latest` to the current Medium model and bills `mistral-medium-3.5`; its [model page](https://docs.mistral.ai/models/mistral-medium-3-5-26-04) quotes 1.50/7.50. `ministral-8b-latest` maps to the model on the [Ministral 3 8B page](https://docs.mistral.ai/models/ministral-3-8b-25-12), which quotes 0.15/0.15. Those existing dynamically refreshed quotes need no correction.

## Hugging Face, Together, OpenCode

The [Hugging Face native router listing](https://router.huggingface.co/v1/models) publishes distinct quotes for each inference provider. The existing adapter's fastest-provider selection correctly selects Together's 1.04/1.04 for Llama 3.3 70B and Novita's 0.522/1.044 for `XiaomiMiMo/MiMo-V2.5-Pro` in the checked native source. A different host's quote must not be substituted; the selected provider's native pricing path is retained as provenance. These quotes can change with the native listing.

[Together's native serverless list](https://docs.together.ai/docs/serverless/models.md) confirms Qwen 3.7 Max 2.50/7.50 with cache-read 0.50. [OpenCode's native Zen documentation](https://opencode.ai/docs/zen.md) confirms GPT 5.6 Terra 2/12, cache-read 0.20 and cache-write 2.50 up to 272K input tokens, with the published higher context tier. These existing dynamic quotes need no correction. No comparison catalog supplied production data for this verification.
