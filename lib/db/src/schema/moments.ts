import { pgTable, text, serial, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Indexed "moments" within videos — the searchable units (transcript lines,
// scene descriptions, person appearances).
export const momentsTable = pgTable("moments", {
  id: serial("id").primaryKey(),
  videoId: integer("video_id").notNull(),
  snippet: text("snippet").notNull(),
  matchType: text("match_type").notNull().default("speech"),
  timestampSeconds: integer("timestamp_seconds").notNull().default(0),
  keywords: text("keywords").array().notNull().default([]),
});

export const insertMomentSchema = createInsertSchema(momentsTable).omit({
  id: true,
});
export type InsertMoment = z.infer<typeof insertMomentSchema>;
export type MomentRow = typeof momentsTable.$inferSelect;
