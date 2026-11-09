CREATE TABLE `retained_volumes` (
	`name` text PRIMARY KEY NOT NULL,
	`project_name` text NOT NULL,
	`service_name` text NOT NULL,
	`kind` text NOT NULL,
	`retained_at` integer NOT NULL,
	CONSTRAINT "retained_volumes_kind_check" CHECK("retained_volumes"."kind" IN ('app', 'database', 'compose'))
);
--> statement-breakpoint
CREATE INDEX `retained_volumes_service_idx` ON `retained_volumes` (`project_name`,`service_name`);