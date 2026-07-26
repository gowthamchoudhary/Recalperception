# Recall

A personal video memory search engine — search a lifetime of video by what was said, what happened, and who was there.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Required env: `SESSION_SECRET` — session cookie signing (API server refuses to boot without it)
- Optional env: `VIDEODB_API_KEY` — enables real video ingestion + semantic search (routes return 503 without it)
- Optional env: `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION` / `AWS_REKOGNITION_COLLECTION_ID` — enable face-based person search (enrollment returns 503 without them; search silently stays scene-only)
- Optional env: `ELEVENLABS_API_KEY` — voice input (STT) and spoken answers (TTS); `/api/voice/*` returns 503 without it and the UI hides the mic

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Frontend: React + Vite + Tailwind (wouter router), artifact `artifacts/recall` at `/`

## Where things live

- API contract: `lib/api-spec/openapi.yaml` (source of truth, run codegen after edits)
- DB schema: `lib/db/src/schema/` (users, session, videos, moments, review_items, people)
- API routes: `artifacts/api-server/src/routes/` (auth, videos, search, chats, voice, review, people, stats)
- Search pipeline shared by `/search` and chat turns: `artifacts/api-server/src/lib/searchPipeline.ts` (emits staged progress via `onStage`)
- Frontend: `artifacts/recall/src/` — pages: landing, login, chat home (`/dashboard`), chat thread (`/chat/:id`), library, review, people. Authed pages wrap in `components/layout/AppShell.tsx` (dark sidebar + chat list); composer is `components/chat/chat-input.tsx`; player/exporter/moment-lookup live in `components/player-overlay.tsx`; SSE client + voice fetch helpers in `lib/chat-stream.ts`; `src/lib/auth.tsx` has `useCurrentUser`/logout helpers
- Seed thumbnails: `artifacts/recall/public/thumbs/` (AI-generated placeholders)

## Architecture decisions

- Video intelligence is VideoDB (SDK `videodb`, key `VIDEODB_API_KEY`): `POST /api/videos/upload` (multipart file or URL) inserts a `processing` row and runs a background pipeline in `artifacts/api-server/src/lib/ingestion.ts` — upload → spoken-word index → transcript excerpt → privacy scene scan. Clean scan → `indexed`; sensitive scenes or scan failure → `flagged` + review item; pipeline error → `failed` + `indexError`. Batches are client-side: one request per file, each with its own independent pipeline, so one flagged/failed video never blocks the rest.
- Privacy scan is a single combined pass: baseline categories (screens, documents/IDs, financial, nudity, medical, plates — regex over scene descriptions) PLUS the upload's optional `privacyRequest` (stored on the video row, reused by manual rescans). The scene prompt tells the model to append the `USER_REQUEST_MATCH` sentinel to matching descriptions; review items are created one per matched reason with explicit sourcing — `Baseline: <category>` vs `Your request: matches "<text>"` — and the sentinel is stripped before details are stored.
- Search is hybrid: VideoDB semantic search over real uploads (rows with `videodbVideoId`, synthetic negative result ids) merged with keyword scoring over seeded "moments". No silent fallbacks — VideoDB errors surface as 502/503 to the client.
- Intent routing: every query is first classified by Groq (`classifyIntent` in `artifacts/api-server/src/lib/intent.ts`) into `search`/`count`/`recency`/`group` plus a direction (latest/earliest) and a topic (query minus question phrasing; names kept). Non-search intents retrieve with the topic; count/group widen retrieval (25 per index vs 12, group shows up to 24 cards); recency sorts deduped results by best date (`recordedAt` → `YYYY-MM-DD` parsed from title → `uploadedAt`, undated last) and returns the single top match; count counts moments pre-dedupe. Count/recency get a grounded Groq answer (8s timeout) with a deterministic fallback sentence; any classification failure fails open to plain search. Response is `{ results, personFilter, intent, answer }`; person face-filtering composes on top of every intent. The VideoDB SDK has no aggregate/count API, so count aggregates broad search hits server-side. Group requires explicit exhaustive phrasing ("show every…", "all my…") — a bare scene description classifies as search.
- Title match layer: a third retrieval signal (`artifacts/api-server/src/lib/titleMatch.ts`) — stopword-filtered token/prefix matching of the effective query against indexed videos' titles (accepted only on strong signals — full title coverage, or ≥60% query coverage with ≥2 matched words; pure date/number tokens never carry a match alone; cap 6, ties newest-first). VideoDB's semantic indexes never see titles, so a video named for its subject (e.g. "stuck in traffic" whose footage is a face close-up) is otherwise unfindable. Title hits append AFTER semantic results as lower-confidence `matchType: "title"` cards (synthetic ids from -1,000,000 down), never enter the rerank or the moment counts (count/recency answers mention them separately — "matched by title only"), only join the recency pool when no content matched at all, and are skipped when a person face-filter is active (they bypass face confirmation and would contradict the person banner).
- Person search: enrolled faces live in `people` (one Rekognition FaceId per person; reference photo stored as a data-URL thumbnail, collection auto-created on first use). Groq splits the query into person + scene (parsed name must round-trip to an enrolled person, else treated as no person). Scene search runs normally, then up to 8 candidate videos are face-confirmed — 1–2 frames each via VideoDB `generateThumbnail` (t and t+2s), `SearchFacesByImage` threshold 85, second frame only if the first misses. Search response is `{ results, personFilter }`; Rekognition service failures (incl. timeouts) degrade to unfiltered scene results with `personFilter.status: "unavailable"`, never an error. `InvalidParameterException` from Rekognition means "no face in frame" — a normal negative, not an outage.
- Review queue: Accept → video back to `indexed` once no pending items; Discard → deletes from VideoDB first, then removes the video + moments + review items entirely.
- Boot sweep marks rows stuck in `processing` as `failed` on server restart (background jobs don't survive restarts).
- Auth is self-managed: scrypt-hashed passwords (`salt:hex`, timingSafeEqual) in `users`, express-session + connect-pg-simple Postgres sessions (survive restarts/refresh), session regenerated on login/signup, cookie httpOnly/lax (secure in prod), trust proxy 1. All data routes sit behind `requireAuth` and every query is scoped to the session's user id (`/dashboard` and `/search` are also route-guarded client-side).
- Signup adopts any videos with `user_id IS NULL` — a one-time hand-off of pre-auth uploads to the first account; inert afterwards.
- Real uploads get VideoDB `streamUrl` (HLS) + `playerUrl` and play via hls.js (player overlay seeks to the matched moment; landing hero cards run muted HLS loops when logged in, stock imagery when logged out).
- Chat threading: `chats` + `chat_messages` tables; `POST /api/chats/:id/messages` runs the search pipeline and returns a `ChatTurn` — as JSON, or as SSE when the client sends `Accept: text/event-stream` (`event: stage` per pipeline stage, then `event: result`). Pipeline failures are persisted as `failed: true` assistant turns, never 5xx, so threads always stay renderable. Follow-up questions are rewritten into standalone queries by Groq using recent thread context (`lib/chatContext.ts`); chat titles auto-set from the first message. The frontend parses SSE with a raw `fetch` reader (`lib/chat-stream.ts`) because generated axios hooks can't stream; the chat page appends turns with id-deduped `setQueryData` (the server persists the user message before the pipeline finishes, so refocus refetches mid-stream would otherwise duplicate it).
- Voice: ElevenLabs behind `/api/voice/*` — `transcribe` (multipart, field `audio`, 15MB cap) and `tts` (returns base64 audio JSON). 503 when unconfigured (UI checks `/api/voice/status` and hides the mic), 502 on upstream failure. Voice-originated turns auto-play a spoken answer; any assistant turn from a voice message shows a "Hear the answer" replay button.
- Person mention pills: typing `/` in the composer opens an enrolled-people picker; selected people ride along as `personIds` (AND semantics — every pill must be face-confirmed in frame). Pills with an empty text query take a `pillOnly` pipeline path: face-confirm over the newest indexed videos instead of a semantic search.
- In-player moment lookup: `GET /api/videos/:id/find` scopes semantic search to one video (spoken preferred, keyword fallback); `{ found: false }` is a normal answer, and the player queues the seek if the HLS element isn't attached yet.

## Product

- Landing hero with floating memory cards matching the user's reference design (cream #f4f4f2, green #1c8a3e accent, dark moment-found card, JetBrains Mono stamped accent)
- Authed app is chat-centered under a dark sidebar (AppShell): nav (Chat/Library/People/Review + pending-review badge), date-grouped chat history with inline rename + delete, "New chat" button
- `/dashboard` (chat home): greeting, hero composer with suggestion chips, recent-videos strip + stats; first message stashes locally, creates the chat, and streams on `/chat/:id`
- `/chat/:id`: user bubbles (pills + voice tag), real staged progress from SSE (stage checklist), assistant answers (dark intent-answer panel, person-filter banners, result cards), failed-turn cards with retry, docked composer
- `/library`: upload machinery + video grid with status badges (Indexing/Needs review/Failed), batch upload dialog (multi-file/folder/drag-drop/links, one optional privacy request field, concurrency 3), 4s polling while ingesting; per-video ⋯ menu (Details & edit / Export clip / Delete)
- `/review`: flagged-video queue with Accept/Discard; `/search` redirects to `/dashboard`
- Player overlay: highlighted matched segment, clip exporter, and an AI "find a moment in this video" input that seeks the playhead to the answer; title-only matches carry an amber "Matched by title only" badge and hide the moment timestamp
- People page (`/people`): enroll a person from a name + clear photo (client-side canvas downscale to ≤1000px JPEG before upload), inline rename, delete (also removes the Rekognition face)

## User preferences

- The landing hero card media areas must remain swappable slots — the user will upload real video clips to replace the placeholder imagery once the design is settled.

## Gotchas

- Body schemas in the OpenAPI spec must use entity-shaped names (`VideoInput`, not `CreateVideoBody`) to avoid TS2308 collisions after codegen.
- `lib/api-zod/tsconfig.json` needs `"lib": ["es2022", "dom"]` — orval generates `zod.instanceof(File)`/`Blob` for multipart schemas (fine at runtime on Node 20+).
- videodb SDK: `SearchResult.shots` is a property (not a method); pnpm blocks its postinstall script — harmless, it only fetches optional capture binaries. Zero-hit semantic search *raises* "No results found" — the search route maps that to an empty result list.
- connect-pg-simple's `createTableIfMissing` fails under the esbuild-bundled server (it can't resolve its `table.sql` asset from `dist/`) — the `session` table is owned by the drizzle schema instead; keep that option off.
- Don't use `format: email` in the OpenAPI spec — orval emits zod-v4's top-level `zod.email()` against the zod v3 import and the generated file fails typecheck. Validate email format server-side.
- Don't name an OpenAPI component schema `<OperationId>Params` — orval already generates a query-param type with that exact name and the duplicate export breaks the build.
- AWS + ElevenLabs credentials used to live as plaintext env vars in `.replit` `[userenv.shared]` (that's why they never appeared in the secrets pane). They are being migrated to Replit Secrets — keep credentials out of `[userenv]`.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
