CREATE TABLE `studio_members` (
	`service_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`service_id`, `user_id`),
	FOREIGN KEY (`service_id`) REFERENCES `studio_apps`(`service_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `studio_members_user_idx` ON `studio_members` (`user_id`);