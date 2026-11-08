ALTER TABLE `domains` ADD `is_primary` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `domains_one_primary_per_service` ON `domains` (`project_name`,`service_name`) WHERE "domains"."is_primary" = 1;--> statement-breakpoint
ALTER TABLE `projects` ADD `env` text DEFAULT '' NOT NULL;