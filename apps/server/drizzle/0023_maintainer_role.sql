PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_project_members` (
	`user_id` text NOT NULL,
	`project_name` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `project_name`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_name`) REFERENCES `projects`(`name`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "project_members_role_check" CHECK("__new_project_members"."role" IN ('viewer', 'operator', 'maintainer'))
);
--> statement-breakpoint
INSERT INTO `__new_project_members`("user_id", "project_name", "role", "created_at", "updated_at") SELECT "user_id", "project_name", "role", "created_at", "updated_at" FROM `project_members`;--> statement-breakpoint
DROP TABLE `project_members`;--> statement-breakpoint
ALTER TABLE `__new_project_members` RENAME TO `project_members`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `project_members_project_idx` ON `project_members` (`project_name`);