import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, videosTable, momentsTable } from "@workspace/db";
import {
  SearchMemoriesQueryParams,
  SearchMemoriesResponse,
} from "@workspace/api-zod";
import { SearchResult, SearchTypeValues, IndexTypeValues } from "videodb";
import { logger } from "../lib/logger";
import {
  isVideoDBConfigured,
  getVideoDBCollection,
  withTimeout,
} from "../lib/videodb";
import { USER_MATCH_SENTINEL } from "../lib/ingestion";
import { rerankWithGroq, type RerankCandidate } from "../lib/rerank";
import { currentUserId } from "../lib/auth";

const router: IRouter = Router();

type ApiSearchResult = {
  id: number;
  videoId: number;
  videoTitle: string;
  thumbnailUrl: string;
  videoUrl: string | null;
  snippet: string;
  matchType: "speech" | "scene" | "person";
  matchReason: string | null;
  timestampSeconds: number;
  durationSeconds: number;
  people: string[];
  recordedAt: string | null;
  location: string | null;
};

/** Scene descriptions may carry the privacy-scan sentinel — never show it. */
function cleanSnippet(text: string): string {
  return text.replaceAll(USER_MATCH_SENTINEL, "").replace(/\s{2,}/g, " ").trim();
}

router.get("/search", async (req, res): Promise<void> => {
  const parsed = SearchMemoriesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const rawQuery = parsed.data.q.trim();
  const q = rawQuery.toLowerCase();
  const terms = q.split(/\s+/).filter((t) => t.length > 2);

  // Scoped to the logged-in user's library; the maps below make both the
  // keyword branch and the VideoDB shot mapping drop anything they don't own.
  const uid = currentUserId(req);
  const [momentRows, videos] = await Promise.all([
    // Scoped at the SQL layer: only moments belonging to the user's videos.
    db
      .select({ moment: momentsTable })
      .from(momentsTable)
      .innerJoin(videosTable, eq(momentsTable.videoId, videosTable.id))
      .where(eq(videosTable.userId, uid)),
    db.select().from(videosTable).where(eq(videosTable.userId, uid)),
  ]);
  const moments = momentRows.map((r) => r.moment);
  const videoById = new Map(videos.map((v) => [v.id, v]));
  const videoByVdbId = new Map(
    videos
      .filter((v) => v.videodbVideoId)
      .map((v) => [v.videodbVideoId as string, v]),
  );

  // Semantic search over VideoDB-indexed videos (real uploads): two parallel
  // retrievals — spoken-word transcript AND visual scene descriptions.
  let videodbResults: ApiSearchResult[] = [];
  if (videoByVdbId.size > 0) {
    if (!isVideoDBConfigured()) {
      res.status(503).json({
        error:
          "This library contains VideoDB-indexed videos, but VideoDB is not configured. Add the VIDEODB_API_KEY secret.",
      });
      return;
    }
    try {
      const coll = await withTimeout(
        getVideoDBCollection(),
        60_000,
        "getCollection",
      );
      const searchIndex = async (
        indexType: IndexTypeValues,
      ): Promise<InstanceType<typeof SearchResult>["shots"]> => {
        try {
          const result = await withTimeout(
            coll.search(rawQuery, SearchTypeValues.semantic, indexType, 12),
            60_000,
            `search:${indexType}`,
          );
          return result instanceof SearchResult ? result.shots : [];
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // The VideoDB SDK raises instead of returning an empty result set —
          // zero matches is a normal outcome, not an upstream failure.
          if (/no results found/i.test(message)) return [];
          throw err;
        }
      };
      const [spokenShots, sceneShots] = await Promise.all([
        searchIndex(IndexTypeValues.spoken),
        searchIndex(IndexTypeValues.scene),
      ]);

      let syntheticId = 0;
      const toResult = (
        shot: (typeof spokenShots)[number],
        matchType: "speech" | "scene",
      ): ApiSearchResult[] => {
        const row = videoByVdbId.get(shot.videoId);
        if (!row) return [];
        syntheticId += 1;
        return [
          {
            // Synthetic negative ids: VideoDB shots are not moment rows.
            id: -syntheticId,
            videoId: row.id,
            videoTitle: row.title,
            thumbnailUrl: row.thumbnailUrl,
            videoUrl: row.videoUrl,
            snippet: cleanSnippet(shot.text?.trim() || "") || "Matched moment",
            matchType,
            matchReason: null,
            timestampSeconds: Math.max(0, Math.round(shot.start)),
            durationSeconds:
              row.durationSeconds || Math.round(shot.videoLength || 0),
            people: row.people,
            recordedAt: row.recordedAt,
            location: row.location,
          },
        ];
      };
      videodbResults = [
        ...spokenShots.flatMap((s) => toResult(s, "speech")),
        ...sceneShots.flatMap((s) => toResult(s, "scene")),
      ];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, query: rawQuery }, "VideoDB search failed");
      res.status(502).json({ error: `VideoDB search failed: ${message}` });
      return;
    }
  }

  // Keyword scoring over seeded/legacy moments (videos without a VideoDB id).
  const scored = moments
    .map((m) => {
      const video = videoById.get(m.videoId);
      if (!video || video.videodbVideoId) return null;
      const haystack = [
        m.snippet,
        m.keywords.join(" "),
        video.title,
        video.location ?? "",
        video.tags.join(" "),
        video.people.join(" "),
      ]
        .join(" ")
        .toLowerCase();
      let score = 0;
      if (q.length > 0 && haystack.includes(q)) score += 5;
      for (const t of terms) {
        if (haystack.includes(t)) score += 1;
      }
      return score > 0 ? { m, video, score } : null;
    })
    .filter((x) => x !== null)
    .sort((a, b) => b.score - a.score);

  const keywordResults: ApiSearchResult[] = scored.map(({ m, video }) => ({
    id: m.id,
    videoId: video.id,
    videoTitle: video.title,
    thumbnailUrl: video.thumbnailUrl,
    videoUrl: video.videoUrl,
    snippet: m.snippet,
    matchType: m.matchType as ApiSearchResult["matchType"],
    matchReason: null,
    timestampSeconds: m.timestampSeconds,
    durationSeconds: video.durationSeconds,
    people: video.people,
    recordedAt: video.recordedAt,
    location: video.location,
  }));

  // Combined candidate set → LLM rerank (filter + order + per-result reason).
  const candidates = [...videodbResults, ...keywordResults];
  const byKey = new Map(candidates.map((c) => [c.id, c]));
  const rerankInput: RerankCandidate[] = candidates.map((c) => ({
    key: c.id,
    videoTitle: c.videoTitle,
    snippet: c.snippet,
    matchType: c.matchType,
    timestampSeconds: c.timestampSeconds,
  }));
  const reranked = await rerankWithGroq(rawQuery, rerankInput);

  let ordered: ApiSearchResult[];
  if (reranked) {
    ordered = reranked.flatMap(({ key, reason }) => {
      const c = byKey.get(key);
      return c ? [{ ...c, matchReason: reason || null }] : [];
    });
  } else {
    // Rerank unavailable — raw retrieval order (spoken, scene, keyword).
    ordered = candidates;
  }

  // Deduplicate: one card per video, keeping its most relevant match
  // (rerank order when available, otherwise branch priority).
  const seenVideos = new Set<number>();
  const results: ApiSearchResult[] = [];
  for (const r of ordered) {
    if (seenVideos.has(r.videoId)) continue;
    seenVideos.add(r.videoId);
    results.push(r);
    if (results.length >= 12) break;
  }

  res.json(SearchMemoriesResponse.parse(results));
});

export default router;
