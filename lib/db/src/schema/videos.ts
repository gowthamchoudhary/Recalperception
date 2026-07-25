import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const videosTable = pgTable("videos", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  thumbnailUrl: text("thumbnail_url").notNull().default(""),
  videoUrl: text("video_url"),
  durationSeconds: integer("duration_seconds").notNull().default(0),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  recordedAt: text("recorded_at"),
  location: text("location"),
  status: text("status").notNull().default("indexed"),
  source: text("source").notNull().default("gallery"),
  tags: text("tags").array().notNull().default([]),
  people: text("people").array().notNull().default([]),
  transcriptExcerpt: text("transcript_excerpt"),
  sceneCount: integer("scene_count"),
  videodbVideoId: text("videodb_video_id"),
  playerUrl: text("player_url"),
  indexError: text("index_error"),
});

export const insertVideoSchema = createInsertSchema(videosTable).omit({
  id: true,
  uploadedAt: true,
});
export type InsertVideo = z.infer<typeof insertVideoSchema>;
export type VideoRow = typeof videosTable.$inferSelect;
