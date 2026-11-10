import { NextResponse } from "next/server"
import { deleteStudioStory, saveStudioStory } from "@/lib/server/studio-story-service"
import type { StoryDocument } from "@/lib/story-schema"
import { studioAccessResponse } from "@/lib/server/studio-auth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function PUT(
  request: Request,
  context: { params: Promise<{ storyId: string }> }
) {
  const denied = studioAccessResponse(request.headers)
  if (denied) return denied
  try {
    const { storyId } = await context.params
    const story = (await request.json()) as StoryDocument

    if (!storyId || !story || typeof story !== "object" || story.id !== storyId) {
      return NextResponse.json(
        {
          error: "Story payload is invalid."
        },
        { status: 400 }
      )
    }

    const savedStory = await saveStudioStory(story)

    return NextResponse.json({
      savedAt: new Date().toISOString(),
      story: savedStory
    })
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Story save failed."
      },
      { status: 500 }
    )
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ storyId: string }> }
) {
  const denied = studioAccessResponse(request.headers)
  if (denied) return denied
  try {
    const { storyId } = await context.params

    if (!storyId) {
      return NextResponse.json(
        {
          error: "Story id is required."
        },
        { status: 400 }
      )
    }

    await deleteStudioStory(storyId)

    return NextResponse.json({
      deleted: true
    })
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Story delete failed."
      },
      { status: 500 }
    )
  }
}
