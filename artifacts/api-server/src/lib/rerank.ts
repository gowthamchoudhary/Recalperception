import { logger } from "./logger";

/**
 * LLM reranking for search results via Groq (llama-3.3-70b-versatile).
 *
 * Given the user's query and the combined retrieval candidates (spoken +
 * scene + keyword branches), the model:
 *   1. drops candidates that don't genuinely answer the query's intent,
 *   2. ranks the rest by true relevance,
 *   3. writes one short sentence per kept result explaining the match.
 *
 * Returns null when reranking is unavailable (no GROQ_API_KEY, timeout, bad
 * response) — the caller falls back to the raw retrieval order.
 */

export type RerankCandidate = {
  key: number;
  videoTitle: string;
  snippet: string;
  matchType: "speech" | "scene" | "person" | "title";
  timestampSeconds: number;
};

export type RerankedItem = { key: number; reason: string };

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";
const GROQ_TIMEOUT_MS = 12_000;

export function isRerankConfigured(): boolean {
  return Boolean(process.env["GROQ_API_KEY"]);
}

export async function rerankWithGroq(
  query: string,
  candidates: RerankCandidate[],
): Promise<RerankedItem[] | null> {
  const apiKey = process.env["GROQ_API_KEY"];
  if (!apiKey || candidates.length === 0) return null;

  const system = [
    "You rerank search results for a personal video memory archive.",
    "The user searches their own home videos by what was said (speech transcript matches) and what was visible (scene description matches).",
    "Transcripts can be garbled or in the wrong language — a snippet of gibberish that merely embedded-matched is NOT a genuine answer.",
    "Given the query and candidates, return JSON: {\"results\": [{\"key\": <candidate key>, \"reason\": \"<one short sentence why this matches>\"}]}.",
    "Rules:",
    "- Drop candidates that do not genuinely answer the query's intent, even if they matched semantically.",
    "- Order the kept candidates from most to least relevant.",
    "- Each reason must be a single short plain-English sentence grounded in the candidate's snippet.",
    "- Only use keys that exist in the candidate list. Return {\"results\": []} if nothing is relevant.",
  ].join("\n");

  const user = JSON.stringify({
    query,
    candidates: candidates.map((c) => ({
      key: c.key,
      title: c.videoTitle,
      matchType: c.matchType,
      timestampSeconds: c.timestampSeconds,
      snippet: c.snippet.slice(0, 400),
    })),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);
  try {
    const started = Date.now();
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
        max_tokens: 1024,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      logger.warn(
        { status: resp.status, body: body.slice(0, 300) },
        "Groq rerank request failed; falling back to retrieval order",
      );
      return null;
    }
    const data = (await resp.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content) as { results?: unknown };
    if (!Array.isArray(parsed.results)) return null;

    const validKeys = new Set(candidates.map((c) => c.key));
    const seen = new Set<number>();
    const items: RerankedItem[] = [];
    for (const r of parsed.results) {
      if (typeof r !== "object" || r === null) continue;
      const key = (r as { key?: unknown }).key;
      const reason = (r as { reason?: unknown }).reason;
      if (typeof key !== "number" || !validKeys.has(key) || seen.has(key)) {
        continue;
      }
      seen.add(key);
      items.push({
        key,
        reason: typeof reason === "string" ? reason.slice(0, 300) : "",
      });
    }
    logger.info(
      {
        model: GROQ_MODEL,
        candidates: candidates.length,
        kept: items.length,
        ms: Date.now() - started,
      },
      "Groq rerank completed",
    );
    return items;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Groq rerank errored/timed out; falling back to retrieval order",
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}
