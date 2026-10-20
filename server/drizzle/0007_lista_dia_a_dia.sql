CREATE TABLE "chat_tags" (
	"chat_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "chat_tags_chat_id_tag_id_pk" PRIMARY KEY("chat_id","tag_id")
);
--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "waiting_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_tags" ADD CONSTRAINT "chat_tags_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_tags" ADD CONSTRAINT "chat_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;