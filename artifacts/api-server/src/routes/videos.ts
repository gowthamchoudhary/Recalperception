import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, videosTable, momentsTable, reviewItemsTable } from "@workspace/db";
import {
  ListVideosResponse,
  CreateVideoBody,
  CreateVideoResponse,
  GetVideoParams,
  GetVideoResponse,
  UpdateVideoParams,
  UpdateVideoBody,
  UpdateVideoResponse,
  DeleteVideoParams,
} from "@workspace/api-zod";
import type { VideoRow } from "@workspace/db";

const router: IRouter = Router();

export function toApiVideo(v: VideoRow) {
  return {
    id: v.id,
    title: v.title,
    thumbnailUrl: v.thumbnailUrl,
    videoUrl: v.videoUrl,
    durationSeconds: v.durationSeconds,
    uploadedAt: v.uploadedAt.toISOString(),
    recordedAt: v.recordedAt,
    location: v.location,
    status: v.status,
    source: v.source,
    tags: v.tags,
    people: v.people,
  };
}

router.get("/videos", async (_req, res): Promise<void> => {
  const videos = await db
    .select()
    .from(videosTable)
    .orderBy(videosTable.uploadedAt);
  res.json(ListVideosResponse.parse(videos.reverse().map(toApiVideo)));
});

router.post("/videos", async (req, res): Promise<void> => {
  const parsed = CreateVideoBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const d = parsed.data;
  const [video] = await db
    .insert(videosTable)
    .values({
      title: d.title,
      thumbnailUrl: d.thumbnailUrl ?? "",
      videoUrl: d.videoUrl ?? null,
      durationSeconds: d.durationSeconds ?? 0,
      recordedAt: d.recordedAt ?? null,
      location: d.location ?? null,
      source: d.source ?? "gallery",
      tags: d.tags ?? [],
      people: d.people ?? [],
      status: "indexed",
    })
    .returning();
  res.status(201).json(CreateVideoResponse.parse(toApiVideo(video!)));
});

router.get("/videos/:id", async (req, res): Promise<void> => {
  const params = GetVideoParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [video] = await db
    .select()
    .from(videosTable)
    .where(eq(videosTable.id, params.data.id));
  if (!video) {
    res.status(404).json({ error: "Video not found" });
    return;
  }
  res.json(
    GetVideoResponse.parse({
      ...toApiVideo(video),
      transcriptExcerpt: video.transcriptExcerpt,
      sceneCount: video.sceneCount,
    }),
  );
});

router.patch("/videos/:id", async (req, res): Promise<void> => {
  const params = UpdateVideoParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateVideoBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [video] = await db
    .update(videosTable)
    .set(parsed.data)
    .where(eq(videosTable.id, params.data.id))
    .returning();
  if (!video) {
    res.status(404).json({ error: "Video not found" });
    return;
  }
  res.json(UpdateVideoResponse.parse(toApiVideo(video)));
});

router.delete("/videos/:id", async (req, res): Promise<void> => {
  const params = DeleteVideoParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [video] = await db
    .delete(videosTable)
    .where(eq(videosTable.id, params.data.id))
    .returning();
  if (!video) {
    res.status(404).json({ error: "Video not found" });
    return;
  }
  await db.delete(momentsTable).where(eq(momentsTable.videoId, params.data.id));
  await db
    .delete(reviewItemsTable)
    .where(eq(reviewItemsTable.videoId, params.data.id));
  res.sendStatus(204);
});

export default router;
