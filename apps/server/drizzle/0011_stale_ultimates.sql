PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_actions` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`project_name` text,
	`service_name` text,
	`actor_email` text,
	`origin` text,
	`origin_detail` text,
	`has_log` integer DEFAULT false NOT NULL,
	`log_truncated` integer DEFAULT false NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	CONSTRAINT "actions_status_check" CHECK("__new_actions"."status" IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'uncertain'))
);
--> statement-breakpoint
INSERT INTO `__new_actions`("seq", "id", "type", "title", "status", "project_name", "service_name", "actor_email", "origin", "origin_detail", "has_log", "log_truncated", "error", "created_at", "started_at", "finished_at") SELECT "seq", "id", "type", "title", "status", "project_name", "service_name", "actor_email", "origin", "origin_detail", "has_log", "log_truncated", "error", "created_at", "started_at", "finished_at" FROM `actions`;--> statement-breakpoint
DROP TABLE `actions`;--> statement-breakpoint
ALTER TABLE `__new_actions` RENAME TO `actions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `actions_id_unique` ON `actions` (`id`);--> statement-breakpoint
CREATE INDEX `actions_status_idx` ON `actions` (`status`);--> statement-breakpoint
CREATE INDEX `actions_service_idx` ON `actions` (`project_name`,`service_name`);--> statement-breakpoint
CREATE INDEX `actions_type_idx` ON `actions` (`type`);