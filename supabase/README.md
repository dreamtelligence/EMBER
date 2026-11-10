# Supabase persistence

EMBER's author studio persists story structure, scenes, context packets, generation jobs and reviewed state changes in Supabase Postgres. The static public reader does not query this database.

## Schema map

- Workspace and membership tables define ownership relationships for the schema.
- Story, act, chapter, scene, block and choice tables represent authored content.
- World bible, canon, character state, threads, scene cards and context packs form the book memory.
- Draft jobs, stage runs, quality evaluations, human-edit examples and StateDiff records support the writer/review loop.

`migrations/` is the chronological source of schema and data changes. Some later migrations replace earlier provider constraints. Read the complete sequence rather than treating the initial migration as the current schema. The story-specific character rename is historical example-content maintenance, not a general normalization rule.

## Local setup

Use your own isolated Supabase project, configure the variables in [`.env.example`](../.env.example), and apply the migrations in order. They assume Supabase's `auth.users` and roles exist. The import script and app build validate database configuration even when they do not make a database request.

Never run a reset, an author import or migration experiments against the live author workspace. This repository does not include a copy of its private manuscripts or database.

## Access model

The deployed application is a single-author studio protected by HTTP Basic authentication and explicit server route checks. Server persistence uses the service-role client, which bypasses RLS; schema membership policies alone do not make this application a multi-tenant service. See the [access boundary](../README.md#access-boundary) and [authentication helper](../lib/server/studio-auth.ts).

The deterministic tests require neither a running database nor provider credentials. They do not prove that migrations have been applied to a particular deployment, that backups exist, or that multiple end-user accounts are isolated by the current server code.
