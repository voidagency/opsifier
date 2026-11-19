CREATE TABLE `studio_remark_screenshots` (
	`remark_id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`data` blob NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`remark_id`) REFERENCES `studio_remarks`(`id`) ON UPDATE no action ON DELETE cascade
);
