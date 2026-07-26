import { Router, type IRouter, type Request, type Response } from "express";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  db,
  chatsTable,
  chatMessagesTable,
  peopleTable,
  type ChatRow,
  type ChatMessageRow,
} from "@workspace/db";
import {
  ListChatsResponse,
  CreateChatBody,
  CreateChatResponse,
  GetChatParams,
  GetChatResponse,
  UpdateChatParams,
  UpdateChatBody,
  UpdateChatResponse,
  DeleteChatParams,
  SendChatMessageParams,
  SendChatMessageBody,
  SendChatMessageResponse,
} from "@workspace/api-zod";
import { logger } from "../lib/logger";
import { currentUserId } from "../lib/auth";
import {
  runSearchPipeline,
  SearchUnavailableError,
  type PipelineStage,
  type PipelineResponse,
} from "../lib/searchPipeline";
import type { ChatHistoryEntry } from "../lib/chatContext";

const router: IRouter = Router();

const DEFAULT_TITLE = "New chat";
const TITLE_MAX = 60;
const HISTORY_LIMIT = 6;

function toApiChat(row: ChatRow) {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Payload fields ride alongside the core columns in the API shape. */
function toApiMessage(row: ChatMessageRow) {
  const payload =
    row.payload && typeof row.payload === "object"
      ? (row.payload as Record<string, unknown>)
      : {};
  return {
    ...payload,
    id: row.id,
    chatId: row.chatId,
    role: row.role,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
  };
}

async function ownedChat(req: Request): Promise<ChatRow | null> {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id)) return null;
  const [chat] = await db
    .select()
    .from(chatsTable)
    .where(
      and(eq(chatsTable.id, id), eq(chatsTable.userId, currentUserId(req))),
    );
  return chat ?? null;
}

router.get("/chats", async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(chatsTable)
    .where(eq(chatsTable.userId, currentUserId(req)))
    .orderBy(desc(chatsTable.updatedAt));
  res.json(ListChatsResponse.parse(rows.map(toApiChat)));
});

router.post("/chats", async (req, res): Promise<void> => {
  const parsed = CreateChatBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [chat] = await db
    .insert(chatsTable)
    .values({
      userId: currentUserId(req),
      title: parsed.data.title?.trim() || DEFAULT_TITLE,
    })
    .returning();
  res.status(201).json(CreateChatResponse.parse(toApiChat(chat!)));
});

router.get("/chats/:id", async (req, res): Promise<void> => {
  const params = GetChatParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const chat = await ownedChat(req);
  if (!chat) {
    res.status(404).json({ error: "Chat not found" });
    return;
  }
  const messages = await db
    .select()
    .from(chatMessagesTable)
    .where(eq(chatMessagesTable.chatId, chat.id))
    .orderBy(asc(chatMessagesTable.id));
  res.json(
    GetChatResponse.parse({
      ...toApiChat(chat),
      messages: messages.map(toApiMessage),
    }),
  );
});

router.patch("/chats/:id", async (req, res): Promise<void> => {
  const params = UpdateChatParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = UpdateChatBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const [chat] = await db
    .update(chatsTable)
    .set({ title: body.data.title.trim(), updatedAt: new Date() })
    .where(
      and(
        eq(chatsTable.id, params.data.id),
        eq(chatsTable.userId, currentUserId(req)),
      ),
    )
    .returning();
  if (!chat) {
    res.status(404).json({ error: "Chat not found" });
    return;
  }
  res.json(UpdateChatResponse.parse(toApiChat(chat)));
});

router.delete("/chats/:id", async (req, res): Promise<void> => {
  const params = DeleteChatParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [chat] = await db
    .delete(chatsTable)
    .where(
      and(
        eq(chatsTable.id, params.data.id),
        eq(chatsTable.userId, currentUserId(req)),
      ),
    )
    .returning();
  if (!chat) {
    res.status(404).json({ error: "Chat not found" });
    return;
  }
  res.sendStatus(204);
});

/** One-line reply text for turns that don't produce a count/recency answer. */
function summarize(out: PipelineResponse): string {
  if (out.answer) return out.answer;
  const n = out.results.length;
  if (n === 0) {
    return out.personFilter && out.personFilter.status === "applied"
      ? `I couldn't find any moments with ${out.personFilter.personName} matching that.`
      : "I couldn't find anything matching that in your library.";
  }
  const clips = `${n} matching moment${n === 1 ? "" : "s"}`;
  const who =
    out.personFilter && out.personFilter.status === "applied"
      ? ` with ${out.personFilter.personName}`
      : "";
  return `Found ${clips}${who}.`;
}

function sseWrite(res: Response, event: string, data: unknown): void {
  if (res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

router.post("/chats/:id/messages", async (req, res): Promise<void> => {
  const params = SendChatMessageParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = SendChatMessageBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const content = body.data.content.trim();
  const personIds = [...new Set(body.data.personIds ?? [])];
  if (!content && personIds.length === 0) {
    res.status(400).json({ error: "Say something or mention a person." });
    return;
  }
  const chat = await ownedChat(req);
  if (!chat) {
    res.status(404).json({ error: "Chat not found" });
    return;
  }
  const uid = currentUserId(req);

  // Resolve pill names once — stored on the message so threads render the
  // pills even if the person is later renamed or deleted.
  const personRows =
    personIds.length > 0
      ? await db
          .select()
          .from(peopleTable)
          .where(
            and(eq(peopleTable.userId, uid), inArray(peopleTable.id, personIds)),
          )
      : [];
  const validPersonIds = personRows.map((p) => p.id);
  const personNames = personRows.map((p) => p.name);

  // Conversation context: completed turns BEFORE this one, oldest first.
  const prior = await db
    .select()
    .from(chatMessagesTable)
    .where(eq(chatMessagesTable.chatId, chat.id))
    .orderBy(asc(chatMessagesTable.id));
  const history: ChatHistoryEntry[] = prior
    .filter((m) => {
      const payload = (m.payload ?? {}) as Record<string, unknown>;
      return payload["failed"] !== true;
    })
    .map((m) => {
      const payload = (m.payload ?? {}) as Record<string, unknown>;
      const personNames =
        m.role === "user" && Array.isArray(payload["personNames"])
          ? (payload["personNames"] as string[]).filter(
              (name) => typeof name === "string" && name.trim().length > 0,
            )
          : undefined;
      return {
        role: m.role as "user" | "assistant",
        content: m.content,
        ...(personNames?.length ? { personNames } : {}),
      };
    })
    .filter((m) => m.content.trim().length > 0)
    .slice(-HISTORY_LIMIT);

  const [userMessage] = await db
    .insert(chatMessagesTable)
    .values({
      chatId: chat.id,
      role: "user",
      content,
      payload: {
        ...(body.data.voice ? { voice: true } : {}),
        ...(validPersonIds.length > 0
          ? { personIds: validPersonIds, personNames }
          : {}),
      },
    })
    .returning();

  const wantsStream = (req.headers.accept ?? "").includes("text/event-stream");
  if (wantsStream) {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
  }
  const onStage = wantsStream
    ? (stage: PipelineStage) => sseWrite(res, "stage", { stage })
    : undefined;

  // The pipeline runs to completion and the turn is persisted even if the
  // client disconnects mid-stream — the thread stays consistent on reload.
  let assistantContent: string;
  let assistantPayload: Record<string, unknown>;
  try {
    const out = await runSearchPipeline({
      userId: uid,
      query: content,
      history,
      personIds: validPersonIds,
      onStage,
    });
    assistantContent = summarize(out);
    assistantPayload = {
      results: out.results,
      personFilter: out.personFilter,
      intent: out.intent,
      answer: out.answer,
    };
  } catch (err) {
    const friendly =
      err instanceof SearchUnavailableError
        ? err.message
        : "Something went wrong searching your library. Please try again.";
    if (!(err instanceof SearchUnavailableError)) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "Chat turn failed",
      );
    }
    assistantContent = friendly;
    assistantPayload = { failed: true, results: [], intent: "search" };
  }

  const [assistantMessage] = await db
    .insert(chatMessagesTable)
    .values({
      chatId: chat.id,
      role: "assistant",
      content: assistantContent,
      payload: assistantPayload,
    })
    .returning();

  // First turn names the thread; every turn bumps recency.
  const draftTitle = content || personNames.join(" & ");
  const shouldTitle = chat.title === DEFAULT_TITLE && draftTitle;
  await db
    .update(chatsTable)
    .set({
      updatedAt: new Date(),
      ...(shouldTitle
        ? {
            title:
              draftTitle.length > TITLE_MAX
                ? `${draftTitle.slice(0, TITLE_MAX - 1)}…`
                : draftTitle,
          }
        : {}),
    })
    .where(eq(chatsTable.id, chat.id));

  const turn = SendChatMessageResponse.parse({
    userMessage: toApiMessage(userMessage!),
    assistantMessage: toApiMessage(assistantMessage!),
  });
  if (wantsStream) {
    sseWrite(res, "result", turn);
    res.end();
  } else {
    res.json(turn);
  }
});

export default router;
