/** One-off: exercise the new two-index retrieval + Groq rerank for user 7. */
import { eq } from "drizzle-orm";
import { db, videosTable } from "@workspace/db";
import { SearchResult, SearchTypeValues, IndexTypeValues } from "videodb";
import { getVideoDBCollection, withTimeout } from "../src/lib/videodb";
import { rerankWithGroq } from "../src/lib/rerank";

const UID = 7;

async function run(query: string) {
  console.log(`\n########## QUERY: "${query}" ##########`);
  const videos = await db.select().from(videosTable).where(eq(videosTable.userId, UID));
  const byVdb = new Map(videos.filter(v => v.videodbVideoId).map(v => [v.videodbVideoId as string, v]));
  const coll = await withTimeout(getVideoDBCollection(), 60000, "getCollection");

  const search = async (idx: IndexTypeValues) => {
    const t0 = Date.now();
    try {
      const r = await withTimeout(coll.search(query, SearchTypeValues.semantic, idx, 12), 60000, `search:${idx}`);
      const shots = r instanceof SearchResult ? r.shots : [];
      console.log(`  [${idx}] ${shots.length} shots in ${Date.now() - t0}ms`);
      return shots;
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      if (/no results found/i.test(m)) { console.log(`  [${idx}] 0 shots (no results) in ${Date.now() - t0}ms`); return []; }
      throw e;
    }
  };
  const tR = Date.now();
  const [spoken, scene] = await Promise.all([search(IndexTypeValues.spoken), search(IndexTypeValues.scene)]);
  console.log(`  retrieval total (parallel): ${Date.now() - tR}ms`);

  let k = 0;
  const cands = [
    ...spoken.map(s => ({ shot: s, matchType: "speech" as const })),
    ...scene.map(s => ({ shot: s, matchType: "scene" as const })),
  ].flatMap(({ shot, matchType }) => {
    const row = byVdb.get(shot.videoId);
    if (!row) return [];
    k += 1;
    return [{ key: -k, videoTitle: row.title, matchType, timestampSeconds: Math.round(shot.start),
      snippet: (shot.text || "").replaceAll("USER_REQUEST_MATCH", "").trim() }];
  });
  console.log("  RAW CANDIDATES:");
  for (const c of cands) console.log(`    key=${c.key} [${c.matchType}@${c.timestampSeconds}s] ${c.videoTitle} :: ${c.snippet.slice(0, 90)}`);

  const tL = Date.now();
  const reranked = await rerankWithGroq(query, cands);
  console.log(`  rerank: ${Date.now() - tL}ms, kept ${reranked ? reranked.length : "NULL(fallback)"}`);
  if (reranked) {
    const byKey = new Map(cands.map(c => [c.key, c]));
    const seen = new Set<string>();
    for (const { key, reason } of reranked) {
      const c = byKey.get(key); if (!c) continue;
      const dedup = seen.has(c.videoTitle) ? " (deduped away)" : ""; seen.add(c.videoTitle);
      console.log(`    ${dedup ? "-" : "✓"} [${c.matchType}] ${c.videoTitle} — ${reason}${dedup}`);
    }
  }
}

(async () => {
  await run("website");
  await run("teacher");
  process.exit(0);
})().catch(e => { console.error("ERR", e); process.exit(1); });
