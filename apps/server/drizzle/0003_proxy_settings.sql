DROP INDEX `domains_host_path_unique`;--> statement-breakpoint
ALTER TABLE `domains` ADD `destination_protocol` text DEFAULT 'http' NOT NULL;--> statement-breakpoint
ALTER TABLE `domains` ADD `destination_path` text DEFAULT '/' NOT NULL;--> statement-breakpoint
ALTER TABLE `domains` ADD `certificate_resolver` text;--> statement-breakpoint
ALTER TABLE `domains` ADD `wildcard` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `domains` ADD `middlewares` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `domains_host_path_unique` ON `domains` (`host`,`path`,`wildcard`);