import { NextResponse } from "next/server";
import { generateStoryChat } from "@/lib/server/story-chat-service";
import { studioAccessResponse } from "@/lib/server/studio-auth";
import type {
  AssistantContextSelection,
  AssistantModelSelection,
  AssistantOutputMode,
  AssistantProvider,
  StoryDocument
} from "@/lib/story-schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const denied = studioAccessResponse(request.headers);
  if (denied) return denied;
  try {
    const body = (await request.json()) as {
      story?: StoryDocument;
      threadId?: string;
      provider?: AssistantProvider;
      modelSelection?: AssistantModelSelection;
      outputMode?: AssistantOutputMode;
      contextSelection?: AssistantContextSelection;
    };

    if (!body.story || !body.threadId) {
      return NextResponse.json(
        {
          error: "story und threadId sind erforderlich."
        },
        { status: 400 }
      );
    }

    const result = await generateStoryChat({
      story: body.story,
      threadId: body.threadId,
      provider: body.provider,
      modelSelection: body.modelSelection,
      outputMode: body.outputMode,
      contextSelection: body.contextSelection
    });

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Story-Chat fehlgeschlagen."
      },
      { status: 500 }
    );
  }
}
