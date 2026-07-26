import { logger } from "./logger";

/**
 * Follow-up context for chat threads: rewrite "what about in the garden?"
 * into a standalone archive query using the recent conversation.
 *
 * Strictly fail-open — any Groq failure returns the original query so a
 * chat message is never worse off than a plain search.
 */

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";
const REWRITE_TIMEOUT_MS = 8_000;
const MAX_HISTORY_ENTRIES = 6;
const MAX_ENTRY_CHARS = 300;
const MAX_REWRITE_CHARS = 300;

export type ChatHistoryEntry = {
  role: "user" | "assistant";
  content: string;
};

export async function rewriteQueryWithHistory(
  query: string,
  history: ChatHistoryEntry[],
): Promise<string> {
  const apiKey = process.env["GROQ_API_KEY"];
  const recent = history
    .filter((h) => h.content.trim().length > 0)
    .slice(-MAX_HISTORY_ENTRIES);
  if (!apiKey || recent.length === 0 || !query.trim()) return query;

  const transcript = recent
    .map(
      (h) =>
        `${h.role === "user" ? "User" : "Assistant"}: ${h.content.slice(0, MAX_ENTRY_CHARS)}`,
    )
    .join("\n");

  const system = [
    "You rewrite the newest message in a conversation about a personal video archive into ONE standalone search query.",
    'Return JSON: {"query": "<standalone search query>"}.',
    "Rules:",
    "- If the newest message already stands alone, return it UNCHANGED.",
    "- Resolve references like \"there\", \"that trip\", \"what about her\" using the conversation.",
    "- Keep person names exactly as written. Never invent details that were not mentioned.",
    "- Keep it short and search-like — no question rephrasing beyond what's needed.",
  ].join("\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REWRITE_TIMEOUT_MS);
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
        max_tokens: 120,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: `Conversation so far:\n${transcript}\n\nNewest message: ${query}`,
          },
        ],
      }),
    });
    if (!resp.ok) {
      logger.warn(
        { status: resp.status },
        "History rewrite failed; using the message as-is",
      );
      return query;
    }
    const data = (await resp.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return query;
    const parsed = JSON.parse(content) as { query?: unknown };
    const rewritten =
      typeof parsed.query === "string" ? parsed.query.trim() : "";
    // Sanity bounds: an empty or runaway rewrite is worse than the original.
    if (!rewritten || rewritten.length > MAX_REWRITE_CHARS) return query;
    if (rewritten !== query) {
      logger.info({ from: query, to: rewritten }, "Follow-up query rewritten");
    }
    return rewritten;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "History rewrite errored/timed out; using the message as-is",
    );
    return query;
  } finally {
    clearTimeout(timer);
  }
}
