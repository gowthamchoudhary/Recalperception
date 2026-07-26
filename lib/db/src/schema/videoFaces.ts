import {
  integer,
  pgTable,
  serial,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { videosTable } from "./videos";
import { peopleTable } from "./people";

/**
 * Persisted face matches for indexed videos. This is the person-search index:
 * query-time search joins against it instead of sampling frames live.
 */
export const videoFacesTable = pgTable(
  "video_faces",
  {
    id: serial("id").primaryKey(),
    videoId: integer("video_id")
      .notNull()
      .references(() => videosTable.id, { onDelete: "cascade" }),
    personId: integer("person_id")
      .notNull()
      .references(() => peopleTable.id, { onDelete: "cascade" }),
    confidence: integer("confidence").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    videoPersonUnique: uniqueIndex("video_faces_video_person_unique").on(
      table.videoId,
      table.personId,
    ),
  }),
);

export const insertVideoFaceSchema = createInsertSchema(videoFacesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertVideoFace = z.infer<typeof insertVideoFaceSchema>;
export type VideoFaceRow = typeof videoFacesTable.$inferSelect;
