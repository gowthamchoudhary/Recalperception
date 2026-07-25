import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, reviewItemsTable, videosTable, momentsTable } from "@workspace/db";
import {
  ListReviewItemsResponse,
  ResolveReviewItemParams,
  ResolveReviewItemBody,
  ResolveReviewItemResponse,
} from "@workspace/api-zod";
import {
  isVideoDBConfigured,
  isVideoDBNotFoundError,
  getVideoDBCollection,
} from "../lib/videodb";
import { hasPendingReviewItems } from "../lib/ingestion";

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

/**
 * Accept: the flagged content is fine — resolve the item and, when no other
 * pending items remain, move the video back to "indexed".
 * Discard: privacy-first — the video is deleted from VideoDB and removed
 * from the library entirely, along with its moments and review items.
 */
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
    .select()
    .from(reviewItemsTable)
    .where(eq(reviewItemsTable.id, params.data.id));
  if (!item) {
    res.status(404).json({ error: "Review item not found" });
    return;
  }
  const [video] = await db
    .select()
    .from(videosTable)
    .where(eq(videosTable.id, item.videoId));

  const responsePayload = {
    id: item.id,
    videoId: item.videoId,
    videoTitle: video?.title ?? "",
    thumbnailUrl: video?.thumbnailUrl ?? "",
    reason: item.reason,
    detail: item.detail,
    status: body.data.status,
    createdAt: item.createdAt.toISOString(),
  };

  if (body.data.status === "accepted") {
    await db
      .update(reviewItemsTable)
      .set({ status: "accepted" })
      .where(eq(reviewItemsTable.id, item.id));
    if (video && video.status === "flagged") {
      const stillPending = await hasPendingReviewItems(video.id);
      if (!stillPending) {
        await db
          .update(videosTable)
          .set({ status: "indexed" })
          .where(eq(videosTable.id, video.id));
      }
    }
    res.json(ResolveReviewItemResponse.parse(responsePayload));
    return;
  }

  // Discard.
  if (video?.videodbVideoId) {
    if (!isVideoDBConfigured()) {
      res.status(503).json({
        error:
          "This video lives in VideoDB, but VideoDB is not configured. Add the VIDEODB_API_KEY secret before discarding it.",
      });
      return;
    }
    try {
      const coll = await getVideoDBCollection();
      await coll.deleteVideo(video.videodbVideoId);
    } catch (err) {
      // Tolerate assets that are already gone so local cleanup can proceed.
      if (!isVideoDBNotFoundError(err)) {
        const message = err instanceof Error ? err.message : String(err);
        res
          .status(502)
          .json({ error: `Could not delete the video from VideoDB: ${message}` });
        return;
      }
    }
  }
  if (video) {
    await db.transaction(async (tx) => {
      await tx.delete(momentsTable).where(eq(momentsTable.videoId, video.id));
      await tx
        .delete(reviewItemsTable)
        .where(eq(reviewItemsTable.videoId, video.id));
      await tx.delete(videosTable).where(eq(videosTable.id, video.id));
    });
  } else {
    await db.delete(reviewItemsTable).where(eq(reviewItemsTable.id, item.id));
  }
  res.json(ResolveReviewItemResponse.parse(responsePayload));
});

export default router;
