import { pgTable, text, serial, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

/**
 * Enrolled people for face-based search. Each row is one person the user
 * taught the app to recognize from a single reference photo: the photo is
 * indexed into the AWS Rekognition face collection and we keep the returned
 * FaceId to match against frames extracted from search candidates.
 */
export const peopleTable = pgTable("people", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id),
  name: text("name").notNull(),
  rekognitionFaceId: text("rekognition_face_id").notNull(),
  // Small data-URL copy of the reference photo (client downscales before
  // upload) — shown in the People grid; nothing is stored on disk.
  thumbnailUrl: text("thumbnail_url").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertPersonSchema = createInsertSchema(peopleTable).omit({
  id: true,
  createdAt: true,
});
export type InsertPerson = z.infer<typeof insertPersonSchema>;
export type PersonRow = typeof peopleTable.$inferSelect;
