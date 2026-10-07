-- Custom SQL migration file, put your code below! --
-- `models.capabilities` becomes a yes/no flag map on every row, or null.
--
-- 1 and 2: a provider's native listing object (fal, byteplus, elevenlabs,
-- replicate, reactor) moves to `provider_metadata`. Such an object is told
-- from a flag map by a value that is not a boolean, or by one of the native
-- boolean keys those listings use. Every key moves but `asyncapi`, the one
-- flag sync writes beside them; it stays behind as the row's flag map.
--
-- 3: a flag list becomes a map: `["tools","seed"]` is
-- `{"tools":true,"seed":true}`. A list only ever said yes, so every key is
-- true; the poller adds the stated noes on its next pass. An empty list said
-- nothing a null does not, so it becomes null.
--
-- Each statement matches only the old shape, so a second run changes nothing.
UPDATE `models`
SET `provider_metadata` = (
  SELECT json_group_object(`key`, json(`models`.`capabilities` -> `fullkey`))
  FROM json_each(`models`.`capabilities`)
  WHERE `key` <> 'asyncapi'
)
WHERE json_type(`capabilities`) = 'object'
  AND EXISTS (
    SELECT 1 FROM json_each(`models`.`capabilities`)
    WHERE `key` <> 'asyncapi'
      AND (
        `type` NOT IN ('true', 'false')
        OR `key` IN ('canDoTextToSpeech', 'canDoVoiceConversion', 'official', 'structuredOutputProbed')
      )
  );
--> statement-breakpoint
UPDATE `models`
SET `capabilities` = CASE
  WHEN json_extract(`capabilities`, '$.asyncapi') = 1
    THEN json_object('asyncapi', json('true'))
  ELSE NULL
END
WHERE json_type(`capabilities`) = 'object'
  AND EXISTS (
    SELECT 1 FROM json_each(`models`.`capabilities`)
    WHERE `key` <> 'asyncapi'
      AND (
        `type` NOT IN ('true', 'false')
        OR `key` IN ('canDoTextToSpeech', 'canDoVoiceConversion', 'official', 'structuredOutputProbed')
      )
  );
--> statement-breakpoint
UPDATE `models`
SET `capabilities` = (
  SELECT CASE
    WHEN count(*) = 0 THEN NULL
    ELSE json_group_object(`flag`, json('true'))
  END
  FROM (
    SELECT DISTINCT `value` AS `flag`
    FROM json_each(`models`.`capabilities`)
    WHERE `type` = 'text'
  )
)
WHERE json_type(`capabilities`) = 'array';
