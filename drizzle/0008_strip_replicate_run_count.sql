-- Replicate run_count is usage telemetry, not a catalog fact (#92). Strip it
-- from stored rows so the first poll after deploy does not diff every model.
UPDATE `models` SET `capabilities` = json_remove(`capabilities`, '$.runCount')
WHERE `provider_id` = 'replicate' AND json_type(`capabilities`, '$.runCount') IS NOT NULL;
