CREATE TABLE `studio_conversation_events` (
	`conversation_id` text NOT NULL,
	`position` integer NOT NULL,
	`event_id` text NOT NULL,
	`data` text NOT NULL,
	PRIMARY KEY(`conversation_id`, `position`),
	FOREIGN KEY (`conversation_id`) REFERENCES `studio_conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `studio_conversation_events_event_unique` ON `studio_conversation_events` (`conversation_id`,`event_id`);