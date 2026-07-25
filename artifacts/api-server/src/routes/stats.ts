import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, videosTable, reviewItemsTable } from "@workspace/db";
import { GetStatsResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/stats", async (_req, res): Promise<void> => {
  const [videos, pending] = await Promise.all([
    db.select().from(videosTable),
    db
      .select()
      .from(reviewItemsTable)
      .where(eq(reviewItemsTable.status, "pending")),
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
