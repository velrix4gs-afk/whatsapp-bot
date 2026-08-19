import { pgTable, text, jsonb, timestamp } from "drizzle-orm/pg-core";

export const settingsTable = pgTable("settings", {
    id: text("id").primaryKey().default("default"),
    features: jsonb("features").notNull().default({}),
    keywordReplies: jsonb("keyword_replies").notNull().default([]),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
});