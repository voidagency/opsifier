CREATE TABLE `service_releases` (
	`service_id` text NOT NULL,
	`number` integer NOT NULL,
	`image` text NOT NULL,
	`image_id` text NOT NULL,
	`digest` text,
	`size_bytes` integer,
	`requested_ref` text,
	`built_commit` text,
	`oci_revision` text,
	`rollback_of` integer,
	`actor_email` text,
	`action_id` text,
	`snapshot` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`service_id`, `number`)
);
--> statement-breakpoint
ALTER TABLE `actions` ADD `deployment` text;--> statement-breakpoint
ALTER TABLE `services` ADD `deployed` text;