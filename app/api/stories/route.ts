import { NextResponse } from "next/server"
import { createStudioStory, listStudioStories } from "@/lib/server/studio-story-service"
import { studioAccessResponse } from "@/lib/server/studio-auth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const denied = studioAccessResponse(request.headers)
  if (denied) return denied
  try {
    const stories = await listStudioStories()

    return NextResponse.json({
      stories
    })
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Story list failed."
      },
      { status: 500 }
    )
  }
}

export async function POST(request: Request) {
  const denied = studioAccessResponse(request.headers)
  if (denied) return denied
  try {
    const payload = (await request.json().catch(function () {
      return {}
    })) as {
      workspaceId?: string | null
    }

    const created = await createStudioStory(payload.workspaceId ?? null)

    return NextResponse.json(created, { status: 201 })
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Story creation failed."
      },
      { status: 500 }
    )
  }
}
