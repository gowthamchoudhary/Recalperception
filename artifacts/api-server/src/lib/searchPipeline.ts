import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  videosTable,
  momentsTable,
  peopleTable,
  videoFacesTable,
} from "@workspace/db";
import { SearchResult, SearchTypeValues, IndexTypeValues } from "videodb";
import { logger } from "./logger";
import {
  isVideoDBConfigured,
  getVideoDBCollection,
  withTimeout,
} from "./videodb";
import { USER_MATCH_SENTINEL } from "./ingestion";
import { rerankWithGroq, type RerankCandidate } from "./rerank";
import { parsePersonQuery } from "./personSearch";
import {
  classifyIntent,
  generateIntentAnswer,
  generateSearchAnswer,
  bestVideoDate,
  DEFAULT_CLASSIFICATION,
  type SearchIntent,
} from "./intent";
import { matchTitles } from "./titleMatch";
import { rewriteQueryWithHistory, type ChatHistoryEntry } from "./chatContext";

/**
 * The full memory-search pipeline, shared by GET /search (one-shot) and the
 * chat endpoints (threaded, streaming stage feedback).
 *
 * Phases — reported through onStage as each one STARTS:
 *   contextualizing → classifying → retrieving → person_check → reranking → answering
 * contextualizing only fires when conversation history is provided,
 * person_check only when a person filter is in play, reranking only when
 * there are candidates to rank, answering only for count/recency intents.
 */

export type PipelineStage =
  | "contextualizing"
  | "classifying"
  | "retrieving"
  | "person_check"
  | "reranking"
  | "answering";

export type ApiSearchResult = {
  id: number;
  videoId: number;
  videoTitle: string;
  thumbnailUrl: string;
  videoUrl: string | null;
  snippet: string;
  matchType: "speech" | "scene" | "person" | "title";
  matchReason: string | null;
  timestampSeconds: number;
  durationSeconds: number;
  people: string[];
  recordedAt: string | null;
  location: string | null;
};

export type PipelinePersonFilter = {
  personName: string;
  sceneQuery: string;
  status: "applied" | "unavailable";
};

export type PipelineRequest = {
  userId: number;
  query: string;
  /** Recent conversation, oldest first — enables follow-up rewriting. */
  history?: ChatHistoryEntry[];
  /** Explicit person mentions ("/" pills) — bypasses fuzzy person parsing. */
  personIds?: number[];
  onStage?: (stage: PipelineStage) => void;
};

export type PipelineResponse = {
  results: ApiSearchResult[];
  personFilter: PipelinePersonFilter | null;
  intent: SearchIntent;
  answer: string | null;
  /** The query text retrieval actually ran on (post rewrite/topic/person split). */
  effectiveQuery: string;
};

/** Retrieval-backend failures the routes translate into HTTP statuses. */
export class SearchUnavailableError extends Error {
  constructor(
    public statusCode: 502 | 503,
    message: string,
  ) {
    super(message);
    this.name = "SearchUnavailableError";
  }
}

/** Scene descriptions may carry the privacy-scan sentinel — never show it. */
function cleanSnippet(text: string): string {
  return text.replaceAll(USER_MATCH_SENTINEL, "").replace(/\s{2,}/g, " ").trim();
}

function postgresErrorDetails(err: unknown): Record<string, unknown> {
  const cause =
    err instanceof Error && "cause" in err
      ? (err as Error & { cause?: unknown }).cause
      : undefined;
  const pgErr = (cause ?? err) as {
    message?: unknown;
    code?: unknown;
    detail?: unknown;
    hint?: unknown;
    schema?: unknown;
    table?: unknown;
    column?: unknown;
    constraint?: unknown;
  };
  return {
    wrapper: err instanceof Error ? err.message : String(err),
    message: typeof pgErr.message === "string" ? pgErr.message : undefined,
    code: typeof pgErr.code === "string" ? pgErr.code : undefined,
    detail: typeof pgErr.detail === "string" ? pgErr.detail : undefined,
    hint: typeof pgErr.hint === "string" ? pgErr.hint : undefined,
    schema: typeof pgErr.schema === "string" ? pgErr.schema : undefined,
    table: typeof pgErr.table === "string" ? pgErr.table : undefined,
    column: typeof pgErr.column === "string" ? pgErr.column : undefined,
    constraint:
      typeof pgErr.constraint === "string" ? pgErr.constraint : undefined,
  };
}

const NON_SCENE_WORDS = new Set([
  "show",
  "me",
  "find",
  "search",
  "moments",
  "moment",
  "clips",
  "clip",
  "videos",
  "video",
  "with",
  "of",
  "the",
  "a",
  "an",
  "all",
  "every",
  "where",
  "when",
  "please",
]);

function hasMeaningfulSceneDescription(text: string): boolean {
  const terms = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !NON_SCENE_WORDS.has(t));
  return terms.length > 0;
}

/** Deterministic answer when Groq answer generation is unavailable. */
function fallbackAnswer(
  intent: "count" | "recency",
  direction: "latest" | "earliest",
  totalMoments: number,
  totalVideos: number,
  top: { title: string; date: string | null; byTitleOnly?: boolean } | null,
  titleOnlyCount: number,
): string {
  if (totalMoments === 0 && titleOnlyCount === 0) {
    return "I couldn't find any matching moments in your library.";
  }
  if (intent === "count") {
    if (totalMoments === 0) {
      return `I couldn't find any matching moments, but ${titleOnlyCount} video title${titleOnlyCount === 1 ? " matches" : "s match"} your search — shown below.`;
    }
    const m = `${totalMoments} matching moment${totalMoments === 1 ? "" : "s"}`;
    const v = `${totalVideos} video${totalVideos === 1 ? "" : "s"}`;
    const recent = top?.date
      ? ` Most recent: "${top.title}" (${top.date}).`
      : "";
    const extra =
      titleOnlyCount > 0
        ? ` Plus ${titleOnlyCount} more video${titleOnlyCount === 1 ? "" : "s"} matched by title only.`
        : "";
    return `I found ${m} across ${v}.${recent}${extra}`;
  }
  if (!top) {
    return "I couldn't find any matching moments in your library.";
  }
  const which = direction === "earliest" ? "first" : "most recent";
  const when = top.date ? ` on ${top.date}` : "";
  const how = top.byTitleOnly ? " — matched by title only" : "";
  return `The ${which} match is "${top.title}"${when}${how}.`;
}

export async function runSearchPipeline(
  req: PipelineRequest,
): Promise<PipelineResponse> {
  const { userId: uid, onStage } = req;
  const rawQuery = req.query.trim();

  // Follow-up context: rewrite "what about at the beach?" into a standalone
  // query using the recent thread. Fail-open — worst case the raw text runs.
  let workingQuery = rawQuery;
  if (req.history && req.history.length > 0 && rawQuery) {
    onStage?.("contextualizing");
    workingQuery = await rewriteQueryWithHistory(rawQuery, req.history);
  }

  onStage?.("classifying");
  // Scoped to the logged-in user's library; the maps below make both the
  // keyword branch and the VideoDB shot mapping drop anything they don't own.
  const [momentRows, videos, enrolledPeople, classified] = await Promise.all([
    // Scoped at the SQL layer: only moments belonging to the user's videos.
    db
      .select({ moment: momentsTable })
      .from(momentsTable)
      .innerJoin(videosTable, eq(momentsTable.videoId, videosTable.id))
      .where(eq(videosTable.userId, uid)),
    db.select().from(videosTable).where(eq(videosTable.userId, uid)),
    db.select().from(peopleTable).where(eq(peopleTable.userId, uid)),
    // Intent routing: search / count / recency / group (fails open to search).
    workingQuery
      ? classifyIntent(workingQuery)
      : Promise.resolve(DEFAULT_CLASSIFICATION),
  ]);
  const intent = classified.intent;

  // Person resolution — two paths:
  //   1. Explicit "/" mention pills: exact person rows, no LLM involved.
  //      Multiple pills mean ALL of them must appear (AND).
  //   2. Fuzzy: "Anaya blowing out candles" → person "Anaya" + scene
  //      "blowing out candles" via Groq. Skipped entirely (plain search,
  //      exactly as before) when nobody is enrolled or parsing fails.
  const explicitIds = [...new Set(req.personIds ?? [])];
  let persons: (typeof enrolledPeople)[number][] = [];
  let sceneFromParse = "";
  if (explicitIds.length > 0) {
    const byId = new Map(enrolledPeople.map((p) => [p.id, p]));
    persons = explicitIds.flatMap((id) => {
      const row = byId.get(id);
      return row ? [row] : [];
    });
    sceneFromParse = workingQuery;
  } else if (enrolledPeople.length > 0 && workingQuery) {
    const personParse = await parsePersonQuery(
      workingQuery,
      enrolledPeople.map((p) => p.name),
    );
    const person = personParse?.personName
      ? (enrolledPeople.find((p) => p.name === personParse.personName) ?? null)
      : null;
    if (person) {
      persons = [person];
      sceneFromParse = personParse?.sceneDescription ?? "";
    }
    // Stage (a): log person resolution outcome every time so failures are visible.
    logger.info(
      {
        query: workingQuery,
        enrolledCount: enrolledPeople.length,
        parsedPersonName: personParse?.personName ?? null,
        resolvedPersonId: person?.id ?? null,
        resolvedPersonName: person?.name ?? null,
        sceneDescription: personParse?.sceneDescription ?? null,
        parseSucceeded: !!personParse,
      },
      "[person-search-a] pronoun/name resolution result",
    );
  }

  // Retrieval query priority: for non-search intents the classifier's
  // cleaned topic retrieves better than question phrasing ("how many times
  // did I play cricket" → "playing cricket"); person-split scenes cover the
  // search intent; the working query is always the fallback. When the query
  // is only a person's name (or only pills), the scene half is empty — fall
  // back to the names and let face matching do the rest.
  let effectiveQuery = workingQuery;
  if (intent !== "search" && classified.topic) {
    effectiveQuery = classified.topic;
  } else if (persons.length > 0 && sceneFromParse) {
    effectiveQuery = sceneFromParse;
  }
  if (!effectiveQuery && persons.length > 0) {
    effectiveQuery = persons.map((p) => p.name).join(" ");
  }
  // Pill-only turn ("show me moments with X", no topic text): semantic
  // search over a bare name is meaningless — browse the library instead
  // and let face confirmation / people tags do the filtering.
  const explicitPersonOnly =
    explicitIds.length > 0 &&
    persons.length > 0 &&
    !hasMeaningfulSceneDescription(sceneFromParse);
  let personFilterStatus: "applied" | "unavailable" = "applied";

  const q = effectiveQuery.toLowerCase();
  const terms = q.split(/\s+/).filter((t) => t.length > 2);
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
  const selectedPersonIds = persons.map((p) => p.id);
  const personNames = persons.map((p) => p.name).join(" & ");
  /**
   * Returns a Map from videoId → best timeline startTime (seconds) for
   * videos where ALL requested persons appear. The startTime comes from the
   * highest-confidence range per person, so the player can jump straight to
   * the exact matched moment rather than the beginning of the video.
   *
   * Use .has(videoId) to check presence and .get(videoId) for the timestamp.
   */
  const faceMatchedVideoIds = async (
    candidateVideoIds?: number[],
  ): Promise<Map<number, number>> => {
    if (selectedPersonIds.length === 0) return new Map();
    if (candidateVideoIds && candidateVideoIds.length === 0) return new Map();
    const filters = [
      eq(videosTable.userId, uid),
      inArray(videoFacesTable.personId, selectedPersonIds),
      ...(candidateVideoIds
        ? [inArray(videoFacesTable.videoId, candidateVideoIds)]
        : []),
    ];
    let rows: { videoId: number; personId: number; startTime: number; confidence: number }[];
    try {
      rows = await db
        .select({
          videoId: videoFacesTable.videoId,
          personId: videoFacesTable.personId,
          startTime: videoFacesTable.startTime,
          confidence: videoFacesTable.confidence,
        })
        .from(videoFacesTable)
        .innerJoin(videosTable, eq(videoFacesTable.videoId, videosTable.id))
        .where(and(...filters));
    } catch (err) {
      logger.error(
        {
          ...postgresErrorDetails(err),
          selectedPersonIds,
          candidateVideoIds,
        },
        "video_faces lookup failed",
      );
      throw err;
    }
    // Pick the best (highest-confidence) range per (videoId, personId).
    const bestByKey = new Map<
      string,
      { videoId: number; personId: number; startTime: number; confidence: number }
    >();
    for (const row of rows) {
      const key = `${row.videoId}:${row.personId}`;
      const existing = bestByKey.get(key);
      if (!existing || row.confidence > existing.confidence) {
        bestByKey.set(key, row);
      }
    }
    // Aggregate by videoId: collect personIds and find earliest best startTime.
    const byVideo = new Map<number, { personIds: Set<number>; earliestStart: number }>();
    for (const entry of bestByKey.values()) {
      const agg = byVideo.get(entry.videoId) ?? {
        personIds: new Set<number>(),
        earliestStart: Infinity,
      };
      agg.personIds.add(entry.personId);
      if (entry.startTime < agg.earliestStart) agg.earliestStart = entry.startTime;
      byVideo.set(entry.videoId, agg);
    }
    // Keep only videos where every requested person appears.
    return new Map(
      [...byVideo]
        .filter(([, { personIds }]) => selectedPersonIds.every((id) => personIds.has(id)))
        .map(([videoId, { earliestStart }]) => [
          videoId,
          earliestStart === Infinity ? 0 : earliestStart,
        ]),
    );
  };

  if (explicitPersonOnly) {
    onStage?.("person_check");
    const matchedVideoIds = await faceMatchedVideoIds();
    logger.info(
      {
        personIds: selectedPersonIds,
        personNames: persons.map((p) => p.name),
        faceMatchedVideoIds: [...matchedVideoIds.keys()],
      },
      "[person-search-b] explicit-pill path: video_ids from direct video_faces lookup",
    );
    let syntheticId = 0;
    videodbResults = videos
      .filter((v) => matchedVideoIds.has(v.id))
      .sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime())
      .map((v) => ({
        id: --syntheticId,
        videoId: v.id,
        videoTitle: v.title,
        thumbnailUrl: v.thumbnailUrl,
        videoUrl: v.videoUrl,
        snippet: `${personNames} ${persons.length === 1 ? "appears" : "appear"} in this video.`,
        matchType: "person" as const,
        matchReason: null,
        // Jump to the earliest confirmed appearance rather than the start.
        timestampSeconds: matchedVideoIds.get(v.id) ?? 0,
        durationSeconds: v.durationSeconds,
        people: v.people,
        recordedAt: v.recordedAt,
        location: v.location,
      }));
    logger.info(
      {
        persons: persons.map((p) => p.name),
        matchedVideos: videodbResults.length,
      },
      "Person-only query answered from video_faces",
    );
  }

  // Pre-fetch ALL face-matched video IDs for this person (unconstrained by
  // semantic results) so we can: (b) log what the DB actually has, and
  // (c) fall back to face-only results when the semantic+face intersection
  // is empty (e.g. the video didn't rank in the top-12 semantic hits).
  let preFetchedFaceMatches: Map<number, number> | null = null;
  if (persons.length > 0 && !explicitPersonOnly) {
    preFetchedFaceMatches = await faceMatchedVideoIds(); // unconstrained
    logger.info(
      {
        personIds: selectedPersonIds,
        personNames: persons.map((p) => p.name),
        faceMatchedVideoIds: [...preFetchedFaceMatches.keys()],
        faceMatchCount: preFetchedFaceMatches.size,
      },
      "[person-search-b] video_ids from direct video_faces lookup (unconstrained)",
    );
  }

  if (videoByVdbId.size > 0 && !explicitPersonOnly) {
    if (!isVideoDBConfigured()) {
      throw new SearchUnavailableError(
        503,
        "This library contains VideoDB-indexed videos, but VideoDB is not configured. Add the VIDEODB_API_KEY secret.",
      );
    }
    onStage?.("retrieving");
    try {
      const coll = await withTimeout(
        getVideoDBCollection(),
        60_000,
        "getCollection",
      );
      // count/group cast a wider net; search/recency keep the tight cap.
      const perIndexLimit = intent === "count" || intent === "group" ? 25 : 12;
      const searchIndex = async (
        indexType: IndexTypeValues,
      ): Promise<InstanceType<typeof SearchResult>["shots"]> => {
        try {
          const result = await withTimeout(
            coll.search(
              effectiveQuery,
              SearchTypeValues.semantic,
              indexType,
              perIndexLimit,
            ),
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
      let spokenShots: InstanceType<typeof SearchResult>["shots"] = [];
      let sceneShots: InstanceType<typeof SearchResult>["shots"] = [];
      if (true) {
        // One index erroring (the scene index rejects some short queries)
        // must not sink the turn while the other still has answers.
        const settled = await Promise.allSettled([
          searchIndex(IndexTypeValues.spoken),
          searchIndex(IndexTypeValues.scene),
        ]);
        const rejected = settled.filter(
          (s): s is PromiseRejectedResult => s.status === "rejected",
        );
        if (rejected.length === settled.length) throw rejected[0]!.reason;
        for (const r of rejected) {
          logger.warn(
            {
              err:
                r.reason instanceof Error
                  ? r.reason.message
                  : String(r.reason),
              query: effectiveQuery,
            },
            "One VideoDB index search failed — continuing with the other",
          );
        }
        if (settled[0]!.status === "fulfilled") spokenShots = settled[0]!.value;
        if (settled[1]!.status === "fulfilled") sceneShots = settled[1]!.value;
      }

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
      // Face confirmation: filter semantic hits to only videos where every
      // requested person appears per the pre-indexed video_faces table.
      // Uses preFetchedFaceMatches (unconstrained DB lookup done before
      // semantic search) rather than a constrained re-query, so videos that
      // Rekognition confirmed but that didn't rank in the semantic top-N are
      // not silently dropped.
      if (persons.length > 0) {
        onStage?.("person_check");
        const faceMatches = preFetchedFaceMatches ?? new Map<number, number>();
        const beforeCount = videodbResults.length;
        const semanticVideoIds = [...new Set(videodbResults.map((r) => r.videoId))];
        videodbResults = videodbResults.filter((r) => faceMatches.has(r.videoId));
        logger.info(
          {
            personNames: persons.map((p) => p.name),
            semanticVideoIds,
            faceMatchedVideoIds: [...faceMatches.keys()],
            beforeFaceFilter: beforeCount,
            survivingCandidates: videodbResults.length,
            droppedByIntersection: beforeCount - videodbResults.length,
          },
          "[person-search-c] semantic results after face filter",
        );
        // Fallback: semantic search ran but none of its results overlapped with
        // face-confirmed videos (or semantic returned nothing at all). Rather
        // than returning empty, surface the face-confirmed videos directly.
        if (videodbResults.length === 0 && faceMatches.size > 0) {
          logger.info(
            {
              personNames: persons.map((p) => p.name),
              faceMatchCount: faceMatches.size,
              semanticHadResults: beforeCount > 0,
            },
            "[person-search-c] semantic+face intersection empty — falling back to face-only results",
          );
          let syntheticId = 0;
          videodbResults = videos
            .filter((v) => faceMatches.has(v.id))
            .sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime())
            .map((v) => ({
              id: --syntheticId,
              videoId: v.id,
              videoTitle: v.title,
              thumbnailUrl: v.thumbnailUrl,
              videoUrl: v.videoUrl,
              snippet: `${personNames} ${persons.length === 1 ? "appears" : "appear"} in this video.`,
              matchType: "person" as const,
              matchReason: null,
              timestampSeconds: faceMatches.get(v.id) ?? 0,
              durationSeconds: v.durationSeconds,
              people: v.people,
              recordedAt: v.recordedAt,
              location: v.location,
            }));
        }
      }
    } catch (err) {
      if (err instanceof SearchUnavailableError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, query: rawQuery }, "VideoDB search failed");
      throw new SearchUnavailableError(
        502,
        `VideoDB search failed: ${message}`,
      );
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

  // Legacy/demo videos have no VideoDB footage to frame-check; when a person
  // filter is active they only qualify via their people metadata tags —
  // every requested person must be tagged (AND).
  const personScored =
    persons.length > 0
      ? scored.filter(({ video }) =>
          persons.every((person) =>
            video.people.some(
              (p) => p.toLowerCase() === person.name.toLowerCase(),
            ),
          ),
        )
      : scored;

  const keywordResults: ApiSearchResult[] = personScored.map(({ m, video }) => ({
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
  const skipRerank = explicitPersonOnly || intent === "group";
  if (rerankInput.length > 0 && !skipRerank) onStage?.("reranking");
  const reranked = skipRerank
    ? null
    : await rerankWithGroq(effectiveQuery, rerankInput);

  let ordered: ApiSearchResult[];
  if (reranked) {
    for (const dropped of reranked.dropped) {
      const c = byKey.get(dropped.key);
      logger.info(
        {
          key: dropped.key,
          videoTitle: c?.videoTitle,
          matchType: c?.matchType,
          reason: dropped.reason,
        },
        "Search rerank dropped candidate",
      );
    }
    ordered = reranked.results.flatMap(({ key, reason }) => {
      const c = byKey.get(key);
      return c ? [{ ...c, matchReason: reason || null }] : [];
    });
  } else {
    // Rerank unavailable — raw retrieval order (spoken, scene, keyword).
    ordered = candidates;
  }

  // Deduplicate non-group turns to one card per video. Group intent is meant
  // to show the broad retrieved set, so preserve candidates as retrieved.
  const maxCards = intent === "group" ? ordered.length : 12;
  const seenVideos = new Set<number>();
  let results: ApiSearchResult[] =
    intent === "group"
      ? ordered
      : [];
  if (intent !== "group") {
    for (const r of ordered) {
      if (seenVideos.has(r.videoId)) continue;
      seenVideos.add(r.videoId);
      results.push(r);
      if (results.length >= maxCards) break;
    }
  }

  // Title layer: lightweight third retrieval signal. VideoDB's semantic
  // indexes never see titles, so a video literally named what the user
  // asked for ("stuck in traffic") can be semantically unfindable. Indexed
  // videos whose title matches the query and that aren't already results
  // are appended as clearly-labeled, lower-confidence "title" cards — they
  // never outrank semantic matches. Skipped when a person face-filter is
  // in play: title hits bypass face confirmation and would contradict the
  // "filtered to <person>" banner.
  const semanticCount = results.length;
  if (persons.length === 0) {
    const titleCandidates = matchTitles(
      videos.filter((v) => v.videodbVideoId && v.status === "indexed"),
      effectiveQuery,
    );
    // Synthetic ids far below the VideoDB shot range; uniqueness only
    // matters within a single response.
    let titleSyntheticId = -1_000_000;
    for (const { video } of titleCandidates) {
      if (results.length >= maxCards) break;
      if (seenVideos.has(video.id)) continue;
      seenVideos.add(video.id);
      results.push({
        id: titleSyntheticId--,
        videoId: video.id,
        videoTitle: video.title,
        thumbnailUrl: video.thumbnailUrl,
        videoUrl: video.videoUrl,
        snippet:
          "Matched by title — nothing in this video's indexed scenes or speech matched the search.",
        matchType: "title",
        matchReason: null,
        timestampSeconds: 0,
        durationSeconds: video.durationSeconds,
        people: video.people,
        recordedAt: video.recordedAt,
        location: video.location,
      });
    }
    if (results.length > semanticCount) {
      logger.info(
        { appended: results.length - semanticCount, query: effectiveQuery },
        "Title-only matches appended",
      );
    }
  }

  const dateFor = (videoId: number): Date | null => {
    const row = videoById.get(videoId);
    return row ? bestVideoDate(row) : null;
  };
  const fmt = (d: Date | null): string | null =>
    d ? d.toISOString().slice(0, 10) : null;

  // recency: the single most relevant match by date. Relevance order breaks
  // date ties; undated results sort last so a dated match always wins.
  if (intent === "recency" && results.length > 0) {
    // Content matches outrank title-only ones: title cards join the
    // recency pool only when nothing in scenes/speech matched at all.
    const pool = semanticCount > 0 ? results.slice(0, semanticCount) : results;
    const indexed = pool.map((r, i) => ({ r, i, d: dateFor(r.videoId) }));
    indexed.sort((a, b) => {
      if (a.d && b.d) {
        const diff =
          classified.direction === "earliest"
            ? a.d.getTime() - b.d.getTime()
            : b.d.getTime() - a.d.getTime();
        return diff !== 0 ? diff : a.i - b.i;
      }
      if (a.d) return -1;
      if (b.d) return 1;
      return a.i - b.i;
    });
    results = [indexed[0]!.r];
  }

  // count/recency: natural-language answer above the supporting clips.
  // Counts are matched MOMENTS (a video can contain several), taken before
  // per-video dedupe. Groq phrases the answer; a deterministic sentence
  // covers Groq being down; zero matches skip the model entirely.
  let answer: string | null = null;
  if (intent === "count" || intent === "recency") {
    const totalMoments = ordered.length;
    const totalVideos = new Set(ordered.map((r) => r.videoId)).size;
    // Title-only cards actually shown (recency may have collapsed them away).
    const shownTitleOnly = results.filter(
      (r) => r.matchType === "title",
    ).length;
    const contentResults = results.filter((r) => r.matchType !== "title");
    const newest = contentResults
      .map((r) => ({ title: r.videoTitle, date: dateFor(r.videoId) }))
      .filter((x): x is { title: string; date: Date } => x.date !== null)
      .sort((a, b) => b.date.getTime() - a.date.getTime())[0];
    if (totalMoments > 0) {
      onStage?.("answering");
      answer = await generateIntentAnswer(
        workingQuery,
        {
          intent,
          direction: classified.direction,
          totalMoments,
          totalVideos,
          titleOnlyMatches: shownTitleOnly,
          matches: results.slice(0, 12).map((r) => ({
            title: r.videoTitle,
            date: fmt(dateFor(r.videoId)),
            snippet: r.snippet.slice(0, 160),
            matchedBy:
              r.matchType === "title"
                ? ("title" as const)
                : ("content" as const),
          })),
        },
        req.history ?? [],
      );
    }
    if (!answer) {
      const top =
        intent === "recency"
          ? results[0]
            ? {
                title: results[0].videoTitle,
                date: fmt(dateFor(results[0].videoId)),
                byTitleOnly: results[0].matchType === "title",
              }
            : null
          : newest
            ? { title: newest.title, date: fmt(newest.date) }
            : contentResults[0]
              ? { title: contentResults[0].videoTitle, date: null }
              : null;
      answer = fallbackAnswer(
        intent,
        classified.direction,
        totalMoments,
        totalVideos,
        top,
        shownTitleOnly,
      );
    }
    logger.info(
      {
        intent,
        totalMoments,
        totalVideos,
        titleOnly: shownTitleOnly,
        hasAnswer: Boolean(answer),
      },
      "Intent-routed search answered",
    );
  } else if (intent === "search" || intent === "group") {
    onStage?.("answering");
    answer = await generateSearchAnswer(
      workingQuery,
      {
        intent,
        personName:
          persons.length > 0 ? persons.map((p) => p.name).join(" & ") : null,
        matches: results.slice(0, 12).map((r) => ({
          title: r.videoTitle,
          date: fmt(dateFor(r.videoId)),
          snippet: r.snippet.slice(0, 220),
          matchType: r.matchType,
        })),
      },
      req.history ?? [],
    );
    if (!answer) {
      const n = results.length;
      answer =
        n === 0
          ? persons.length > 0
            ? `I couldn't find any matching moments with ${persons.map((p) => p.name).join(" & ")}.`
            : "I couldn't find anything matching that in your library."
          : `I found ${n} matching video${n === 1 ? "" : "s"}: ${results
              .slice(0, 3)
              .map((r) => `"${r.videoTitle}"`)
              .join(", ")}.`;
    }
  }

  return {
    results,
    personFilter:
      persons.length > 0
        ? {
            personName: persons.map((p) => p.name).join(" & "),
            sceneQuery: effectiveQuery,
            status: personFilterStatus,
          }
        : null,
    intent,
    answer,
    effectiveQuery,
  };
}
