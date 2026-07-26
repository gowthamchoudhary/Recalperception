import { Router, type IRouter } from "express";
import { and, asc, eq } from "drizzle-orm";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import multer from "multer";
import {
  db,
  videosTable,
  peopleTable,
  videoFacesTable,
  type PersonRow,
} from "@workspace/db";
import {
  ListPeopleResponse,
  ListEnrolledPeopleResponse,
  EnrollPersonResponse,
  UpdateEnrolledPersonParams,
  UpdateEnrolledPersonBody,
  UpdateEnrolledPersonResponse,
  DeleteEnrolledPersonParams,
} from "@workspace/api-zod";
import { currentUserId } from "../lib/auth";
import { logger } from "../lib/logger";
import {
  isRekognitionConfigured,
  indexReferenceFace,
  deleteFace,
  RekognitionUnavailableError,
} from "../lib/rekognition";
import {
  enqueueFaceIndexForPerson,
  enqueueFaceIndexForLibrary,
} from "../lib/videoFaceIndex";

const router: IRouter = Router();

// Reference photos are small (the client downscales before upload); 8MB
// leaves headroom while keeping Rekognition's 5MB byte limit enforceable
// after read.
const photoUpload = multer({
  dest: path.join(os.tmpdir(), "recall-people-photos"),
  limits: { fileSize: 8 * 1024 * 1024 },
});

const PHOTO_MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpeg",
  "image/png": "png",
};

function toApiEnrolledPerson(row: PersonRow) {
  return {
    id: row.id,
    name: row.name,
    thumbnailUrl: row.thumbnailUrl,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Fire-and-forget: re-run face indexing across the user's entire library.
 * Needed when videos were uploaded before any person was enrolled, or after
 * the sampling logic is improved.
 */
router.post("/people/enrolled/rebuild-face-index", async (req, res): Promise<void> => {
  if (!isRekognitionConfigured()) {
    res.status(503).json({
      error: "Face recognition is not configured. Add the AWS Rekognition secrets first.",
    });
    return;
  }
  const uid = currentUserId(req);
  enqueueFaceIndexForLibrary(uid);
  res.json({ ok: true, message: "Face index rebuild started for your entire library." });
});

router.get("/people/enrolled", async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(peopleTable)
    .where(eq(peopleTable.userId, currentUserId(req)))
    .orderBy(asc(peopleTable.name));
  res.json(ListEnrolledPeopleResponse.parse(rows.map(toApiEnrolledPerson)));
});

router.post(
  "/people/enrolled",
  photoUpload.single("photo"),
  async (req, res): Promise<void> => {
    const file = req.file;
    try {
      const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
      if (!name || name.length > 80) {
        res.status(400).json({ error: "Enter a name (up to 80 characters)." });
        return;
      }
      if (!file) {
        res.status(400).json({ error: "Attach a reference photo." });
        return;
      }
      const ext = PHOTO_MIME_TO_EXT[file.mimetype];
      if (!ext) {
        res.status(400).json({ error: "Use a JPEG or PNG photo." });
        return;
      }
      if (!isRekognitionConfigured()) {
        res.status(503).json({
          error:
            "Face recognition is not configured. Add the AWS Rekognition secrets, then try again.",
        });
        return;
      }
      const uid = currentUserId(req);
      const bytes = await fs.readFile(file.path);
      if (bytes.byteLength > 5 * 1024 * 1024) {
        res.status(400).json({
          error: "Photo is too large — use one under 5MB.",
        });
        return;
      }

      const outcome = await indexReferenceFace(bytes, `u${uid}`);
      if (!outcome.ok) {
        const messages = {
          "no-face":
            "No face was detected in that photo. Use a clear, front-facing photo.",
          "low-quality":
            "The face in that photo is too small or blurry. Use a sharper, closer photo.",
          "bad-image":
            "That image could not be read. Use a standard JPEG or PNG photo under 5MB.",
        } as const;
        res.status(400).json({ error: messages[outcome.reason] });
        return;
      }

      const [row] = await db
        .insert(peopleTable)
        .values({
          userId: uid,
          name,
          rekognitionFaceId: outcome.faceId,
          thumbnailUrl: `data:${file.mimetype};base64,${bytes.toString("base64")}`,
        })
        .returning();
      logger.info({ personId: row!.id }, "Enrolled person for face search");
      enqueueFaceIndexForPerson(row!.id);
      res.status(201).json(EnrollPersonResponse.parse(toApiEnrolledPerson(row!)));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err }, "Person enrollment failed");
      if (err instanceof RekognitionUnavailableError) {
        res.status(503).json({
          error:
            "Face recognition is unreachable or misconfigured. Check the AWS secrets and try again.",
        });
        return;
      }
      res.status(502).json({ error: `Could not enroll this person: ${message}` });
    } finally {
      if (file) void fs.unlink(file.path).catch(() => {});
    }
  },
);

router.patch("/people/enrolled/:id", async (req, res): Promise<void> => {
  const params = UpdateEnrolledPersonParams.safeParse(req.params);
  const body = UpdateEnrolledPersonBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const newName = body.data.name.trim();
  if (!newName) {
    res.status(400).json({ error: "Name cannot be empty." });
    return;
  }
  const [row] = await db
    .update(peopleTable)
    .set({ name: newName })
    .where(
      and(
        eq(peopleTable.id, params.data.id),
        eq(peopleTable.userId, currentUserId(req)),
      ),
    )
    .returning();
  if (!row) {
    res.status(404).json({ error: "Person not found" });
    return;
  }
  res.json(UpdateEnrolledPersonResponse.parse(toApiEnrolledPerson(row)));
});

router.delete("/people/enrolled/:id", async (req, res): Promise<void> => {
  const params = DeleteEnrolledPersonParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const [existing] = await db
    .select()
    .from(peopleTable)
    .where(
      and(
        eq(peopleTable.id, params.data.id),
        eq(peopleTable.userId, currentUserId(req)),
      ),
    );
  if (!existing) {
    res.status(404).json({ error: "Person not found" });
    return;
  }
  await db
    .delete(videoFacesTable)
    .where(eq(videoFacesTable.personId, existing.id));
  const [row] = await db
    .delete(peopleTable)
    .where(eq(peopleTable.id, existing.id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Person not found" });
    return;
  }
  // Best-effort collection cleanup; the row is already gone either way.
  await deleteFace(row.rekognitionFaceId);
  res.status(204).end();
});

router.get("/people", async (req, res): Promise<void> => {
  const videos = await db
    .select()
    .from(videosTable)
    .where(eq(videosTable.userId, currentUserId(req)));
  const byName = new Map<
    string,
    { count: number; lastSeenAt: string | null }
  >();
  for (const v of videos) {
    for (const name of v.people) {
      const entry = byName.get(name) ?? { count: 0, lastSeenAt: null };
      entry.count += 1;
      const seen = v.recordedAt ?? v.uploadedAt.toISOString();
      if (!entry.lastSeenAt || seen > entry.lastSeenAt) entry.lastSeenAt = seen;
      byName.set(name, entry);
    }
  }
  const people = Array.from(byName.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .map(([name, { count, lastSeenAt }], i) => ({
      id: i + 1,
      name,
      appearanceCount: count,
      lastSeenAt,
    }));
  res.json(ListPeopleResponse.parse(people));
});

export default router;
