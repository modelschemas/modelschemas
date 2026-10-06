-- Issue #197. models.dev is not a catalog source. Null those rate cards
-- (a provider docs card has a different source url and stays), drop schema
-- versions taken from that document, and deprecate the frozen catalogs on
-- adapters whose listModels still skips. A skip is not an empty list, so
-- this is a one-time statement: a later first-party poll clears
-- deprecated_at for ids that list returns.
UPDATE `models`
SET
  `pricing` = NULL,
  `fact_sources` = CASE
    WHEN json_remove(`fact_sources`, '$.pricing') = '{}' THEN NULL
    ELSE json_remove(`fact_sources`, '$.pricing')
  END
WHERE json_extract(`pricing`, '$.source.url') = 'https://models.dev/api.json';

UPDATE `models`
SET `deprecated_at` = unixepoch()
WHERE
  `deprecated_at` IS NULL
  AND `provider_id` IN (
    'cloudflare-ai-gateway',
    'google-vertex',
    'google-vertex-anthropic',
    'kimi-code-plan-cn',
    'kimi-code-plan-global',
    'meta',
    'xiaomi'
  );

DELETE FROM `schema_versions`
WHERE `source_url` = 'https://models.dev/api.json';
