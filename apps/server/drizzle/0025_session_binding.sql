ALTER TABLE `sessions` ADD `binding_hash` text;--> statement-breakpoint
-- Sessions opened before the second secret existed open with their cookie alone, wherever it was caught: everyone signs in again once.
DELETE FROM `sessions`;
