import { NextResponse } from "next/server";
import type { BookJobModelOverrides } from "@/lib/book-job-models";
import { generateBookDraftJob, type BookJobProvider } from "@/lib/server/book-job-service";
import { loadHumanEditExamplesForWorkspace } from "@/lib/server/studio-story-service";
import type { SceneContextPacket } from "@/lib/book-engine";
import type { StoryDocument } from "@/lib/story-schema";
import { studioAccessResponse } from "@/lib/server/studio-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const denied = studioAccessResponse(request.headers);
  if (denied) return denied;
  try {
    const body = (await request.json()) as {
      story?: StoryDocument;
      workspaceId?: string;
      sceneId?: string;
      packet?: SceneContextPacket;
      provider?: BookJobProvider;
      modelOverrides?: BookJobModelOverrides;
      targetSceneWordsMin?: number;
      targetSceneWordsMax?: number;
      directorNote?: string;
      humanEditLearningStatuses?: Array<{
        id: string;
        learningStatus: "included" | "excluded" | "needs_review";
      }>;
    };

    if (!body.sceneId || (!body.packet && !body.story)) {
      return NextResponse.json(
        {
          error: "sceneId and packet or story are required"
        },
        { status: 400 }
      );
    }

    const workspaceId = body.workspaceId || body.story?.workspaceId || "";
    const humanEditExamples = workspaceId
      ? await loadHumanEditExamplesForWorkspace(workspaceId)
      : [];
    const learningStatusesById = new Map(
      (body.humanEditLearningStatuses ?? []).map(function (entry) {
        return [entry.id, entry.learningStatus] as const;
      })
    );
    const effectiveHumanEditExamples = humanEditExamples.map(function (example) {
      const learningStatus = learningStatusesById.get(example.id);

      return learningStatus
        ? {
            ...example,
            learningStatus
          }
        : example;
    }).filter(function (example) {
      return example.learningStatus === "included";
    });

    const result = await generateBookDraftJob({
      story: body.story,
      sceneId: body.sceneId,
      packet: body.packet,
      provider: body.provider,
      modelOverrides: body.modelOverrides,
      targetSceneWordsMin: body.targetSceneWordsMin,
      targetSceneWordsMax: body.targetSceneWordsMax,
      directorNote: body.directorNote,
      humanEditExamples: effectiveHumanEditExamples
    });

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Book job generation failed."
      },
      { status: 500 }
    );
  }
}
