import { Router, type IRouter, type Request } from "express";
import { eq, isNull } from "drizzle-orm";
import { db, usersTable, videosTable, type UserRow } from "@workspace/db";
import {
  SignupBody,
  SignupResponse,
  LoginBody,
  LoginResponse,
  GetCurrentUserResponse,
} from "@workspace/api-zod";
import { hashPassword, verifyPassword, requireAuth } from "../lib/auth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

function toApiUser(u: UserRow) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    createdAt: u.createdAt.toISOString(),
  };
}

/** Prevents session fixation: a fresh session id is issued on every auth change. */
function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}

router.post("/auth/signup", async (req, res): Promise<void> => {
  const parsed = SignupBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error:
        "Enter a valid email, your name, and a password of at least 8 characters.",
    });
    return;
  }
  const email = parsed.data.email.trim().toLowerCase();
  const name = parsed.data.name.trim();
  if (!name) {
    res.status(400).json({ error: "Enter your name." });
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: "Enter a valid email address." });
    return;
  }

  const [existing] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email));
  if (existing) {
    res.status(409).json({
      error: "An account with this email already exists. Log in instead.",
    });
    return;
  }

  const passwordHash = await hashPassword(parsed.data.password);
  let user: UserRow;
  try {
    const inserted = await db
      .insert(usersTable)
      .values({ email, name, passwordHash })
      .returning();
    user = inserted[0]!;
  } catch (err) {
    // Unique-violation race: two signups with the same email at once.
    if ((err as { code?: string }).code === "23505") {
      res.status(409).json({
        error: "An account with this email already exists. Log in instead.",
      });
      return;
    }
    throw err;
  }

  // One-time migration: videos uploaded before accounts existed (user_id NULL)
  // are adopted by the first account that signs up. After that no NULL rows
  // remain, so this is inert for every later signup.
  const adopted = await db
    .update(videosTable)
    .set({ userId: user.id })
    .where(isNull(videosTable.userId))
    .returning({ id: videosTable.id });
  if (adopted.length > 0) {
    logger.info(
      { userId: user.id, videoIds: adopted.map((a) => a.id) },
      "Adopted pre-auth videos into new account",
    );
  }

  await regenerateSession(req);
  req.session.userId = user.id;
  res.status(201).json(SignupResponse.parse(toApiUser(user)));
});

router.post("/auth/login", async (req, res): Promise<void> => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter your email and password." });
    return;
  }
  const email = parsed.data.email.trim().toLowerCase();
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email));
  const ok = user
    ? await verifyPassword(parsed.data.password, user.passwordHash)
    : false;
  if (!user || !ok) {
    res.status(401).json({ error: "Incorrect email or password." });
    return;
  }
  await regenerateSession(req);
  req.session.userId = user.id;
  res.json(LoginResponse.parse(toApiUser(user)));
});

router.post("/auth/logout", (req, res): void => {
  req.session.destroy((err) => {
    if (err) {
      logger.error({ err }, "Failed to destroy session on logout");
    }
    res.clearCookie("connect.sid");
    res.sendStatus(204);
  });
});

router.get("/auth/me", requireAuth, async (req, res): Promise<void> => {
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, req.session.userId!));
  if (!user) {
    // Account was deleted while the session was still alive.
    req.session.destroy(() => {
      res.status(401).json({ error: "This account no longer exists." });
    });
    return;
  }
  res.json(GetCurrentUserResponse.parse(toApiUser(user)));
});

export default router;
