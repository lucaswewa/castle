CREATE TABLE `room_features` (
	`code` text PRIMARY KEY NOT NULL,
	`white_time_ms` integer DEFAULT 600000 NOT NULL,
	`black_time_ms` integer DEFAULT 600000 NOT NULL,
	`turn_started_at` integer,
	`draw_offered_by` text,
	`rematch_white` integer DEFAULT 0 NOT NULL,
	`rematch_black` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
