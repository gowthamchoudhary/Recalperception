import { pgTable, varchar, json, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Session storage for connect-pg-simple. Column names and types must match
 * exactly what the library expects (its bundled table.sql), because we create
 * the table ourselves via drizzle push — `createTableIfMissing` is disabled
 * (the bundled dev server can't resolve the library's table.sql asset).
 */
export const sessionsTable = pgTable(
  "session",
  {
    sid: varchar("sid").primaryKey(),
    sess: json("sess").notNull(),
    expire: timestamp("expire", { precision: 6, mode: "date" }).notNull(),
  },
  (table) => [index("IDX_session_expire").on(table.expire)],
);
