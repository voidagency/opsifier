ALTER TABLE `backup_configs` ADD `scope` text DEFAULT 'database' NOT NULL;--> statement-breakpoint
ALTER TABLE `backup_restores` ADD `scope` text DEFAULT 'database' NOT NULL;