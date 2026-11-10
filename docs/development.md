# Development map

## Boundaries

- `app/`: Next.js routes and HTTP entry points. Private routes check studio access before loading or changing project data.
- `components/studio/`: author workspace, book planning/writing and explicit StateDiff review.
- `lib/`: story types, normalization, context construction and deterministic rules. `book-state-validator.ts` has no provider or database calls.
- `lib/server/`: orchestration, provider integration, access checks and persistence through the server-only database client.
- `public/legacy/`: the public static reader, its example stories and browser-local progress.
- `supabase/migrations/`: schema and data changes in migration order.
- `scripts/`: deterministic checks, author import and optional paid prose evaluation.

`story-schema.ts`, `book-engine.ts`, `studio-story-service.ts`, `book-job-service.ts` and the main workspace remain substantial modules. Their size is a maintenance concern, not a reason to move code during a documentation review. Locked-fact helpers have already been separated into `lib/book-locked-facts.ts`.

## Verification

Use the README's secret-free checks first. The state suite checks supplied diffs, acceptance rules and prompt/context construction; it does not prove automatic knowledge/promise extraction or prose quality. The access suite checks both the middleware boundary and shared access helper. Type checking does not establish live provider availability.

The full app build requires Supabase configuration because the server client validates configuration when it is imported. Do not use a production database for exploratory import or migration tests.

Next.js stays on the patched 15.5 maintenance line. Its pinned PostCSS dependency is overridden to 8.5.32 to address the [upstream source-map file-read advisory](https://github.com/advisories/GHSA-fxqj-rqcc-2cmp) without changing the framework major version. Recheck the override when upgrading Next.js; tests, type checking and the production build verify this combination.

The `eval:*` scripts are opt-in provider evaluations, not CI checks. They can consume provider resources and write ignored local outputs. The bootstrap script is an author tool: supply your own creative Markdown with `--regie <file>` and inspect `--dry-run` first. It imports database modules even for a dry run, so valid local database configuration is still required. No personal source manuscript is included in the repository.

## Editing constraints

Preserve stable story/scene identifiers and the reader's `ember-progress-v1` storage contract. Schema and normalization changes must remain compatible with stored older stories. Keep domain data out of reusable genre engines, and keep provider/database calls out of deterministic state validation.
