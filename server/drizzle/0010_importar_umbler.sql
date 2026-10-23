CREATE TABLE "umbler_imports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"phase" text,
	"analysis" jsonb,
	"mapping" jsonb,
	"progress" jsonb,
	"report" jsonb,
	"error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "umbler_map" (
	"kind" text NOT NULL,
	"umbler_id" text NOT NULL,
	"local_id" uuid NOT NULL,
	"done_at" timestamp with time zone,
	CONSTRAINT "umbler_map_kind_umbler_id_pk" PRIMARY KEY("kind","umbler_id")
);
--> statement-breakpoint
ALTER TABLE "umbler_imports" ADD CONSTRAINT "umbler_imports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "umbler_imports_one_active" ON "umbler_imports" USING btree ((true)) WHERE "umbler_imports"."state" in ('analyzing', 'running');--> statement-breakpoint
CREATE INDEX "umbler_map_local_idx" ON "umbler_map" USING btree ("kind","local_id");