import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, reviewItemsTable, videosTable } from "@workspace/db";
import {
  ListReviewItemsResponse,
  ResolveReviewItemParams,
  ResolveReviewItemBody,
  ResolveReviewItemResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/review-items", async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      item: reviewItemsTable,
      videoTitle: videosTable.title,
      thumbnailUrl: videosTable.thumbnailUrl,
    })
    .from(reviewItemsTable)
    .innerJoin(videosTable, eq(reviewItemsTable.videoId, videosTable.id))
    .where(eq(reviewItemsTable.status, "pending"));

  res.json(
    ListReviewItemsResponse.parse(
      rows.map(({ item, videoTitle, thumbnailUrl }) => ({
        id: item.id,
        videoId: item.videoId,
        videoTitle,
        thumbnailUrl,
        reason: item.reason,
        detail: item.detail,
        status: item.status,
        createdAt: item.createdAt.toISOString(),
      })),
    ),
  );
});

router.patch("/review-items/:id", async (req, res): Promise<void> => {
  const params = ResolveReviewItemParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = ResolveReviewItemBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const [item] = await db
    .update(reviewItemsTable)
    .set({ status: body.data.status })
    .where(eq(reviewItemsTable.id, params.data.id))
    .returning();
  if (!item) {
    res.status(404).json({ error: "Review item not found" });
    return;
  }
  const [video] = await db
    .select()
    .from(videosTable)
    .where(eq(videosTable.id, item.videoId));
  res.json(
    ResolveReviewItemResponse.parse({
      id: item.id,
      videoId: item.videoId,
      videoTitle: video?.title ?? "",
      thumbnailUrl: video?.thumbnailUrl ?? "",
      reason: item.reason,
      detail: item.detail,
      status: item.status,
      createdAt: item.createdAt.toISOString(),
    }),
  );
});

export default router;
