CREATE TABLE `actions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`payload` text NOT NULL,
	`preview` text NOT NULL,
	`result` text,
	`source` text NOT NULL,
	`source_ref` text,
	`approval_id` text,
	`requested_by` text NOT NULL,
	`idempotency_key` text,
	`created_at` text NOT NULL,
	`executed_at` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `actions_idem` ON `actions` (`workspace_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `actions_ws` ON `actions` (`workspace_id`,`status`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`campaign_id` text,
	`status` text DEFAULT 'open' NOT NULL,
	`action_id` text,
	`created_at` text NOT NULL,
	`done_at` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `tasks_ws` ON `tasks` (`workspace_id`,`status`);