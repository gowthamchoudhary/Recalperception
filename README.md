# Recall

A personal video memory search engine — search a lifetime of video by what was said, what happened, and who was there.

## What it does

- **Upload** a batch of videos from your device, Google Photos, or YouTube links.
- **Indexes** them through a dual pipeline: spoken-word transcript (via [VideoDB](https://videodb.io)) and visual scene understanding.
- **Protects** privacy with a sensitivity scan that flags any questionable content before it becomes searchable.
- **Searches** in plain language — classify intent, find moments, count occurrences, or ask for the latest one.
- **Recognizes people** by face via AWS Rekognition, so you can ask “show me where Arjun talked about HydraDB”.
- **Chats** with results naturally and exports the exact clip you want.

## Project structure

This is a pnpm workspace monorepo with three artifacts:

| Artifact | Path | Description |
|----------|------|-------------|
| Web app | `artifacts/recall` | React + Vite + Tailwind landing page and chat UI |
| API server | `artifacts/api-server` | Express 5 API, search pipeline, ingestion, auth, voice, people |
| Mockup sandbox | `artifacts/mockup-sandbox` | Isolated component preview server for canvas mockups |

Shared libraries:

- `lib/db` — PostgreSQL schema and Drizzle ORM
- `lib/api-spec` — OpenAPI contract
- `lib/api-zod` / `lib/api-client-react` — generated Zod schemas and React hooks

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5, Drizzle ORM, PostgreSQL
- Frontend: React 19, Vite 7, Tailwind 4, Framer Motion, wouter
- Video intelligence: VideoDB
- Face recognition: AWS Rekognition
- LLM intent + answers: Groq
- Voice: ElevenLabs (STT + TTS)
- Validation: Zod, OpenAPI → Orval codegen

## Run locally

### Prerequisites

- PostgreSQL database
- pnpm
- Replit or local environment variables (see Required env below)

### Start the services

```bash
# Install dependencies
pnpm install

# Run the API server
pnpm --filter @workspace/api-server run dev

# In a separate terminal, run the web app
pnpm --filter @workspace/recall run dev
```

### Useful scripts

```bash
pnpm run typecheck      # typecheck all packages
pnpm run build          # full build
pnpm --filter @workspace/db run push          # push DB schema changes
pnpm --filter @workspace/api-spec run codegen # regenerate API hooks + Zod schemas
```

## Required environment variables

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Postgres connection string |
| `SESSION_SECRET` | Session cookie signing |

## Optional environment variables

| Variable | Purpose |
|----------|---------|
| `VIDEODB_API_KEY` | Video indexing and semantic search |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION` / `AWS_REKOGNITION_COLLECTION_ID` | Face-based person search |
| `ELEVENLABS_API_KEY` | Voice input and spoken answers |
| `GROQ_API_KEY` | LLM intent classification and answer generation |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | Google OAuth login |

## Architecture highlights

- **Dual indexing:** every video gets a spoken-word transcript and a visual scene index.
- **Privacy scan:** baseline sensitive categories + user-supplied privacy rules create a review queue before content is searchable.
- **Intent routing:** queries are classified into `search`, `count`, `recency`, or `group` intents before retrieval.
- **Face timelines:** enrolled people are matched across the full video duration and merged into confirmed appearance ranges.
- **Hybrid search:** semantic scene search + keyword scoring + title matching, with a final LLM rerank.
- **Chat/SSE:** chat turns stream pipeline stages in real time, and failures are persisted as failed turns rather than crashing the thread.

## Key pages

- `/` — landing page
- `/login` / `/signup` — session-based auth
- `/dashboard` — chat home with composer and suggestions
- `/chat/:id` — threaded chat with search results
- `/library` — video upload grid and status
- `/review` — flagged-video review queue
- `/people` — face enrollment and management
- `/search` — redirects to `/dashboard`

## License

MIT
