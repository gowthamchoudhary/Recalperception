import os from "node:os";
import path from "node:path";
import { unlink } from "node:fs/promises";
import { Router, type IRouter } from "express";
import multer from "multer";
import { and, eq, like } from "drizzle-orm";
import { db, videosTable, momentsTable, reviewItemsTable } from "@workspace/db";
import {
  ListVideosQueryParams,
  ListVideosResponse,
  GetVideoParams,
  GetVideoResponse,
  UpdateVideoParams,
  UpdateVideoBody,
  UpdateVideoResponse,
  DeleteVideoParams,
  UploadVideoResponse,
  PrivacyScanVideoParams,
  PrivacyScanVideoResponse,
  ConfirmVideoLanguageParams,
  ConfirmVideoLanguageBody,
  ConfirmVideoLanguageResponse,
  ExportClipParams,
  ExportClipBody,
  ExportClipResponse,
  FindInVideoParams,
  FindInVideoQueryParams,
  FindInVideoResponse,
} from "@workspace/api-zod";
import { SearchResult, SearchTypeValues, IndexTypeValues } from "videodb";
import type { VideoRow } from "@workspace/db";
import { logger } from "../lib/logger";
import {
  isVideoDBConfigured,
  isVideoDBNotFoundError,
  getVideoDBCollection,
  withTimeout,
} from "../lib/videodb";
import {
  runIngestion,
  runPrivacyScan,
  isScanInProgress,
  regenerateTranscript,
  USER_MATCH_SENTINEL,
} from "../lib/ingestion";
import { currentUserId } from "../lib/auth";

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
    detectedLanguage: v.detectedLanguage,
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

const NON_ENGLISH_RE = /[\u0B80-\u0BFF\u0900-\u097F\u4E00-\u9FFF\u0600-\u06FF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/;

function isEnglishOnly(text?: string | null) {
  return !text || !NON_ENGLISH_RE.test(text);
}

function scoreTeacher(row: VideoRow) {
  const t = `${row.title} ${row.transcriptExcerpt ?? ""} ${row.tags.join(" ")}`.toLowerCase();
  const terms = [
    "teacher", "lecture", "lesson", "class", "explain", "tutorial", "show you", "today i",
    "how to", "what is", "learn", "concept", "understand", "whiteboard", "blackboard", "topic", "course",
  ];
  return terms.reduce((acc, term) => acc + (t.includes(term) ? 1 : 0), 0);
}

function scorePodcast(row: VideoRow) {
  const t = `${row.title} ${row.transcriptExcerpt ?? ""} ${row.tags.join(" ")}`.toLowerCase();
  const terms = [
    "podcast", "episode", "debate", "interview", "discussion", "news", "conversation", "talk show",
    "rant", "opinion", "hot take", "guest", "host", "panel", "roundtable",
  ];
  return terms.reduce((acc, term) => acc + (t.includes(term) ? 1 : 0), 0);
}

router.get("/videos", async (req, res): Promise<void> => {
  const uid = currentUserId(req);
  const query = ListVideosQueryParams.safeParse(req.query);
  const status = query.success ? query.data.status : undefined;
  const where = status
    ? and(eq(videosTable.userId, uid), eq(videosTable.status, status))
    : eq(videosTable.userId, uid);
  const rows = await db
    .select()
    .from(videosTable)
    .where(where)
    .orderBy(videosTable.uploadedAt);
  res.json(ListVideosResponse.parse(rows.reverse().map(toApiVideo)));
});

/**
 * Hero video picker: finds the best English-only "teacher" and "podcast" clips
 * for the landing page so we never surface non-English or off-topic videos.
 */
router.get("/videos/hero", async (req, res): Promise<void> => {
  const uid = currentUserId(req);
  const rows = await db
    .select()
    .from(videosTable)
    .where(and(eq(videosTable.userId, uid), eq(videosTable.status, "indexed")));

  const english = rows.filter((r) => r.videoUrl && isEnglishOnly(r.transcriptExcerpt) && isEnglishOnly(r.title));
  const sortedTeacher = english.slice().sort((a, b) => scoreTeacher(b) - scoreTeacher(a));
  const teacher = sortedTeacher[0];
  const sortedPodcast = english
    .filter((r) => r.id !== teacher?.id)
    .sort((a, b) => scorePodcast(b) - scorePodcast(a));
  const podcast = sortedPodcast[0] ?? english[0];

  res.json({
    teacher: teacher ? { ...toApiVideo(teacher), transcriptExcerpt: teacher.transcriptExcerpt } : null,
    podcast: podcast ? { ...toApiVideo(podcast), transcriptExcerpt: podcast.transcriptExcerpt } : null,
  });
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

    const privacyRequestRaw =
      typeof body["privacyRequest"] === "string" ? body["privacyRequest"] : "";
    const privacyRequest =
      privacyRequestRaw.replace(/\s+/g, " ").trim().slice(0, 500) || null;
    const requestedLanguage =
      typeof body["requestedLanguage"] === "string" && body["requestedLanguage"]
        ? body["requestedLanguage"].trim().toLowerCase()
        : null;

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
          userId: currentUserId(req),
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
          privacyRequest,
          requestedLanguage,
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
    .where(
      and(
        eq(videosTable.id, params.data.id),
        eq(videosTable.userId, currentUserId(req)),
      ),
    );
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

/**
 * Renders a downloadable clip for an exact in/out range via VideoDB.
 * Nothing is persisted server-side: the trimmed stream and its download are
 * generated on demand each time.
 */
router.post("/videos/:id/export-clip", async (req, res): Promise<void> => {
  const params = ExportClipParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = ExportClipBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const start = Math.max(0, body.data.startSeconds);
  const end = body.data.endSeconds;
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
    .where(
      and(
        eq(videosTable.id, params.data.id),
        eq(videosTable.userId, currentUserId(req)),
      ),
    );
  if (!video) {
    res.status(404).json({ error: "Video not found" });
    return;
  }
  if (!video.videodbVideoId) {
    res.status(409).json({
      error: "This video has not finished uploading to VideoDB yet.",
    });
    return;
  }
  if (video.durationSeconds > 0 && start >= video.durationSeconds) {
    res.status(400).json({ error: "The clip starts after the video ends." });
    return;
  }
  const clampedEnd =
    video.durationSeconds > 0 ? Math.min(end, video.durationSeconds) : end;
  // Validate the EFFECTIVE range (after clamping to the video's duration).
  if (clampedEnd - start < 1) {
    res.status(400).json({ error: "Select a clip of at least one second." });
    return;
  }

  try {
    const coll = await getVideoDBCollection();
    const media = await withTimeout(
      coll.getVideo(video.videodbVideoId),
      60_000,
      "VideoDB video fetch",
    );
    // A trimmed stream containing ONLY the requested range. Sub-second
    // precision is passed through; VideoDB cuts on the nearest frame.
    const clipStreamUrl = await withTimeout(
      media.generateStream([[start, clampedEnd]]),
      3 * 60_000,
      "Clip stream generation",
    );
    if (!clipStreamUrl) {
      throw new Error("VideoDB did not return a stream for the clip range");
    }
    // …then a downloadable file rendered from that stream. `download()` posts
    // the instance's streamUrl, so point it at the trimmed stream first.
    const safeTitle =
      video.title.replace(/[^\w\- ]+/g, "").trim().slice(0, 60) || "clip";
    const name = `${safeTitle} ${formatTimestampForFilename(start)}-${formatTimestampForFilename(clampedEnd)}`;
    // `streamUrl` is typed read-only but is a plain instance property; the
    // SDK's download() posts it verbatim, so we point it at the trimmed stream.
    (media as unknown as { streamUrl: string }).streamUrl = clipStreamUrl;
    const download = (await withTimeout(
      media.download(name),
      5 * 60_000,
      "Clip download rendering",
    )) as Record<string, unknown> | undefined;

    const downloadUrl =
      typeof download?.["downloadUrl"] === "string"
        ? (download["downloadUrl"] as string)
        : typeof download?.["download_url"] === "string"
          ? (download["download_url"] as string)
          : null;
    if (!downloadUrl) {
      logger.error(
        { videoId: video.id, downloadKeys: Object.keys(download ?? {}) },
        "VideoDB download response had no download URL",
      );
      throw new Error("VideoDB did not return a download URL");
    }
    res.json(ExportClipResponse.parse({ downloadUrl, name: `${name}.mp4` }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, videoId: video.id }, "Clip export failed");
    res.status(502).json({ error: `Could not export the clip: ${message}` });
  }
});

function formatTimestampForFilename(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}m${(s % 60).toString().padStart(2, "0")}s`;
}

router.post("/videos/:id/confirm-language", async (req, res): Promise<void> => {
  const params = ConfirmVideoLanguageParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = ConfirmVideoLanguageBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
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
    .where(
      and(
        eq(videosTable.id, params.data.id),
        eq(videosTable.userId, currentUserId(req)),
      ),
    );
  if (!video) {
    res.status(404).json({ error: "Video not found" });
    return;
  }

  try {
    await regenerateTranscript(video.id, body.data.languageCode);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, videoId: video.id }, "Language confirmation transcription failed");
    res.status(502).json({ error: `Could not re-transcribe the video: ${message}` });
    return;
  }

  await db
    .update(reviewItemsTable)
    .set({ status: "accepted" })
    .where(
      and(
        eq(reviewItemsTable.videoId, video.id),
        eq(reviewItemsTable.status, "pending"),
        like(reviewItemsTable.reason, "Language confusion:%"),
      ),
    );

  const stillPending = await db
    .select({ id: reviewItemsTable.id })
    .from(reviewItemsTable)
    .where(
      and(
        eq(reviewItemsTable.videoId, video.id),
        eq(reviewItemsTable.status, "pending"),
      ),
    );

  const [updated] = await db
    .update(videosTable)
    .set({ status: stillPending.length > 0 ? "flagged" : "indexed" })
    .where(eq(videosTable.id, video.id))
    .returning();

  res.json(
    ConfirmVideoLanguageResponse.parse({
      ...toApiVideo(updated!),
      transcriptExcerpt: updated!.transcriptExcerpt,
      sceneCount: updated!.sceneCount,
      detectedLanguage: updated!.detectedLanguage,
    }),
  );
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
    .where(
      and(
        eq(videosTable.id, params.data.id),
        eq(videosTable.userId, currentUserId(req)),
      ),
    );
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
    .where(
      and(
        eq(videosTable.id, params.data.id),
        eq(videosTable.userId, currentUserId(req)),
      ),
    )
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
    .where(
      and(
        eq(videosTable.id, params.data.id),
        eq(videosTable.userId, currentUserId(req)),
      ),
    );
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
      await withTimeout(
        coll.deleteVideo(video.videodbVideoId),
        60_000,
        "VideoDB video deletion",
      );
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

// AI moment lookup inside one video: semantic search filtered to this
// video's VideoDB id, falling back to keyword matching over its indexed
// moment rows (covers legacy/demo videos too). Never errors on a miss —
// { found: false } is a normal answer.
router.get("/videos/:id/find", async (req, res): Promise<void> => {
  const params = FindInVideoParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const query = FindInVideoQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const q = query.data.q.trim();
  if (!q) {
    res.status(400).json({ error: "Ask what you're looking for." });
    return;
  }
  const [video] = await db
    .select()
    .from(videosTable)
    .where(
      and(
        eq(videosTable.id, params.data.id),
        eq(videosTable.userId, currentUserId(req)),
      ),
    );
  if (!video) {
    res.status(404).json({ error: "Video not found" });
    return;
  }

  // Semantic pass — collection-wide search, kept only for this video. The
  // wider per-index limit compensates for other videos crowding the list.
  if (video.videodbVideoId && isVideoDBConfigured()) {
    try {
      const coll = await withTimeout(
        getVideoDBCollection(),
        60_000,
        "getCollection",
      );
      // Video-level search stays inside this one video — no collection
      // noise from the user's other footage.
      const vdbVideo = await withTimeout(
        coll.getVideo(video.videodbVideoId),
        60_000,
        "getVideo",
      );
      const searchIndex = async (
        indexType: IndexTypeValues,
      ): Promise<InstanceType<typeof SearchResult>["shots"]> => {
        try {
          const result = await withTimeout(
            vdbVideo.search(q, SearchTypeValues.semantic, indexType, 5),
            60_000,
            `find:${indexType}`,
          );
          return result instanceof SearchResult ? result.shots : [];
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (/no results found/i.test(message)) return [];
          throw err;
        }
      };
      // One index erroring must not sink the other's answer.
      const settled = await Promise.allSettled([
        searchIndex(IndexTypeValues.spoken),
        searchIndex(IndexTypeValues.scene),
      ]);
      if (
        settled[0].status === "rejected" &&
        settled[1].status === "rejected"
      ) {
        throw settled[0].reason;
      }
      const spoken =
        settled[0].status === "fulfilled" ? settled[0].value[0] : undefined;
      const scene =
        settled[1].status === "fulfilled" ? settled[1].value[0] : undefined;
      const shot = spoken ?? scene;
      if (shot) {
        const snippet = (shot.text?.trim() || "")
          .replaceAll(USER_MATCH_SENTINEL, "")
          .replace(/\s{2,}/g, " ")
          .trim();
        res.json(
          FindInVideoResponse.parse({
            found: true,
            timestampSeconds: Math.max(0, Math.round(shot.start)),
            snippet: snippet || "Matched moment",
            matchType: spoken ? "speech" : "scene",
          }),
        );
        return;
      }
    } catch (err) {
      // Fall through to the keyword pass — an in-player lookup should
      // degrade quietly rather than surface retrieval plumbing errors.
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          videoId: video.id,
        },
        "Semantic find-in-video failed; falling back to keywords",
      );
    }
  }

  // Keyword pass over this video's indexed moments.
  const rows = await db
    .select()
    .from(momentsTable)
    .where(eq(momentsTable.videoId, video.id));
  const needle = q.toLowerCase();
  const terms = needle.split(/\s+/).filter((t) => t.length > 2);
  const best = rows
    .map((m) => {
      const haystack = `${m.snippet} ${m.keywords.join(" ")}`.toLowerCase();
      let score = 0;
      if (haystack.includes(needle)) score += 5;
      for (const t of terms) {
        if (haystack.includes(t)) score += 1;
      }
      return score > 0 ? { m, score } : null;
    })
    .filter((x) => x !== null)
    .sort(
      (a, b) =>
        b.score - a.score || a.m.timestampSeconds - b.m.timestampSeconds,
    )[0];
  if (best) {
    res.json(
      FindInVideoResponse.parse({
        found: true,
        timestampSeconds: best.m.timestampSeconds,
        snippet: best.m.snippet,
        matchType: "speech",
      }),
    );
    return;
  }
  res.json(
    FindInVideoResponse.parse({
      found: false,
      timestampSeconds: null,
      snippet: null,
      matchType: null,
    }),
  );
});

export default router;
