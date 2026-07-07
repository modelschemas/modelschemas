# Providers to add — credential checklist

Working list for expanding past the current 7 (OpenAI, Anthropic, Gemini, Grok,
ElevenLabs, OpenRouter, FAL). Ordered by priority.

**Two things need auth, separately:**

- **Schemas** (`fetchSpec`) — keyless whenever the provider publishes a public
  spec URL. This is the core product.
- **Model list** (`listModels`) — needs the key below. Missing key → schemas
  still sync, model list is skipped. So a provider can ship schema-only first,
  key added later.

Set each secret in Doppler under the name in the **Secret** column (must match
`ProviderSecrets` in `src/server/providers/types.ts`). Console URLs are
best-known — confirm on signup.

## Simple API key (bearer) — the easy batch

| Secret                | Provider          | Activity                          | Get it at                          |
| --------------------- | ----------------- | --------------------------------- | ---------------------------------- |
| `MISTRAL_API_KEY`     | Mistral           | chat · embed · moderation · audio | console.mistral.ai                 |
| `REPLICATE_API_TOKEN` | Replicate         | chat · image · video · audio      | replicate.com/account/api-tokens   |
| `GROQ_API_KEY`        | Groq              | chat · audio                      | console.groq.com/keys              |
| `FIREWORKS_API_KEY`   | Fireworks AI      | chat                              | fireworks.ai → API keys            |
| `TOGETHER_API_KEY`    | Together AI       | chat                              | api.together.ai → settings         |
| `VOYAGE_API_KEY`      | Voyage AI         | embed                             | dashboard.voyageai.com             |
| `COHERE_API_KEY`      | Cohere            | chat · embed                      | dashboard.cohere.com/api-keys      |
| `DEEPSEEK_API_KEY`    | DeepSeek          | chat                              | platform.deepseek.com              |
| `DEEPGRAM_API_KEY`    | Deepgram          | audio                             | console.deepgram.com               |
| `ASSEMBLYAI_API_KEY`  | AssemblyAI        | audio                             | assemblyai.com → dashboard         |
| `RUNWAY_API_KEY`      | Runway            | video · image                     | dev.runwayml.com                   |
| `CARTESIA_API_KEY`    | Cartesia          | audio                             | play.cartesia.ai → API keys        |
| `PERPLEXITY_API_KEY`  | Perplexity        | chat                              | perplexity.ai/settings/api         |
| `CEREBRAS_API_KEY`    | Cerebras          | chat                              | cloud.cerebras.ai                  |
| `SAMBANOVA_API_KEY`   | SambaNova         | chat                              | cloud.sambanova.ai                 |
| `JINA_API_KEY`        | Jina AI           | embed                             | jina.ai → API                      |
| `STABILITY_API_KEY`   | Stability AI      | image                             | platform.stability.ai/account/keys |
| `BFL_API_KEY`         | Black Forest Labs | image                             | api.bfl.ai (FLUX)                  |
| `KLING_API_KEY`       | Kling AI          | video · image                     | app.klingai.com → dev console      |
| `HYPERBOLIC_API_KEY`  | Hyperbolic        | chat                              | app.hyperbolic.xyz                 |
| `NOVITA_API_KEY`      | Novita AI         | chat · image                      | novita.ai → key management         |

## Special auth — higher effort, do these later

| Secret(s)                                                          | Provider            | Why it's harder                                                                           |
| ------------------------------------------------------------------ | ------------------- | ----------------------------------------------------------------------------------------- |
| `BYTEPLUS_ACCESS_KEY` + `BYTEPLUS_SECRET_KEY`                      | BytePlus (ModelArk) | Signature auth (HMAC), not a bearer token. Seedance/Seedream/Doubao. console.byteplus.com |
| AWS creds (`AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` + region) | AWS Bedrock         | SigV4 / IAM. Spec is Smithy models, not one OpenAPI URL.                                  |
| service-account JSON                                               | Google Vertex AI    | OAuth service account, per-project routing.                                               |
| `AZURE_OPENAI_API_KEY` + endpoint                                  | Azure OpenAI        | Key + resource endpoint + `api-version`; deployment-name routing.                         |

## Keyless — no credential needed

Aggregators/specs that fetch without auth (like OpenRouter today): confirm each
provider's spec URL and `/models` endpoint are public before assuming. Portkey,
LiteLLM, and other gateways still need their own key if we poll their catalogs.
