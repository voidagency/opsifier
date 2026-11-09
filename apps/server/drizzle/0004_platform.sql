CREATE TABLE `custom_domains` (
	`id` text PRIMARY KEY NOT NULL,
	`host` text NOT NULL,
	`path` text DEFAULT '/' NOT NULL,
	`https` integer DEFAULT true NOT NULL,
	`servers` text NOT NULL,
	`certificate_resolver` text,
	`wildcard` integer DEFAULT false NOT NULL,
	`middlewares` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `custom_domains_host_path_unique` ON `custom_domains` (`host`,`path`,`wildcard`);--> statement-breakpoint
CREATE TABLE `log_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_name` text NOT NULL,
	`service_name` text NOT NULL,
	`at` integer NOT NULL,
	`stream` text NOT NULL,
	`level` text NOT NULL,
	`line` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `log_entries_service_at_idx` ON `log_entries` (`project_name`,`service_name`,`at`);--> statement-breakpoint
CREATE INDEX `log_entries_at_idx` ON `log_entries` (`at`);--> statement-breakpoint
CREATE TABLE `metric_samples` (
	`scope` text NOT NULL,
	`resolution` integer NOT NULL,
	`at` integer NOT NULL,
	`cpu` real,
	`memory_used` real,
	`memory_total` real,
	`disk_used` real,
	`disk_total` real,
	`rx` real,
	`tx` real,
	`readings` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`scope`, `resolution`, `at`)
);
--> statement-breakpoint
CREATE INDEX `metric_samples_resolution_at_idx` ON `metric_samples` (`resolution`,`at`);--> statement-breakpoint
CREATE TABLE `notification_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`config` text NOT NULL,
	`sealed_secrets` text,
	`events` text NOT NULL,
	`last_disk_check_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notification_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`channel_id` text,
	`channel_name` text NOT NULL,
	`event` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_deliveries_event_channel_unique` ON `notification_deliveries` (`event_id`,`channel_id`);--> statement-breakpoint
CREATE INDEX `notification_deliveries_created_idx` ON `notification_deliveries` (`created_at`);--> statement-breakpoint
CREATE TABLE `project_members` (
	`user_id` text NOT NULL,
	`project_name` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `project_name`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_name`) REFERENCES `projects`(`name`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "project_members_role_check" CHECK("project_members"."role" IN ('viewer', 'operator'))
);
--> statement-breakpoint
CREATE INDEX `project_members_project_idx` ON `project_members` (`project_name`);--> statement-breakpoint
ALTER TABLE `api_tokens` ADD `level` text DEFAULT 'write' NOT NULL;--> statement-breakpoint
ALTER TABLE `api_tokens` ADD `projects` text;--> statement-breakpoint
ALTER TABLE `users` ADD `is_owner` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE `users` SET `is_owner` = 1 WHERE `id` = (SELECT `id` FROM `users` ORDER BY `created_at`, rowid LIMIT 1);--> statement-breakpoint
CREATE UNIQUE INDEX `users_one_owner` ON `users` (`is_owner`) WHERE "users"."is_owner" = 1;