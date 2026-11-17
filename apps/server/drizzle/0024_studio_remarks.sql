CREATE TABLE `studio_guest_links` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`label` text NOT NULL,
	`token_hash` text NOT NULL,
	`remarks` integer DEFAULT true NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`last_used_at` integer,
	FOREIGN KEY (`service_id`) REFERENCES `studio_apps`(`service_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `studio_guest_links_token_idx` ON `studio_guest_links` (`token_hash`);--> statement-breakpoint
CREATE INDEX `studio_guest_links_service_idx` ON `studio_guest_links` (`service_id`);--> statement-breakpoint
CREATE TABLE `studio_remarks` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`number` integer NOT NULL,
	`path` text NOT NULL,
	`element` text,
	`point` text,
	`viewport` text,
	`text` text NOT NULL,
	`author` text NOT NULL,
	`author_kind` text NOT NULL,
	`guest_link_id` text,
	`user_id` text,
	`status` text DEFAULT 'new' NOT NULL,
	`conversation_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `studio_apps`(`service_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`guest_link_id`) REFERENCES `studio_guest_links`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `studio_remarks_number_idx` ON `studio_remarks` (`service_id`,`number`);--> statement-breakpoint
CREATE INDEX `studio_remarks_guest_link_idx` ON `studio_remarks` (`guest_link_id`);--> statement-breakpoint
ALTER TABLE `studio_apps` ADD `remark_counter` integer DEFAULT 0 NOT NULL;