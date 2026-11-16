ALTER TABLE `studio_apps` ADD `agent_service_id` text REFERENCES services(id) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
ALTER TABLE `studio_apps` ADD `repository` text;--> statement-breakpoint
ALTER TABLE `studio_apps` ADD `git_token_hash` text;--> statement-breakpoint
ALTER TABLE `studio_conversations` ADD `shared_agent` integer DEFAULT true NOT NULL;