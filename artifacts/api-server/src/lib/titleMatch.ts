import { bestVideoDate } from "./intent";

/**
 * Lightweight third retrieval signal: keyword/fuzzy match of the query
 * against video titles in the local database.
 *
 * VideoDB's semantic indexes only cover scene descriptions and spoken
 * words — a video whose TITLE names the subject (e.g. "stuck in traffic"
 * filmed as a face close-up) is otherwise unfindable by that phrase.
 * Title hits are a lower-confidence supplement: they never outrank
 * semantic matches, and results carry matchType "title" so the UI can
 * label them honestly ("Matched by title only").
 */

const STOPWORDS = new Set([
  "a", "an", "the", "i", "im", "me", "my", "we", "our", "you", "your",
  "of", "in", "on", "at", "to", "for", "with", "from", "by", "about",
  "into", "over", "under", "is", "am", "are", "was", "were", "be", "been",
  "being", "do", "does", "did", "have", "has", "had", "can", "could",
  "when", "what", "where", "which", "who", "how", "many", "much",
  "time", "times", "last", "first", "recent", "recently", "ever", "again",
  "this", "that", "these", "those", "show", "find", "see", "get", "give",
  "all", "every", "any", "some", "and", "or", "not", "no", "it", "its",
  "there", "video", "videos", "clip", "clips", "footage", "moment",
  "moments",
]);

export type TitleMatch<T> = { video: T; score: number };

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

/** Token pair match: exact, or a ≥4-char prefix overlap (record/recording). */
function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4) {
    return a.startsWith(b) || b.startsWith(a);
  }
  return false;
}

function isNumeric(t: string): boolean {
  return /^\d+$/.test(t);
}

/**
 * Score every title against the query and keep the confident ones.
 *
 * Score is the better of two coverages: how much of the query's content
 * tokens appear in the title (long titles), and how much of the title is
 * covered by the query (short titles fully contained in a longer query,
 * the common case — "when was I last stuck in traffic" vs "stuck in
 * traffic"). Threshold 0.5; ties broken newest-first.
 */
export function matchTitles<
  T extends {
    title: string;
    recordedAt: string | null;
    uploadedAt: Date | string | null;
  },
>(videos: T[], query: string, limit = 6): TitleMatch<T>[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];
  const queryAllNumeric = queryTokens.every(isNumeric);

  const matches: TitleMatch<T>[] = [];
  for (const video of videos) {
    const titleTokens = tokenize(video.title);
    if (titleTokens.length === 0) continue;
    const matchedQueryTokens = queryTokens.filter((qt) =>
      titleTokens.some((tt) => tokensMatch(qt, tt)),
    );
    if (matchedQueryTokens.length === 0) continue;
    // Date/number fragments ("2026", "06") are too generic to carry a
    // match on their own — a year in the query must not drag in every
    // date-stamped title. They only count alongside a matched real word
    // (unless the whole query is a date lookup).
    if (!queryAllNumeric && matchedQueryTokens.every(isNumeric)) continue;
    const matchedTitle = titleTokens.filter((tt) =>
      queryTokens.some((qt) => tokensMatch(qt, tt)),
    ).length;
    const qCov = matchedQueryTokens.length / queryTokens.length;
    const tCov = matchedTitle / titleTokens.length;
    // Accept only strong signals: the whole title covered by the query
    // (short title inside a longer question — the classic rescue), or most
    // of the query matched and not just one word of a multi-word query.
    const accept =
      tCov === 1 ||
      (qCov >= 0.6 &&
        (queryTokens.length < 2 || matchedQueryTokens.length >= 2));
    if (accept) matches.push({ video, score: Math.max(qCov, tCov) });
  }

  return matches
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const da = bestVideoDate(a.video)?.getTime() ?? 0;
      const db = bestVideoDate(b.video)?.getTime() ?? 0;
      return db - da;
    })
    .slice(0, limit);
}
