import { logger } from "./logger";
import type { ChatHistoryEntry } from "./chatContext";

/**
 * Intent routing for search queries.
 *
 * Before retrieval, the query is classified (Groq) into one of four
 * operations so questions get answered with the right shape of result:
 *   - search:  find specific clip(s)                 → normal flow
 *   - count:   "how many times / how often"          → aggregate + answer
 *   - recency: "when was the last/first time"        → date-sorted single match + answer
 *   - group:   "show every / all X"                  → wider result set
 *
 * Fail-open by design: any classification failure, timeout, or ambiguity
 * collapses to plain search — routing must never block or break a query.
 */

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";
const CLASSIFY_TIMEOUT_MS = 8_000;
const ANSWER_TIMEOUT_MS = 8_000;

export type SearchIntent = "search" | "count" | "recency" | "group";

export type ClassifiedQuery = {
  intent: SearchIntent;
  /** Recency only: "last time" vs "first time". */
  direction: "latest" | "earliest";
  /** Retrieval-ready topic with question phrasing stripped; "" = use raw query. */
  topic: string;
};

export const DEFAULT_CLASSIFICATION: ClassifiedQuery = {
  intent: "search",
  direction: "latest",
  topic: "",
};

const VALID_INTENTS: ReadonlySet<string> = new Set([
  "search",
  "count",
  "recency",
  "group",
]);

export async function classifyIntent(query: string): Promise<ClassifiedQuery> {
  const apiKey = process.env["GROQ_API_KEY"];
  if (!apiKey) return DEFAULT_CLASSIFICATION;

  const system = [
    "You route queries for a personal video memory archive into one of four operations.",
    'Return JSON: {"intent": "search"|"count"|"recency"|"group", "direction": "latest"|"earliest"|null, "topic": "<string>"}.',
    "Intents:",
    '- "search": find specific moment(s) or clip(s). E.g. "Arjun eating ice cream", "the demo where the app crashed". This is the DEFAULT whenever you are unsure.',
    '- "count": asks how many times / how often something happened. E.g. "how many times did I play cricket this year".',
    '- "recency": asks WHEN the most recent or first occurrence was. E.g. "when was the last time I filmed a sunset", "when did I first record a demo".',
    '- "group": asks for the complete set of a category, with EXPLICIT exhaustive phrasing — "show every...", "all my...", "show me all the times...". A plain scene description ("friends enjoying drinks", "kids playing in the garden") is NOT group, it is search, even if it could match several clips.',
    "Rules:",
    '- direction: only meaningful for recency — "earliest" when asking about the first time, otherwise "latest". Use null for other intents.',
    '- topic: the subject to retrieve, with question/intent phrasing removed but ALL content words kept (names, places, activities). E.g. "how many times did I play cricket this year" → "playing cricket". Keep person names in the topic.',
    '- If the query is ambiguous between intents, use "search".',
  ].join("\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLASSIFY_TIMEOUT_MS);
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
        max_tokens: 150,
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
        "Intent classification failed; defaulting to search",
      );
      return DEFAULT_CLASSIFICATION;
    }
    const data = (await resp.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return DEFAULT_CLASSIFICATION;
    const parsed = JSON.parse(content) as {
      intent?: unknown;
      direction?: unknown;
      topic?: unknown;
    };
    const intent =
      typeof parsed.intent === "string" && VALID_INTENTS.has(parsed.intent)
        ? (parsed.intent as SearchIntent)
        : "search";
    const classification: ClassifiedQuery = {
      intent,
      direction: parsed.direction === "earliest" ? "earliest" : "latest",
      topic:
        typeof parsed.topic === "string" ? parsed.topic.trim().slice(0, 300) : "",
    };
    logger.info(
      { intent: classification.intent, topic: classification.topic },
      "Query intent classified",
    );
    return classification;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Intent classification errored/timed out; defaulting to search",
    );
    return DEFAULT_CLASSIFICATION;
  } finally {
    clearTimeout(timer);
  }
}

export type AnswerFacts = {
  intent: "count" | "recency";
  direction: "latest" | "earliest";
  totalMoments: number;
  totalVideos: number;
  /** Top supporting matches; dates are YYYY-MM-DD or null when unknown. */
  matches: {
    title: string;
    date: string | null;
    snippet: string;
    /** "title" = only the video's title matched, not its indexed content. */
    matchedBy?: "content" | "title";
  }[];
  /** Videos whose TITLE matched the query but whose indexed content did not. */
  titleOnlyMatches?: number;
};

export type SearchAnswerFacts = {
  intent: "search" | "group";
  personName?: string | null;
  matches: {
    title: string;
    date: string | null;
    snippet: string;
    matchType: "speech" | "scene" | "person" | "title";
  }[];
};

/**
 * Short natural-language answer for count/recency queries, grounded in the
 * retrieval facts. Returns null on any failure — the caller falls back to a
 * deterministic sentence, never an error.
 */
export async function generateIntentAnswer(
  query: string,
  facts: AnswerFacts,
  history: ChatHistoryEntry[] = [],
): Promise<string | null> {
  const apiKey = process.env["GROQ_API_KEY"];
  if (!apiKey) return null;

  const system = [
    "You answer questions about a user's personal video archive.",
    "You receive verified retrieval facts: total matched moments, total videos, and the top matches (title, date, snippet). Dates are YYYY-MM-DD; null means unknown.",
    "Rules:",
    "- Reply with 1-2 short conversational sentences of plain text. No JSON, no markdown, no preamble.",
    "- Ground every number and date in the facts. Never invent or extrapolate.",
    '- intent "count": lead with how many matching moments were found (mention the video count if it helps), and when the most recent one was if dates exist. The archive only knows matched moments — say "I found 14 moments of..." rather than claiming real-world totals.',
    '- intent "recency": say when the last (direction "latest") or first (direction "earliest") matching moment was, naming the video naturally. If its date is null, say the match has no recorded date.',
    '- If the query implies a timeframe (e.g. "this year"), only reference facts consistent with it and phrase accordingly.',
    '- Matches marked matchedBy "title" only matched the video\'s TITLE — nothing in the footage or speech. Describe them as matched by title only, and NEVER count them among the matched moments.',
    '- titleOnlyMatches is how many such title-only videos are included; when nonzero for counts, mention them separately (e.g. "plus 1 more video whose title matches").',
    '- Speak directly to the user ("You\'ve...", "I found...").',
  ].join("\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ANSWER_TIMEOUT_MS);
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
        temperature: 0.2,
        max_tokens: 150,
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: JSON.stringify({
              query,
              recentHistory: history.slice(-6),
              ...facts,
            }),
          },
        ],
      }),
    });
    if (!resp.ok) {
      logger.warn(
        { status: resp.status },
        "Intent answer generation failed; using deterministic fallback",
      );
      return null;
    }
    const data = (await resp.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = data.choices?.[0]?.message?.content?.trim();
    return text ? text.slice(0, 500) : null;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Intent answer generation errored/timed out; using deterministic fallback",
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Short grounded answer for ordinary search/group turns. This replaces route
 * templates with a sentence derived from the actual matched snippets.
 */
export async function generateSearchAnswer(
  query: string,
  facts: SearchAnswerFacts,
  history: ChatHistoryEntry[] = [],
): Promise<string | null> {
  const apiKey = process.env["GROQ_API_KEY"];
  if (!apiKey) return null;

  const system = [
    "You answer search results for a user's personal video archive.",
    "You receive only verified matched clips: title, date, snippet, and match type.",
    "Rules:",
    "- Reply with 1 short conversational sentence of plain text. No JSON, no markdown, no preamble.",
    "- Ground the answer in the provided matches. Never invent clips, people, dates, or counts not present in facts.",
    "- For search intent, describe the strongest actual match or say what the matching clips show.",
    "- For group intent, summarize the set naturally and mention the number of matching videos shown.",
    "- If there are no matches, say you couldn't find a matching moment in the archive.",
    "- Use recentHistory only to resolve natural references or keep continuity; do not add facts from it unless supported by matches.",
    "- If personName is present, mention that the results are filtered to that person or people.",
  ].join("\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ANSWER_TIMEOUT_MS);
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
        temperature: 0.2,
        max_tokens: 120,
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: JSON.stringify({
              query,
              recentHistory: history.slice(-6),
              ...facts,
              matches: facts.matches.slice(0, 12),
            }),
          },
        ],
      }),
    });
    if (!resp.ok) {
      logger.warn(
        { status: resp.status },
        "Search answer generation failed; using deterministic fallback",
      );
      return null;
    }
    const data = (await resp.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = data.choices?.[0]?.message?.content?.trim();
    return text ? text.slice(0, 500) : null;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Search answer generation errored/timed out; using deterministic fallback",
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Best-effort date for a video: explicit recordedAt, else a date embedded in
 * the title (screen recordings and camera files usually carry one, e.g.
 * "Screen Recording 2026-04-30 175646"), else the upload time.
 */
export function bestVideoDate(video: {
  recordedAt: string | null;
  title: string;
  uploadedAt: Date | string | null;
}): Date | null {
  if (video.recordedAt) {
    const d = new Date(video.recordedAt);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const m = video.title.match(
    /\b(20\d{2})-([01]\d)-([0-3]\d)(?:[ T_.-]([0-2]\d)[:.]?([0-5]\d)[:.]?([0-5]\d))?\b/,
  );
  if (m) {
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const d = new Date(
        Date.UTC(
          Number(m[1]),
          month - 1,
          day,
          m[4] ? Number(m[4]) : 12,
          m[5] ? Number(m[5]) : 0,
          m[6] ? Number(m[6]) : 0,
        ),
      );
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  if (video.uploadedAt) {
    const d = new Date(video.uploadedAt);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}
