import { pgTable, text, jsonb, timestamp } from "drizzle-orm/pg-core";

export const sessionsTable = pgTable("sessions", {
    id: text("id").primaryKey(),
    label: text("label").notNull().default(""),
    status: text("status").notNull().default("disconnected"),
    qrDataUrl: text("qr_data_url"),
    pairingCode: text("pairing_code"),
    phoneNumber: text("phone_number"),
    savedFiles: jsonb("saved_files").notNull().default([]),
    log: jsonb("log").notNull().default([]),
    creds: jsonb("creds"),
    keys: jsonb("keys"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
});