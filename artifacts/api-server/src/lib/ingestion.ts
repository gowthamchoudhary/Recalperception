import { unlink } from "node:fs/promises";
import { and, eq, lt } from "drizzle-orm";
import { db, videosTable, reviewItemsTable } from "@workspace/db";
import { Video as VideoDBVideo } from "videodb";
import { logger } from "./logger";
import { getVideoDBCollection } from "./videodb";

export type UploadSource =
  | { kind: "url"; url: string }
  | { kind: "file"; filePath: string };

/** Process start time; the boot sweep only touches rows older than this. */
const BOOT_TIME = new Date();

/** Videos with a privacy scan currently in flight (per-process lock). */
const scansInProgress = new Set<number>();

export function isScanInProgress(videoRowId: number): boolean {
  return scansInProgress.has(videoRowId);
}

/**
 * Prompt used for the privacy scene-index pass. VideoDB describes each scene;
 * we then look for sensitive markers in those descriptions.
 */
const SCENE_PROMPT =
  "Describe this scene factually in one or two sentences. Explicitly mention if the scene shows any of the following: a computer, phone, or laptop screen with readable content; personal documents such as passports, ID cards, credit cards, or bank statements; people who are undressed or in a private moment; a medical setting such as a hospital or clinic; or a readable license plate.";

const SENSITIVE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  {
    pattern:
      /\b(?:computer|phone|laptop|tablet) screen\b|\bscreen (?:showing|with|displaying)\b|\breadable (?:text on|content on) (?:a |the )?screen\b/i,
    label: "Visible screen content",
  },
  {
    pattern:
      /\bpassport\b|\bcredit card\b|\bdebit card\b|\bid card\b|\bdriver'?s licen[cs]e\b|\bbank statement\b|\bpersonal documents?\b/i,
    label: "Personal documents",
  },
  {
    pattern: /\bnude\b|\bnudity\b|\bundressed\b|\bunclothed\b|\bprivate moment\b/i,
    label: "Possible private moment",
  },
  {
    pattern: /\bhospital\b|\bmedical setting\b|\bclinic\b|\bprescription\b|\bmedication\b/i,
    label: "Medical context",
  },
  {
    pattern: /\blicense plate\b|\bnumber plate\b/i,
    label: "Readable license plate",
  },
];

function excerpt(text: string, max = 280): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function formatTimestamp(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Full ingestion pipeline for a newly uploaded video:
 * upload to VideoDB -> spoken-word index -> transcript excerpt -> privacy scan.
 * Designed to run in the background; all failures are recorded on the row.
 */
export async function runIngestion(
  videoRowId: number,
  source: UploadSource,
): Promise<void> {
  try {
    const coll = await getVideoDBCollection();
    const media =
      source.kind === "url"
        ? await coll.uploadURL({ url: source.url, mediaType: "video" })
        : await coll.uploadFile({ filePath: source.filePath, mediaType: "video" });

    if (!media || !(media instanceof VideoDBVideo)) {
      throw new Error("VideoDB upload did not return a video object");
    }
    logger.info(
      { videoRowId, videodbVideoId: media.id },
      "VideoDB upload complete",
    );

    let thumbnailUrl: string | undefined;
    try {
      const thumb = await media.generateThumbnail();
      if (typeof thumb === "string") {
        thumbnailUrl = thumb;
      } else if (thumb && typeof (thumb as { url?: unknown }).url === "string") {
        thumbnailUrl = (thumb as { url: string }).url;
      }
    } catch (err) {
      logger.warn({ err, videoRowId }, "Thumbnail generation failed");
    }

    await db
      .update(videosTable)
      .set({
        videodbVideoId: media.id,
        durationSeconds: Math.round(media.length || 0),
        videoUrl: media.streamUrl || null,
        playerUrl: media.playerUrl || null,
        ...(thumbnailUrl ? { thumbnailUrl } : {}),
      })
      .where(eq(videosTable.id, videoRowId));

    const indexResult = await media.indexSpokenWords();
    if (indexResult && indexResult.success === false) {
      throw new Error(indexResult.message || "Spoken-word indexing failed");
    }
    logger.info({ videoRowId }, "Spoken-word indexing complete");

    try {
      const text = await media.getTranscriptText();
      if (typeof text === "string" && text.trim().length > 0) {
        await db
          .update(videosTable)
          .set({ transcriptExcerpt: excerpt(text) })
          .where(eq(videosTable.id, videoRowId));
      }
    } catch (err) {
      logger.warn({ err, videoRowId }, "Transcript fetch failed");
    }

    await runPrivacyScan(videoRowId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, videoRowId }, "Ingestion failed");
    try {
      await db
        .update(videosTable)
        .set({ status: "failed", indexError: message })
        .where(eq(videosTable.id, videoRowId));
    } catch (dbErr) {
      logger.error({ err: dbErr, videoRowId }, "Failed to record ingestion error");
    }
  } finally {
    if (source.kind === "file") {
      await unlink(source.filePath).catch(() => {});
    }
  }
}

/**
 * Privacy/sensitivity pass over a VideoDB-indexed video.
 * Flagged scenes create a pending review item and quarantine the video
 * (status "flagged"); a clean pass marks it "indexed".
 * If the scan itself cannot run, the video is quarantined for manual review —
 * we never silently mark unscanned content as indexed.
 */
export async function runPrivacyScan(videoRowId: number): Promise<void> {
  if (scansInProgress.has(videoRowId)) {
    logger.warn({ videoRowId }, "Privacy scan already in progress; skipping");
    return;
  }
  scansInProgress.add(videoRowId);
  try {
    await runPrivacyScanLocked(videoRowId);
  } finally {
    scansInProgress.delete(videoRowId);
  }
}

async function runPrivacyScanLocked(videoRowId: number): Promise<void> {
  const [row] = await db
    .select()
    .from(videosTable)
    .where(eq(videosTable.id, videoRowId));
  if (!row) {
    throw new Error(`Video row ${videoRowId} not found`);
  }
  if (!row.videodbVideoId) {
    throw new Error(`Video ${videoRowId} has no VideoDB id; cannot scan`);
  }

  try {
    const coll = await getVideoDBCollection();
    const media = await coll.getVideo(row.videodbVideoId);
    const sceneIndexId = await media.indexScenes({
      prompt: SCENE_PROMPT,
      name: "privacy-scan",
    });
    if (!sceneIndexId) {
      throw new Error("Scene indexing did not return an index id");
    }

    // Scene indexing runs asynchronously on VideoDB's side; poll until ready.
    let scenes: Awaited<ReturnType<typeof media.getSceneIndex>> | undefined;
    const maxAttempts = 30;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await sleep(10_000);
      try {
        const records = await media.getSceneIndex(sceneIndexId);
        if (Array.isArray(records) && records.length > 0) {
          scenes = records;
          break;
        }
      } catch {
        // Index not ready yet — keep polling.
      }
    }
    if (!scenes || scenes.length === 0) {
      throw new Error("Scene index was not ready after 5 minutes");
    }

    await db
      .update(videosTable)
      .set({ sceneCount: scenes.length })
      .where(eq(videosTable.id, videoRowId));

    const hits: Array<{ label: string; start: number; description: string }> = [];
    for (const scene of scenes) {
      const description =
        typeof scene.description === "string" ? scene.description : "";
      for (const { pattern, label } of SENSITIVE_PATTERNS) {
        if (pattern.test(description)) {
          hits.push({ label, start: Number(scene.start) || 0, description });
          break;
        }
      }
    }

    // The latest scan supersedes pending items from earlier scans: reruns
    // never stack duplicates, and a clean rerun clears stale flags.
    if (hits.length > 0) {
      const first = hits[0]!;
      const extra =
        hits.length > 1
          ? ` (+${hits.length - 1} more flagged scene${hits.length > 2 ? "s" : ""})`
          : "";
      await db.transaction(async (tx) => {
        await tx
          .delete(reviewItemsTable)
          .where(
            and(
              eq(reviewItemsTable.videoId, videoRowId),
              eq(reviewItemsTable.status, "pending"),
            ),
          );
        await tx.insert(reviewItemsTable).values({
          videoId: videoRowId,
          reason: `${first.label} detected by privacy scan`,
          detail: `Scene at ${formatTimestamp(first.start)}: ${excerpt(first.description, 180)}${extra}`,
          status: "pending",
        });
        await tx
          .update(videosTable)
          .set({ status: "flagged", indexError: null })
          .where(eq(videosTable.id, videoRowId));
      });
      logger.info({ videoRowId, hits: hits.length }, "Privacy scan flagged video");
    } else {
      await db.transaction(async (tx) => {
        await tx
          .delete(reviewItemsTable)
          .where(
            and(
              eq(reviewItemsTable.videoId, videoRowId),
              eq(reviewItemsTable.status, "pending"),
            ),
          );
        await tx
          .update(videosTable)
          .set({ status: "indexed", indexError: null })
          .where(eq(videosTable.id, videoRowId));
      });
      logger.info({ videoRowId }, "Privacy scan clean; video indexed");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { err, videoRowId },
      "Privacy scan failed; quarantining for manual review",
    );
    await db.transaction(async (tx) => {
      await tx
        .delete(reviewItemsTable)
        .where(
          and(
            eq(reviewItemsTable.videoId, videoRowId),
            eq(reviewItemsTable.status, "pending"),
          ),
        );
      await tx.insert(reviewItemsTable).values({
        videoId: videoRowId,
        reason: "Privacy scan could not run",
        detail: `${message}. Review this video manually, then accept or discard it.`,
        status: "pending",
      });
      await tx
        .update(videosTable)
        .set({ status: "flagged" })
        .where(eq(videosTable.id, videoRowId));
    });
  }
}

/**
 * Marks rows stuck in "processing" as failed. Called once at server boot:
 * a restart kills any in-flight background ingestion, and leaving rows in
 * "processing" forever would look like a hung upload in the UI.
 */
export async function sweepInterruptedIngestions(): Promise<void> {
  try {
    const rows = await db
      .update(videosTable)
      .set({
        status: "failed",
        indexError:
          "Ingestion was interrupted by a server restart. Upload the video again, or re-run the privacy scan if it was already uploaded.",
      })
      .where(
        and(
          eq(videosTable.status, "processing"),
          // Never touch uploads that arrived after this process booted.
          lt(videosTable.uploadedAt, BOOT_TIME),
        ),
      )
      .returning({ id: videosTable.id });
    if (rows.length > 0) {
      logger.warn(
        { count: rows.length, ids: rows.map((r) => r.id) },
        "Marked interrupted ingestions as failed",
      );
    }
  } catch (err) {
    logger.error({ err }, "Failed to sweep interrupted ingestions");
  }
}

/**
 * True when a video still has unresolved review items.
 */
export async function hasPendingReviewItems(videoId: number): Promise<boolean> {
  const pending = await db
    .select({ id: reviewItemsTable.id })
    .from(reviewItemsTable)
    .where(
      and(
        eq(reviewItemsTable.videoId, videoId),
        eq(reviewItemsTable.status, "pending"),
      ),
    );
  return pending.length > 0;
}
