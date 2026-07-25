---
name: Long-running jobs from the agent shell
description: Running multi-minute batch/drain jobs reliably from the agent shell — backgrounded processes get reaped
---

Rule: never rely on `&`, `nohup`, or `setsid` to keep a long job alive after a shell call returns — the platform silently reaps orphaned processes (the job dies with no log tail and looks like a hang).

**Why:** during a batch reprocessing drain (July 2026), every backgrounded attempt died within seconds; only foreground execution survived.

**How to apply:**
- Run long drains as foreground chunks inside one shell call: `timeout <N> <cmd>` with the tool timeout a comfortable margin above N (e.g. `timeout 235` with a 290s tool timeout).
- Make the job resumable: per-item status state machine in the DB, so a chunk killed mid-item is picked up by the next chunk.
- Start each chunk with a guarded reset SQL that re-queues rows stranded by the previous timebox kill (e.g. `status='processing' AND started_at older than 1h`).
- When matching stored error text in SQL, beware curly apostrophes (’ vs ') and that negated enumerations ("not X, Y, or Z") span commas — prefer `~*` regex on a distinctive fragment.
- Cap per-item time inside the script (Promise.race) so one wedged item can't eat the whole chunk; on cap, reset that row to a retryable/terminal status explicitly.
- esbuild-bundled dev servers may wipe `dist/` on rebuild — keep drain-script bundles in a separate gitignored dir (e.g. `dist-scripts/`).
