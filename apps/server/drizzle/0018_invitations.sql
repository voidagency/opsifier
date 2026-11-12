CREATE TABLE `invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`projects` text NOT NULL,
	`token_hash` text NOT NULL,
	`invited_by` text NOT NULL,
	`delivery` text NOT NULL,
	`channel_name` text,
	`sent_at` integer,
	`delivery_error` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`invited_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "invitations_role_check" CHECK("invitations"."role" IN ('admin', 'member')),
	CONSTRAINT "invitations_delivery_check" CHECK("invitations"."delivery" IN ('link', 'sending', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invitations_token_hash_unique` ON `invitations` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `invitations_email_unique` ON `invitations` (`email`);--> statement-breakpoint
CREATE INDEX `invitations_invited_by_idx` ON `invitations` (`invited_by`);