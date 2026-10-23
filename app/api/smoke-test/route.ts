import { NextResponse } from "next/server"
import { hasCronSecret } from "@/lib/server/cron-auth"
import { supabaseAdmin } from "@/lib/supabase/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const EXPECTED_TABLES = [
  "profiles",
  "workspaces",
  "workspace_members",
  "stories",
  "story_versions",
  "acts",
  "chapters",
  "scenes",
  "scene_blocks",
  "story_variables",
  "choices",
  "choice_conditions",
  "choice_effects",
  "world_bible_entries",
  "book_projects",
  "book_writer_rules",
  "book_canon_facts",
  "book_canon_fact_scene_refs",
  "book_character_states",
  "book_open_threads",
  "book_scene_cards",
  "book_context_packs",
  "book_context_pack_canon_facts",
  "book_context_pack_character_states",
  "book_context_pack_threads",
  "book_draft_jobs",
  "ai_runs",
  "ai_patches",
  "playtest_sessions",
  "submissions",
  "submission_reviews"
]

export async function GET(request: Request) {
  if (!hasCronSecret(request)) {
    return NextResponse.json({ status: "UNAUTHORIZED" }, { status: 401 })
  }

  try {
    const checks = await Promise.all(
      EXPECTED_TABLES.map(async (table) => {
        const { error } = await supabaseAdmin
          .from(table)
          .select("*", { count: "exact", head: true })

        return [table, error ? `FAIL: ${error.message}` : "OK"] as const
      })
    )

    const results = Object.fromEntries(checks)
    const passed = checks.filter(([, status]) => status === "OK").length
    const failed = checks.length - passed

    return NextResponse.json({
      status: failed === 0 ? "ALL_PASSED" : "SOME_FAILED",
      summary: `${passed}/${EXPECTED_TABLES.length} tables reachable`,
      tables: results
    })
  } catch (error) {
    return NextResponse.json(
      {
        status: "ERROR",
        error: error instanceof Error ? error.message : "Smoke test failed"
      },
      { status: 500 }
    )
  }
}
