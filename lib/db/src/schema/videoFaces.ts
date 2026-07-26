import {
  integer,
  pgTable,
  serial,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { videosTable } from "./videos";
import { peopleTable } from "./people";

/**
 * Persisted face-timeline ranges for indexed videos.
 *
 * Each row represents a contiguous time range in a video where a specific
 * person's face was confirmed present. Consecutive matching frames (sampled
 * every ~30 s) are merged into one range instead of stored as individual
 * rows, so a 60-minute video with someone appearing in three clusters produces
 * three rows, not thousands.
 *
 * Query-time person search is a pure DB lookup against this table — no live
 * Rekognition calls per query.
 */
export const videoFacesTable = pgTable("video_faces", {
  id: serial("id").primaryKey(),
  videoId: integer("video_id")
    .notNull()
    .references(() => videosTable.id, { onDelete: "cascade" }),
  personId: integer("person_id")
    .notNull()
    .references(() => peopleTable.id, { onDelete: "cascade" }),
  /** Seconds into the video where this appearance range starts. */
  startTime: integer("start_time").notNull().default(0),
  /** Seconds into the video where this appearance range ends. */
  endTime: integer("end_time").notNull().default(0),
  /** Rekognition similarity score (0–100) — highest across merged frames. */
  confidence: integer("confidence").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertVideoFaceSchema = createInsertSchema(videoFacesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertVideoFace = z.infer<typeof insertVideoFaceSchema>;
export type VideoFaceRow = typeof videoFacesTable.$inferSelect;
