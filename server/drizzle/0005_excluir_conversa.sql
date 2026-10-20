CREATE TABLE "deleted_chats" (
	"id" uuid PRIMARY KEY NOT NULL,
	"contact_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"until" timestamp with time zone NOT NULL,
	"deleted_by" uuid,
	"deleted_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deleted_chats" ADD CONSTRAINT "deleted_chats_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deleted_chats" ADD CONSTRAINT "deleted_chats_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deleted_chats" ADD CONSTRAINT "deleted_chats_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deleted_chats_channel_contact_idx" ON "deleted_chats" USING btree ("channel_id","contact_id");