CREATE TABLE `studio_apps` (
	`service_id` text PRIMARY KEY NOT NULL,
	`workspace_dir` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `studio_conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`title` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `studio_apps`(`service_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `studio_conversations_service_idx` ON `studio_conversations` (`service_id`,`updated_at`);