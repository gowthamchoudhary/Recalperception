import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const reviewItemsTable = pgTable("review_items", {
  id: serial("id").primaryKey(),
  videoId: integer("video_id").notNull(),
  reason: text("reason").notNull(),
  detail: text("detail"),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertReviewItemSchema = createInsertSchema(reviewItemsTable).omit(
  { id: true, createdAt: true },
);
export type InsertReviewItem = z.infer<typeof insertReviewItemSchema>;
export type ReviewItemRow = typeof reviewItemsTable.$inferSelect;
