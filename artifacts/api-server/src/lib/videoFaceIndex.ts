import { and, eq, inArray } from "drizzle-orm";
import { Video as VideoDBVideo } from "videodb";
import {
  db,
  peopleTable,
  videoFacesTable,
  videosTable,
  type PersonRow,
  type VideoRow,
} from "@workspace/db";
import { logger } from "./logger";
import { getVideoDBCollection, withTimeout } from "./videodb";
import {
  isRekognitionConfigured,
  matchedFacesInFrame,
  RekognitionUnavailableError,
} from "./rekognition";

const MAX_FRAME_BYTES = 5 * 1024 * 1024;

/** Interval between sampled frames, in seconds. */
const SAMPLE_INTERVAL = 30;

/** Frames within this many seconds of each other are merged into one range. */
const MERGE_GAP = SAMPLE_INTERVAL * 2.5;

type IndexedPerson = Pick<PersonRow, "id" | "name" | "rekognitionFaceId">;
type IndexedVideo = Pick<
  VideoRow,
  "id" | "userId" | "videodbVideoId" | "durationSeconds" | "status"
>;

type FrameMatch = {
  timeSeconds: number;
  personId: number;
  confidence: number;
};

type TimelineRange = {
  personId: number;
  startTime: number;
  endTime: number;
  confidence: number;
};

export function enqueueFaceIndexForVideo(videoId: number): void {
  void indexFacesForVideo(videoId).catch((err) => {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), videoId },
      "Video face-index job crashed",
    );
  });
}

export function enqueueFaceIndexForPerson(personId: number): void {
  void indexFacesForPerson(personId).catch((err) => {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), personId },
      "Person face-index job crashed",
    );
  });
}

/**
 * Re-run face indexing across every indexed video in the user's library.
 * Needed after the first enrollment of any person (or manually via the
 * "Rebuild face index" action) to backfill videos that predate the fix.
 */
export function enqueueFaceIndexForLibrary(userId: number): void {
  void indexFacesForLibrary(userId).catch((err) => {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), userId },
      "Library face-index rebuild crashed",
    );
  });
}

/**
 * After a video is indexed, compare sampled frames against every enrolled
 * person for that user and persist the timeline ranges.
 */
export async function indexFacesForVideo(videoId: number): Promise<void> {
  if (!isRekognitionConfigured()) {
    logger.warn({ videoId }, "Face indexing skipped: Rekognition is not configured");
    return;
  }
  const [video] = await db
    .select()
    .from(videosTable)
    .where(eq(videosTable.id, videoId));
  if (!video?.userId || !video.videodbVideoId || video.status !== "indexed") {
    return;
  }
  const people = await db
    .select()
    .from(peopleTable)
    .where(eq(peopleTable.userId, video.userId));
  await indexVideoAgainstPeople(video, people);
}

/**
 * After a person is enrolled, compare them against all existing indexed
 * videos for that user.
 */
export async function indexFacesForPerson(personId: number): Promise<void> {
  if (!isRekognitionConfigured()) {
    logger.warn({ personId }, "Face indexing skipped: Rekognition is not configured");
    return;
  }
  const [person] = await db
    .select()
    .from(peopleTable)
    .where(eq(peopleTable.id, personId));
  if (!person) return;
  const videos = await db
    .select()
    .from(videosTable)
    .where(
      and(
        eq(videosTable.userId, person.userId),
        eq(videosTable.status, "indexed"),
      ),
    );
  for (const video of videos.filter((v) => v.videodbVideoId)) {
    await indexVideoAgainstPeople(video, [person]);
  }
}

/**
 * Re-run face indexing for every indexed video in the user's library,
 * checking against all their currently enrolled people.
 */
async function indexFacesForLibrary(userId: number): Promise<void> {
  if (!isRekognitionConfigured()) {
    logger.warn({ userId }, "Library face rebuild skipped: Rekognition not configured");
    return;
  }
  const [people, videos] = await Promise.all([
    db.select().from(peopleTable).where(eq(peopleTable.userId, userId)),
    db
      .select()
      .from(videosTable)
      .where(and(eq(videosTable.userId, userId), eq(videosTable.status, "indexed"))),
  ]);
  if (people.length === 0) {
    logger.info({ userId }, "Library face rebuild: no enrolled people, nothing to do");
    return;
  }
  const eligible = videos.filter((v) => v.videodbVideoId);
  logger.info(
    { userId, videos: eligible.length, people: people.length },
    "Library face index rebuild started",
  );
  for (const video of eligible) {
    await indexVideoAgainstPeople(video, people);
  }
  logger.info(
    { userId, videos: eligible.length },
    "Library face index rebuild complete",
  );
}

async function indexVideoAgainstPeople(
  video: IndexedVideo,
  people: IndexedPerson[],
): Promise<void> {
  if (!video.videodbVideoId || people.length === 0) return;
  const targetByFaceId = new Map(people.map((p) => [p.rekognitionFaceId, p]));
  const frameMatches: FrameMatch[] = [];
  const samplePoints = timeSamplePoints(video.durationSeconds);

  try {
    const coll = await withTimeout(getVideoDBCollection(), 60_000, "getCollection");
    const media = await withTimeout(
      coll.getVideo(video.videodbVideoId),
      60_000,
      "face-index: video fetch",
    );

    for (const time of samplePoints) {
      const bytes = await extractFrame(media, time);
      if (!bytes) continue;
      const matches = await matchedFacesInFrame(bytes);
      for (const [faceId, confidence] of matches) {
        const person = targetByFaceId.get(faceId);
        if (!person) continue;
        frameMatches.push({ timeSeconds: time, personId: person.id, confidence });
      }
    }
  } catch (err) {
    if (err instanceof RekognitionUnavailableError) {
      logger.error(
        { videoId: video.id },
        "Face indexing stopped: Rekognition unavailable",
      );
      return;
    }
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        videoId: video.id,
      },
      "Face indexing failed for video",
    );
    return;
  }

  const ranges = buildTimelineRanges(frameMatches);
  const personIds = people.map((p) => p.id);

  await db.transaction(async (tx) => {
    // Replace all existing ranges for the people being re-indexed on this video.
    await tx
      .delete(videoFacesTable)
      .where(
        and(
          eq(videoFacesTable.videoId, video.id),
          inArray(videoFacesTable.personId, personIds),
        ),
      );
    if (ranges.length > 0) {
      await tx.insert(videoFacesTable).values(
        ranges.map((r) => ({
          videoId: video.id,
          personId: r.personId,
          startTime: r.startTime,
          endTime: r.endTime,
          confidence: r.confidence,
        })),
      );
    }
  });

  logger.info(
    {
      videoId: video.id,
      sampledFrames: samplePoints.length,
      checkedPeople: people.length,
      matchedRanges: ranges.length,
    },
    "Video face timeline index updated",
  );
}

/**
 * Sample times at fixed SAMPLE_INTERVAL intervals across the full video.
 * A 10-minute video produces ~21 frames; a 2-hour video produces ~241.
 * Unknown duration falls back to a handful of early points.
 */
function timeSamplePoints(durationSeconds: number): number[] {
  const duration = Math.max(0, durationSeconds || 0);
  if (duration === 0) {
    return [0, 15, 30, 60];
  }
  const points: number[] = [];
  for (let t = 0; t <= duration; t += SAMPLE_INTERVAL) {
    points.push(Math.round(t));
  }
  // Always cover the tail of the video.
  const tail = Math.round(duration);
  if (!points.includes(tail)) points.push(tail);
  return [...new Set(points)].sort((a, b) => a - b);
}

/**
 * Merge per-frame Rekognition matches into contiguous timeline ranges.
 * Consecutive frames for the same person that are within MERGE_GAP seconds
 * of each other are merged into one range. This avoids one row per frame
 * while preserving distinct appearance clusters.
 */
function buildTimelineRanges(frameMatches: FrameMatch[]): TimelineRange[] {
  const byPerson = new Map<number, FrameMatch[]>();
  for (const m of frameMatches) {
    const arr = byPerson.get(m.personId) ?? [];
    arr.push(m);
    byPerson.set(m.personId, arr);
  }

  const ranges: TimelineRange[] = [];
  for (const [personId, matches] of byPerson) {
    matches.sort((a, b) => a.timeSeconds - b.timeSeconds);
    let rangeStart = matches[0]!.timeSeconds;
    let rangeEnd = matches[0]!.timeSeconds;
    let maxConf = matches[0]!.confidence;

    for (let i = 1; i < matches.length; i++) {
      const m = matches[i]!;
      if (m.timeSeconds - rangeEnd <= MERGE_GAP) {
        rangeEnd = m.timeSeconds;
        maxConf = Math.max(maxConf, m.confidence);
      } else {
        ranges.push({ personId, startTime: rangeStart, endTime: rangeEnd, confidence: maxConf });
        rangeStart = m.timeSeconds;
        rangeEnd = m.timeSeconds;
        maxConf = m.confidence;
      }
    }
    ranges.push({ personId, startTime: rangeStart, endTime: rangeEnd, confidence: maxConf });
  }
  return ranges;
}

async function extractFrame(
  media: VideoDBVideo,
  timeSeconds: number,
): Promise<Buffer | null> {
  try {
    const thumb = await withTimeout(
      media.generateThumbnail(timeSeconds),
      45_000,
      "face-index: frame extraction",
    );
    let url: string | null = null;
    if (typeof thumb === "string") {
      url = thumb;
    } else if (thumb && typeof thumb === "object") {
      url =
        (thumb as { url?: string }).url ||
        (await withTimeout(
          (thumb as { generateUrl: () => Promise<string> }).generateUrl(),
          30_000,
          "face-index: frame url",
        ));
    }
    if (!url) return null;
    const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!resp.ok) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > MAX_FRAME_BYTES) return null;
    return buf;
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        timeSeconds,
      },
      "Face-index frame extraction failed",
    );
    return null;
  }
}
