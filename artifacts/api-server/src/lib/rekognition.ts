import {
  RekognitionClient,
  CreateCollectionCommand,
  DescribeCollectionCommand,
  IndexFacesCommand,
  SearchFacesByImageCommand,
  DeleteFacesCommand,
} from "@aws-sdk/client-rekognition";
import { logger } from "./logger";
import { withTimeout } from "./videodb";

/**
 * AWS Rekognition face collection wrapper.
 *
 * One shared collection (AWS_REKOGNITION_COLLECTION_ID) holds every enrolled
 * face; rows in the `people` table map FaceIds to users, so matching is
 * always checked against a specific person's FaceId — never "any face".
 *
 * Every entry point is resilient: callers can distinguish "service not
 * usable" (misconfigured/unreachable — fall back to scene-only search) from
 * per-image outcomes like "no face in this frame".
 */

const REQUIRED_ENV = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_REGION",
  "AWS_REKOGNITION_COLLECTION_ID",
] as const;

export function isRekognitionConfigured(): boolean {
  return REQUIRED_ENV.every((k) => Boolean(process.env[k]));
}

function collectionId(): string {
  return process.env["AWS_REKOGNITION_COLLECTION_ID"] ?? "";
}

let client: RekognitionClient | null = null;
function getClient(): RekognitionClient {
  if (!client) {
    client = new RekognitionClient({
      region: process.env["AWS_REGION"],
    });
  }
  return client;
}

/** Errors that mean "Rekognition itself is unusable", not "this image had no face". */
export class RekognitionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RekognitionUnavailableError";
  }
}

function isServiceLevelError(err: unknown): boolean {
  const name = (err as { name?: string })?.name ?? "";
  if (
    [
      "UnrecognizedClientException",
      "InvalidSignatureException",
      "AccessDeniedException",
      "ResourceNotFoundException",
      "ThrottlingException",
      "ProvisionedThroughputExceededException",
      "CredentialsProviderError",
      "TimeoutError",
      "NetworkingError",
    ].includes(name)
  ) {
    return true;
  }
  // withTimeout rejections — a stalled AWS endpoint is a service problem.
  const message = err instanceof Error ? err.message : "";
  return /timed out/i.test(message);
}

/**
 * First-run collection bootstrap: DescribeCollection, and if it does not
 * exist yet, CreateCollection. Cached after the first success so we don't
 * pay a Describe round-trip on every call.
 */
let collectionReady: Promise<void> | null = null;
export function ensureCollection(): Promise<void> {
  if (!collectionReady) {
    collectionReady = (async () => {
      const id = collectionId();
      try {
        await withTimeout(
          getClient().send(new DescribeCollectionCommand({ CollectionId: id })),
          15_000,
          "Rekognition DescribeCollection",
        );
      } catch (err) {
        if ((err as { name?: string })?.name === "ResourceNotFoundException") {
          await withTimeout(
            getClient().send(new CreateCollectionCommand({ CollectionId: id })),
            15_000,
            "Rekognition CreateCollection",
          );
          logger.info({ collectionId: id }, "Created Rekognition face collection");
          return;
        }
        throw err;
      }
    })().catch((err) => {
      // Allow a retry on the next call instead of caching the failure forever.
      collectionReady = null;
      throw err;
    });
  }
  return collectionReady;
}

export type IndexFaceOutcome =
  | { ok: true; faceId: string }
  | { ok: false; reason: "no-face" | "low-quality" | "bad-image" };

/**
 * Index the (single, largest) face in a reference photo into the collection.
 * Returns the FaceId to store, or a friendly reason when the photo is not
 * usable. Throws RekognitionUnavailableError when the service is unusable.
 */
export async function indexReferenceFace(
  imageBytes: Buffer,
  externalImageId: string,
): Promise<IndexFaceOutcome> {
  await ensureCollectionOrThrowUnavailable();
  try {
    const out = await withTimeout(
      getClient().send(
        new IndexFacesCommand({
          CollectionId: collectionId(),
          Image: { Bytes: imageBytes },
          MaxFaces: 1,
          QualityFilter: "AUTO",
          DetectionAttributes: [],
          ExternalImageId: externalImageId,
        }),
      ),
      30_000,
      "Rekognition IndexFaces",
    );
    const faceId = out.FaceRecords?.[0]?.Face?.FaceId;
    if (faceId) return { ok: true, faceId };
    const unindexed = out.UnindexedFaces?.length ?? 0;
    return { ok: false, reason: unindexed > 0 ? "low-quality" : "no-face" };
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === "InvalidParameterException") {
      // Rekognition raises this when no face is detected in the image.
      return { ok: false, reason: "no-face" };
    }
    if (name === "InvalidImageFormatException" || name === "ImageTooLargeException") {
      return { ok: false, reason: "bad-image" };
    }
    throw toUnavailableIfServiceLevel(err, "IndexFaces");
  }
}

/**
 * Does this specific FaceId appear in the frame? Uses SearchFacesByImage
 * (matches the largest face in the frame against the collection) and checks
 * the target FaceId against the returned matches.
 *
 * Returns false for "no face in frame" / "face present but not this person".
 * Throws RekognitionUnavailableError when the service is unusable so the
 * caller can abandon person-filtering entirely.
 */
export async function frameContainsFace(
  frameBytes: Buffer,
  targetFaceId: string,
): Promise<boolean> {
  return (await matchedFaceIdsInFrame(frameBytes)).has(targetFaceId);
}

/**
 * All collection FaceIds that match the (largest) face in this frame.
 * One SearchFacesByImage call serves any number of target people — callers
 * intersect the returned set with their own targets.
 *
 * Returns an empty set for "no face in frame". Throws
 * RekognitionUnavailableError when the service is unusable.
 */
export async function matchedFaceIdsInFrame(
  frameBytes: Buffer,
): Promise<Set<string>> {
  const matches = await matchedFacesInFrame(frameBytes);
  return new Set(matches.keys());
}

/**
 * Collection FaceIds that match the largest face in this frame, with AWS
 * similarity percentages rounded to integers for persisted confidence.
 */
export async function matchedFacesInFrame(
  frameBytes: Buffer,
): Promise<Map<string, number>> {
  try {
    const out = await withTimeout(
      getClient().send(
        new SearchFacesByImageCommand({
          CollectionId: collectionId(),
          Image: { Bytes: frameBytes },
          FaceMatchThreshold: 85,
          MaxFaces: 10,
        }),
      ),
      20_000,
      "Rekognition SearchFacesByImage",
    );
    const matches = new Map<string, number>();
    for (const m of out.FaceMatches ?? []) {
      const faceId = m.Face?.FaceId;
      if (!faceId) continue;
      const similarity = Math.round(m.Similarity ?? 0);
      matches.set(faceId, Math.max(matches.get(faceId) ?? 0, similarity));
    }
    return matches;
  } catch (err) {
    if ((err as { name?: string })?.name === "InvalidParameterException") {
      // No face detected in this frame — a normal negative, not an outage.
      return new Map();
    }
    throw toUnavailableIfServiceLevel(err, "SearchFacesByImage");
  }
}

/** Best-effort face removal when a person is deleted. Never throws. */
export async function deleteFace(faceId: string): Promise<void> {
  try {
    await withTimeout(
      getClient().send(
        new DeleteFacesCommand({ CollectionId: collectionId(), FaceIds: [faceId] }),
      ),
      10_000,
      "Rekognition DeleteFaces",
    );
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), faceId },
      "Could not delete face from Rekognition collection (row removed anyway)",
    );
  }
}

async function ensureCollectionOrThrowUnavailable(): Promise<void> {
  try {
    await ensureCollection();
  } catch (err) {
    throw toUnavailableIfServiceLevel(err, "ensureCollection");
  }
}

function toUnavailableIfServiceLevel(err: unknown, op: string): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (isServiceLevelError(err) || !(err instanceof Error)) {
    logger.error({ err: message, op }, "Rekognition unavailable");
    return new RekognitionUnavailableError(`${op}: ${message}`);
  }
  logger.error({ err: message, op }, "Rekognition call failed");
  return err;
}
