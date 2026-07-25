# Recall

A personal video memory search engine — search a lifetime of video by what was said, what happened, and who was there.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

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

- Search is keyword scoring over indexed "moments" (snippet + keywords per video) — no external AI service.
- Auth is UI-only (login page navigates to dashboard); no real auth backend yet.
- Videos have `videoUrl: null` for now — the player and hero cards are built as swappable media slots for real clips the user will upload later.

## Product

- Landing hero with floating memory cards matching the user's reference design (cream #f4f4f2, green #1c8a3e accent, dark moment-found card, JetBrains Mono stamped accent)
- Dashboard: search bar, video library grid, simulated upload flow, Needs Review queue with Accept/Discard
- Search with staged loading transition and results list; player overlay with highlighted matched segment

## User preferences

- The landing hero card media areas must remain swappable slots — the user will upload real video clips to replace the placeholder imagery once the design is settled.

## Gotchas

- Body schemas in the OpenAPI spec must use entity-shaped names (`VideoInput`, not `CreateVideoBody`) to avoid TS2308 collisions after codegen.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
