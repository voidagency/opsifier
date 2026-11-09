CREATE TABLE `backup_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_name` text NOT NULL,
	`service_name` text NOT NULL,
	`kind` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`schedule` text NOT NULL,
	`retention` integer,
	`database_name` text,
	`volume_name` text,
	`storage_provider_id` text,
	`path` text NOT NULL,
	`next_run_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`storage_provider_id`) REFERENCES `storage_providers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`project_name`,`service_name`) REFERENCES `services`(`project_name`,`name`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "backup_configs_kind_check" CHECK("backup_configs"."kind" IN ('database', 'volume'))
);
--> statement-breakpoint
CREATE INDEX `backup_configs_service_idx` ON `backup_configs` (`project_name`,`service_name`);--> statement-breakpoint
CREATE INDEX `backup_configs_next_run_idx` ON `backup_configs` (`next_run_at`);--> statement-breakpoint
CREATE TABLE `backup_restores` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`project_name` text NOT NULL,
	`service_name` text NOT NULL,
	`kind` text NOT NULL,
	`backup_id` text,
	`storage_provider_name` text NOT NULL,
	`source_path` text NOT NULL,
	`database_name` text,
	`volume_name` text,
	`status` text NOT NULL,
	`phase` text NOT NULL,
	`safety_backup_id` text,
	`earlier_copy` text,
	`previous_replicas` integer,
	`actor_email` text,
	`action_id` text,
	`error` text,
	`unresolved` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `backup_restores_id_unique` ON `backup_restores` (`id`);--> statement-breakpoint
CREATE INDEX `backup_restores_service_idx` ON `backup_restores` (`project_name`,`service_name`,`seq`);--> statement-breakpoint
CREATE INDEX `backup_restores_status_idx` ON `backup_restores` (`status`);--> statement-breakpoint
CREATE TABLE `backups` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`project_name` text NOT NULL,
	`service_name` text NOT NULL,
	`config_id` text,
	`kind` text NOT NULL,
	`origin` text NOT NULL,
	`name` text,
	`status` text NOT NULL,
	`database_name` text,
	`volume_name` text,
	`engine` text,
	`engine_version` text,
	`format` text,
	`scope` text NOT NULL,
	`storage_provider_id` text,
	`storage_provider_name` text NOT NULL,
	`path` text NOT NULL,
	`size_bytes` integer,
	`sha256` text,
	`action_id` text,
	`error` text,
	`cleanup_error` text,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	`deleted_at` integer,
	FOREIGN KEY (`config_id`) REFERENCES `backup_configs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `backups_id_unique` ON `backups` (`id`);--> statement-breakpoint
CREATE INDEX `backups_service_idx` ON `backups` (`project_name`,`service_name`,`seq`);--> statement-breakpoint
CREATE INDEX `backups_config_idx` ON `backups` (`config_id`);--> statement-breakpoint
CREATE INDEX `backups_status_idx` ON `backups` (`status`);--> statement-breakpoint
CREATE TABLE `storage_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`built_in` integer DEFAULT false NOT NULL,
	`config` text NOT NULL,
	`sealed_secrets` text,
	`connected` integer DEFAULT true NOT NULL,
	`last_check_at` integer,
	`last_check_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `storage_providers_name_unique` ON `storage_providers` (`name`);--> statement-breakpoint
CREATE TABLE `template_installs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_name` text NOT NULL,
	`template_id` text NOT NULL,
	`template_version` text NOT NULL,
	`template_name` text NOT NULL,
	`category` text NOT NULL,
	`custom` integer DEFAULT false NOT NULL,
	`instructions` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_name`) REFERENCES `projects`(`name`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `template_installs_project_idx` ON `template_installs` (`project_name`);--> statement-breakpoint
ALTER TABLE `domains` ADD `compose_service` text;