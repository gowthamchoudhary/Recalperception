import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, videosTable, reviewItemsTable } from "@workspace/db";
import { GetStatsResponse } from "@workspace/api-zod";
import { currentUserId } from "../lib/auth";

const router: IRouter = Router();

router.get("/stats", async (req, res): Promise<void> => {
  const uid = currentUserId(req);
  const [videos, pending] = await Promise.all([
    db.select().from(videosTable).where(eq(videosTable.userId, uid)),
    db
      .select({ id: reviewItemsTable.id })
      .from(reviewItemsTable)
      .innerJoin(videosTable, eq(reviewItemsTable.videoId, videosTable.id))
      .where(
        and(
          eq(reviewItemsTable.status, "pending"),
          eq(videosTable.userId, uid),
        ),
      ),
  ]);
  const totalSeconds = videos.reduce((s, v) => s + v.durationSeconds, 0);
  const people = new Set(videos.flatMap((v) => v.people));
  const totalScenes = videos.reduce((s, v) => s + (v.sceneCount ?? 0), 0);
  res.json(
    GetStatsResponse.parse({
      totalVideos: videos.length,
      totalHoursIndexed: Math.round((totalSeconds / 3600) * 10) / 10,
      totalPeople: people.size,
      totalScenes,
      pendingReviewCount: pending.length,
    }),
  );
});

export default router;
