import { NextResponse } from "next/server"
import { hasCronSecret } from "@/lib/server/cron-auth"
import { supabaseAdmin } from "@/lib/supabase/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Called daily by Vercel Cron (vercel.json) so the Supabase Free project
// sees real database activity and is not paused after 7 idle days.
export async function GET(request: Request) {
  if (!hasCronSecret(request)) {
    return NextResponse.json({ status: "UNAUTHORIZED" }, { status: 401 })
  }

  const { error } = await supabaseAdmin.from("stories").select("id").limit(1)

  if (error) {
    return NextResponse.json({ status: "FAIL", error: error.message }, { status: 502 })
  }

  return NextResponse.json({ status: "OK", checkedAt: new Date().toISOString() })
}
