ALTER TABLE `custom_domains` ADD `strip_path` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `domains` ADD `strip_path` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `domains` ADD `upstream_server_name` text;--> statement-breakpoint
ALTER TABLE `domains` ADD `upstream_ca` text;