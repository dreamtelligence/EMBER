# Repository Guidelines

## Current architecture constraints

Locked-fact normalization, legacy mapping and getters already live in `lib/book-locked-facts.ts`; their types remain in `lib/story-schema.ts`. Reuse that boundary. A broader schema/engine split is deferred work and requires its own scoped change.

Keep bootstrap and reusable genre engines free of story-specific character, institution and setting literals. In default engine mode, avoid deriving genre-specific locked facts too aggressively. Private creative source files are not repository dependencies.

## Project Structure & Module Organization
This repository is a Next.js app with the studio under `app/`, shared logic under `lib/`, and UI components under `components/`. The legacy storefront/reader that still powers `/` and `/story` lives in `public/legacy/` with its own `index.html`, `app.js`, `story.js`, `styles.css`, and image assets. Supabase SQL lives in `supabase/migrations/`. Developer and author documentation lives under `docs/`; private planning manuscripts are ignored and are not runtime code.

## Build, Test, and Development Commands
Install dependencies and use the Next.js workflow:

```bash
npm install
npm run dev
```

Then open `http://localhost:3000`. Use `npm run build` as the main verification step before handing work off. If you need to inspect the legacy reader in isolation, use the running app paths `/legacy/index.html?view=store` or `/legacy/index.html?view=story` instead of reviving root-level static files.

## Coding Style & Naming Conventions
Match the existing style in each layer: TypeScript/TSX in `app/`, `components/`, and `lib/` uses the repo's current semicolon-free style and double quotes only where already established; the legacy files in `public/legacy/` keep 2-space indentation, semicolon-free JavaScript, double quotes, and `function`-based helpers. Keep file names descriptive. In legacy `story.js`, use stable IDs such as `scene3` or `endingA`; in CSS, keep class names kebab-case such as `store-card--featured`.

## Testing Guidelines
Run `npm run test:book-state`, `npm run test:studio-auth` and `npm run typecheck` for the existing deterministic and access checks. Run `npm run build` with valid local configuration for runtime changes, then manually verify the affected browser flow. For legacy reader changes, check scene progression, localStorage resume behavior, conditional story branches, and responsive layout. After story or UI edits, test a fresh run and a resumed run by clearing and reusing browser storage.

## Commit & Pull Request Guidelines
Recent commits use short, lowercase summaries like `store front`. Keep commit messages concise and imperative, preferably one line focused on the user-visible change. Pull requests should include a short description, affected files, manual test notes, and screenshots or screen recordings for visual changes.

## Configuration & Content Notes
The legacy reader stores progress in browser localStorage under `ember-progress-v1`. If you change scene IDs, ending IDs, or asset names inside `public/legacy/`, update all references together to avoid broken progress restores or missing media. Keep runtime assets under `public/legacy/` instead of duplicating them in the repository root.

For the Book pipeline, keep the docs aligned with the current runtime instead of older provider experiments:

- Remote Book jobs are routed only through `OpenAI` or `Anthropic`.
- `local_fallback` is an expected safety path, not a signal that the model is bad.
- The UI currently exposes `Auto`, `OpenAI`, and `Anthropic`; there is no Gemini runtime path in the Book writer.
- Remote jobs use the lean scene pipeline: `beat_plan` and `rewrite` remain compatibility stages, but the remote path skips separate model calls for them. Draft prose is written directly from Scene Intention; `length_control` only runs an expand/compress pass for strong length outliers before `extract`, `continuity`, and `quality_eval`.
- Scene Cards are parsed from fenced code blocks. Hard fields are only `pov`, `location` / `ort`, `timeAnchor` / `uhrzeit`, locked facts, canon names, and explicit continuity anchors. `objective`, `opening`, `coreAction`, `dramaticBeat`, `ending`, and `closingLine` are soft guidance, not prose commands.
- Hard custom keys are limited to `object_anchor`, `prop_anchor`, `locked_object`, and `locked_material`. Legacy `required_material` must be mapped to `locked_material` only during import when it is a true continuity requirement. `proof_object` / `beweisobjekt`, `alltagswaffe`, `ersetzungsmoment`, `false_friend_signal`, and `kindmoment` / `mila_kindmoment` are soft material/pressure guidance.
- Author-specific Regie files are private local inputs; use the tracked studio guide for public onboarding and keep technical pipeline rules in `docs/architecture/book-pipeline.md`. For new book projects, convert the author's raw thoughts into a compact creative blueprint: Core, World/Pressure System, Characters, Canon Facts, Open Threads, Act Map, and fenced Scene Cards with `situation`, `want`, `pressure`, `material`, `turn`, `irreversible_change`, `thread`, `avoid`, and optional `aftertaste`.
- Current quality audits warn, they do not rewrite prose or create acceptance blockers. Smoothness markers, abstract noun density, over-precise pressure-figure timing, functional/regie language, and repeated Scene Card `ending_type` patterns belong in `styleDriftNotes` or `qualityWarnings`; only existing continuity guards should block acceptance.
- Scene Cards should include `ending_type` when possible. Vary endings across windows of scenes: not every chapter may end on object/proof intrusion. Mix proof with decision, silence, social consequence, access loss, quiet countermove, child echo, or apparent relief.
- `authorIntent` and `currentFocus` live in the Master Brief JSON and are soft prompt controls: `authorIntent` is the long-term book promise, `currentFocus` is the next 1-3 scene focus. They should guide drafting without overriding hard canon constraints.
- The Blueprint Review Queue is derived, not persisted. It combines continuity blockers, quality/market warnings, and propagation debt. Propagation debt warns when jobs may be stale because summaries, context packs, memory sync, Blueprint, or Writer Rules moved after the job.
- Human Edit Memory is part of the writer loop. Accepted job text compared with later human edits is stored in `book_human_edit_examples`; preserve `included` / `excluded` / `needs_review` learning statuses when syncing.
- Keep `book_writer_rules`, `book_scene_cards`, `book_context_packs`, `book_human_edit_examples`, `master_brief_runtime`, and `writer_rules_runtime` in sync when you touch the book bootstrap, save, or sync flow.

### Book StateDiff Layer
The Book pipeline now has a minimal typed StateDiff layer on top of the existing Draft Extraction flow. Keep this layer conservative and deterministic:

- Core types live in `lib/story-schema.ts`: `BookStateDiff`, `BookObjectState`, `BookKnowledgeState`, `BookPromiseState`, and `BookObjectStateChange`.
- Runtime logic lives in `lib/book-state-validator.ts`. It must stay deterministic and must not call OpenAI, Anthropic, Supabase, or any other remote/API service.
- `BookMemoryBackbone` includes `objectLedger`, `knowledgeLedger`, and `promiseLedger`. Old stories without those fields must continue to normalize safely.
- `BookDraftJob` includes `stateDiff` and `stateDiffStatus`. New jobs with a generated diff use `pending`; old or legacy jobs without a diff use `none`.
- `approveBookStateDiff` may update the typed ledgers and promote `proposedCanonFacts`; `rejectBookStateDiff` must never mutate ledgers. Do not set `approved_manual` automatically.
- `sceneLocalDetails` are scene-local only and must never be promoted into `canonLedger`. `proposedCanonFacts` may enter `canonLedger` only after explicit StateDiff approval.
- The writer prompt should not be expanded for this layer. Keep the writer free; make validation and memory sync stricter instead.
- Database support is in `supabase/migrations/20260428000001_add_book_state_diff.sql`. Apply it when deploying this layer to a remote Supabase project.
- Verify StateDiff changes with `npm run typecheck` and `npm run test:book-state`.
