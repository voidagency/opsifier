CREATE TABLE `git_known_hosts` (
	`id` text PRIMARY KEY NOT NULL,
	`host` text NOT NULL,
	`port` integer DEFAULT 22 NOT NULL,
	`key_type` text NOT NULL,
	`public_key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`added_by` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `git_known_hosts_key_unique` ON `git_known_hosts` (`host`,`port`,`key_type`,`public_key`);--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`hook_id` text NOT NULL,
	`delivery_id` text,
	`body_hash` text NOT NULL,
	`action_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_deliveries_hook_delivery_unique` ON `webhook_deliveries` (`hook_id`,`delivery_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_deliveries_hook_body_unique` ON `webhook_deliveries` (`hook_id`,`body_hash`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_created_idx` ON `webhook_deliveries` (`created_at`);--> statement-breakpoint
ALTER TABLE `actions` ADD `origin` text;--> statement-breakpoint
ALTER TABLE `actions` ADD `origin_detail` text;