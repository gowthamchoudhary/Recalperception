import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * Per-user OAuth grants for external ingestion sources.
 * provider: "google_photos" | "youtube" (separate consents, even if the
 * underlying Google account is the same).
 */
export const oauthTokensTable = pgTable("oauth_tokens", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id),
  provider: text("provider").notNull(),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token"),
  /** Epoch millis when the access token expires. */
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type OauthTokenRow = typeof oauthTokensTable.$inferSelect;
