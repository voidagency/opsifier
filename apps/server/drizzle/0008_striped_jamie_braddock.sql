CREATE TABLE `console_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_name` text NOT NULL,
	`service_name` text NOT NULL,
	`task` text NOT NULL,
	`started_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `log_cursors` (
	`project_name` text NOT NULL,
	`service_name` text NOT NULL,
	`last_at` text NOT NULL,
	PRIMARY KEY(`project_name`, `service_name`)
);
