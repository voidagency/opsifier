ALTER TABLE `services` ADD `id` text;--> statement-breakpoint
ALTER TABLE `services` ADD `applied` text;--> statement-breakpoint
ALTER TABLE `services` ADD `answering` integer;--> statement-breakpoint
ALTER TABLE `services` ADD `runtime_uncertain` text;--> statement-breakpoint
CREATE UNIQUE INDEX `services_id_unique` ON `services` (`id`);