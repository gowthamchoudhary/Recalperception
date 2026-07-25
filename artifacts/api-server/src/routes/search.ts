import { Router, type IRouter } from "express";
import { db, videosTable, momentsTable } from "@workspace/db";
import {
  SearchMemoriesQueryParams,
  SearchMemoriesResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/search", async (req, res): Promise<void> => {
  const parsed = SearchMemoriesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const q = parsed.data.q.trim().toLowerCase();
  const terms = q.split(/\s+/).filter((t) => t.length > 2);

  const [moments, videos] = await Promise.all([
    db.select().from(momentsTable),
    db.select().from(videosTable),
  ]);
  const videoById = new Map(videos.map((v) => [v.id, v]));

  const scored = moments
    .map((m) => {
      const video = videoById.get(m.videoId);
      if (!video) return null;
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
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);

  const results = scored.map(({ m, video }) => ({
    id: m.id,
    videoId: video.id,
    videoTitle: video.title,
    thumbnailUrl: video.thumbnailUrl,
    videoUrl: video.videoUrl,
    snippet: m.snippet,
    matchType: m.matchType,
    timestampSeconds: m.timestampSeconds,
    durationSeconds: video.durationSeconds,
    people: video.people,
    recordedAt: video.recordedAt,
    location: video.location,
  }));

  res.json(SearchMemoriesResponse.parse(results));
});

export default router;
