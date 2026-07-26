import { unlink } from "node:fs/promises";
import { and, eq, lt, like, not } from "drizzle-orm";
import { db, videosTable, reviewItemsTable, usersTable } from "@workspace/db";
import { Video as VideoDBVideo } from "videodb";
import { logger } from "./logger";
import {
  getVideoDBCollection,
  isVideoDBNotFoundError,
  withTimeout,
} from "./videodb";
import {
  detectTranscriptLanguage,
  displayName,
  findLanguageConfusion,
} from "./languageConfusion";

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
 * Baseline prompt for the privacy scene-index pass — always on. VideoDB
 * describes each scene; we then look for sensitive markers in those
 * descriptions. The model is told to only mention categories that are
 * actually present: sentences like "no documents are visible" previously
 * tripped the keyword matcher and flooded the review queue.
 */
const BASELINE_SCENE_PROMPT =
  "Describe this scene factually in one or two sentences. Only if it is clearly visible in the scene, explicitly mention any of the following: a computer, phone, or laptop screen with readable content; a personal document such as a passport, ID card, or driver's license; financial information such as a credit card, bank statement, or account number; a person who is undressed or in a private moment; a medical setting such as a hospital or clinic, or visible medication; a readable license plate. Never mention items from that list that are absent or uncertain — for example, do not write 'no documents are visible'.";

/**
 * Token the scene model is told to append when a scene matches the user's
 * own "don't process this" request. Detection then only needs an exact
 * substring check — no fragile keyword guessing over free-form text.
 */
export const USER_MATCH_SENTINEL = "USER_REQUEST_MATCH";

/** One scan pass covers baseline categories plus the user's request, if any. */
function buildScenePrompt(privacyRequest: string | null): string {
  // Strip any sentinel occurrences from the user's own text so a request
  // can never trick the detector into matching by self-reference.
  const request = privacyRequest
    ?.replaceAll(USER_MATCH_SENTINEL, "")
    .replace(/\s+/g, " ")
    .replace(/"/g, "'")
    .trim();
  if (!request) return BASELINE_SCENE_PROMPT;
  return `${BASELINE_SCENE_PROMPT} The owner of this video also asked: "${request.slice(0, 300)}". If, and only if, this scene actually shows or matches what they described, append the exact token ${USER_MATCH_SENTINEL} to the end of your description. Never append the token otherwise, and never mention it when the scene does not match.`;
}

const SENSITIVE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  {
    pattern:
      /\b(?:computer|phone|laptop|tablet) screen\b|\bscreen (?:showing|with|displaying)\b|\breadable (?:text on|content on) (?:a |the )?screen\b/i,
    label: "Visible screen content",
  },
  {
    pattern:
      /\bpassport\b|\bid card\b|\bdriver'?s licen[cs]e\b|\bpersonal documents?\b/i,
    label: "Personal documents or IDs",
  },
  {
    pattern:
      /\bcredit card\b|\bdebit card\b|\bbank statement\b|\baccount numbers?\b|\bfinancial (?:info|information|details)\b/i,
    label: "Financial information",
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

/**
 * Negation/hedging cues that disqualify a keyword match within a clause:
 * "no personal documents are visible" or "a license plate that is not
 * readable" must never flag a video.
 */
const NEGATION_CUE =
  /\b(?:no|not|none|nothing|without|never|neither|nor|absent|absence|free of|lacks?|lacking|rather than|instead of|do(?:es)?n'?t|didn'?t|isn'?t|aren'?t|wasn'?t|weren'?t|has?n'?t|haven'?t|cannot|can'?t|won'?t|hardly|barely|unclear|unreadable|illegible|obscured|blurred|blurry|difficult to)\b[^.!?]*$/i;

/** Conjunctions that flip polarity and therefore reset a negation scope. */
const ADVERSATIVE = /\b(?:but|however|yet|although|though|whereas|except that)\b/i;

/**
 * Post-positioned negations/hedges: "the license plate is not readable",
 * "documents are barely visible", "the screen is obscured".
 */
const AFTER_NEGATION_CUE =
  /\b(?:not|never|barely|hardly|no longer)\b|\b(?:unreadable|illegible|unclear|obscured|blurr(?:ed|y)|out of focus|indistinct|unidentifiable|invisible|absent|missing|cut off|off-?screen)\b/i;

/**
 * Returns the offset of a pattern match that has NO negation cue in scope,
 * or null when every occurrence is negated/hedged. The before-scope runs
 * from the last sentence terminator [.!?] — commas and SEMICOLONS do NOT
 * reset it, because scene models write negated enumerations both ways:
 * "no screens, personal documents, or license plates" and "I do not see a
 * screen; personal documents; financial information". The after-scope
 * catches trailing negations ("the license plate is not readable") up to
 * the next clause. Adversative conjunctions start a fresh scope in both
 * directions, so "no clutter, but a passport lies open" still counts.
 * Checks every occurrence of the pattern.
 */
function confidentMatch(description: string, pattern: RegExp): number | null {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  for (const m of description.matchAll(new RegExp(pattern.source, flags))) {
    const idx = m.index ?? 0;
    const before = description.slice(0, idx);
    const sentenceStart = Math.max(
      before.lastIndexOf("."),
      before.lastIndexOf("!"),
      before.lastIndexOf("?"),
    );
    const beforeSegments = before.slice(sentenceStart + 1).split(ADVERSATIVE);
    const beforeScope = beforeSegments[beforeSegments.length - 1] ?? "";
    if (NEGATION_CUE.test(beforeScope)) continue;

    const afterRaw = description.slice(idx + m[0].length);
    const boundary = afterRaw.search(/[.,;!?]/);
    const afterClause = (
      boundary === -1 ? afterRaw : afterRaw.slice(0, boundary)
    ).slice(0, 60);
    const afterScope = afterClause.split(ADVERSATIVE)[0] ?? "";
    if (AFTER_NEGATION_CUE.test(afterScope)) continue;

    return idx;
  }
  return null;
}

/** The review-queue reason used for the user's own privacy request. */
export function buildUserReason(
  privacyRequest: string | null | undefined,
): string | null {
  const pr = privacyRequest?.trim();
  if (!pr) return null;
  return `Your request: matches "${pr.length > 80 ? `${pr.slice(0, 79)}…` : pr}"`;
}

export type SceneEvidence = {
  start: number;
  description: string;
  /** Offset of the confident regex match, so excerpts can center on it. */
  matchIndex?: number;
};

/**
 * Sequential scan with an early stop per category: the FIRST confident match
 * decides a category, later scenes can no longer add to it, and scanning
 * stops entirely once every target has matched. The result is at most ONE
 * review item per distinct matched category, each backed by a single clear
 * evidence scene — never a pile of low-confidence flags for the same video.
 */
export function evaluateScenes(
  scenes: ReadonlyArray<{ start?: unknown; description?: unknown }>,
  privacyRequest: string | null | undefined,
): Map<string, SceneEvidence> {
  const userReason = buildUserReason(privacyRequest);
  const totalTargets = SENSITIVE_PATTERNS.length + (userReason ? 1 : 0);
  const matched = new Map<string, SceneEvidence>();
  for (const scene of scenes) {
    if (matched.size >= totalTargets) break;
    const raw = typeof scene.description === "string" ? scene.description : "";
    // Stored details must read naturally — never show the sentinel. Curly
    // apostrophes are normalized so negation cues like "don’t" match.
    const description = raw
      .replaceAll(USER_MATCH_SENTINEL, "")
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/\s{2,}/g, " ")
      .trim();
    const start = Number(scene.start) || 0;
    for (const { pattern, label } of SENSITIVE_PATTERNS) {
      const reason = `Baseline: ${label}`;
      if (matched.has(reason)) continue;
      const matchIndex = confidentMatch(description, pattern);
      if (matchIndex !== null) {
        matched.set(reason, { start, description, matchIndex });
      }
    }
    if (
      userReason &&
      !matched.has(userReason) &&
      raw.includes(USER_MATCH_SENTINEL)
    ) {
      matched.set(userReason, { start, description });
    }
  }
  return matched;
}

/**
 * Excerpt for a review-item detail: centered on the confident match when we
 * have one (long descriptions often bury the evidence mid-text), otherwise
 * the head of the description.
 */
function evidenceExcerpt(evidence: SceneEvidence, len = 180): string {
  const { description, matchIndex } = evidence;
  if (matchIndex == null || description.length <= len) {
    return excerpt(description, len);
  }
  const from = Math.max(
    0,
    Math.min(matchIndex - Math.floor(len / 2), description.length - len),
  );
  const slice = description.slice(from, from + len).trim();
  const prefix = from > 0 ? "…" : "";
  const suffix = from + len < description.length ? "…" : "";
  return `${prefix}${slice}${suffix}`;
}

/**
 * Writes a scan result to the database: flagged with one review item per
 * matched category, or clean ("indexed"). The latest scan always supersedes
 * pending items from earlier scans, so reruns never stack duplicates and a
 * clean rerun clears stale flags.
 */
export async function applyScanResults(
  videoRowId: number,
  matched: Map<string, SceneEvidence>,
  sceneCount?: number,
): Promise<void> {
  if (matched.size > 0) {
    await db.transaction(async (tx) => {
      await tx
        .delete(reviewItemsTable)
        .where(
          and(
            eq(reviewItemsTable.videoId, videoRowId),
            eq(reviewItemsTable.status, "pending"),
          ),
        );
      for (const [reason, evidence] of matched) {
        await tx.insert(reviewItemsTable).values({
          videoId: videoRowId,
          reason,
          detail: `Scene at ${formatTimestamp(evidence.start)}: ${evidenceExcerpt(evidence)}`,
          status: "pending",
        });
      }
      await tx
        .update(videosTable)
        .set({ status: "flagged", indexError: null })
        .where(eq(videosTable.id, videoRowId));
    });
    // Log reason KINDS only — the user-request reason embeds the user's
    // own privacy text, which must not end up in server logs.
    logger.info(
      {
        videoRowId,
        baselineReasons: [...matched.keys()].filter((r) =>
          r.startsWith("Baseline: "),
        ),
        userRequestMatched: [...matched.keys()].some((r) =>
          r.startsWith("Your request:"),
        ),
        ...(sceneCount === undefined ? {} : { sceneCount }),
      },
      "Privacy scan flagged video",
    );
  } else {
    await db.transaction(async (tx) => {
      // Privacy scan owns its own review items; never delete language-confusion
      // items, which are handled by the language confirmation flow.
      await tx
        .delete(reviewItemsTable)
        .where(
          and(
            eq(reviewItemsTable.videoId, videoRowId),
            eq(reviewItemsTable.status, "pending"),
            not(like(reviewItemsTable.reason, "Language confusion:%")),
          ),
        );
      const stillPending = await tx
        .select({ id: reviewItemsTable.id })
        .from(reviewItemsTable)
        .where(
          and(
            eq(reviewItemsTable.videoId, videoRowId),
            eq(reviewItemsTable.status, "pending"),
          ),
        );
      await tx
        .update(videosTable)
        .set({
          status: stillPending.length > 0 ? "flagged" : "indexed",
          indexError: null,
        })
        .where(eq(videosTable.id, videoRowId));
    });
    logger.info({ videoRowId }, "Privacy scan clean; video indexed");
  }
}

const LANGUAGE_CONFUSION_REASON_PREFIX = "Language confusion:";

/**
 * Checks whether the resolved transcript language is likely a misdetection for
 * this user. If so, creates a review item with language-candidate metadata and
 * quarantines the video until the user confirms the correct language.
 */
async function checkLanguageConfusion(
  videoRowId: number,
  detectedLanguage: string,
): Promise<ReturnType<typeof findLanguageConfusion>> {
  const [video] = await db
    .select({ userId: videosTable.userId })
    .from(videosTable)
    .where(eq(videosTable.id, videoRowId));
  if (!video?.userId) return null;

  const [user] = await db
    .select({ languageProfile: usersTable.languageProfile })
    .from(usersTable)
    .where(eq(usersTable.id, video.userId));
  if (!user?.languageProfile?.length) return null;

  const confusion = findLanguageConfusion(detectedLanguage, user.languageProfile);
  if (!confusion) return null;

  const otherNames = confusion.candidates
    .filter((c) => c.toLowerCase() !== confusion.detected.toLowerCase())
    .map(displayName)
    .join(", ");
  const message = `Detected as ${displayName(confusion.detected)} — this is often confused with ${otherNames}. Which is correct?`;

  await db.transaction(async (tx) => {
    await tx.insert(reviewItemsTable).values({
      videoId: videoRowId,
      reason: `${LANGUAGE_CONFUSION_REASON_PREFIX} ${confusion.clusterId}`,
      detail: JSON.stringify({
        type: "language-confusion",
        detected: confusion.detected,
        candidates: confusion.candidates,
        message,
      }),
      status: "pending",
    });
    await tx
      .update(videosTable)
      .set({ status: "flagged" })
      .where(eq(videosTable.id, videoRowId));
  });

  return confusion;
}

/**
 * Re-runs transcription with a user-confirmed language code, then updates the
 * stored transcript excerpt and detected language. Does not resolve the review
 * item — the caller handles that after a successful regeneration.
 */
export async function regenerateTranscript(
  videoRowId: number,
  languageCode: string,
): Promise<{ transcriptExcerpt: string | null }> {
  const [video] = await db
    .select()
    .from(videosTable)
    .where(eq(videosTable.id, videoRowId));
  if (!video) throw new Error("Video not found");
  if (!video.videodbVideoId) {
    throw new Error("This video has no VideoDB asset; upload it again instead.");
  }

  const coll = await getVideoDBCollection();
  const media = await withTimeout(
    coll.getVideo(video.videodbVideoId),
    60_000,
    "VideoDB video fetch",
  );

  await withTimeout(
    media.generateTranscript(true, languageCode),
    2 * 60_000,
    "Transcript regeneration",
  );

  let text = "";
  const maxAttempts = 30;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await sleep(5_000);
    const result = await withTimeout(
      media.getTranscriptText(),
      60_000,
      "Transcript fetch",
    );
    if (typeof result === "string" && result.trim().length > 0) {
      text = result;
      break;
    }
  }

  if (!text.trim()) {
    throw new Error("Could not retrieve a transcript after regeneration.");
  }

  const transcriptExcerpt = excerpt(text);
  await db
    .update(videosTable)
    .set({
      transcriptExcerpt,
      hasTranscript: true,
      detectedLanguage: languageCode,
    })
    .where(eq(videosTable.id, videoRowId));

  return { transcriptExcerpt };
}

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

async function videoRowExists(videoRowId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: videosTable.id })
    .from(videosTable)
    .where(eq(videosTable.id, videoRowId));
  return !!row;
}

/**
 * The server owns every job after upload, and a deleted row is the cancel
 * signal: when the user cancels (deletes) a video mid-pipeline, the row is
 * gone. Each pipeline stage calls this at its boundary; it removes the
 * VideoDB asset so nothing is left behind and tells the caller to stop.
 */
async function stopIfCancelled(
  videoRowId: number,
  media?: VideoDBVideo | null,
): Promise<boolean> {
  if (await videoRowExists(videoRowId)) return false;
  if (media) {
    try {
      const coll = await getVideoDBCollection();
      await coll.deleteVideo(media.id);
    } catch (err) {
      // Already removed by the delete route — that's fine.
      if (!isVideoDBNotFoundError(err)) {
        logger.warn(
          { err, videoRowId },
          "Could not remove VideoDB asset of a cancelled video",
        );
      }
    }
  }
  logger.info({ videoRowId }, "Video was cancelled; ingestion stopped");
  return true;
}

async function recordIngestionFailure(
  videoRowId: number,
  message: string,
): Promise<void> {
  try {
    await db
      .update(videosTable)
      .set({ status: "failed", indexError: message })
      .where(eq(videosTable.id, videoRowId));
  } catch (dbErr) {
    logger.error({ err: dbErr, videoRowId }, "Failed to record ingestion error");
  }
}

/**
 * "No speech in this video" answers from VideoDB. These are an expected,
 * non-fatal outcome for silent clips, screen recordings, and music-only
 * footage — audio and visual indexing are independent steps.
 */
const NO_SPEECH_PATTERN =
  /no spoken data|failed to detect the language|language detection|no speech|no audio/i;

/**
 * Full ingestion pipeline for a newly uploaded video:
 * upload to VideoDB -> spoken-word index -> transcript excerpt -> privacy scan.
 * Runs entirely server-side in the background; all failures are recorded on
 * the row, and a deleted row (= user cancel) stops the pipeline cleanly.
 */
export async function runIngestion(
  videoRowId: number,
  source: UploadSource,
): Promise<void> {
  let media: VideoDBVideo | null = null;
  try {
    const coll = await getVideoDBCollection();
    const uploaded =
      source.kind === "url"
        ? await withTimeout(
            coll.uploadURL({ url: source.url, mediaType: "video" }),
            15 * 60_000,
            "VideoDB URL upload",
          )
        : await withTimeout(
            coll.uploadFile({ filePath: source.filePath, mediaType: "video" }),
            15 * 60_000,
            "VideoDB file upload",
          );

    if (!uploaded || !(uploaded instanceof VideoDBVideo)) {
      throw new Error("VideoDB upload did not return a video object");
    }
    media = uploaded;
    logger.info(
      { videoRowId, videodbVideoId: media.id },
      "VideoDB upload complete",
    );

    // The user may have cancelled while the file was in transit.
    if (await stopIfCancelled(videoRowId, media)) return;

    let thumbnailUrl: string | undefined;
    try {
      const thumb = await withTimeout(
        media.generateThumbnail(),
        2 * 60_000,
        "VideoDB thumbnail generation",
      );
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

    await indexAndScan(videoRowId, media);
  } catch (err) {
    // Cancelled mid-flight? Clean up quietly instead of recording a failure.
    if (await stopIfCancelled(videoRowId, media)) return;
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, videoRowId }, "Ingestion failed");
    await recordIngestionFailure(videoRowId, message);
  } finally {
    if (source.kind === "file") {
      await unlink(source.filePath).catch(() => {});
    }
  }
}

/**
 * Re-runs indexing + privacy scan for a video whose VideoDB upload already
 * succeeded (e.g. one that previously failed on a no-speech error before
 * silent videos were handled). Never re-uploads the file.
 */
export async function resumeIngestion(videoRowId: number): Promise<void> {
  try {
    const [row] = await db
      .select()
      .from(videosTable)
      .where(eq(videosTable.id, videoRowId));
    if (!row) return;
    if (!row.videodbVideoId) {
      throw new Error("This video has no VideoDB asset; upload it again instead.");
    }
    await db
      .update(videosTable)
      .set({ status: "processing", indexError: null })
      .where(eq(videosTable.id, videoRowId));
    const coll = await getVideoDBCollection();
    const media = await withTimeout(
      coll.getVideo(row.videodbVideoId),
      60_000,
      "VideoDB video fetch",
    );
    await indexAndScan(videoRowId, media);
  } catch (err) {
    if (await stopIfCancelled(videoRowId)) return;
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, videoRowId }, "Resumed ingestion failed");
    await recordIngestionFailure(videoRowId, message);
  }
}

/**
 * Indexing steps shared by fresh uploads and resumed ingestions. Audio and
 * visual indexing are independent: a video with no speech still gets scene
 * indexing and a privacy scan, and is marked indexed like any other.
 */
async function indexAndScan(
  videoRowId: number,
  media: VideoDBVideo,
): Promise<void> {
  let hasSpeech = true;
  try {
    const indexResult = await withTimeout(
      media.indexSpokenWords(),
      20 * 60_000,
      "Spoken-word indexing",
    );
    if (indexResult && indexResult.success === false) {
      throw new Error(indexResult.message || "Spoken-word indexing failed");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Silent clips are a normal outcome; only genuine failures propagate.
    if (!NO_SPEECH_PATTERN.test(message)) throw err;
    hasSpeech = false;
  }
  if (await stopIfCancelled(videoRowId, media)) return;

  let detectedLanguage: string | null = null;
  if (hasSpeech) {
    logger.info({ videoRowId }, "Spoken-word indexing complete");
    try {
      const text = await withTimeout(
        media.getTranscriptText(),
        2 * 60_000,
        "Transcript fetch",
      );
      if (typeof text === "string" && text.trim().length > 0) {
        const [video] = await db
          .select({ requestedLanguage: videosTable.requestedLanguage })
          .from(videosTable)
          .where(eq(videosTable.id, videoRowId));
        detectedLanguage =
          video?.requestedLanguage?.trim() || detectTranscriptLanguage(text) || null;
        await db
          .update(videosTable)
          .set({
            transcriptExcerpt: excerpt(text),
            hasTranscript: true,
            detectedLanguage,
          })
          .where(eq(videosTable.id, videoRowId));
      }
    } catch (err) {
      logger.warn({ err, videoRowId }, "Transcript fetch failed");
    }
  } else {
    logger.info(
      { videoRowId },
      "No speech detected; indexing visuals only (non-fatal)",
    );
    await db
      .update(videosTable)
      .set({ hasTranscript: false, transcriptExcerpt: null, detectedLanguage: null })
      .where(eq(videosTable.id, videoRowId));
  }

  if (detectedLanguage) {
    const confusion = await checkLanguageConfusion(videoRowId, detectedLanguage);
    if (confusion) {
      logger.info(
        { videoRowId, detectedLanguage, clusterId: confusion.clusterId },
        "Language confusion flagged for review",
      );
      await runPrivacyScan(videoRowId);
      return;
    }
  }

  await runPrivacyScan(videoRowId);
}

/**
 * Privacy/sensitivity pass over a VideoDB-indexed video.
 * Matched categories create ONE pending review item each and quarantine the
 * video (status "flagged"); a clean pass marks it "indexed".
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
    logger.info({ videoRowId }, "Privacy scan skipped: video was cancelled");
    return;
  }
  if (!row.videodbVideoId) {
    throw new Error(`Video ${videoRowId} has no VideoDB id; cannot scan`);
  }

  let media: VideoDBVideo | null = null;
  try {
    const coll = await getVideoDBCollection();
    media = await withTimeout(
      coll.getVideo(row.videodbVideoId),
      60_000,
      "VideoDB video fetch",
    );
    const sceneIndexId = await withTimeout(
      media.indexScenes({
        prompt: buildScenePrompt(row.privacyRequest),
        name: "privacy-scan",
      }),
      3 * 60_000,
      "Scene indexing request",
    );
    if (!sceneIndexId) {
      throw new Error("Scene indexing did not return an index id");
    }
    await db
      .update(videosTable)
      .set({ sceneIndexId })
      .where(eq(videosTable.id, videoRowId));

    // Scene indexing runs asynchronously on VideoDB's side; poll until ready.
    let scenes: Awaited<ReturnType<typeof media.getSceneIndex>> | undefined;
    const maxAttempts = 30;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await sleep(10_000);
      // React to a cancel within seconds, not after full indexing.
      if (await stopIfCancelled(videoRowId, media)) return;
      try {
        const records = await withTimeout(
          media.getSceneIndex(sceneIndexId),
          60_000,
          "Scene index fetch",
        );
        if (Array.isArray(records) && records.length > 0) {
          scenes = records;
          break;
        }
      } catch {
        // Index not ready yet (or one slow fetch) — keep polling.
      }
    }
    if (!scenes || scenes.length === 0) {
      throw new Error("Scene index was not ready after 5 minutes");
    }

    await db
      .update(videosTable)
      .set({ sceneCount: scenes.length })
      .where(eq(videosTable.id, videoRowId));

    const matched = evaluateScenes(scenes, row.privacyRequest);
    await applyScanResults(videoRowId, matched, scenes.length);
  } catch (err) {
    if (await stopIfCancelled(videoRowId, media)) return;
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
