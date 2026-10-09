# Meta Model API native sources (#163)

The current public [models document](https://dev.meta.ai/docs/models) publishes eight API-hosted identifiers in model tables. The adapter parses those tables dynamically, including the Standard and Contributor variants. Self-hosted Muse Glimmer is explicitly excluded from the hosted tables by Meta; the adapter creates no serving row for it. An empty or structurally unreadable model source throws, preserving stored rows through a failed poll.

[Native pricing](https://dev.meta.ai/docs/pricing-rate-limits) supplies each Spark tier's model identifiers and token meters, Image's generated-image meter, Voice Transcribe's audio duration, and SAM's image/frame meters. The adapter never fills a missing quote from another model, weights repository, SDK, or provider. Unknown output limits and release dates remain null. No API key is needed to read these public documents; an authenticated team-specific API listing is not claimed.

[Native reasoning](https://dev.meta.ai/docs/reasoning) publishes supported efforts, explains that Spark cannot disable reasoning, and restricts `max` to the Standard-tier model explicitly named in its table. [Native protocols](https://dev.meta.ai/docs/protocols) publish the three chat routes; the models document also publishes Image and ASR endpoint paths. Each route's operation page names its own request and response definitions:

- [Chat operation](https://dev.meta.ai/docs/api-reference/chat-completions/create-chat-completion) and [schemas](https://dev.meta.ai/docs/api-reference/chat-completions/schemas).
- [Responses operation](https://dev.meta.ai/docs/api-reference/responses/create-response) and [schemas](https://dev.meta.ai/docs/api-reference/responses/schemas).
- [Image generation](https://dev.meta.ai/docs/api-reference/images/create-image), [editing](https://dev.meta.ai/docs/api-reference/images/edit-image), and [schemas](https://dev.meta.ai/docs/api-reference/images/schemas).
- [ASR transcription](https://dev.meta.ai/docs/api-reference/voice/transcribe) and [schemas](https://dev.meta.ai/docs/api-reference/voice/schemas).
- [Messages operation](https://dev.meta.ai/docs/api-reference/messages/create-message) and [schemas](https://dev.meta.ai/docs/api-reference/messages/schemas).

The schema translator reads Meta's own field/type/required/description tables, aliases, unions, enum values, array nesting and stated constraints. It does not import OpenAI, Anthropic, or the older Llama SDK schemas. Unknown named types, missing cells, and unresolved references throw. Meta explicitly leaves the Type cell for a Responses `ToolSearchCall.arguments` field blank; that field retains its source-published required marker and an unconstrained schema with `x-source-type: null`, without a guessed type.

Each generated spec has index-aligned provenance whose revision hash includes its native schema document, operation document, and protocol document. Fixtures capture those same public pages, with only decorative attributes, wrapper tags, and sample code blocks removed; they are offline parser tests, never a production catalog or fallback.

The adapter publishes six native generation endpoints across the three conversational protocols, image generation/editing, and ASR transcription. Meta's ASR operation declares its multipart request only as inline `object`, without field definitions. That exact declared shape is emitted with `x-source-fields: null`; no guessed multipart fields or constraints are inserted. SAM's catalog activity remains null because the current activity vocabulary has no segmentation activity; it is not assigned a chat schema. Authenticated team-specific availability, ASR realtime WebSocket schemas, and unspecified model output limits are not claimed.
