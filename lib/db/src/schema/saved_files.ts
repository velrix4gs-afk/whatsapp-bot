import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const savedFilesTable = pgTable("saved_files", {
    id: text("id").primaryKey().defaultRandom(),
    filename: text("filename").notNull(),
    type: text("type").notNull(), // 'view-once', 'status', 'profile'
    chatJid: text("chat_jid"),
    senderJid: text("sender_jid"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});