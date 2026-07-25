import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, videosTable, momentsTable } from "@workspace/db";
import {
  SearchMemoriesQueryParams,
  SearchMemoriesResponse,
} from "@workspace/api-zod";
import { SearchResult, SearchTypeValues, IndexTypeValues } from "videodb";
import { logger } from "../lib/logger";
import { isVideoDBConfigured, getVideoDBCollection } from "../lib/videodb";
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
  timestampSeconds: number;
  durationSeconds: number;
  people: string[];
  recordedAt: string | null;
  location: string | null;
};

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

  // Semantic search over VideoDB-indexed videos (real uploads).
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
      const coll = await getVideoDBCollection();
      const result = await coll.search(
        rawQuery,
        SearchTypeValues.semantic,
        IndexTypeValues.spoken,
        12,
      );
      const shots = result instanceof SearchResult ? result.shots : [];
      videodbResults = shots.flatMap((shot, i) => {
        const row = videoByVdbId.get(shot.videoId);
        if (!row) return [];
        return [
          {
            // Synthetic negative ids: VideoDB shots are not moment rows.
            id: -(i + 1),
            videoId: row.id,
            videoTitle: row.title,
            thumbnailUrl: row.thumbnailUrl,
            videoUrl: row.videoUrl,
            snippet: shot.text?.trim() || "Matched moment",
            matchType: "speech" as const,
            timestampSeconds: Math.max(0, Math.round(shot.start)),
            durationSeconds:
              row.durationSeconds || Math.round(shot.videoLength || 0),
            people: row.people,
            recordedAt: row.recordedAt,
            location: row.location,
          },
        ];
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The VideoDB SDK raises instead of returning an empty result set —
      // zero matches is a normal outcome, not an upstream failure.
      if (/no results found/i.test(message)) {
        videodbResults = [];
      } else {
        logger.error({ err, query: rawQuery }, "VideoDB search failed");
        res.status(502).json({ error: `VideoDB search failed: ${message}` });
        return;
      }
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
    timestampSeconds: m.timestampSeconds,
    durationSeconds: video.durationSeconds,
    people: video.people,
    recordedAt: video.recordedAt,
    location: video.location,
  }));

  const results = [...videodbResults, ...keywordResults].slice(0, 12);
  res.json(SearchMemoriesResponse.parse(results));
});

export default router;
