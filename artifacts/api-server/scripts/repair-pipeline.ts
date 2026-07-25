/**
 * One-off repair after the July 2026 pipeline fixes.
 *
 *  Phase 1 — flagged videos: re-run the NEW matching logic (negation guard,
 *            first confident match per category) over their EXISTING VideoDB
 *            scene indexes. Collapses duplicate/contradictory review items
 *            without paying for re-indexing. Videos whose flags were all
 *            negation artifacts become "indexed".
 *
 *  Phase 2 — videos that failed on "no spoken data found": resume ingestion
 *            from the spoken-word step (now non-fatal for silent clips) so
 *            they get scene-indexed, privacy-scanned, and marked indexed.
 *
 * Usage: node dist/repair-pipeline.mjs [phase1|phase2]
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { db, videosTable } from "@workspace/db";
import {
  evaluateScenes,
  applyScanResults,
  resumeIngestion,
} from "../src/lib/ingestion";
import { getVideoDBCollection } from "../src/lib/videodb";

async function phase1(): Promise<void> {
  const flagged = await db
    .select()
    .from(videosTable)
    .where(
      and(
        eq(videosTable.status, "flagged"),
        isNotNull(videosTable.videodbVideoId),
      ),
    );
  console.log(`Phase 1: ${flagged.length} flagged videos to re-evaluate`);
  const coll = await getVideoDBCollection();
  for (const row of flagged) {
    try {
      const media = await coll.getVideo(row.videodbVideoId!);
      const indexes = await media.listSceneIndex();
      const idx = indexes.find((i) => i.name === "privacy-scan") ?? indexes[0];
      if (!idx) {
        console.log(`video ${row.id}: no scene index; leaving as-is`);
        continue;
      }
      const scenes = await media.getSceneIndex(idx.sceneIndexId);
      if (!Array.isArray(scenes) || scenes.length === 0) {
        console.log(`video ${row.id}: scene index empty; leaving as-is`);
        continue;
      }
      const matched = evaluateScenes(scenes, row.privacyRequest);
      await applyScanResults(row.id, matched, scenes.length);
      await db
        .update(videosTable)
        .set({ sceneIndexId: idx.sceneIndexId })
        .where(eq(videosTable.id, row.id));
      console.log(
        `video ${row.id}: ${matched.size} confident categor${matched.size === 1 ? "y" : "ies"} -> ${matched.size > 0 ? "flagged" : "indexed"}`,
      );
    } catch (err) {
      console.error(`video ${row.id}: repair failed`, err);
    }
  }
}

async function phase2(): Promise<void> {
  const failed = await db
    .select()
    .from(videosTable)
    .where(
      and(
        eq(videosTable.status, "failed"),
        isNotNull(videosTable.videodbVideoId),
      ),
    );
  const eligible = failed.filter(
    (r) => r.indexError && /no spoken data|language/i.test(r.indexError),
  );
  console.log(
    `Phase 2: resuming ${eligible.length} of ${failed.length} failed videos`,
  );
  // Serial on purpose: concurrent long calls kept wedging against VideoDB.
  // A hard per-video cap guarantees the batch always advances; capped rows
  // are reset to their original failed state so a later rerun picks them up.
  const NO_SPEECH_ERROR =
    "VideoDB Error: Failed to detect the language, no spoken data found.";
  const PER_VIDEO_CAP_MS = 12 * 60_000;
  for (const row of eligible) {
    console.log(`video ${row.id}: resuming…`);
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      resumeIngestion(row.id).then(
        () => "done" as const,
        (err) => {
          console.error(`video ${row.id}: resume threw`, err);
          return "done" as const;
        },
      ),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), PER_VIDEO_CAP_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    if (outcome === "timeout") {
      console.log(
        `video ${row.id}: exceeded ${PER_VIDEO_CAP_MS / 60_000}min cap; resetting for a later retry`,
      );
      await db
        .update(videosTable)
        .set({ status: "failed", indexError: NO_SPEECH_ERROR })
        .where(
          and(eq(videosTable.id, row.id), eq(videosTable.status, "processing")),
        );
      continue;
    }
    const [after] = await db
      .select({ status: videosTable.status })
      .from(videosTable)
      .where(eq(videosTable.id, row.id));
    console.log(`video ${row.id}: ${after?.status ?? "gone"}`);
  }
  const leftovers = await db
    .select({ id: videosTable.id, status: videosTable.status })
    .from(videosTable)
    .where(eq(videosTable.status, "processing"));
  if (leftovers.length > 0) {
    console.log(`WARNING: still processing: ${leftovers.map((l) => l.id).join(", ")}`);
  }
}

const main = process.argv[2] === "phase2" ? phase2 : phase1;
main()
  .then(() => {
    console.log("done");
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
