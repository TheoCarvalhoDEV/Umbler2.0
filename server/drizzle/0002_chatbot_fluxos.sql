CREATE TABLE "bot_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"bot_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"chat_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"state" text DEFAULT 'running' NOT NULL,
	"current_node_id" text NOT NULL,
	"wait_node_id" text,
	"wake_at" timestamp with time zone,
	"timeout_at" timestamp with time zone,
	"waiting_since" timestamp with time zone,
	"retries" integer DEFAULT 0 NOT NULL,
	"vars" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"depth" integer DEFAULT 0 NOT NULL,
	"parent_run_id" uuid,
	"started_by" uuid,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "bot_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"bot_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"graph" jsonb NOT NULL,
	"valid" boolean NOT NULL,
	"created_by" uuid,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'paused' NOT NULL,
	"start_channel_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"manual_start" boolean DEFAULT false NOT NULL,
	"manual_title" text DEFAULT '' NOT NULL,
	"manual_unlisted" boolean DEFAULT false NOT NULL,
	"published_version_id" uuid,
	"run_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bots_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "bot_run_id" uuid;--> statement-breakpoint
ALTER TABLE "bot_runs" ADD CONSTRAINT "bot_runs_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_runs" ADD CONSTRAINT "bot_runs_version_id_bot_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."bot_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_runs" ADD CONSTRAINT "bot_runs_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_runs" ADD CONSTRAINT "bot_runs_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_runs" ADD CONSTRAINT "bot_runs_parent_run_id_bot_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."bot_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_runs" ADD CONSTRAINT "bot_runs_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_versions" ADD CONSTRAINT "bot_versions_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_versions" ADD CONSTRAINT "bot_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bots" ADD CONSTRAINT "bots_published_version_id_bot_versions_id_fk" FOREIGN KEY ("published_version_id") REFERENCES "public"."bot_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bot_runs_state_wake_idx" ON "bot_runs" USING btree ("state","wake_at");--> statement-breakpoint
CREATE INDEX "bot_runs_state_timeout_idx" ON "bot_runs" USING btree ("state","timeout_at");--> statement-breakpoint
CREATE INDEX "bot_runs_chat_idx" ON "bot_runs" USING btree ("chat_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bot_runs_one_active_per_chat_bot" ON "bot_runs" USING btree ("chat_id","bot_id") WHERE "bot_runs"."state" in ('running','waiting_reply','waiting_timer','waiting_flow') and "bot_runs"."depth" = 0;--> statement-breakpoint
CREATE UNIQUE INDEX "bot_versions_bot_number_unique" ON "bot_versions" USING btree ("bot_id","number");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_bot_run_id_bot_runs_id_fk" FOREIGN KEY ("bot_run_id") REFERENCES "public"."bot_runs"("id") ON DELETE set null ON UPDATE no action;