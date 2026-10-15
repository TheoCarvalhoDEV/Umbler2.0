ALTER TABLE "contacts" ADD COLUMN "avatar_path" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "avatar_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "see_all_sectors" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "avatar_path" text;