---
name: Orval multipart needs DOM lib in shared zod package
description: Why lib/api-zod compiles with DOM types and what breaks without it
---

# Orval multipart schemas require DOM lib in `lib/api-zod`

The rule: any OpenAPI schema with `format: binary` makes orval emit `zod.instanceof(File)` and `Blob` types into `lib/api-zod/src/generated/`. The workspace base tsconfig has `lib: ["es2022"]` and `types: []`, so codegen's typecheck step fails with TS2304 (`Cannot find name 'File'`).

**Why:** Fixed by adding `"lib": ["es2022", "dom"]` to `lib/api-zod/tsconfig.json` only (not the base config). Safe at runtime: Node 20+ has global `File`/`Blob`, and the package is isomorphic anyway.

**How to apply:** If codegen fails with `Cannot find name 'File'/'Blob'` after adding an upload endpoint, check that tsconfig override is still present rather than removing `format: binary` from the spec (removing it would break the generated FormData client).

## Schema naming: `<OperationId>Params` is reserved

For any operation with query parameters, orval emits a type named `<PascalCaseOperationId>Params` in the same generated module as component schemas. Defining a component schema with that exact name (e.g. schema `FindInVideoParams` next to operationId `findInVideo`) produces two exports with one name and the generated package fails typecheck.

**Why:** Hit when adding the find-in-video endpoint; the collision error (TS2308) points at generated code, not at the spec, so it's slow to trace back.
**How to apply:** When adding schemas to `lib/api-spec/openapi.yaml`, avoid the `*Params` suffix entirely — use entity-shaped names (`MomentQuery`, not `FindInVideoParams`).
