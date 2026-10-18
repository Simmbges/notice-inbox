CREATE TABLE `notices` (
	`owner_id` text NOT NULL,
	`id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`data` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`owner_id`, `id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notices_owner_fingerprint` ON `notices` (`owner_id`,`fingerprint`);