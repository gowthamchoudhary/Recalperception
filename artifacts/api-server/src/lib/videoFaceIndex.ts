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

type IndexedPerson = Pick<PersonRow, "id" | "name" | "rekognitionFaceId">;
type IndexedVideo = Pick<
  VideoRow,
  "id" | "userId" | "videodbVideoId" | "durationSeconds" | "status"
>;

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
 * After a video is indexed, compare sampled frames against every enrolled
 * person for that user and persist the matches.
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
 * VideoDB videos for that user.
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

async function indexVideoAgainstPeople(
  video: IndexedVideo,
  people: IndexedPerson[],
): Promise<void> {
  if (!video.videodbVideoId || people.length === 0) return;
  const targetByFaceId = new Map(people.map((p) => [p.rekognitionFaceId, p]));
  const confidenceByPersonId = new Map<number, number>();

  try {
    const coll = await withTimeout(getVideoDBCollection(), 60_000, "getCollection");
    const media = await withTimeout(
      coll.getVideo(video.videodbVideoId),
      60_000,
      "face-index: video fetch",
    );
    for (const time of sampleTimes(video.durationSeconds)) {
      const bytes = await extractFrame(media, time);
      if (!bytes) continue;
      const matches = await matchedFacesInFrame(bytes);
      for (const [faceId, confidence] of matches) {
        const person = targetByFaceId.get(faceId);
        if (!person) continue;
        confidenceByPersonId.set(
          person.id,
          Math.max(confidenceByPersonId.get(person.id) ?? 0, confidence),
        );
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

  const personIds = people.map((p) => p.id);
  await db.transaction(async (tx) => {
    await tx
      .delete(videoFacesTable)
      .where(
        and(
          eq(videoFacesTable.videoId, video.id),
          inArray(videoFacesTable.personId, personIds),
        ),
      );
    const rows = [...confidenceByPersonId].map(([personId, confidence]) => ({
      videoId: video.id,
      personId,
      confidence,
    }));
    if (rows.length > 0) await tx.insert(videoFacesTable).values(rows);
  });
  logger.info(
    {
      videoId: video.id,
      checkedPeople: people.length,
      matchedPeople: confidenceByPersonId.size,
    },
    "Video face index updated",
  );
}

function sampleTimes(durationSeconds: number): number[] {
  const duration = Math.max(0, durationSeconds || 0);
  const raw =
    duration > 0
      ? [0, duration * 0.15, duration * 0.35, duration * 0.6, duration * 0.85]
      : [0, 5, 15, 30];
  return [...new Set(raw.map((t) => Math.max(0, Math.round(t))))];
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
