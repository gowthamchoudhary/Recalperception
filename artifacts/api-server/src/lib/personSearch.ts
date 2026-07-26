import { Video } from "videodb";
import { logger } from "./logger";
import { withTimeout } from "./videodb";
import {
  matchedFaceIdsInFrame,
  RekognitionUnavailableError,
} from "./rekognition";

/**
 * Person-aware search: query parsing (Groq) + face confirmation
 * (Rekognition) against frames extracted from VideoDB search candidates.
 *
 * Cost safety by construction:
 *   - face matching only runs on the narrowed candidate set from semantic
 *     search (capped at MAX_FACE_CANDIDATES videos per query), never on the
 *     whole library;
 *   - at most MAX_FRAMES_PER_CANDIDATE frames are extracted per candidate,
 *     and the second frame is only tried when the first didn't confirm.
 */

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";
const PARSE_TIMEOUT_MS = 8_000;

export const MAX_FACE_CANDIDATES = 8;
const MAX_FRAMES_PER_CANDIDATE = 2;
const MAX_FRAME_BYTES = 5 * 1024 * 1024; // Rekognition image-bytes limit
// Prompt-size bound: only this many enrolled names are offered to the
// parser (newest-first ordering is the caller's concern; slicing here is
// pure cost defense — typical accounts enroll a handful).
const MAX_PARSE_NAMES = 100;

export type ParsedPersonQuery = {
  /** Exact enrolled name (canonical casing) or null when no person detected. */
  personName: string | null;
  /** The rest of the query, usable as a standalone scene description. */
  sceneDescription: string;
};

/**
 * Ask Groq to split the query into an enrolled person reference + scene
 * description. Fuzzy on casing/spelling ("anya" → "Anaya"); returns null on
 * any failure so the caller can run the query exactly as it does today.
 */
export async function parsePersonQuery(
  query: string,
  enrolledNames: string[],
): Promise<ParsedPersonQuery | null> {
  const apiKey = process.env["GROQ_API_KEY"];
  if (!apiKey || enrolledNames.length === 0) return null;
  const names = enrolledNames.slice(0, MAX_PARSE_NAMES);

  const system = [
    "You split a video-archive search query into a person reference and a scene description.",
    `Enrolled people (the ONLY valid person values): ${JSON.stringify(names)}.`,
    'Return JSON: {"person_name": <exact enrolled name or null>, "scene_description": "<rest of the query>"}.',
    "Rules:",
    "- person_name must be copied EXACTLY from the enrolled list. Match fuzzily against the query: wrong casing, misspellings, or possessives of an enrolled name all count (\"anya's\" → \"Anaya\").",
    "- Pronoun rule: if exactly ONE person is enrolled and the query contains a third-person pronoun (he, him, his, she, her, hers, they, them, their) that clearly refers to a specific person, resolve it to that one enrolled person. Example: enrolled=[\"Alice\"], query=\"find him talking\" → person_name=\"Alice\", scene_description=\"talking\".",
    "- If no enrolled person is referenced (and no pronoun resolves to one), person_name is null and scene_description is the whole query.",
    "- scene_description is the query with the person reference removed, rewritten minimally so it stands alone (\"Anaya blowing out candles\" → \"blowing out candles\").",
    "- If the query is ONLY a person reference, scene_description is \"\".",
    "- Generic words like \"someone\", \"people\", \"kids\" are NOT person references.",
  ].join("\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PARSE_TIMEOUT_MS);
  try {
    const resp = await fetch(GROQ_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0,
        max_tokens: 200,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: query },
        ],
      }),
    });
    if (!resp.ok) {
      logger.warn(
        { status: resp.status },
        "Person query parse failed; running plain search",
      );
      return null;
    }
    const data = (await resp.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content) as {
      person_name?: unknown;
      scene_description?: unknown;
    };
    const rawName =
      typeof parsed.person_name === "string" ? parsed.person_name.trim() : null;
    // Trust but verify: the name must round-trip to an actual enrolled person.
    const canonical = rawName
      ? names.find((n) => n.toLowerCase() === rawName.toLowerCase())
      : undefined;
    return {
      personName: canonical ?? null,
      sceneDescription:
        typeof parsed.scene_description === "string"
          ? parsed.scene_description.trim()
          : "",
    };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Person query parse errored/timed out; running plain search",
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export type FaceCandidate = {
  /** Key back into the caller's result list. */
  key: number;
  videodbVideoId: string;
  timestampSeconds: number;
  durationSeconds: number;
};

export type FaceConfirmation =
  | { status: "applied"; confirmedKeys: Set<number> }
  | { status: "unavailable" };

export type MultiFaceConfirmation =
  | { status: "applied"; confirmedByKey: Map<number, Set<string>> }
  | { status: "unavailable" };

/**
 * Single-person convenience wrapper over confirmFacesInCandidates.
 */
export async function confirmFaceInCandidates(
  coll: { getVideo: (id: string) => Promise<InstanceType<typeof Video>> },
  candidates: FaceCandidate[],
  targetFaceId: string,
): Promise<FaceConfirmation> {
  const multi = await confirmFacesInCandidates(coll, candidates, [
    targetFaceId,
  ]);
  if (multi.status === "unavailable") return { status: "unavailable" };
  const confirmedKeys = new Set<number>();
  for (const [key, faceIds] of multi.confirmedByKey) {
    if (faceIds.has(targetFaceId)) confirmedKeys.add(key);
  }
  return { status: "applied", confirmedKeys };
}

/**
 * Confirm which of the target people appear in each candidate. Extracts a
 * few frames near each candidate's matched timestamp via VideoDB thumbnail
 * generation; ONE Rekognition SearchFacesByImage call per frame covers all
 * targets at once (the response lists every matching collection FaceId).
 *
 * Multi-person caveat: Rekognition matches the LARGEST face per frame, so
 * an extra frame is sampled when several people are requested — across
 * frames, different people take their turn as the largest face.
 *
 * Returns "unavailable" if Rekognition itself is unusable — the caller
 * falls back to unfiltered scene results (never fails the query).
 * Individual frame failures only affect their own candidate.
 */
export async function confirmFacesInCandidates(
  coll: { getVideo: (id: string) => Promise<InstanceType<typeof Video>> },
  candidates: FaceCandidate[],
  targetFaceIds: string[],
): Promise<MultiFaceConfirmation> {
  const targets = [...new Set(targetFaceIds)];
  const capped = candidates.slice(0, MAX_FACE_CANDIDATES);
  const maxFrames =
    targets.length > 1 ? MAX_FRAMES_PER_CANDIDATE + 1 : MAX_FRAMES_PER_CANDIDATE;
  let unavailable = false;
  const confirmedByKey = new Map<number, Set<string>>();

  await Promise.all(
    capped.map(async (cand) => {
      if (unavailable) return;
      try {
        const media = await withTimeout(
          coll.getVideo(cand.videodbVideoId),
          30_000,
          "face: video fetch",
        );
        const confirmed = new Set<string>();
        for (const t of frameTimes(cand, maxFrames)) {
          if (unavailable) return;
          const bytes = await extractFrame(media, t);
          if (!bytes) continue;
          const inFrame = await matchedFaceIdsInFrame(bytes);
          for (const target of targets) {
            if (inFrame.has(target)) confirmed.add(target);
          }
          if (confirmed.size === targets.length) break; // all confirmed — cost cap
        }
        if (confirmed.size > 0) confirmedByKey.set(cand.key, confirmed);
      } catch (err) {
        if (err instanceof RekognitionUnavailableError) {
          unavailable = true;
          return;
        }
        logger.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            videodbVideoId: cand.videodbVideoId,
          },
          "Face check failed for candidate; treating as unconfirmed",
        );
      }
    }),
  );

  if (unavailable) {
    logger.error(
      "Rekognition unavailable mid-search — returning scene-only results without person filtering",
    );
    return { status: "unavailable" };
  }
  return { status: "applied", confirmedByKey };
}

/** Frame timestamps near the matched moment, clamped into the video. */
function frameTimes(cand: FaceCandidate, maxFrames: number): number[] {
  const max = Math.max(0, (cand.durationSeconds || 0) - 1);
  const first = Math.min(Math.max(0, cand.timestampSeconds), max);
  const times = [first];
  for (const offset of [2, 5]) {
    const t = Math.min(first + offset, max);
    if (times.length >= maxFrames) break;
    if (t > (times[times.length - 1] ?? 0)) times.push(t);
  }
  return times;
}

/** VideoDB thumbnail at a timestamp → JPEG bytes (null when not usable). */
async function extractFrame(
  media: InstanceType<typeof Video>,
  timeSeconds: number,
): Promise<Buffer | null> {
  try {
    const thumb = await withTimeout(
      media.generateThumbnail(timeSeconds),
      45_000,
      "face: frame extraction",
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
          "face: frame url",
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
      "Frame extraction failed",
    );
    return null;
  }
}
