CREATE TABLE `games` (
	`id` text PRIMARY KEY NOT NULL,
	`room_code` text NOT NULL,
	`white_username` text NOT NULL,
	`black_username` text NOT NULL,
	`result` text NOT NULL,
	`pgn` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `players` (
	`username` text PRIMARY KEY NOT NULL,
	`rating` integer DEFAULT 1200 NOT NULL,
	`wins` integer DEFAULT 0 NOT NULL,
	`losses` integer DEFAULT 0 NOT NULL,
	`draws` integer DEFAULT 0 NOT NULL,
	`games` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
