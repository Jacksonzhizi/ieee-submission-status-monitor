CREATE TABLE `monitors` (
	`id` text PRIMARY KEY NOT NULL,
	`journal_name` text NOT NULL,
	`journal_slug` text NOT NULL,
	`manuscript_url` text NOT NULL,
	`username` text NOT NULL,
	`password_ciphertext` text NOT NULL,
	`password_iv` text NOT NULL,
	`password_salt` text NOT NULL,
	`notify_email` text NOT NULL,
	`last_status` text,
	`last_status_detail` text,
	`last_checked_at` text,
	`last_changed_at` text,
	`check_count` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `status_events` (
	`id` text PRIMARY KEY NOT NULL,
	`monitor_id` text NOT NULL,
	`previous_status` text,
	`current_status` text NOT NULL,
	`detail` text,
	`raw_excerpt` text,
	`checked_at` text NOT NULL,
	`notification_sent_at` text,
	`notification_error` text,
	FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `status_events_monitor_checked_idx` ON `status_events` (`monitor_id`,`checked_at`);