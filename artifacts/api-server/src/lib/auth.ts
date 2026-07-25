import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import type { Express, Request, RequestHandler } from "express";
import { pool } from "@workspace/db";

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>;

declare module "express-session" {
  interface SessionData {
    userId?: number;
  }
}

/** scrypt hash, stored as `salt:hex`. Passwords are never stored in plain text. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, 64);
  return `${salt}:${derived.toString("hex")}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const derived = await scrypt(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/**
 * Server-side sessions stored in Postgres (survives restarts). Cookie is
 * httpOnly so it cannot be read from client-side JS.
 */
export function configureSessions(app: Express): void {
  if (!process.env.SESSION_SECRET) {
    throw new Error("SESSION_SECRET must be set to run the API server.");
  }
  const PgStore = connectPgSimple(session);
  app.set("trust proxy", 1);
  app.use(
    session({
      // The table is owned by the drizzle schema (sessionsTable) and created
      // via drizzle push — createTableIfMissing breaks under the bundled dev
      // server because the library can't resolve its table.sql asset.
      store: new PgStore({ pool, createTableIfMissing: false }),
      secret: process.env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      },
    }),
  );
}

/** Rejects requests without a real server-side session. */
export const requireAuth: RequestHandler = (req, res, next) => {
  if (!req.session.userId) {
    res.status(401).json({ error: "You must be logged in." });
    return;
  }
  next();
};

/** Only call after requireAuth has run. */
export function currentUserId(req: Request): number {
  const id = req.session.userId;
  if (!id) {
    throw new Error("currentUserId called on an unauthenticated request");
  }
  return id;
}
