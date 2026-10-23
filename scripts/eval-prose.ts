// Generates fresh drafts for a fixed set of scenes so two pipeline versions can be
// compared blind with scripts/eval-compare.ts. Reads only; never writes to Supabase.
//
// npm run eval:prose -- --label baseline [--story <id>] [--scenes 6] [--model claude-sonnet-5-5]
import { mkdir, readFile, writeFile } from "node:fs/promises";
import Module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSceneContextPacket } from "@/lib/book-engine";
import type { StoryDocument, StoryScene } from "@/lib/story-schema";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
type ModuleWithResolver = typeof Module & {
  _resolveFilename: (
    request: string,
    parent: unknown,
    isMain: boolean,
    options: unknown
  ) => string;
};
const moduleWithResolver = Module as ModuleWithResolver;
const originalResolveFilename = moduleWithResolver._resolveFilename;

moduleWithResolver._resolveFilename = function (request, parent, isMain, options) {
  if (request === "server-only") {
    return path.join(__dirname, "server-only-stub.cjs");
  }

  return originalResolveFilename.call(this, request, parent, isMain, options);
};

const MIN_SCENE_WORDS = 300;
const PREVIOUS_ENDING_WORDS = 300;
const CONCURRENCY = 3;

type EvalSceneResult = {
  sceneId: string;
  sceneTitle: string;
  sceneSummary: string;
  previousSceneEnding: string;
  label: string;
  mode: string;
  warning: string | null;
  modelName: string | null;
  text: string;
  words: number;
  qualityScore: number | null;
  qualityIssues: string[];
  stages: Record<string, { status: string; inputTokens: number | null; outputTokens: number | null; durationMs: number | null }>;
};

main().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const label = args.label;

  if (!label || !/^[a-z0-9_-]+$/i.test(label)) {
    throw new Error("--label is required (letters, digits, - and _ only).");
  }

  const outputDir = path.join(process.cwd(), "outputs", "eval", label);
  const { listStudioStories, loadStudioStory, loadHumanEditExamplesForWorkspace } = await import(
    "@/lib/server/studio-story-service"
  );
  const { generateBookDraftJob } = await import("@/lib/server/book-job-service");

  // listStudioStories first: loadStudioStory bootstraps a new story when none exists.
  const stories = await listStudioStories();

  if (!stories.length) {
    throw new Error("No stories in Supabase; nothing to evaluate.");
  }

  const storyId = args.story ?? stories[0].id;

  if (!stories.some(function (entry) { return entry.id === storyId; })) {
    throw new Error(`Story ${storyId} not found. Available: ${stories.map(function (entry) { return `${entry.id} (${entry.title})`; }).join(", ")}`);
  }

  const story = (await loadStudioStory(storyId)) as StoryDocument;
  const sceneIds = await resolveSceneSelection(story, Number(args.scenes ?? 6));
  const humanEditExamples = (await loadHumanEditExamplesForWorkspace(story.workspaceId)).filter(function (example) {
    return example.learningStatus === "included";
  });
  const model = args.model ?? "claude-sonnet-5-5";

  await mkdir(outputDir, { recursive: true });
  console.log(`Story "${story.title}" · ${sceneIds.length} Szenen · Modell ${model} · Label ${label}`);

  await runWithConcurrency(sceneIds, CONCURRENCY, async function (sceneId) {
    const scenes = listScenes(story);
    const index = scenes.findIndex(function (scene) { return scene.id === sceneId; });
    const scene = scenes[index];
    const startedAt = Date.now();
    const execution = await generateBookDraftJob({
      story,
      sceneId,
      provider: "anthropic",
      modelOverrides: { anthropic: model },
      humanEditExamples
    });
    const job = execution.job;
    const text = job.rewriteText || job.draftText;
    const result: EvalSceneResult = {
      sceneId,
      sceneTitle: scene.title,
      sceneSummary: scene.summary,
      previousSceneEnding: lastWords(sceneText(scenes[index - 1]), PREVIOUS_ENDING_WORDS),
      label,
      mode: execution.mode,
      warning: execution.warning ?? null,
      modelName: job.modelName,
      text,
      words: countWords(text),
      qualityScore: job.stages.quality_eval.qualityScore ?? null,
      qualityIssues: job.stages.quality_eval.qualityIssues ?? [],
      stages: Object.fromEntries(
        Object.entries(job.stages).map(function ([name, stage]) {
          return [
            name,
            {
              status: stage.status,
              inputTokens: stage.inputTokens,
              outputTokens: stage.outputTokens,
              durationMs: stage.durationMs
            }
          ];
        })
      )
    };

    await writeFile(path.join(outputDir, `${sceneId}.json`), JSON.stringify(result, null, 2));
    console.log(
      `${execution.mode === "remote" ? "ok " : "FALLBACK"} ${scene.title} · ${result.words} Wörter · Note ${result.qualityScore ?? "-"} · ${Math.round((Date.now() - startedAt) / 1000)} s`
    );
  });

  console.log(`Fertig: ${outputDir}`);
}

async function resolveSceneSelection(currentStory: StoryDocument, count: number) {
  // The first run fixes the scene set in outputs/eval/scenes-<storyId>.json so every
  // later label is generated for exactly the same scenes.
  const selectionFile = path.join(process.cwd(), "outputs", "eval", `scenes-${currentStory.id}.json`);

  try {
    return JSON.parse(await readFile(selectionFile, "utf8")) as string[];
  } catch {
    const scenes = listScenes(currentStory);
    const candidates = scenes.filter(function (scene, index) {
      return index > 0 &&
        countWords(sceneText(scene)) >= MIN_SCENE_WORDS &&
        countWords(sceneText(scenes[index - 1])) >= MIN_SCENE_WORDS &&
        Boolean(buildSceneContextPacket(currentStory, scene.id));
    });

    if (!candidates.length) {
      throw new Error("No scene with prose that follows another scene with prose.");
    }

    const step = Math.max(1, candidates.length / Math.min(count, candidates.length));
    const selection = Array.from({ length: Math.min(count, candidates.length) }, function (_, index) {
      return candidates[Math.floor(index * step)].id;
    });

    await mkdir(path.dirname(selectionFile), { recursive: true });
    await writeFile(selectionFile, JSON.stringify(selection, null, 2));

    return selection;
  }
}

function listScenes(currentStory: StoryDocument): StoryScene[] {
  return currentStory.acts.flatMap(function (act) {
    return act.chapters.flatMap(function (chapter) {
      return chapter.scenes;
    });
  });
}

function sceneText(scene: StoryScene | undefined) {
  return (scene?.blocks ?? []).map(function (block) { return block.text.trim(); }).filter(Boolean).join("\n\n");
}

function lastWords(value: string, count: number) {
  const words = value.split(/\s+/).filter(Boolean);

  return words.slice(Math.max(0, words.length - count)).join(" ");
}

function countWords(value: string) {
  return value.split(/\s+/).filter(Boolean).length;
}

async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
  const queue = items.slice();
  const failures: string[] = [];

  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async function () {
      while (queue.length) {
        const item = queue.shift() as T;

        try {
          await worker(item);
        } catch (error) {
          failures.push(`${String(item)}: ${error instanceof Error ? error.message : String(error)}`);
          console.error(`FEHLER ${String(item)}`, error);
        }
      }
    })
  );

  if (failures.length) {
    throw new Error(`${failures.length} Szene(n) fehlgeschlagen:\n${failures.join("\n")}`);
  }
}

function parseArgs(values: string[]) {
  const parsed: Record<string, string> = {};

  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];

    if (key.startsWith("--") && values[index + 1] !== undefined) {
      parsed[key.slice(2)] = values[index + 1];
      index += 1;
    }
  }

  return parsed as { label?: string; story?: string; scenes?: string; model?: string };
}
