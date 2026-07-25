---
name: Orval multipart needs DOM lib in shared zod package
description: Why lib/api-zod compiles with DOM types and what breaks without it
---

# Orval multipart schemas require DOM lib in `lib/api-zod`

The rule: any OpenAPI schema with `format: binary` makes orval emit `zod.instanceof(File)` and `Blob` types into `lib/api-zod/src/generated/`. The workspace base tsconfig has `lib: ["es2022"]` and `types: []`, so codegen's typecheck step fails with TS2304 (`Cannot find name 'File'`).

**Why:** Fixed by adding `"lib": ["es2022", "dom"]` to `lib/api-zod/tsconfig.json` only (not the base config). Safe at runtime: Node 20+ has global `File`/`Blob`, and the package is isomorphic anyway.

**How to apply:** If codegen fails with `Cannot find name 'File'/'Blob'` after adding an upload endpoint, check that tsconfig override is still present rather than removing `format: binary` from the spec (removing it would break the generated FormData client).
