import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, videosTable } from "@workspace/db";
import { ListPeopleResponse } from "@workspace/api-zod";
import { currentUserId } from "../lib/auth";

const router: IRouter = Router();

router.get("/people", async (req, res): Promise<void> => {
  const videos = await db
    .select()
    .from(videosTable)
    .where(eq(videosTable.userId, currentUserId(req)));
  const byName = new Map<
    string,
    { count: number; lastSeenAt: string | null }
  >();
  for (const v of videos) {
    for (const name of v.people) {
      const entry = byName.get(name) ?? { count: 0, lastSeenAt: null };
      entry.count += 1;
      const seen = v.recordedAt ?? v.uploadedAt.toISOString();
      if (!entry.lastSeenAt || seen > entry.lastSeenAt) entry.lastSeenAt = seen;
      byName.set(name, entry);
    }
  }
  const people = Array.from(byName.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .map(([name, { count, lastSeenAt }], i) => ({
      id: i + 1,
      name,
      appearanceCount: count,
      lastSeenAt,
    }));
  res.json(ListPeopleResponse.parse(people));
});

export default router;
