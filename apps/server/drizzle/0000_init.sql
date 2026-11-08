CREATE TABLE `actions` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`project_name` text,
	`service_name` text,
	`actor_email` text,
	`has_log` integer DEFAULT false NOT NULL,
	`log_truncated` integer DEFAULT false NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	CONSTRAINT "actions_status_check" CHECK("actions"."status" IN ('queued', 'running', 'succeeded', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `actions_id_unique` ON `actions` (`id`);--> statement-breakpoint
CREATE INDEX `actions_status_idx` ON `actions` (`status`);--> statement-breakpoint
CREATE INDEX `actions_service_idx` ON `actions` (`project_name`,`service_name`);--> statement-breakpoint
CREATE INDEX `actions_type_idx` ON `actions` (`type`);--> statement-breakpoint
CREATE TABLE `api_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`token_prefix` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`expires_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_token_hash_unique` ON `api_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `api_tokens_user_id_idx` ON `api_tokens` (`user_id`);--> statement-breakpoint
CREATE TABLE `domains` (
	`id` text PRIMARY KEY NOT NULL,
	`project_name` text NOT NULL,
	`service_name` text NOT NULL,
	`host` text NOT NULL,
	`path` text DEFAULT '/' NOT NULL,
	`port` integer NOT NULL,
	`https` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_name`,`service_name`) REFERENCES `services`(`project_name`,`name`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "domains_port_check" CHECK("domains"."port" BETWEEN 1 AND 65535)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `domains_host_path_unique` ON `domains` (`host`,`path`);--> statement-breakpoint
CREATE INDEX `domains_service_idx` ON `domains` (`project_name`,`service_name`);--> statement-breakpoint
CREATE TABLE `projects` (
	`name` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `services` (
	`project_name` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`spec` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`project_name`, `name`),
	FOREIGN KEY (`project_name`) REFERENCES `projects`(`name`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`user_id` text NOT NULL,
	`persistent` integer NOT NULL,
	`ip` text,
	`user_agent` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_id_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_expires_at_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text NOT NULL,
	`totp_secret` text,
	`totp_pending_secret` text,
	`totp_last_step` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "users_role_check" CHECK("users"."role" IN ('admin', 'member'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);