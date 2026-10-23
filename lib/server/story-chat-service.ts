import "server-only";

import { execFile } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import {
  analyzeBookDraftReadiness,
  buildSceneContextPacket,
  getDraftJobsForScene
} from "@/lib/book-engine";
import {
  DEFAULT_BOOK_JOB_MODELS,
  resolveBookJobModelValue
} from "@/lib/book-job-models";
import type {
  AssistantArtifactKind,
  AssistantContextSelection,
  AssistantModelSelection,
  AssistantOutputMode,
  AssistantProvider,
  StoryDocument
} from "@/lib/story-schema";
import {
  countWords,
  createDefaultAssistantContextSelection,
  getAllScenes
} from "@/lib/story-schema";

const STORY_CHAT_THREAD_TITLE_MAX = 80;
const STORY_CHAT_ARTIFACT_TITLE_MAX = 120;
const STORY_CHAT_ARTIFACT_SUMMARY_MAX = 240;

const storyChatSchema = z.object({
  reply: z.string().min(40),
  suggestedThreadTitle: z.string().min(3).optional(),
  artifact: z
    .object({
      title: z.string().min(3),
      kind: z.string().min(1),
      summary: z.string().min(3),
      content: z.string().min(80)
    })
    .nullable()
});

type RawStoryChatPayload = z.infer<typeof storyChatSchema>;
type StoryChatPayload = {
  reply: string;
  suggestedThreadTitle?: string;
  artifact: {
    title: string;
    kind: AssistantArtifactKind;
    summary: string;
    content: string;
  } | null;
};
type RemoteStoryChatProvider = "openai" | "anthropic";
type StoryChatDraftJob = StoryDocument["book"]["draftEngine"]["jobs"][number];
const DEFAULT_LOCAL_GEMMA_COMMAND = "/Users/bucci369/mlx-gemma4/.venv/bin/mlx_vlm.generate";
const DEFAULT_LOCAL_GEMMA_MODEL = "mlx-community/gemma-4-e4b-it-mxfp4";
const DEFAULT_LOCAL_GEMMA_SERVER_URL = "http://127.0.0.1:18080";

const STORY_CHAT_STAGE_ORDER = [
  "context",
  "beat_plan",
  "draft",
  "rewrite",
  "length_control",
  "extract",
  "continuity",
  "quality_eval"
] as const;

export type StoryChatExecution = {
  provider: Exclude<AssistantProvider, "auto">;
  mode: "remote" | "local_fallback";
  modelName: string | null;
  reply: string;
  suggestedThreadTitle?: string;
  artifact?: {
    title: string;
    kind: AssistantArtifactKind;
    summary: string;
    content: string;
  };
  warning?: string;
};

export async function generateStoryChat(params: {
  story: StoryDocument;
  threadId: string;
  provider?: AssistantProvider;
  modelSelection?: AssistantModelSelection;
  outputMode?: AssistantOutputMode;
  contextSelection?: AssistantContextSelection;
}): Promise<StoryChatExecution> {
  const provider = params.provider ?? "auto";
  const outputMode = params.outputMode ?? "chat";
  const thread = params.story.assistant.threads.find(function (candidate) {
    return candidate.id === params.threadId;
  });

  if (!thread) {
    throw new Error("Assistant-Thread konnte nicht gefunden werden.");
  }

  if (!thread.messages.length) {
    throw new Error("Der Assistant-Thread enthält noch keine Nachricht.");
  }

  const contextSelection =
    params.contextSelection ?? thread.context ?? createDefaultAssistantContextSelection();

  if (provider === "local") {
    try {
      const payload = await generateWithLocalGemma(
        params.story,
        thread.id,
        outputMode,
        contextSelection
      );

      return {
        provider: "local",
        mode: "local_fallback",
        modelName: payload.modelName,
        reply: payload.data.reply,
        suggestedThreadTitle: payload.data.suggestedThreadTitle,
        artifact: payload.data.artifact ?? undefined
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Lokales Gemma-Modell konnte nicht ausgeführt werden.";

      if (outputMode === "regie") {
        throw new Error(`Gemma-Regie-Test fehlgeschlagen. Kein lokaler Template-Fallback wurde erzeugt: ${message}`);
      }

      return createLocalExecution(
        params.story,
        thread.id,
        outputMode,
        contextSelection,
        `Gemma lokal fehlgeschlagen; deterministischer lokaler Fallback verwendet. ${message}`
      );
    }
  }

  const remoteProvider = resolveRemoteProvider(provider);

  if (!remoteProvider) {
    if (outputMode === "regie") {
      throw new Error("Regie-Erstellung braucht einen aktiven OPENAI_API_KEY oder ANTHROPIC_API_KEY. Lokaler Fallback ist für Regie deaktiviert.");
    }

    return createLocalExecution(
      params.story,
      thread.id,
      outputMode,
      contextSelection,
      "Kein OPENAI_API_KEY oder ANTHROPIC_API_KEY gesetzt; lokaler Fallback verwendet."
    );
  }

  try {
    const payload =
      remoteProvider === "openai"
        ? await generateWithOpenAI(
            params.story,
            thread.id,
            outputMode,
            contextSelection,
            params.modelSelection
          )
        : await generateWithAnthropic(
            params.story,
            thread.id,
            outputMode,
            contextSelection,
            params.modelSelection
          );

    return {
      provider: remoteProvider,
      mode: "remote",
      modelName: payload.modelName,
      reply: payload.data.reply,
      suggestedThreadTitle: payload.data.suggestedThreadTitle,
      artifact: payload.data.artifact ?? undefined
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Story-Chat konnte nicht remote erzeugt werden.";

    if (outputMode === "regie") {
      throw new Error(`Regie-Erstellung über ${remoteProvider} fehlgeschlagen. Kein lokaler Fallback: ${message}`);
    }

    return createLocalExecution(params.story, thread.id, outputMode, contextSelection, message);
  }
}

function resolveRemoteProvider(provider: AssistantProvider) {
  if (provider === "openai" && process.env.OPENAI_API_KEY) {
    return "openai" as const;
  }

  if (provider === "anthropic" && process.env.ANTHROPIC_API_KEY) {
    return "anthropic" as const;
  }

  if (provider === "auto") {
    if (process.env.OPENAI_API_KEY) {
      return "openai" as const;
    }

    if (process.env.ANTHROPIC_API_KEY) {
      return "anthropic" as const;
    }

  }

  return null;
}

async function generateWithOpenAI(
  story: StoryDocument,
  threadId: string,
  outputMode: AssistantOutputMode,
  contextSelection: AssistantContextSelection,
  modelSelection?: AssistantModelSelection
) {
  const modelName = resolveBookJobModelValue(
    modelSelection?.openai,
    process.env.OPENAI_STORY_CHAT_MODEL,
    DEFAULT_BOOK_JOB_MODELS.openai
  );
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });
  const response = await client.responses.parse({
    model: modelName,
    store: false,
    reasoning: {
      effort: "medium"
    },
    input: [
      {
        role: "system",
        content: buildSystemPrompt(story, outputMode)
      },
      {
        role: "user",
        content: buildUserPrompt(story, threadId, outputMode, contextSelection)
      }
    ],
    text: {
      format: zodTextFormat(storyChatSchema, "ember_story_chat")
    }
  });

  if (!response.output_parsed) {
    throw new Error("OpenAI lieferte keine strukturierte Antwort.");
  }

  return {
    modelName,
    data: normalizeStoryChatPayload(response.output_parsed, outputMode)
  };
}

async function generateWithAnthropic(
  story: StoryDocument,
  threadId: string,
  outputMode: AssistantOutputMode,
  contextSelection: AssistantContextSelection,
  modelSelection?: AssistantModelSelection
) {
  const modelName = resolveBookJobModelValue(
    modelSelection?.anthropic,
    process.env.ANTHROPIC_STORY_CHAT_MODEL,
    DEFAULT_BOOK_JOB_MODELS.anthropic
  );
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY
  });
  const message = await client.messages.parse({
    model: modelName,
    max_tokens: 8200,
    system: buildAnthropicSystemPrompt(story, outputMode),
    messages: [
      {
        role: "user",
        content: buildUserPrompt(story, threadId, outputMode, contextSelection)
      }
    ],
    output_config: {
      format: zodOutputFormat(storyChatSchema)
    }
  });

  if (!message.parsed_output) {
    throw new Error("Anthropic lieferte keine strukturierte Antwort.");
  }

  return {
    modelName,
    data: normalizeStoryChatPayload(message.parsed_output, outputMode)
  };
}

async function generateWithLocalGemma(
  story: StoryDocument,
  threadId: string,
  outputMode: AssistantOutputMode,
  contextSelection: AssistantContextSelection
) {
  const command = process.env.LOCAL_GEMMA_COMMAND || DEFAULT_LOCAL_GEMMA_COMMAND;
  const modelName = process.env.LOCAL_GEMMA_MODEL || DEFAULT_LOCAL_GEMMA_MODEL;
  const maxTokens = process.env.LOCAL_GEMMA_MAX_TOKENS || (outputMode === "regie" ? "2200" : outputMode === "note" ? "1200" : "900");
  const temperature = process.env.LOCAL_GEMMA_TEMPERATURE || "0.35";
  const prompt = buildLocalGemmaUserPrompt(story, threadId, outputMode, contextSelection);
  const systemPrompt = buildLocalGemmaSystemPrompt(outputMode);
  const serverUrl = normalizeLocalGemmaServerUrl(
    process.env.LOCAL_GEMMA_SERVER_URL ?? DEFAULT_LOCAL_GEMMA_SERVER_URL
  );
  let reply = "";

  if (serverUrl) {
    try {
      reply = await requestLocalGemmaServer({
        serverUrl,
        modelName,
        systemPrompt,
        prompt,
        maxTokens,
        temperature
      });
    } catch (error) {
      if (process.env.LOCAL_GEMMA_SERVER_ONLY === "true") {
        throw error;
      }
    }
  }

  if (!reply) {
    const rawOutput = await execLocalGemma(command, [
      "--model",
      modelName,
      "--system",
      systemPrompt,
      "--prompt",
      prompt,
      "--max-tokens",
      maxTokens,
      "--temperature",
      temperature,
      "--skip-special-tokens"
    ]);
    reply = normalizeLocalGemmaOutput(rawOutput);
  }

  if (reply.length < (outputMode === "chat" ? 3 : 20)) {
    throw new Error("Gemma lieferte keine verwertbare Antwort.");
  }

  const data: StoryChatPayload = {
    reply: outputMode === "regie"
      ? "Gemma lokal hat eine Roh-Regie-Vorlage erzeugt. Bitte gegen Regie_Anleitung.md und per Dry-Run prüfen, bevor sie importiert wird."
      : outputMode === "note"
        ? "Gemma lokal hat eine Arbeitsnotiz erzeugt. Nutze sie als Vorarbeit, nicht als finalen Pipeline-Vertrag."
      : reply,
    suggestedThreadTitle: deriveLocalThreadTitle(
      getLastUserMessage(story, threadId),
      outputMode === "regie" ? "Gemma Regie" : outputMode === "note" ? "Gemma Notiz" : "Gemma"
    ),
    artifact: outputMode !== "chat"
      ? {
          title: outputMode === "regie"
            ? `Gemma-Regie-Vorlage — ${story.title}`
            : `Gemma-Notiz — ${story.title}`,
          kind: outputMode === "regie" ? "regie" : "note",
          summary: outputMode === "regie"
            ? "Lokale Roh-Regie-Vorlage aus Gemma; vor Import gegen Regie_Anleitung.md prüfen."
            : "Lokale Arbeitsnotiz aus Gemma; für Brainstorming und Vorstrukturierung gedacht.",
          content: reply
        }
      : null
  };

  return {
    modelName,
    data: normalizeStoryChatPayload(data, outputMode)
  };
}

function normalizeLocalGemmaServerUrl(value: string | undefined) {
  const trimmed = value?.trim() ?? "";

  if (!trimmed || trimmed === "0" || trimmed.toLowerCase() === "false" || trimmed.toLowerCase() === "off") {
    return null;
  }

  return trimmed.replace(/\/+$/, "");
}

async function requestLocalGemmaServer(params: {
  serverUrl: string;
  modelName: string;
  systemPrompt: string;
  prompt: string;
  maxTokens: string;
  temperature: string;
}) {
  const controller = new AbortController();
  const timeout = setTimeout(function () {
    controller.abort();
  }, Number(process.env.LOCAL_GEMMA_SERVER_TIMEOUT_MS || 60000));

  try {
    const response = await fetch(`${params.serverUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: params.modelName,
        messages: [
          {
            role: "system",
            content: params.systemPrompt
          },
          {
            role: "user",
            content: params.prompt
          }
        ],
        max_tokens: Number(params.maxTokens),
        temperature: Number(params.temperature)
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Gemma Server HTTP ${response.status}: ${await response.text()}`);
    }

    const payload = await response.json() as {
      choices?: Array<{
        message?: {
          content?: unknown;
        };
      }>;
    };
    const content = payload.choices?.[0]?.message?.content;

    if (typeof content !== "string" || !content.trim()) {
      throw new Error("Gemma Server lieferte keine Chat-Completion-Antwort.");
    }

    return stripLocalGemmaMetaNotes(content.trim());
  } finally {
    clearTimeout(timeout);
  }
}

function execLocalGemma(command: string, args: string[]) {
  return new Promise<string>(function (resolve, reject) {
    execFile(
      command,
      args,
      {
        timeout: Number(process.env.LOCAL_GEMMA_TIMEOUT_MS || 180000),
        maxBuffer: 1024 * 1024 * 8
      },
      function (error, stdout, stderr) {
        if (error) {
          const detail = [error.message, stderr].filter(Boolean).join("\n").trim();
          reject(new Error(detail || "MLX-Prozess fehlgeschlagen."));
          return;
        }

        resolve([stdout, stderr].filter(Boolean).join("\n"));
      }
    );
  });
}

function buildLocalGemmaSystemPrompt(outputMode: AssistantOutputMode) {
  return [
    "Du bist Gemma lokal im EMBER Studio.",
    "Antworte auf Deutsch.",
    "Deine Rolle: Vorarbeit, Brainstorming, Sortierung und Rohentwurf.",
    "Gib nur die Antwort aus. Keine Selbstnotizen, keine Klammer-Kommentare, keine 'Anmerkung für mich', keine Gedankenprotokolle.",
    "Erfinde keine harten Canon-Fakten. Markiere Lücken klar.",
    "Finale Pipeline-Kompatibilität muss später geprüft werden.",
    outputMode === "regie"
      ? "Erzeuge Markdown als Roh-Regie-Vorlage nach der neuen EMBER-Struktur. Kennzeichne unsichere Stellen."
      : outputMode === "note"
        ? "Erzeuge eine kompakte Markdown-Arbeitsnotiz mit Entscheidungen, Risiken und nächsten Schritten."
        : "Antworte kompakt mit konkreten Listen, Entscheidungen und nächsten Schritten."
  ].join("\n");
}

function buildLocalGemmaUserPrompt(
  story: StoryDocument,
  threadId: string,
  outputMode: AssistantOutputMode,
  contextSelection: AssistantContextSelection
) {
  const thread = story.assistant.threads.find(function (candidate) {
    return candidate.id === threadId;
  });
  const recentMessages = (thread?.messages ?? []).slice(-6).map(function (message) {
    return `${message.role === "assistant" ? "ASSISTANT" : "USER"}: ${trimPromptText(message.content, 900)}`;
  });
  const scopedScenes = getScopedSceneContexts(story, contextSelection).slice(0, 10);
  const sceneLines = scopedScenes.map(function (sceneContext) {
    return `- ${sceneContext.sceneTitle}: ${trimPromptText(sceneContext.summary || "", 180)}`;
  });
  const contextBlock = contextSelection.scope === "project"
    ? buildLocalGemmaProjectDigest(story)
    : [
        "AKTIVE SZENEN:",
        sceneLines.length ? sceneLines.join("\n") : "- Keine Szenen im aktiven Scope."
      ].join("\n");

  return [
    `OUTPUT_MODE: ${outputMode}`,
    `AKTIVER_KONTEXT: ${buildContextLabel(story, contextSelection) || "Gesamtprojekt"}`,
    "",
    "PROJEKT:",
    `Titel: ${story.title}`,
    `Genre: ${story.meta.genre || "nicht gesetzt"}`,
    `Prämisse: ${trimPromptText(story.book.masterBrief.premise || "nicht gesetzt", 420)}`,
    `Reader Promise: ${trimPromptText(story.book.masterBrief.readerPromise || "nicht gesetzt", 360)}`,
    `Thematischer Kern: ${trimPromptText(story.book.masterBrief.thematicCore || "nicht gesetzt", 360)}`,
    `Author Intent: ${trimPromptText(story.book.masterBrief.authorIntent || "nicht gesetzt", 300)}`,
    `Current Focus: ${trimPromptText(story.book.masterBrief.currentFocus || "nicht gesetzt", 300)}`,
    "",
    "WRITER CONSTITUTION AUSZUG:",
    formatPromptList(story.book.writerConstitution.slice(0, 8), "Keine Writer Constitution gesetzt.", 8),
    "",
    contextBlock,
    "",
    "LETZTE NACHRICHTEN:",
    recentMessages.length ? recentMessages.join("\n") : "- Keine bisherigen Nachrichten.",
    "",
    outputMode === "regie"
      ? [
          "AUFGABE:",
          "Erzeuge eine Roh-Regie-Vorlage als Markdown nach Regie_Anleitung.md.",
          "Nutze diese Hauptabschnitte: # EMBER Story Document, ## MASTER BRIEF, ## MARKET BRIEF, ## WRITER CONSTITUTION, ## WORLD BIBLE, ## CANON FACTS, ## CHARACTER STATE LEDGER, ## CONTINUITY GUARDRAILS, ## OPEN THREADS, ## LOSS LADDER / ACT MAP, ## ACTS & KAPITEL — SCENE CARDS.",
          "Canon Facts Kandidaten müssen als Kandidaten markiert bleiben.",
          "Scene Cards nur als einfache key: value Codeblöcke skizzieren.",
          "Markiere am Ende ## LÜCKEN VOR IMPORT."
        ].join("\n")
      : outputMode === "note"
        ? [
            "AUFGABE:",
            "Erzeuge eine kompakte Arbeitsnotiz als Markdown.",
            "Nutze diese Abschnitte: ## Entscheidungen, ## Risiken, ## Material, ## Offene Fragen, ## Nächste Schritte.",
            "Keine finale Regie-Datei bauen."
        ].join("\n")
      : [
    "AUFGABE:",
    "Beantworte die letzte Nutzerfrage. Nutze Gemma nur für Vorarbeit: sortieren, brainstormen, extrahieren, Varianten bilden.",
          "Gib bei harten Entscheidungen an, was später mit starkem Modell oder Dry-Run geprüft werden muss.",
          "Wenn die Nutzerfrage nur eine kurze Verfügbarkeitsfrage ist, antworte nur kurz und ohne Projektanalyse."
        ].join("\n")
  ].join("\n");
}

function buildLocalGemmaProjectDigest(story: StoryDocument) {
  const allScenes = getScopedSceneContexts(story, createDefaultAssistantContextSelection("project"));
  const scenesByAct = story.acts.map(function (act) {
    const actScenes = allScenes.filter(function (scene) {
      return scene.actId === act.id;
    });
    const firstScenes = actScenes.slice(0, 2);
    const lastScene = actScenes[actScenes.length - 1] ?? null;
    const representative = Array.from(new Set(
      firstScenes.concat(lastScene ? [lastScene] : []).map(function (scene) {
        return `${scene.sceneTitle}: ${trimPromptText(scene.summary || "", 120)}`;
      })
    ));

    return `${act.title}: ${actScenes.length} Szenen. ${representative.join(" | ") || "Keine Szenensummaries."}`;
  });
  const highCanon = story.book.memory.canonLedger
    .slice()
    .sort(function (left, right) {
      return scoreImportance(right.importance) - scoreImportance(left.importance) || right.mentionCount - left.mentionCount;
    })
    .slice(0, 8)
    .map(function (entry) {
      return `${entry.title} [${entry.kind}/${entry.status}]: ${trimPromptText(entry.summary, 180)}`;
    });
  const characters = story.book.memory.characterLedger
    .slice(0, 8)
    .map(function (entry) {
      return `${entry.characterName}: ${trimPromptText(entry.currentState, 130)} | Agenda: ${trimPromptText(entry.agenda, 110)}`;
    });
  const openThreads = story.book.memory.openThreads
    .slice()
    .sort(function (left, right) {
      return scoreOpenThread(right.status, right.priority) - scoreOpenThread(left.status, left.priority);
    })
    .slice(0, 8)
    .map(function (thread) {
      return `${thread.label} [${thread.status}/${thread.priority}]: ${trimPromptText(thread.detail, 170)}`;
    });
  const acceptedJobs = story.book.draftEngine.jobs.filter(function (job) {
    return job.status === "accepted";
  }).length;
  const latestJobs = story.book.draftEngine.jobs
    .slice()
    .sort(function (left, right) {
      return right.updatedAt.localeCompare(left.updatedAt);
    })
    .slice(0, 5)
    .map(function (job) {
      return `${job.sceneTitle}: ${job.status}, ${job.provider}${job.modelName ? `/${job.modelName}` : ""}, ${countWords(job.rewriteText)} Wörter`;
    });

  return [
    "LOKALER PROJEKT-DIGEST FUER GEMMA:",
    "Hinweis: Dies ist eine verdichtete Übersicht. Für finale Canon-/Regie-Entscheidungen später starkes Modell oder Dry-Run nutzen.",
    "",
    "## Core",
    `Premise: ${trimPromptText(story.book.masterBrief.premise || "nicht gesetzt", 420)}`,
    `Reader Promise: ${trimPromptText(story.book.masterBrief.readerPromise || "nicht gesetzt", 320)}`,
    `Thematic Core: ${trimPromptText(story.book.masterBrief.thematicCore || "nicht gesetzt", 260)}`,
    `Author Intent: ${trimPromptText(story.book.masterBrief.authorIntent || "nicht gesetzt", 240)}`,
    `Current Focus: ${trimPromptText(story.book.masterBrief.currentFocus || "nicht gesetzt", 240)}`,
    "",
    "## Pressure / Market",
    `Hook: ${trimPromptText(story.book.marketBrief.hook || "nicht gesetzt", 280)}`,
    `Category: ${trimPromptText(story.book.marketBrief.categoryLane || "nicht gesetzt", 180)}`,
    `Narrative Intent: ${trimPromptText(story.book.memory.proseTechniqueProfile.narrativeIntent || "nicht gesetzt", 240)}`,
    "",
    "## Key Canon",
    formatPromptList(highCanon, "Keine Canon-Ledger-Einträge.", 8),
    "",
    "## Characters",
    formatPromptList(characters, "Keine Character States.", 8),
    "",
    "## Open Threads",
    formatPromptList(openThreads, "Keine Open Threads.", 8),
    "",
    "## Act Map / Representative Scenes",
    formatPromptList(scenesByAct, "Keine Acts/Szenen.", 6),
    "",
    "## Draft State",
    `Draft jobs: ${story.book.draftEngine.jobs.length}, accepted: ${acceptedJobs}, total scenes: ${allScenes.length}`,
    formatPromptList(latestJobs, "Noch keine Draft-Jobs.", 5)
  ].join("\n");
}

function scoreImportance(value: StoryDocument["book"]["memory"]["canonLedger"][number]["importance"]) {
  return value === "high" ? 3 : value === "medium" ? 2 : 1;
}

function normalizeLocalGemmaOutput(output: string) {
  const withoutProgress = output
    .replace(/\r/g, "\n")
    .split("\n")
    .filter(function (line) {
      return !line.includes("Fetching ") && !line.includes("it/s]");
    })
    .join("\n")
    .trim();
  const modelMatch = withoutProgress.match(/<\|turn\>model\s*\n+([\s\S]*?)\n=+\s*(?:Prompt:|$)/);

  if (modelMatch?.[1]) {
    return stripLocalGemmaMetaNotes(modelMatch[1].trim());
  }

  const sections = withoutProgress.split("==========").map(function (section) {
    return section.trim();
  }).filter(Boolean);
  const responseSection = sections.find(function (section) {
    return section.includes("<|turn>model");
  });

  if (responseSection) {
    const parts = responseSection.split("<|turn>model");
    return stripLocalGemmaMetaNotes((parts[1] ?? responseSection)
      .replace(/^Prompt:.*$/gm, "")
      .trim());
  }

  return stripLocalGemmaMetaNotes(withoutProgress
    .replace(/^Files:.*$/gm, "")
    .replace(/^Prompt:.*$/gm, "")
    .replace(/^Generation:.*$/gm, "")
    .replace(/^Peak memory:.*$/gm, "")
    .trim());
}

function stripLocalGemmaMetaNotes(text: string) {
  return text
    .replace(/\n+\s*\*?\(?Anmerkung für mich:[\s\S]*$/i, "")
    .replace(/\n+\s*\*?\(?Hinweis an mich:[\s\S]*$/i, "")
    .replace(/\n+\s*\*?\(?Gedankenprotokoll:[\s\S]*$/i, "")
    .replace(/\n+\s*\*?\(?Interne Notiz:[\s\S]*$/i, "")
    .trim();
}

function normalizeStoryChatPayload(
  payload: RawStoryChatPayload,
  outputMode: AssistantOutputMode
): StoryChatPayload {
  const suggestedThreadTitle = clampOptionalText(
    payload.suggestedThreadTitle,
    STORY_CHAT_THREAD_TITLE_MAX
  );

  if (outputMode === "chat" || !payload.artifact) {
    return {
      reply: payload.reply,
      suggestedThreadTitle,
      artifact: null
    };
  }

  const kind = normalizeArtifactKind(payload.artifact.kind, outputMode);

  return {
    reply: payload.reply,
    suggestedThreadTitle,
    artifact: {
      title: clampRequiredText(payload.artifact.title, STORY_CHAT_ARTIFACT_TITLE_MAX, "Assistant Artifact"),
      kind,
      summary: clampRequiredText(payload.artifact.summary, STORY_CHAT_ARTIFACT_SUMMARY_MAX, "Arbeitsdokument"),
      content: payload.artifact.content
    }
  };
}

function normalizeArtifactKind(value: string, outputMode: AssistantOutputMode): AssistantArtifactKind {
  if (outputMode === "regie") {
    return "regie";
  }

  if (outputMode === "note") {
    return "note";
  }

  const normalized = value.trim().toLowerCase();

  if (normalized === "regie" || normalized === "regie-vorlage") {
    return "regie";
  }

  return "note";
}

function clampOptionalText(value: string | undefined, maxLength: number) {
  const trimmed = value?.replace(/\s+/g, " ").trim();

  if (!trimmed) {
    return undefined;
  }

  return clampRequiredText(trimmed, maxLength, "");
}

function clampRequiredText(value: string, maxLength: number, fallback: string) {
  const trimmed = value.replace(/\s+/g, " ").trim() || fallback;

  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function getLastUserMessage(story: StoryDocument, threadId: string) {
  const thread = story.assistant.threads.find(function (candidate) {
    return candidate.id === threadId;
  });

  return [...(thread?.messages ?? [])].reverse().find(function (message) {
    return message.role === "user";
  })?.content ?? "";
}

function buildSystemPrompt(story: StoryDocument, outputMode: AssistantOutputMode) {
  const modeInstruction = getAssistantOutputModeInstructions(outputMode);

  return [
    "Du bist die integrierte Story-Assistentin von EMBER Studio.",
    "Antworte standardmäßig auf Deutsch.",
    "Unterscheide klar zwischen festgehaltenem Projektstand, Vorschlag, Variante, Lücke und harter Canon-Entscheidung.",
    "Behandle Brainstorming nicht automatisch als Canon. Canon entsteht nur, wenn der Nutzer es ausdrücklich festhalten, speichern, übernehmen oder als gesetzt markieren will.",
    "Nutze nur den gegebenen Projektkontext. Wenn etwas fehlt, markiere die Lücke knapp statt zu halluzinieren.",
    "Dein Output muss sofort in einen professionellen Schreib-Workflow passen.",
    ...modeInstruction,
    `Projektmodus: ${story.mode === "book" ? "Buch" : "Branching"}.`
  ].join("\n");
}

function getAssistantOutputModeInstructions(outputMode: AssistantOutputMode) {
  if (outputMode === "regie") {
    return [
      "REGIE-MODUS IST KEIN NORMALER CHAT: Erzeuge ein importnahes Arbeitsdokument, nicht nur Rat oder Brainstorming.",
      "Sichere zuerst vorhandene Fakten aus dem Kontext. Markiere etwas nur als Lücke, wenn es im Kontext wirklich nicht vorhanden ist.",
      "Wenn eine Angabe teilweise vorhanden ist, übernimm den vorhandenen Stand und markiere nur die fehlende Präzisierung.",
      "Verwandle konkrete vorhandene Details nie wieder in generische Lücken.",
      "Wenn du ein Dokument erzeugst, baue eine EMBER-Regie-Vorlage nach der aktuellen Regie_Anleitung.md-Logik.",
      "Die Regie-Vorlage ist ein Rohentwurf für späteren Import, kein alter Regiebrief.",
      "Nutze die echten Pipeline-Sektionen: MASTER BRIEF, MARKET BRIEF, WRITER CONSTITUTION, WORLD BIBLE, CANON FACTS, CHARACTER STATE LEDGER, CONTINUITY GUARDRAILS, OPEN THREADS, LOSS LADDER / ACT MAP, ACTS & KAPITEL — SCENE CARDS.",
      "Scene Cards müssen als einfache key: value Codeblöcke gedacht werden. Keine YAML-Listen, keine verschachtelten reviewOnly-Felder.",
      "Trenne harte Canon-Kandidaten, weiche Scene-Intention und Review-only Material sauber.",
      "Markiere Lücken vor Import explizit."
    ];
  }

  if (outputMode === "note") {
    return [
      "Erzeuge eine interne Arbeitsnotiz, keinen Regie-Importvertrag.",
      "Arbeite mit klaren Entscheidungen, Risiken, Material, offenen Fragen und nächsten Schritten.",
      "Halte harte Canon- oder Pipeline-Entscheidungen als Prüfpunkt fest, wenn sie nicht sicher aus dem Kontext folgen."
    ];
  }

  return [
    "Arbeite wie ein präziser Story-Strategist und Editor.",
    "Gib keine Watte, sondern klare Hebel, Risiken und nächste Schritte.",
    "Wenn der Nutzer kreativ sucht, biete wenige starke Optionen statt langer Lists.",
    "Wenn der Nutzer etwas festhalten will, formuliere es sauber und eindeutig als Projektstand."
  ];
}

function buildAnthropicSystemPrompt(story: StoryDocument, outputMode: AssistantOutputMode) {
  return [
    {
      type: "text" as const,
      text: buildSystemPrompt(story, outputMode)
    }
  ];
}

function buildUserPrompt(
  story: StoryDocument,
  threadId: string,
  outputMode: AssistantOutputMode,
  contextSelection: AssistantContextSelection
) {
  const thread = story.assistant.threads.find(function (candidate) {
    return candidate.id === threadId;
  });
  const recentMessages = (thread?.messages ?? []).slice(-8).map(function (message) {
    return `${message.role === "assistant" ? "ASSISTANT" : "USER"}: ${trimPromptText(message.content, 1400)}`;
  });
  const projectContext = buildAssistantProjectContextPrompt(story, contextSelection);

  return [
    `OUTPUT_MODE: ${outputMode}`,
    `CONTEXT_SCOPE: ${contextSelection.scope}`,
    `AKTIVER_KONTEXT: ${buildContextLabel(story, contextSelection)}`,
    "",
    "PROJECT_CONTEXT:",
    projectContext,
    "",
    "LETZTE NACHRICHTEN:",
    recentMessages.length ? recentMessages.join("\n") : "- Keine bisherigen Nachrichten.",
    "",
    "LIEFERE JSON im vereinbarten Schema.",
    "suggestedThreadTitle muss kurz sein: maximal 80 Zeichen, kein Satz, kein Untertitel.",
    "Nutze PROJECT_CONTEXT als Quelle der Wahrheit: Blueprint, Memory, Pipeline und aktiver Scope sind wichtiger als allgemeine Schreibratschläge.",
    "Wenn die Nutzerfrage unklar ist, antworte trotzdem hilfreich aus dem aktiven Scope und markiere die wichtigste fehlende Entscheidung.",
    "Wenn OUTPUT_MODE chat ist, muss artifact null sein.",
    "Kennzeichne neue Ideen klar als Vorschlag/Variante, solange der Nutzer sie nicht ausdrücklich festhält.",
    "Wenn der Nutzer 'festhalten', 'speichern', 'übernehmen' oder ähnlich sagt, formuliere die Änderung als sauberen Projektstand und vermeide parallele Alternativen.",
    "Wenn OUTPUT_MODE note ist, erzeuge ein kompaktes Markdown-Artifact mit kind exakt note.",
    "Wenn OUTPUT_MODE note ist, muss artifact.content diese Abschnitte enthalten: ## Entscheidungen, ## Risiken, ## Material, ## Offene Fragen, ## Nächste Schritte.",
    "Wenn OUTPUT_MODE regie ist, erzeuge ein Markdown-Artifact mit kind exakt regie.",
    "Wenn OUTPUT_MODE regie ist, muss artifact.content die neue Regie-Vorlagenstruktur anlegen: # EMBER Story Document, ## MASTER BRIEF, ## MARKET BRIEF, ## WRITER CONSTITUTION, ## WORLD BIBLE, ## CANON FACTS, ## CHARACTER STATE LEDGER, ## CONTINUITY GUARDRAILS, ## OPEN THREADS, ## LOSS LADDER / ACT MAP, ## ACTS & KAPITEL — SCENE CARDS, ## LÜCKEN VOR IMPORT.",
    "Wenn OUTPUT_MODE regie ist, sichere alle vorhandenen konkreten Angaben aus PROJECT_CONTEXT, bevor du Lücken benennst.",
    "Wenn OUTPUT_MODE regie ist, darfst du Hook, Setting, Figuren, Kräfte, Regeln, Organisation, Mentor, Unfallmechanik oder Act-Material nicht als Lücke markieren, wenn PROJECT_CONTEXT dazu bereits verwertbare Angaben enthält.",
    "Wenn OUTPUT_MODE regie ist, formuliere teilweise vorhandene Angaben als Arbeitsstand plus gezielte offene Präzisierung.",
    "Wenn OUTPUT_MODE regie ist, sind Canon Facts und Scene Cards Rohentwurf/Kandidaten, bis ein Dry-Run sie geprüft hat.",
    "Wenn du eine Lücke benennst, sage explizit, ob sie heute ein echter Datenmodell- oder Persistenzmangel ist oder nur ein geplanter Ausbau laut Struktur.",
    "Der reply-Text bleibt knapp und sagt, was du entschieden oder erzeugt hast."
  ].join("\n");
}

function buildAssistantProjectContextPrompt(
  story: StoryDocument,
  contextSelection: AssistantContextSelection
) {
  const scopedScenes = getScopedSceneContexts(story, contextSelection);
  const scopedSceneIds = new Set(
    scopedScenes.map(function (sceneContext) {
      return sceneContext.sceneId;
    })
  );
  const sections: Array<string | null> = [
    buildProjectIdentityPrompt(story, scopedScenes.length),
    buildStableBriefPrompt(story),
    buildPipelineContextPrompt(story, scopedSceneIds),
    buildMemoryContextPrompt(story, scopedSceneIds),
    buildActiveScopeContextPrompt(story, contextSelection, scopedScenes),
    buildActiveScenePacketPrompt(story, contextSelection),
    buildAssistantWorkspaceMemoryPrompt(story)
  ];

  return sections.filter(Boolean).join("\n\n");
}

function buildProjectIdentityPrompt(story: StoryDocument, scopedSceneCount: number) {
  const allScenes = getAllScenes(story);
  const totalWords = allScenes.reduce(function (sum, scene) {
    return sum + getSceneTextWordCount(scene);
  }, 0);

  return [
    "## Project Identity",
    `Title: ${formatPromptValue(story.title)}`,
    `Author: ${formatPromptValue(story.authorName)}`,
    `Status: ${story.status}`,
    `Mode: ${story.mode}`,
    `Language: ${formatPromptValue(story.meta.language || "de")}`,
    `Genre: ${formatPromptValue(story.meta.genre)}`,
    `Audience: ${formatPromptValue(story.meta.audience)}`,
    `Target: ${story.book.targetFormat}, ${story.book.targetLengthWords} words`,
    `Current structure: ${story.acts.length} act(s), ${allScenes.length} scene(s), approx. ${totalWords} words in scene text`,
    `Active scope scene count: ${scopedSceneCount}`
  ].join("\n");
}

function buildStableBriefPrompt(story: StoryDocument) {
  return [
    "## Stable Brief",
    `Premise: ${formatPromptValue(story.book.masterBrief.premise)}`,
    `Reader Promise: ${formatPromptValue(story.book.masterBrief.readerPromise)}`,
    `Ending Promise: ${formatPromptValue(story.book.masterBrief.endingPromise)}`,
    `Thematic Core: ${formatPromptValue(story.book.masterBrief.thematicCore)}`,
    `Amazon Goal: ${formatPromptValue(story.book.marketBrief.amazonGoal)}`,
    `Category Lane: ${formatPromptValue(story.book.marketBrief.categoryLane)}`,
    `Commercial Hook: ${formatPromptValue(story.book.marketBrief.hook)}`,
    `Series Potential: ${formatPromptValue(story.book.marketBrief.seriesPotential)}`,
    `Cover Direction: ${formatPromptValue(story.book.marketBrief.coverDirection)}`,
    "Story Architecture:",
    formatPromptList(story.book.masterBrief.storyArchitecture, "Keine Story-Architecture hinterlegt.", 8),
    "Publishing Guardrails:",
    formatPromptList(story.book.marketBrief.publishingGuardrails, "Keine Publishing-Guardrails hinterlegt.", 8),
    "Writer Constitution:",
    buildWriterConstitutionPrompt(story.book.writerConstitution)
  ].join("\n");
}

function buildPipelineContextPrompt(story: StoryDocument, scopedSceneIds: Set<string>) {
  const audit = analyzeBookDraftReadiness(story);
  const allSceneCount = getAllScenes(story).length;
  const sortedJobs = story.book.draftEngine.jobs
    .slice()
    .sort(function (left, right) {
      return right.updatedAt.localeCompare(left.updatedAt);
    });
  const scopedJobs = sortedJobs.filter(function (job) {
    return scopedSceneIds.has(job.sceneId);
  });
  const scopedJobLines = scopedJobs.slice(0, 5).map(formatDraftJobLine);
  const latestJobLines = sortedJobs.slice(0, 5).map(formatDraftJobLine);
  const readinessWarnings = audit.continuityBlockers
    .concat(audit.qualityWarnings)
    .concat(audit.marketWarnings)
    .slice(0, 8);

  return [
    "## Pipeline State",
    `Active Phase: ${story.book.activePhase}`,
    `Draft Target: ${story.book.draftEngine.targetSceneWordsMin}-${story.book.draftEngine.targetSceneWordsMax} words per scene`,
    `Style Profile: ${story.book.draftEngine.styleProfileVersion}`,
    `Market Profile: ${story.book.draftEngine.marketProfileVersion}`,
    `Stage Order: ${STORY_CHAT_STAGE_ORDER.join(" -> ")}`,
    `Draft Jobs: ${sortedJobs.length} total, ${audit.acceptedJobs} accepted, ${audit.pendingJobs} ready/pending, ${audit.uncoveredSceneCount}/${allSceneCount} scene(s) uncovered`,
    `Current Scope Jobs: ${scopedJobs.length}`,
    "Readiness / Risks:",
    formatPromptList(readinessWarnings, "Keine harten Readiness-Warnungen im aktuellen Snapshot.", 8),
    "Latest Draft Jobs:",
    formatPromptList(latestJobLines, "Noch keine Draft-Jobs vorhanden.", 5),
    scopedSceneIds.size && scopedSceneIds.size !== allSceneCount
      ? ["Draft Jobs in Active Scope:", formatPromptList(scopedJobLines, "Noch kein Draft-Job im aktiven Scope.", 5)].join("\n")
      : ""
  ].filter(Boolean).join("\n");
}

function buildMemoryContextPrompt(story: StoryDocument, scopedSceneIds: Set<string>) {
  const memory = story.book.memory;
  const canonEntries = selectRelevantCanonEntries(story, scopedSceneIds);
  const characterStates = selectRelevantCharacterStates(story, scopedSceneIds);
  const openThreads = selectRelevantOpenThreads(story, scopedSceneIds);

  return [
    "## Memory Backbone",
    `Last Synced: ${memory.lastSyncedAt || "noch nie"}`,
    `Canon Ledger: ${memory.canonLedger.length} fact(s)`,
    `Character Ledger: ${memory.characterLedger.length} state(s)`,
    `Open Threads: ${memory.openThreads.length} thread(s)`,
    `Scene Cards: ${memory.sceneCards.length}`,
    `Context Packs: ${memory.contextPacks.length}`,
    "Relevant Canon:",
    formatPromptList(
      canonEntries.map(function (entry) {
        return `${entry.title} [${entry.kind}, ${entry.importance}, ${entry.status}]: ${trimPromptText(entry.summary, 220)}`;
      }),
      "Keine relevanten Kanon-Einträge im aktiven Scope.",
      6
    ),
    "Relevant Character States:",
    formatPromptList(
      characterStates.map(function (entry) {
        const latestSnapshot = entry.snapshots[entry.snapshots.length - 1] ?? null;
        return `${entry.characterName}: ${trimPromptText(entry.currentState, 180)} | Agenda: ${trimPromptText(entry.agenda, 140)} | Latest: ${latestSnapshot?.sourceLabel || "Baseline"}`;
      }),
      "Keine relevanten Figurenstände im aktiven Scope.",
      6
    ),
    "Relevant Open Threads:",
    formatPromptList(
      openThreads.map(function (thread) {
        return `${thread.label} [${thread.status}/${thread.priority}] from ${thread.sourceSceneTitle}: ${trimPromptText(thread.detail, 220)}`;
      }),
      "Keine relevanten offenen Fäden im aktiven Scope.",
      6
    ),
    "Continuity Notes:",
    formatPromptList(memory.continuityNotes, "Keine Continuity-Notizen hinterlegt.", 5)
  ].join("\n");
}

function buildActiveScopeContextPrompt(
  story: StoryDocument,
  contextSelection: AssistantContextSelection,
  scopedScenes: ReturnType<typeof getScopedSceneContexts>
) {
  const structureLines = story.acts.map(function (act) {
    const sceneCount = act.chapters.reduce(function (sum, chapter) {
      return sum + chapter.scenes.length;
    }, 0);

    return `${act.title}: ${act.chapters.length} chapter(s), ${sceneCount} scene(s)`;
  });
  const weakSceneLines = scopedScenes
    .filter(function (sceneContext) {
      return sceneContext.summary.length < 30;
    })
    .slice(0, 5)
    .map(function (sceneContext) {
      return `${sceneContext.sceneTitle} (${sceneContext.chapterTitle}) hat eine sehr kurze oder fehlende Summary.`;
    });

  return [
    "## Active Scope",
    `Resolved Label: ${buildContextLabel(story, contextSelection)}`,
    buildScopedContextPrompt(story, contextSelection),
    "Structure Overview:",
    formatPromptList(structureLines, "Keine Struktur angelegt.", 8),
    "Scenes in Active Scope:",
    formatPromptList(
      scopedScenes.slice(0, 10).map(function (sceneContext) {
        return formatScopedSceneLine(story, sceneContext);
      }),
      "Keine Szene im aktiven Scope auflösbar.",
      10
    ),
    "Scope Gaps:",
    formatPromptList(weakSceneLines, "Keine offensichtlichen Scope-Lücken in den ersten Szenen.", 5)
  ].join("\n");
}

function buildActiveScenePacketPrompt(story: StoryDocument, contextSelection: AssistantContextSelection) {
  if (!contextSelection.sceneId) {
    return null;
  }

  const packet = buildSceneContextPacket(story, contextSelection.sceneId);

  if (!packet) {
    return "## Active Scene Packet\n- Scene Context Packet konnte nicht geladen werden.";
  }

  const sceneCard = story.book.memory.sceneCards.find(function (card) {
    return card.sceneId === contextSelection.sceneId;
  }) ?? null;
  const jobs = getDraftJobsForScene(story, contextSelection.sceneId);
  const latestJob = jobs[0] ?? null;

  return [
    "## Active Scene Packet",
    `Act / Chapter: ${packet.dynamicContext.actTitle} / ${packet.dynamicContext.chapterTitle}`,
    `Scene: ${packet.dynamicContext.sceneTitle}`,
    `Scene Label: ${packet.dynamicContext.sceneCardLabel || "nicht gesetzt"}`,
    `Summary: ${formatPromptValue(packet.dynamicContext.sceneSummary)}`,
    `Excerpt: ${formatPromptValue(packet.dynamicContext.sceneExcerpt, 600)}`,
    `Context Pack: ${packet.dynamicContext.contextPackId || "nicht persistiert"}`,
    `Memory Synced: ${packet.dynamicContext.memorySyncedAt || "noch nie"}`,
    `Word Target: ${packet.dynamicContext.wordTargetMin ?? story.book.draftEngine.targetSceneWordsMin}-${packet.dynamicContext.wordTargetMax ?? story.book.draftEngine.targetSceneWordsMax}`,
    "Scene Card Outline:",
    formatPromptList(packet.dynamicContext.sceneCardOutline, "Keine Outline in der Scene Card.", 8),
    "Scene Directives:",
    formatPromptList(formatSceneDirectives(sceneCard?.directives ?? null), "Keine konkreten Scene-Directives hinterlegt.", 12),
    "Hard Constraints:",
    formatPromptList(packet.dynamicContext.sceneHardConstraints, "Keine harten Szenen-Constraints erkannt.", 8),
    "Previous Beats:",
    formatPromptList(
      packet.dynamicContext.previousBeats.map(function (beat) {
        return `${beat.orderLabel} ${beat.sceneTitle}: ${trimPromptText(beat.summary, 180)}`;
      }),
      "Keine vorherigen Beats im Packet.",
      4
    ),
    "Next Beat:",
    packet.dynamicContext.nextBeatTitle
      ? `- ${packet.dynamicContext.nextBeatTitle}`
      : "- Kein nächster Beat im Packet.",
    "Packet Canon:",
    formatPromptList(
      packet.dynamicContext.relevantCodex.map(function (entry) {
        return `${entry.title}: ${trimPromptText(entry.summary, 220)}`;
      }),
      "Kein relevanter Kanon im Packet.",
      5
    ),
    "Packet Character States:",
    formatPromptList(
      packet.dynamicContext.relevantCharacterStates.map(function (entry) {
        return `${entry.characterName}: ${trimPromptText(entry.currentState, 180)} | ${trimPromptText(entry.innerShift, 160)}`;
      }),
      "Keine relevanten Figurenstände im Packet.",
      5
    ),
    "Packet Open Threads:",
    formatPromptList(
      packet.dynamicContext.activeThreads.map(function (thread) {
        return `${thread.label} [${thread.status}/${thread.priority}]: ${trimPromptText(thread.detail, 220)}`;
      }),
      "Keine aktiven Fäden im Packet.",
      5
    ),
    "Latest Scene Draft Job:",
    latestJob ? formatFocusedJobBlock(latestJob) : "- Noch kein Draft-Job für diese Szene."
  ].join("\n");
}

function buildAssistantWorkspaceMemoryPrompt(story: StoryDocument) {
  const artifacts = story.assistant.artifacts
    .slice()
    .sort(function (left, right) {
      return right.updatedAt.localeCompare(left.updatedAt);
    })
    .slice(0, 4)
    .map(function (artifact) {
      return `${artifact.kind}: ${artifact.title} (${buildContextLabel(story, artifact.context)}) - ${trimPromptText(artifact.summary, 180)}`;
    });

  return [
    "## Assistant Workspace Memory",
    `Threads: ${story.assistant.threads.length}`,
    `Artifacts: ${story.assistant.artifacts.length}`,
    "Recent Artifacts:",
    formatPromptList(artifacts, "Noch keine Assistant-Dokumente gespeichert.", 4)
  ].join("\n");
}

function createLocalExecution(
  story: StoryDocument,
  threadId: string,
  outputMode: AssistantOutputMode,
  contextSelection: AssistantContextSelection,
  warning: string
): StoryChatExecution {
  const thread = story.assistant.threads.find(function (candidate) {
    return candidate.id === threadId;
  });
  const lastUserMessage =
    [...(thread?.messages ?? [])].reverse().find(function (message) {
      return message.role === "user";
    })?.content ?? "";

  if (outputMode !== "chat") {
    const artifact = outputMode === "regie"
      ? buildLocalRegieTemplateArtifact(story, contextSelection, lastUserMessage)
      : buildLocalNoteArtifact(story, contextSelection, lastUserMessage);

    return {
      provider: "local",
      mode: "local_fallback",
      modelName: null,
      reply: outputMode === "regie"
        ? "Ich habe eine Regie-Vorlage im neuen Pipeline-Format als lokalen Fallback erzeugt. Prüfe sie vor Import mit dem Regie-Dry-Run."
        : "Ich habe eine Arbeitsnotiz auf Basis des aktuellen Projektstands erzeugt.",
      suggestedThreadTitle: deriveLocalThreadTitle(lastUserMessage, outputMode === "regie" ? "Regie-Vorlage" : "Notiz"),
      artifact,
      warning
    };
  }

  return {
    provider: "local",
    mode: "local_fallback",
    modelName: null,
    reply: buildLocalReply(story, contextSelection, lastUserMessage),
    suggestedThreadTitle: deriveLocalThreadTitle(lastUserMessage, "Brainstorm"),
    warning
  };
}

function buildLocalReply(story: StoryDocument, contextSelection: AssistantContextSelection, prompt: string) {
  const packet = contextSelection.sceneId ? buildSceneContextPacket(story, contextSelection.sceneId) : null;
  const anchor = packet?.dynamicContext.sceneTitle || buildContextLabel(story, contextSelection) || story.title;
  const hook = story.book.marketBrief.hook || story.book.masterBrief.premise || "Der Stoff braucht einen klareren Zug.";
  const thematicCore = story.book.masterBrief.thematicCore || "Der thematische Kern ist noch nicht scharf genug benannt.";

  return [
    `Fokus: Für ${anchor} ist die stärkste Arbeitsachse aktuell ${hook}.`,
    `Hebel: Verdichte die Entscheidung so, dass sie den thematischen Kern "${thematicCore}" nicht erklärt, sondern im Konflikt sichtbar macht.`,
    `Nächster Schritt: Formuliere die Szene oder Idee als Frage mit Konsequenz und entscheide danach erst über Ton, POV und Eskalation.`,
    prompt ? `Direkt aus deiner Frage: ${prompt}` : "Direkt aus dem Projektzustand: erst Fokus, dann Verdichtung, dann formale Ausarbeitung."
  ].join("\n\n");
}

function buildLocalNoteArtifact(
  story: StoryDocument,
  contextSelection: AssistantContextSelection,
  prompt: string
) {
  const packet = contextSelection.sceneId ? buildSceneContextPacket(story, contextSelection.sceneId) : null;
  const hook = story.book.marketBrief.hook || story.book.masterBrief.premise || "Hook noch nicht gesetzt.";
  const content = [
    `# Arbeitsnotiz — „${story.title}”`,
    "",
    "## Entscheidungen",
    "",
    `- Aktiver Fokus: ${prompt || buildContextLabel(story, contextSelection) || "Projekt schärfen."}`,
    `- Stärkster aktueller Hook: ${hook}`,
    "",
    "## Risiken",
    "",
    packet
      ? `- Szene ${packet.dynamicContext.sceneTitle}: Scene Intention und harte Constraints vor Draft prüfen.`
      : "- Kein einzelnes Scene Context Packet aktiv; Entscheidungen bleiben auf Projekt-/Kapitelebene.",
    story.book.masterBrief.premise ? "" : "- Prämisse fehlt oder ist noch zu weich.",
    story.book.masterBrief.currentFocus ? "" : "- Current Focus fehlt; die nächsten 1-3 Szenen sind nicht klar gesteuert.",
    "",
    "## Material",
    "",
    formatPromptList(
      story.worldBible.slice(0, 5).map(function (entry) {
        return `${entry.title}: ${trimPromptText(entry.summary, 180)}`;
      }),
      "Noch kein belastbares Material im World-Bible-Kontext.",
      5
    ),
    "",
    "## Offene Fragen",
    "",
    "- Welche Fakten sind harte Canon-Wahrheit und welche nur Review-/Payoff-Material?",
    "- Welche Scene Cards brauchen konkrete Objekte, Dokumente, Routinen oder soziale Kosten?",
    "",
    "## Nächste Schritte",
    "",
    "- Rohideen in Core, Pressure System, Characters, Open Threads und Act Map sortieren.",
    "- Danach erst eine Regie-Vorlage nach Regie_Anleitung.md bauen und per Dry-Run prüfen."
  ].filter(function (line) {
    return line !== "";
  }).join("\n");

  return {
    title: `Arbeitsnotiz — ${story.title}`,
    kind: "note" as const,
    summary: `Arbeitsnotiz für ${story.title}${packet ? ` mit Fokus auf ${packet.dynamicContext.sceneTitle}` : ""}.`,
    content
  };
}

function buildLocalRegieTemplateArtifact(
  story: StoryDocument,
  contextSelection: AssistantContextSelection,
  prompt: string
) {
  const packet = contextSelection.sceneId ? buildSceneContextPacket(story, contextSelection.sceneId) : null;
  const today = new Date().toISOString().slice(0, 10);
  const firstScene = packet?.dynamicContext;
  const content = [
    `# EMBER Story Document — „${story.title || "[ARBEITSTITEL]"}"`,
    "",
    `> Format: EMBER Book Blueprint v2 | Rohentwurf: ${today}`,
    `> Autor: ${story.authorName || "[AUTOR]"}`,
    "> Hinweis: Lokaler Fallback-Entwurf. Vor Import gegen Regie_Anleitung.md prüfen und mit bootstrap-book-from-regie.ts --dry-run validieren.",
    "",
    "## MASTER BRIEF",
    "",
    "| Feld | Inhalt |",
    "|---|---|",
    `| **Prämisse** | ${story.book.masterBrief.premise || "[Prämisse ergänzen.]"} |`,
    `| **Reader Promise** | ${story.book.masterBrief.readerPromise || "[Reader Promise ergänzen.]"} |`,
    `| **Ending Promise** | ${story.book.masterBrief.endingPromise || "[Ending Promise ohne Finale-Leak ergänzen.]"} |`,
    `| **Thematischer Kern** | ${story.book.masterBrief.thematicCore || "[Thematischen Kern ergänzen.]"} |`,
    `| **Author Intent** | ${story.book.masterBrief.authorIntent || "[Author Intent ergänzen.]"} |`,
    `| **Current Focus** | ${story.book.masterBrief.currentFocus || prompt || "[Current Focus für die nächsten 1-3 Szenen ergänzen.]"} |`,
    `| **Arbeitstitel** | ${story.title || "[ARBEITSTITEL]"} |`,
    `| **Genre** | ${story.meta.genre || "[Genre ergänzen.]"} |`,
    `| **Ziel-Wortanzahl** | ${story.book.targetLengthWords || "[Zielumfang ergänzen.]"} Wörter |`,
    "| **POV-Strategie** | [POV-Strategie ergänzen.] |",
    "",
    "## MARKET BRIEF",
    "",
    "| Feld | Inhalt |",
    "|---|---|",
    `| **Amazon Goal** | ${story.book.marketBrief.amazonGoal || "[Amazon Goal ergänzen.]"} |`,
    `| **Category Lane** | ${story.book.marketBrief.categoryLane || "[Category Lane ergänzen.]"} |`,
    "| **Comp Titles** | [Comp Titles und Negativgrenzen ergänzen.] |",
    `| **Commercial Hook** | ${story.book.marketBrief.hook || "[Commercial Hook ergänzen.]"} |`,
    `| **Serienpotenzial** | ${story.book.marketBrief.seriesPotential || "[Serienpotenzial ergänzen.]"} |`,
    `| **Cover-Richtung** | ${story.book.marketBrief.coverDirection || "[Cover-Richtung ergänzen.]"} |`,
    "",
    "## WRITER CONSTITUTION",
    "",
    formatPromptList(story.book.writerConstitution.slice(0, 10), "Keine Writer Constitution gesetzt.", 10),
    "",
    "## WORLD BIBLE",
    "",
    formatPromptList(
      story.worldBible.slice(0, 8).map(function (entry) {
        return `- **${entry.title}:** ${trimPromptText(entry.summary, 220)}`;
      }),
      "- [World-Bible-Gegenwartszustand ergänzen.]",
      8
    ),
    "",
    "## CANON FACTS (Initial — Stand: vor Kapitel 1)",
    "",
    "```json",
    JSON.stringify({
      canon_facts: [
        {
          id: "CF001",
          fact: "KANDIDAT: Aus dem aktuellen Projektkontext ableiten und vor Import prüfen.",
          status: "needs_review"
        }
      ]
    }, null, 2),
    "```",
    "",
    "## CHARACTER STATE LEDGER",
    "",
    "### [HAUPTFIGUR NAME] — „[Funktion]\"",
    "```json",
    JSON.stringify({
      character_id: "PROTAGONIST",
      name: "[HAUPTFIGUR NAME]",
      role: "[Rolle ergänzen]",
      background: "[Gegenwartsnahe Vorgeschichte ergänzen]",
      wunde: {
        was_passiert_ist: "[ergänzen]",
        was_es_heute_macht: "[ergänzen]",
        was_er_niemals_tut: "[ergänzen]",
        arc_abschluss: "[ergänzen]"
      },
      initial_state: {
        physisch: "[ergänzen]",
        psychisch: "[ergänzen]",
        verhaeltnis_zum_konflikt: "[ergänzen]"
      },
      speech_pattern: "[ergänzen]"
    }, null, 2),
    "```",
    "",
    "## CONTINUITY GUARDRAILS (Arbeitsstand Entwurf)",
    "",
    "- [Vollständige Figurnamen und Funktionen ergänzen.]",
    "- [Objektfarben und harte Objektanker ergänzen.]",
    "- Keine Auflösungsleaks in World Bible oder Scene Card.",
    "",
    "## OPEN THREADS (Initial)",
    "",
    "```json",
    JSON.stringify({
      open_threads: [
        {
          id: "OT001",
          thread: "[Zentrale dramaturgische Frage ergänzen.]",
          status: "offen",
          payoff_act: "Act 3"
        }
      ]
    }, null, 2),
    "```",
    "",
    "## LOSS LADDER / ACT MAP",
    "",
    "### Act 1 — [Titel]",
    "- **Startglaube:** [ergänzen]",
    "- **Erster Verlust:** [ergänzen]",
    "- **Was unbewiesen bleibt:** [ergänzen]",
    "",
    "### Act 2 — [Titel]",
    "- **Vertiefung:** [ergänzen]",
    "- **Kosten:** [ergänzen]",
    "- **Act-2-Kippmoment:** [ergänzen]",
    "",
    "### Act 3 — [Titel]",
    "- **Rueckeroberung:** [ergänzen]",
    "- **Einloesung:** [ergänzen]",
    "",
    "## ACTS & KAPITEL — SCENE CARDS",
    "",
    "### ACT 1 — „[Act-Titel]\"",
    "",
    `#### Kapitel 1: „${firstScene?.sceneTitle || "[Kapitel-Titel]"}"`,
    "",
    "```",
    "Scene Card",
    "id: SC_1_1",
    `title: ${firstScene?.sceneTitle || "[Kapitel-Titel]"}`,
    "pov: [Vorname Nachname]",
    "ort: [Konkreter Ort]",
    "uhrzeit: [Zeitanker]",
    `objective: ${firstScene?.sceneSummary || "[Konkretes Szenenziel]"}`,
    `situation: ${firstScene?.sceneSummary || "[Was ist schon falsch, wenn die Szene beginnt?]"}`,
    "want: [Spielbares Ziel]",
    "pressure: [Konkretes Hindernis]",
    "material: [1-3 konkrete Materialien]",
    "turn: [Konkrete Verschiebung]",
    "irreversible_change: [Direkte Folge]",
    "thread: OT001",
    "avoid: [Fehlfassung vermeiden]",
    "aftertaste: [Schlusswirkung]",
    "ending_type: [access_loss | relationship_shift | proof_turn | deadline_shift | moral_reframe | social_exposure | quiet_countermove | choice_cost]",
    "word_target_min: 1000",
    "word_target_max: 1500",
    "```",
    "",
    "## LÜCKEN VOR IMPORT",
    "",
    "- Canon Facts sind Kandidaten und müssen geprüft werden.",
    "- Character Ledger ist Platzhalter und muss projektspezifisch ersetzt werden.",
    "- Scene Cards brauchen echte POV-, Ort-, Zeit-, Want-, Pressure-, Material- und Turn-Werte.",
    "- Danach Dry-Run: `npx tsx scripts/bootstrap-book-from-regie.ts --regie <datei> --dry-run`."
  ].join("\n");

  return {
    title: `Regie-Vorlage — ${story.title}`,
    kind: "regie" as const,
    summary: `Pipeline-kompatibler Rohentwurf für ${story.title}; vor Import prüfen.`,
    content
  };
}

function buildScopedContextPrompt(story: StoryDocument, contextSelection: AssistantContextSelection) {
  if (contextSelection.scope === "project") {
    return [
      "Ebene: Gesamtprojekt",
      `Akts: ${story.acts.length}`,
      `Codex-Einträge: ${story.worldBible.length}`,
      `Scene Cards: ${story.book.memory.sceneCards.length}`,
      `Character States: ${story.book.memory.characterLedger.length}`,
      `Context Packs: ${story.book.memory.contextPacks.length}`,
      `Letzte Thread-Ebene: ${buildContextLabel(story, contextSelection)}`
    ].join("\n");
  }

  const act = story.acts.find(function (entry) {
    return entry.id === contextSelection.actId;
  });

  if (!act) {
    return "Kontext konnte nicht aufgelöst werden. Nutze das Gesamtprojekt.";
  }

  if (contextSelection.scope === "act") {
    return [
      `Ebene: Act`,
      `Act: ${act.title}`,
      "Kapitel:",
      act.chapters.map(function (chapter) {
        return `- ${chapter.title}: ${chapter.scenes.length} Szenen`;
      }).join("\n")
    ].join("\n");
  }

  const chapter = act.chapters.find(function (entry) {
    return entry.id === contextSelection.chapterId;
  });

  if (!chapter) {
    return [`Ebene: Act`, `Act: ${act.title}`].join("\n");
  }

  if (contextSelection.scope === "chapter") {
    return [
      `Ebene: Kapitel`,
      `Act: ${act.title}`,
      `Kapitel: ${chapter.title}`,
      "Szenenübersicht:",
      chapter.scenes.map(function (scene) {
        return `- ${scene.title}: ${scene.summary || "Keine Summary."}`;
      }).join("\n")
    ].join("\n");
  }

  const packet = contextSelection.sceneId ? buildSceneContextPacket(story, contextSelection.sceneId) : null;

  if (!packet) {
    return [
      `Ebene: Kapitel`,
      `Act: ${act.title}`,
      `Kapitel: ${chapter.title}`,
      "Szenenkontext konnte nicht geladen werden."
    ].join("\n");
  }

  return [
    `Ebene: Szene`,
    `Act: ${packet.dynamicContext.actTitle}`,
    `Kapitel: ${packet.dynamicContext.chapterTitle}`,
    `Szene: ${packet.dynamicContext.sceneTitle}`,
    `Zusammenfassung: ${packet.dynamicContext.sceneSummary}`,
    `Auszug: ${packet.dynamicContext.sceneExcerpt}`,
    `Context Pack: ${packet.dynamicContext.contextPackId || "nicht persistiert"}`,
    `Vorherige Beats: ${packet.dynamicContext.previousBeats.map(function (beat) {
      return beat.sceneTitle;
    }).join(" | ") || "keine"}`,
    `Nächster Beat: ${packet.dynamicContext.nextBeatTitle || "keiner"}`,
    `Relevanter Codex: ${packet.dynamicContext.relevantCodex.map(function (entry) {
      return entry.title;
    }).join(" | ") || "keiner"}`,
    `Relevante Character States: ${packet.dynamicContext.relevantCharacterStates.map(function (entry) {
      return `${entry.characterName} ← ${entry.snapshots.slice(-1).map(function (snapshot) {
        return snapshot.sourceLabel || snapshot.currentState;
      }).join("") || entry.updatedFromSceneId || "ohne Snapshot"}`;
    }).join(" | ") || "keine"}`,
    packet.dynamicContext.activeThreads.length
      ? `Offene Threads: ${packet.dynamicContext.activeThreads.map(function (thread) {
          return thread.label;
        }).join(" | ")}`
      : "Offene Threads: keine"
  ].join("\n");
}

function buildContextLabel(story: StoryDocument, contextSelection: AssistantContextSelection) {
  if (contextSelection.scope === "project") {
    return "Projektweit";
  }

  const act = story.acts.find(function (entry) {
    return entry.id === contextSelection.actId;
  });

  if (!act) {
    return "Projektweit";
  }

  if (contextSelection.scope === "act") {
    return `Act · ${act.title}`;
  }

  const chapter = act.chapters.find(function (entry) {
    return entry.id === contextSelection.chapterId;
  });

  if (!chapter) {
    return `Act · ${act.title}`;
  }

  if (contextSelection.scope === "chapter") {
    return `Kapitel · ${chapter.title}`;
  }

  const scene = chapter.scenes.find(function (entry) {
    return entry.id === contextSelection.sceneId;
  });

  return scene ? `Szene · ${scene.title}` : `Kapitel · ${chapter.title}`;
}

function deriveLocalThreadTitle(prompt: string, fallback: string) {
  const cleaned = prompt.replace(/\s+/g, " ").trim();

  if (!cleaned) {
    return fallback;
  }

  return cleaned.split(" ").slice(0, 6).join(" ");
}

function buildWriterConstitutionPrompt(rules: string[]) {
  const split = splitWriterConstitution(rules.slice(0, 12));
  const lines: string[] = [];

  lines.push("Positive Leitplanken:");
  lines.push(
    split.positive.length
      ? split.positive.map(function (rule) {
          return `- ${rule}`;
        }).join("\n")
      : "- Keine positiven Leitplanken."
  );
  lines.push("Negative Constraints:");
  lines.push(
    split.negative.length
      ? split.negative.map(function (rule) {
          return `- ${rule}`;
        }).join("\n")
      : "- Keine expliziten Negativregeln."
  );

  return lines.join("\n");
}

function splitWriterConstitution(rules: string[]) {
  return rules.reduce(
    function (acc, rule) {
      const cleaned = rule.trim();

      if (!cleaned) {
        return acc;
      }

      if (/^negative regel:/i.test(cleaned) || /^vermeide\b/i.test(cleaned) || /^kein\b/i.test(cleaned)) {
        acc.negative.push(cleaned.replace(/^negative regel:\s*/i, ""));
        return acc;
      }

      acc.positive.push(cleaned);
      return acc;
    },
    {
      positive: [] as string[],
      negative: [] as string[]
    }
  );
}

function buildMemorySnapshotPrompt(story: StoryDocument, contextSelection: AssistantContextSelection) {
  const packet = contextSelection.sceneId ? buildSceneContextPacket(story, contextSelection.sceneId) : null;

  return [
    `Last synced: ${story.book.memory.lastSyncedAt || "noch nie"}`,
    `Canon facts: ${story.book.memory.canonLedger.length}`,
    `Character states: ${story.book.memory.characterLedger.length}`,
    `Open threads: ${story.book.memory.openThreads.length}`,
    `Scene cards: ${story.book.memory.sceneCards.length}`,
    `Context packs: ${story.book.memory.contextPacks.length}`,
    packet ? `Aktiver Scene-Packet: ${packet.dynamicContext.sceneTitle} (${packet.dynamicContext.contextPackId || "lokal"})` : `Aktiver Scope: ${buildContextLabel(story, contextSelection)}`
  ].join("\n");
}

function getScopedSceneContexts(story: StoryDocument, contextSelection: AssistantContextSelection) {
  const contexts = story.acts.flatMap(function (act) {
    return act.chapters.flatMap(function (chapter) {
      return chapter.scenes.map(function (scene) {
        return {
          actId: act.id,
          actTitle: act.title,
          chapterId: chapter.id,
          chapterTitle: chapter.title,
          sceneId: scene.id,
          sceneTitle: scene.title,
          summary: scene.summary,
          wordCount: getSceneTextWordCount(scene)
        };
      });
    });
  });

  if (contextSelection.scope === "project") {
    return contexts;
  }

  if (contextSelection.scope === "act") {
    return contexts.filter(function (sceneContext) {
      return sceneContext.actId === contextSelection.actId;
    });
  }

  if (contextSelection.scope === "chapter") {
    return contexts.filter(function (sceneContext) {
      return (
        sceneContext.actId === contextSelection.actId &&
        sceneContext.chapterId === contextSelection.chapterId
      );
    });
  }

  return contexts.filter(function (sceneContext) {
    return sceneContext.sceneId === contextSelection.sceneId;
  });
}

function getSceneTextWordCount(
  scene: StoryDocument["acts"][number]["chapters"][number]["scenes"][number]
) {
  if (scene.wordCount > 0) {
    return scene.wordCount;
  }

  return countWords(
    [scene.summary]
      .concat(
        scene.blocks.map(function (block) {
          return block.text;
        })
      )
      .join(" ")
  );
}

function formatScopedSceneLine(
  story: StoryDocument,
  sceneContext: ReturnType<typeof getScopedSceneContexts>[number]
) {
  const latestJob = getLatestJobForScene(story, sceneContext.sceneId);
  const jobStatus = latestJob
    ? `${latestJob.status}, ${countWords(latestJob.rewriteText)} rewrite words`
    : "no draft job";

  return `${sceneContext.actTitle} / ${sceneContext.chapterTitle} / ${sceneContext.sceneTitle} (${sceneContext.wordCount} words; ${jobStatus}): ${formatPromptValue(sceneContext.summary, 220)}`;
}

function getLatestJobForScene(story: StoryDocument, sceneId: string) {
  return getDraftJobsForScene(story, sceneId)[0] ?? null;
}

function selectRelevantCanonEntries(story: StoryDocument, scopedSceneIds: Set<string>) {
  const allSceneCount = getAllScenes(story).length;

  if (!scopedSceneIds.size || scopedSceneIds.size === allSceneCount) {
    return story.book.memory.canonLedger.slice(0, 6);
  }

  const scoped = story.book.memory.canonLedger.filter(function (entry) {
    return entry.sceneIds.some(function (sceneId) {
      return scopedSceneIds.has(sceneId);
    });
  });

  return (scoped.length ? scoped : story.book.memory.canonLedger).slice(0, 6);
}

function selectRelevantCharacterStates(story: StoryDocument, scopedSceneIds: Set<string>) {
  const allSceneCount = getAllScenes(story).length;

  if (!scopedSceneIds.size || scopedSceneIds.size === allSceneCount) {
    return story.book.memory.characterLedger.slice(0, 6);
  }

  const scoped = story.book.memory.characterLedger.filter(function (entry) {
    if (scopedSceneIds.has(entry.updatedFromSceneId)) {
      return true;
    }

    return entry.snapshots.some(function (snapshot) {
      return Boolean(snapshot.sourceSceneId && scopedSceneIds.has(snapshot.sourceSceneId));
    });
  });

  return (scoped.length ? scoped : story.book.memory.characterLedger).slice(0, 6);
}

function selectRelevantOpenThreads(story: StoryDocument, scopedSceneIds: Set<string>) {
  const allSceneCount = getAllScenes(story).length;
  const threads = story.book.memory.openThreads
    .slice()
    .sort(function (left, right) {
      const leftScore = scoreOpenThread(left.status, left.priority);
      const rightScore = scoreOpenThread(right.status, right.priority);

      return rightScore - leftScore || left.label.localeCompare(right.label);
    });

  if (!scopedSceneIds.size || scopedSceneIds.size === allSceneCount) {
    return threads.slice(0, 6);
  }

  const scoped = threads.filter(function (thread) {
    return (
      scopedSceneIds.has(thread.sourceSceneId) ||
      Boolean(thread.payoffSceneId && scopedSceneIds.has(thread.payoffSceneId))
    );
  });

  return (scoped.length ? scoped : threads).slice(0, 6);
}

function scoreOpenThread(status: StoryDocument["book"]["memory"]["openThreads"][number]["status"], priority: StoryDocument["book"]["memory"]["openThreads"][number]["priority"]) {
  const statusScore = status === "active" ? 20 : status === "watch" ? 10 : 0;
  const priorityScore = priority === "high" ? 3 : priority === "medium" ? 2 : 1;

  return statusScore + priorityScore;
}

function formatSceneDirectives(
  directives: StoryDocument["book"]["memory"]["sceneCards"][number]["directives"] | null
) {
  if (!directives) {
    return [];
  }

  const fixedEntries: Array<[string, string | null]> = [
    ["POV", directives.pov],
    ["Location", directives.location],
    ["Time", directives.timeAnchor],
    ["Objective", directives.objective],
    ["Opening", directives.opening],
    ["Core Action", directives.coreAction],
    ["Dramatic Beat", directives.dramaticBeat],
    ["Ending", directives.ending],
    ["Closing Line", directives.closingLine]
  ];
  const customEntries = directives.custom.map(function (entry) {
    return [entry.key, entry.value] as [string, string | null];
  });

  return fixedEntries
    .concat(customEntries)
    .filter(function (entry) {
      return Boolean(entry[1]?.trim());
    })
    .map(function ([key, value]) {
      return `${key}: ${trimPromptText(value ?? "", 240)}`;
    });
}

function formatDraftJobLine(job: StoryChatDraftJob) {
  const pendingSyncItems = job.extractedState.memorySync.items.filter(function (item) {
    return item.status === "pending";
  }).length;
  const qualityScore = job.stages.quality_eval.qualityScore;
  const qualitySuffix = typeof qualityScore === "number" ? `, quality ${qualityScore}` : "";

  return `${job.sceneTitle} [${job.status}, ${job.provider}${job.modelName ? `/${job.modelName}` : ""}, ${countWords(job.rewriteText)} rewrite words${qualitySuffix}, pending sync ${pendingSyncItems}] stages: ${formatStageStatusSummary(job)}`;
}

function formatFocusedJobBlock(job: StoryChatDraftJob) {
  return [
    `- Status: ${job.status}; provider: ${job.provider}${job.modelName ? `/${job.modelName}` : ""}; updated: ${job.updatedAt}`,
    `- Context Snapshot: chapter ${job.contextSnapshot.chapterTitle}; pack ${job.contextSnapshot.contextPackId || "lokal"}; memory ${job.contextSnapshot.memorySyncedAt || "unsynced"}`,
    `- Outline: ${job.outline.length ? job.outline.slice(0, 6).join(" | ") : "keine Outline"}`,
    `- Rewrite Notes: ${job.rewriteNotes.length ? job.rewriteNotes.slice(0, 5).join(" | ") : "keine Rewrite Notes"}`,
    `- Extracted Canon: ${job.extractedState.newCanonFacts.slice(0, 4).join(" | ") || "keine"}`,
    `- Character Updates: ${job.extractedState.characterStateUpdates.slice(0, 4).join(" | ") || "keine"}`,
    `- Open Threads Created: ${job.extractedState.openThreadsCreated.slice(0, 4).join(" | ") || "keine"}`,
    `- Continuity Risks: ${job.extractedState.continuityRisks.concat(job.extractedState.styleDriftNotes).slice(0, 5).join(" | ") || "keine"}`,
    `- Stage Status: ${formatStageStatusSummary(job)}`
  ].join("\n");
}

function formatStageStatusSummary(job: StoryChatDraftJob) {
  return STORY_CHAT_STAGE_ORDER.map(function (stage) {
    const run = job.stages[stage];

    return `${stage}:${run.status}${run.repairCount ? `/repairs-${run.repairCount}` : ""}`;
  }).join(", ");
}

function formatPromptList(items: string[], emptyLabel: string, maxItems = 6) {
  const lines = items
    .map(function (item) {
      return trimPromptText(item, 520);
    })
    .filter(Boolean)
    .slice(0, maxItems);

  if (!lines.length) {
    return `- ${emptyLabel}`;
  }

  return lines.map(function (line) {
    return `- ${line}`;
  }).join("\n");
}

function formatPromptValue(value: string | null | undefined, maxLength = 360) {
  const trimmed = trimPromptText(value ?? "", maxLength);

  return trimmed || "nicht gesetzt";
}

function trimPromptText(value: string, maxLength: number) {
  const cleaned = value.replace(/\s+/g, " ").trim();

  if (cleaned.length <= maxLength) {
    return cleaned;
  }

  return `${cleaned.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}
