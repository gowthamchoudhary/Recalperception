# Recall

A personal video memory search engine — search a lifetime of video by what was said, what happened, and who was there.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Optional env: `VIDEODB_API_KEY` — enables real video ingestion + semantic search (routes return 503 without it)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Frontend: React + Vite + Tailwind (wouter router), artifact `artifacts/recall` at `/`

## Where things live

- API contract: `lib/api-spec/openapi.yaml` (source of truth, run codegen after edits)
- DB schema: `lib/db/src/schema/` (videos, moments, review_items)
- API routes: `artifacts/api-server/src/routes/` (videos, search, review, people, stats)
- Frontend: `artifacts/recall/src/` — pages for landing, login (UI-only), dashboard, search results
- Seed thumbnails: `artifacts/recall/public/thumbs/` (AI-generated placeholders)

## Architecture decisions

- Video intelligence is VideoDB (SDK `videodb`, key `VIDEODB_API_KEY`): `POST /api/videos/upload` (multipart file or URL) inserts a `processing` row and runs a background pipeline in `artifacts/api-server/src/lib/ingestion.ts` — upload → spoken-word index → transcript excerpt → privacy scene scan. Clean scan → `indexed`; sensitive scenes or scan failure → `flagged` + review item; pipeline error → `failed` + `indexError`.
- Search is hybrid: VideoDB semantic search over real uploads (rows with `videodbVideoId`, synthetic negative result ids) merged with keyword scoring over seeded "moments". No silent fallbacks — VideoDB errors surface as 502/503 to the client.
- Review queue: Accept → video back to `indexed` once no pending items; Discard → deletes from VideoDB first, then removes the video + moments + review items entirely.
- Boot sweep marks rows stuck in `processing` as `failed` on server restart (background jobs don't survive restarts).
- Auth is UI-only (login page navigates to dashboard); no real auth backend yet.
- Seeded videos have `videoUrl: null`; real uploads get VideoDB `streamUrl` (HLS) + `playerUrl`. The player overlay and hero cards remain swappable media slots.

## Product

- Landing hero with floating memory cards matching the user's reference design (cream #f4f4f2, green #1c8a3e accent, dark moment-found card, JetBrains Mono stamped accent)
- Dashboard: search bar, video library grid with status badges (Indexing/Needs review/Failed), real file+URL upload to VideoDB, 4s polling while ingesting, Needs Review queue with Accept/Discard
- Search with staged loading transition and results list; player overlay with highlighted matched segment

## User preferences

- The landing hero card media areas must remain swappable slots — the user will upload real video clips to replace the placeholder imagery once the design is settled.

## Gotchas

- Body schemas in the OpenAPI spec must use entity-shaped names (`VideoInput`, not `CreateVideoBody`) to avoid TS2308 collisions after codegen.
- `lib/api-zod/tsconfig.json` needs `"lib": ["es2022", "dom"]` — orval generates `zod.instanceof(File)`/`Blob` for multipart schemas (fine at runtime on Node 20+).
- videodb SDK: `SearchResult.shots` is a property (not a method); pnpm blocks its postinstall script — harmless, it only fetches optional capture binaries.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
