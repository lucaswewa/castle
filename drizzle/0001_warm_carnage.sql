CREATE TABLE `active_rooms` (
	`code` text PRIMARY KEY NOT NULL,
	`fen` text NOT NULL,
	`pgn` text DEFAULT '' NOT NULL,
	`white_username` text,
	`black_username` text,
	`status` text DEFAULT 'waiting' NOT NULL,
	`last_from` text,
	`last_to` text,
	`winner` text,
	`settled` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
