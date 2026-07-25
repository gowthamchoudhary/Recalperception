import os from "node:os";
import path from "node:path";
import { unlink } from "node:fs/promises";
import { Router, type IRouter } from "express";
import multer from "multer";
import { eq } from "drizzle-orm";
import { db, videosTable, momentsTable, reviewItemsTable } from "@workspace/db";
import {
  ListVideosQueryParams,
  ListVideosResponse,
  CreateVideoBody,
  CreateVideoResponse,
  GetVideoParams,
  GetVideoResponse,
  UpdateVideoParams,
  UpdateVideoBody,
  UpdateVideoResponse,
  DeleteVideoParams,
  UploadVideoResponse,
  PrivacyScanVideoParams,
  PrivacyScanVideoResponse,
} from "@workspace/api-zod";
import type { VideoRow } from "@workspace/db";
import { logger } from "../lib/logger";
import {
  isVideoDBConfigured,
  isVideoDBNotFoundError,
  getVideoDBCollection,
} from "../lib/videodb";
import {
  runIngestion,
  runPrivacyScan,
  isScanInProgress,
} from "../lib/ingestion";

const router: IRouter = Router();

const upload = multer({
  dest: path.join(os.tmpdir(), "recall-uploads"),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2 GB
});

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
    playerUrl: v.playerUrl,
    indexError: v.indexError,
  };
}

function deriveTitleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    if (/(^|\.)youtube\.com$|(^|\.)youtu\.be$/i.test(u.hostname)) {
      return "YouTube video";
    }
    const seg = u.pathname.split("/").filter(Boolean).pop() ?? "";
    const base = decodeURIComponent(seg)
      .replace(/\.[^.]+$/, "")
      .replace(/[-_+]/g, " ")
      .trim();
    return base || u.hostname;
  } catch {
    return "Uploaded video";
  }
}

router.get("/videos", async (req, res): Promise<void> => {
  const query = ListVideosQueryParams.safeParse(req.query);
  const status = query.success ? query.data.status : undefined;
  const base = db.select().from(videosTable);
  const rows = status
    ? await base.where(eq(videosTable.status, status)).orderBy(videosTable.uploadedAt)
    : await base.orderBy(videosTable.uploadedAt);
  res.json(ListVideosResponse.parse(rows.reverse().map(toApiVideo)));
});

/**
 * Real upload: pushes the video to VideoDB and kicks off background
 * ingestion (spoken-word indexing + privacy scan). Returns immediately
 * with the row in "processing" state.
 */
router.post(
  "/videos/upload",
  upload.single("file"),
  async (req, res): Promise<void> => {
    const cleanupTempFile = async (): Promise<void> => {
      if (req.file) {
        await unlink(req.file.path).catch(() => {});
      }
    };

    if (!isVideoDBConfigured()) {
      await cleanupTempFile();
      res.status(503).json({
        error:
          "VideoDB is not configured. Add the VIDEODB_API_KEY secret, then try again.",
      });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const url =
      typeof body["url"] === "string" && body["url"].trim().length > 0
        ? body["url"].trim()
        : null;
    const file = req.file ?? null;

    if (!url && !file) {
      res.status(400).json({ error: "Provide a video file or a url." });
      return;
    }
    if (url && file) {
      await cleanupTempFile();
      res
        .status(400)
        .json({ error: "Provide either a file or a url, not both." });
      return;
    }
    if (url) {
      try {
        new URL(url);
      } catch {
        res.status(400).json({ error: `"${url}" is not a valid URL.` });
        return;
      }
    }

    const titleRaw = typeof body["title"] === "string" ? body["title"].trim() : "";
    const title =
      titleRaw ||
      (file
        ? file.originalname.replace(/\.[^.]+$/, "").trim() || "Uploaded video"
        : deriveTitleFromUrl(url!));

    const bodySource = body["source"];
    const source =
      bodySource === "youtube" ||
      bodySource === "google_photos" ||
      bodySource === "gallery"
        ? bodySource
        : url && /youtube\.com|youtu\.be/i.test(url)
          ? "youtube"
          : "gallery";

    let video: VideoRow;
    try {
      const inserted = await db
        .insert(videosTable)
        .values({
          title,
          thumbnailUrl: "",
          videoUrl: null,
          durationSeconds: 0,
          recordedAt:
            typeof body["recordedAt"] === "string" && body["recordedAt"]
              ? body["recordedAt"]
              : null,
          location:
            typeof body["location"] === "string" && body["location"]
              ? body["location"]
              : null,
          status: "processing",
          source,
          tags: [],
          people: [],
        })
        .returning();
      video = inserted[0]!;
    } catch (err) {
      // The background pipeline never got the file; don't leak it.
      await cleanupTempFile();
      throw err;
    }

    const ingestionSource = url
      ? ({ kind: "url", url } as const)
      : ({ kind: "file", filePath: file!.path } as const);

    void runIngestion(video.id, ingestionSource).catch((err) => {
      logger.error({ err, videoId: video.id }, "Ingestion pipeline crashed");
    });

    res.status(202).json(UploadVideoResponse.parse(toApiVideo(video)));
  },
);

/**
 * Re-runs the privacy/sensitivity scan for an already-uploaded video.
 * The scan itself runs in the background so other requests are not blocked.
 */
router.post("/videos/:id/privacy-scan", async (req, res): Promise<void> => {
  const params = PrivacyScanVideoParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!isVideoDBConfigured()) {
    res.status(503).json({
      error:
        "VideoDB is not configured. Add the VIDEODB_API_KEY secret, then try again.",
    });
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
  if (!video.videodbVideoId) {
    res.status(409).json({
      error:
        "This video has not been uploaded to VideoDB yet, so it cannot be scanned.",
    });
    return;
  }
  if (isScanInProgress(video.id)) {
    res.status(409).json({
      error: "A privacy scan is already running for this video.",
    });
    return;
  }
  void runPrivacyScan(video.id).catch((err) => {
    logger.error({ err, videoId: video.id }, "Privacy scan crashed");
  });
  res.status(202).json(PrivacyScanVideoResponse.parse(toApiVideo(video)));
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
    .select()
    .from(videosTable)
    .where(eq(videosTable.id, params.data.id));
  if (!video) {
    res.status(404).json({ error: "Video not found" });
    return;
  }
  if (video.videodbVideoId) {
    if (!isVideoDBConfigured()) {
      res.status(503).json({
        error:
          "This video lives in VideoDB, but VideoDB is not configured. Add the VIDEODB_API_KEY secret before deleting it.",
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
  await db.transaction(async (tx) => {
    await tx
      .delete(momentsTable)
      .where(eq(momentsTable.videoId, params.data.id));
    await tx
      .delete(reviewItemsTable)
      .where(eq(reviewItemsTable.videoId, params.data.id));
    await tx.delete(videosTable).where(eq(videosTable.id, params.data.id));
  });
  res.sendStatus(204);
});

export default router;
