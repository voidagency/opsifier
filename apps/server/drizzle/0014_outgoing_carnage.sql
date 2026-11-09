CREATE TABLE `script_runs` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`project_name` text NOT NULL,
	`service_name` text NOT NULL,
	`script_name` text NOT NULL,
	`origin` text NOT NULL,
	`actor_email` text,
	`origin_detail` text,
	`status` text NOT NULL,
	`exit_code` integer,
	`task_id` text,
	`task_slot` integer,
	`exec_id` text,
	`max_duration_seconds` integer NOT NULL,
	`note_code` text,
	`note` text,
	`output` text DEFAULT '' NOT NULL,
	`output_truncated` integer DEFAULT false NOT NULL,
	`output_complete` integer DEFAULT true NOT NULL,
	`due_at` integer,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`project_name`,`service_name`) REFERENCES `services`(`project_name`,`name`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "script_runs_status_check" CHECK("script_runs"."status" IN ('queued', 'running', 'succeeded', 'failed', 'timed_out', 'cancelled', 'skipped', 'unknown')),
	CONSTRAINT "script_runs_origin_check" CHECK("script_runs"."origin" IN ('manual', 'api', 'schedule', 'hook', 'console'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `script_runs_id_unique` ON `script_runs` (`id`);--> statement-breakpoint
CREATE INDEX `script_runs_script_idx` ON `script_runs` (`project_name`,`service_name`,`script_name`);--> statement-breakpoint
CREATE INDEX `script_runs_status_idx` ON `script_runs` (`status`);--> statement-breakpoint
CREATE TABLE `script_schedules` (
	`project_name` text NOT NULL,
	`service_name` text NOT NULL,
	`script_name` text NOT NULL,
	`next_run_at` integer NOT NULL,
	PRIMARY KEY(`project_name`, `service_name`, `script_name`),
	FOREIGN KEY (`project_name`,`service_name`) REFERENCES `services`(`project_name`,`name`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `script_schedules_next_run_idx` ON `script_schedules` (`next_run_at`);