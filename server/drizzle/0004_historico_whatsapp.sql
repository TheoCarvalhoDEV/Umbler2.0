CREATE TABLE "history_imports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"period" text NOT NULL,
	"auto" boolean NOT NULL,
	"state" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"messages_imported" integer DEFAULT 0 NOT NULL,
	"contacts_created" integer DEFAULT 0 NOT NULL,
	"oldest_message_at" timestamp with time zone,
	"error" text,
	"last_new_at" timestamp with time zone,
	"next_run_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "history_period" text DEFAULT '3m' NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "backfill_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "disconnected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "history" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "media_status" text;--> statement-breakpoint
ALTER TABLE "history_imports" ADD CONSTRAINT "history_imports_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "history_imports_one_running_per_channel" ON "history_imports" USING btree ("channel_id") WHERE "history_imports"."state" = 'running';--> statement-breakpoint
CREATE INDEX "history_imports_channel_idx" ON "history_imports" USING btree ("channel_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chats_one_history_per_contact_channel" ON "chats" USING btree ("contact_id","channel_id") WHERE "chats"."history" = true;--> statement-breakpoint
CREATE INDEX "messages_media_queued_idx" ON "messages" USING btree ("sent_at") WHERE "messages"."media_status" = 'queued';