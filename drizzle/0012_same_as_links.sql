-- Hand-written: evidence of a model's upstream identity is stored apart from
-- the resolved link. Nullable columns are added in place so the catalog is
-- not copied through a table rebuild.
CREATE TABLE `provider_model_namespaces` (
  `namespace` text NOT NULL,
  `provider_id` text NOT NULL,
  PRIMARY KEY (`namespace`, `provider_id`),
  FOREIGN KEY (`provider_id`) REFERENCES `providers` (`id`) ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `provider_model_namespaces_providerId_idx`
  ON `provider_model_namespaces` (`provider_id`);
--> statement-breakpoint
ALTER TABLE `models` ADD `upstream_provider` text;
--> statement-breakpoint
ALTER TABLE `models` ADD `upstream_source` text;
--> statement-breakpoint
ALTER TABLE `models` ADD `upstream_raw_id` text
  CONSTRAINT `models_upstream_identity_pair`
  CHECK ((`upstream_provider` IS NULL) = (`upstream_raw_id` IS NULL)
    AND (`upstream_provider` IS NULL) = (`upstream_source` IS NULL));
--> statement-breakpoint
ALTER TABLE `models` ADD `same_as_model_id` text
  REFERENCES `models` (`id`) ON DELETE set null
  CONSTRAINT `models_sameAs_not_self` CHECK (`same_as_model_id` != `id`);
--> statement-breakpoint
CREATE INDEX `models_sameAsModelId_idx` ON `models` (`same_as_model_id`);
