import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import {
  DEFAULT_BOOK_JOB_MODELS,
  normalizeKnownModelAlias,
  resolveBookJobModelValue,
  type BookJobModelOverrides
} from "@/lib/book-job-models";
import { buildGenreEnginePrompt } from "@/lib/book-genre-engines";
import {
  auditSceneContinuityGuards,
  buildNarrativeSceneCardOutlineSteps,
  buildSceneContextPacket,
  createDraftJobFromPacket,
  createStageRun,
  detectStyleDrift,
  type SceneContextPacket
} from "@/lib/book-engine";
import {
  buildStateDiffFromExtraction,
  validateBookStateDiff
} from "@/lib/book-state-validator";
import {
  getCommonLockedFacts,
  getDomesticSuspenseLockedFacts,
  getYaSuperheroLockedFacts,
  normalizeBookDraftTargets,
  type BookStateDiff,
  type BookDraftJob,
  type BookDraftStageRuns,
  type DraftExtractionState,
  type BookHumanEditExample,
  type StoryDocument,
  withDraftMemorySync
} from "@/lib/story-schema";
import { createUuid } from "@/lib/id";

const beatPlanSchema = z.object({
  beats: z.array(
    z.object({
      label: z.string().min(1).max(120),
      purpose: z.string().min(1).max(600),
      targetWords: z.number().int().min(50).max(1200),
      mustLand: z.string().min(1).max(320)
    })
  )
    .min(3)
    .max(6)
});

const stateExtractionSchema = z.object({
  sceneNotes: z.array(z.string().min(1).max(100)).min(1).max(4),
  extractedState: z.object({
    newCanonFacts: z.array(z.string().min(1).max(100)).max(3),
    characterStateUpdates: z.array(z.string().min(1).max(100)).max(3),
    openThreadsCreated: z.array(z.string().min(1).max(100)).max(3),
    openThreadsResolved: z.array(z.string().min(1).max(100)).max(3),
    foreshadowingAdded: z.array(z.string().min(1).max(100)).max(3),
    continuityRisks: z.array(z.string().min(1).max(100)).max(3),
    styleDriftNotes: z.array(z.string().min(1).max(100)).max(3)
  })
});

const continuityAuditSchema = z.object({
  continuityRisks: z.array(z.string()).max(6),
  styleDriftNotes: z.array(z.string()).max(6)
});

const qualityEvalSchema = z.object({
  wordTargetMin: z.number().int().min(0),
  wordTargetMax: z.number().int().min(0),
  wordActual: z.number().int().min(0),
  hookScore: z.number().int().min(0).max(10),
  tensionScore: z.number().int().min(0).max(10),
  dialogueScore: z.number().int().min(0).max(10),
  specificityScore: z.number().int().min(0).max(10),
  germanCleanlinessScore: z.number().int().min(0).max(10),
  continuityScore: z.number().int().min(0).max(10),
  marketFitScore: z.number().int().min(0).max(10),
  povDisciplineScore: z.number().int().min(0).max(10),
  readabilityScore: z.number().int().min(0).max(10),
  issues: z.array(z.string()).max(8)
});

const ANTHROPIC_PROSE_MIN_TOKENS = 1800;
const ANTHROPIC_PROSE_MAX_TOKENS = 10000;
const OPENAI_PROSE_MIN_TOKENS = 1200;
const OPENAI_PROSE_MAX_TOKENS = 9000;
const STRUCTURED_STAGE_MAX_TOKENS = 1400;
// Current Claude models always think, and max_tokens caps thinking plus answer.
const ANTHROPIC_THINKING_HEADROOM_TOKENS = 6000;
const EXTRACT_STAGE_MAX_TOKENS = 900;
const EXTRACT_ARRAY_MAX_ITEMS = 3;
const EXTRACT_SCENE_NOTES_MAX_ITEMS = 4;
const EXTRACT_STRING_MAX_LENGTH = 100;
const LENGTH_CONTROL_EMERGENCY_MIN_WORDS = 600;
const LENGTH_CONTROL_EMERGENCY_MAX_WORDS = 2500;
const ANTHROPIC_CACHE_TTL = "1h" as const;
const ANTHROPIC_CACHE_BETAS = ["extended-cache-ttl-2025-04-11"] as const;
const buildAnthropicCacheRequestOptions = () => ({
  headers: {
    "anthropic-beta": ANTHROPIC_CACHE_BETAS.join(",")
  }
});

type BeatPlanPayload = z.infer<typeof beatPlanSchema>;
type StateExtractionPayload = z.infer<typeof stateExtractionSchema>;
type ContinuityAuditPayload = z.infer<typeof continuityAuditSchema>;
type QualityEvalPayload = z.infer<typeof qualityEvalSchema>;

type SceneIntentionPayload = {
  situation: string;
  want: string;
  pressure: string;
  concreteMaterial: string;
  intendedTurn: string;
  irreversibleChange: string;
  narratorAnchor: string;
  aftertaste: string;
  avoid: string[];
};

type DraftGenerationOptions = {
  modelOverrides?: BookJobModelOverrides;
  targetSceneWordsMin: number;
  targetSceneWordsMax: number;
  directorNote: string;
  humanEditProfile: string;
};

type StageCallMetrics = {
  modelName: string | null;
  attemptCount: number;
  repairCount: number;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  stopReason: string | null;
};

type StructuredStageResult<T> = {
  payload: T;
  metrics: StageCallMetrics;
};

type TextStageResult = {
  text: string;
  metrics: StageCallMetrics;
};

type LengthControlAction = "accept" | "expand" | "compress";
type AnthropicStructuredStageName = "beat_plan" | "extract" | "continuity" | "quality_eval";

type ScenePipelineAdapter = {
  provider: RemoteBookJobProvider;
  modelName: string;
  continuityModelName: string | null;
  extractModelName: string | null;
  writeDraft: (beatPlan: BeatPlanPayload) => Promise<TextStageResult>;
  expandScene: (beatPlan: BeatPlanPayload, finalSceneText: string) => Promise<TextStageResult>;
  compressScene: (beatPlan: BeatPlanPayload, finalSceneText: string) => Promise<TextStageResult>;
  extractSceneState: (
    beatPlan: BeatPlanPayload,
    finalSceneText: string
  ) => Promise<StructuredStageResult<StateExtractionPayload>>;
  auditContinuity: (
    beatPlan: BeatPlanPayload,
    draftText: string,
    finalSceneText: string,
    extractedState: DraftExtractionState
  ) => Promise<StructuredStageResult<ContinuityAuditPayload>>;
  evaluateQuality: (
    beatPlan: BeatPlanPayload,
    finalSceneText: string,
    extractedState: DraftExtractionState
  ) => Promise<StructuredStageResult<QualityEvalPayload>>;
};

type DraftProviderResult = {
  modelName: string;
  continuityModelName: string | null;
  beatPlan: BeatPlanPayload;
  draftText: string;
  finalSceneText: string;
  sceneNotes: string[];
  extractedState: DraftExtractionState;
  qualityEval: QualityEvalPayload;
  stages: BookDraftStageRuns;
  warning?: string;
};

export type BookJobProvider = "auto" | "openai" | "anthropic" | "local";
type RemoteBookJobProvider = "openai" | "anthropic";

export type BookJobExecution = {
  provider: Exclude<BookJobProvider, "auto">;
  mode: "remote" | "local_fallback";
  job: BookDraftJob;
  warning?: string;
};

export async function generateBookDraftJob(params: {
  story?: StoryDocument;
  sceneId: string;
  packet?: SceneContextPacket;
  provider?: BookJobProvider;
  modelOverrides?: BookJobModelOverrides;
  targetSceneWordsMin?: number;
  targetSceneWordsMax?: number;
  directorNote?: string;
  humanEditExamples?: BookHumanEditExample[];
}): Promise<BookJobExecution> {
  const provider = params.provider ?? "auto";
  const packet =
    params.packet ?? (params.story ? buildSceneContextPacket(params.story, params.sceneId) : null);

  if (!packet) {
    throw new Error("Scene context could not be built.");
  }

  const normalizedTargets = normalizeBookDraftTargets(
    packet.dynamicContext.wordTargetMin ?? params.targetSceneWordsMin ?? 1200,
    packet.dynamicContext.wordTargetMax ?? params.targetSceneWordsMax ?? 1600
  );
  const targetSceneWordsMin = normalizedTargets.targetSceneWordsMin;
  const targetSceneWordsMax = normalizedTargets.targetSceneWordsMax;
  const directorNote = params.directorNote?.trim() || "";
  const humanEditProfile = buildHumanEditProfilePrompt(
    (params.humanEditExamples ?? []).concat(params.story?.book.memory.humanEditExamples ?? []),
    packet
  );

  if (provider === "local") {
    return createLocalExecution(
      packet,
      targetSceneWordsMin,
      targetSceneWordsMax,
      "Lokaler Provider explizit gewaehlt."
    );
  }

  const remoteProvider = resolveRemoteProvider(provider);

  if (!remoteProvider) {
    return createLocalExecution(
      packet,
      targetSceneWordsMin,
      targetSceneWordsMax,
      "Kein OPENAI_API_KEY oder ANTHROPIC_API_KEY gesetzt; lokaler Fallback verwendet."
    );
  }

  try {
    const providerOptions: DraftGenerationOptions = {
      modelOverrides: params.modelOverrides,
      targetSceneWordsMin,
      targetSceneWordsMax,
      directorNote,
      humanEditProfile
    };

    const result =
      remoteProvider === "openai"
        ? await generateWithOpenAI(packet, providerOptions)
        : await generateWithAnthropic(packet, providerOptions);

    return {
      provider: remoteProvider,
      mode: "remote",
      warning: result.warning,
      job: hydrateDraftJob(params.sceneId, packet, result, {
        provider: remoteProvider,
        mode: "remote",
        modelName: result.modelName
      })
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown provider error.";

    return createLocalExecution(
      packet,
      targetSceneWordsMin,
      targetSceneWordsMax,
      `${remoteProvider} request failed; local fallback used. ${message}`
    );
  }
}

function resolveRemoteProvider(provider: BookJobProvider) {
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
  packet: SceneContextPacket,
  options: DraftGenerationOptions
): Promise<DraftProviderResult> {
  const modelName = resolveBookJobModelValue(
    options.modelOverrides?.openai,
    process.env.OPENAI_BOOK_MODEL,
    DEFAULT_BOOK_JOB_MODELS.openai
  );
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });

  return runScenePipeline(packet, options, {
    provider: "openai",
    modelName,
    continuityModelName: modelName,
    extractModelName: modelName,
    writeDraft: function (beatPlan) {
      return requestOpenAIText({
        client,
        modelName,
        systemPrompt: buildSystemPrompt(packet, options),
        userPrompt: buildDraftProsePrompt(packet, options, beatPlan),
        maxOutputTokens: resolveOpenAIProseMaxTokens(options.targetSceneWordsMax)
      });
    },
    expandScene: function (beatPlan, finalSceneText) {
      return requestOpenAIText({
        client,
        modelName,
        systemPrompt: buildSystemPrompt(packet, options),
        userPrompt: buildExpandPrompt(packet, options, beatPlan, finalSceneText),
        maxOutputTokens: resolveOpenAIProseMaxTokens(options.targetSceneWordsMax)
      });
    },
    compressScene: function (beatPlan, finalSceneText) {
      return requestOpenAIText({
        client,
        modelName,
        systemPrompt: buildSystemPrompt(packet, options),
        userPrompt: buildCompressPrompt(packet, options, beatPlan, finalSceneText),
        maxOutputTokens: resolveOpenAIProseMaxTokens(options.targetSceneWordsMax)
      });
    },
    extractSceneState: function (beatPlan, finalSceneText) {
      return requestOpenAIStructured({
        client,
        modelName,
        schema: stateExtractionSchema,
        schemaName: "ember_book_state_extract",
        systemPrompt: buildSystemPrompt(packet),
        userPrompt: buildStateExtractionPrompt(packet, options, beatPlan, finalSceneText)
      });
    },
    auditContinuity: function (beatPlan, draftText, finalSceneText, extractedState) {
      return requestOpenAIStructured({
        client,
        modelName,
        schema: continuityAuditSchema,
        schemaName: "ember_book_continuity_audit",
        systemPrompt: buildSystemPrompt(packet),
        userPrompt: buildContinuityAuditPrompt(
          packet,
          options,
          beatPlan,
          draftText,
          finalSceneText,
          extractedState
        )
      });
    },
    evaluateQuality: function (beatPlan, finalSceneText, extractedState) {
      return requestOpenAIStructured({
        client,
        modelName,
        schema: qualityEvalSchema,
        schemaName: "ember_book_quality_eval",
        systemPrompt: buildSystemPrompt(packet),
        userPrompt: buildQualityEvalPrompt(packet, options, beatPlan, finalSceneText, extractedState)
      });
    }
  });
}

async function generateWithAnthropic(
  packet: SceneContextPacket,
  options: DraftGenerationOptions
): Promise<DraftProviderResult> {
  const modelName = resolveBookJobModelValue(
    options.modelOverrides?.anthropic,
    process.env.ANTHROPIC_BOOK_MODEL,
    DEFAULT_BOOK_JOB_MODELS.anthropic
  );
  const continuityModelName = normalizeAnthropicModelName(
    resolveBookJobModelValue(
      options.modelOverrides?.anthropicContinuity,
      process.env.ANTHROPIC_CONTINUITY_MODEL,
      DEFAULT_BOOK_JOB_MODELS.anthropicContinuity
    )
  );
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY
  });

  return runScenePipeline(packet, options, {
    provider: "anthropic",
    modelName,
    continuityModelName,
    extractModelName: continuityModelName,
    writeDraft: function (beatPlan) {
      return requestAnthropicText({
        client,
        modelName,
        maxTokens: resolveAnthropicProseMaxTokens(options.targetSceneWordsMax),
        systemBlocks: buildAnthropicProseSystemPromptBlocks(packet, options),
        userPrompt: buildAnthropicScenePrompt({
          mode: "draft",
          packet,
          options,
          beatPlan
        })
      });
    },
    expandScene: function (beatPlan, finalSceneText) {
      return requestAnthropicText({
        client,
        modelName,
        maxTokens: resolveAnthropicProseMaxTokens(options.targetSceneWordsMax),
        systemBlocks: buildAnthropicProseSystemPromptBlocks(packet, options),
        userPrompt: buildAnthropicScenePrompt({
          mode: "expand",
          packet,
          options,
          beatPlan,
          finalSceneText
        })
      });
    },
    compressScene: function (beatPlan, finalSceneText) {
      return requestAnthropicText({
        client,
        modelName,
        maxTokens: resolveAnthropicProseMaxTokens(options.targetSceneWordsMax),
        systemBlocks: buildAnthropicProseSystemPromptBlocks(packet, options),
        userPrompt: buildAnthropicScenePrompt({
          mode: "compress",
          packet,
          options,
          beatPlan,
          finalSceneText
        })
      });
    },
    extractSceneState: function (beatPlan, finalSceneText) {
      return requestAnthropicStructured({
        client,
        stageName: "extract",
        modelName: continuityModelName,
        maxTokens: EXTRACT_STAGE_MAX_TOKENS,
        schema: stateExtractionSchema,
        systemBlocks: buildAnthropicSystemPromptBlocks(packet),
        userPrompt: buildStateExtractionPrompt(packet, options, beatPlan, finalSceneText)
      });
    },
    auditContinuity: function (beatPlan, draftText, finalSceneText, extractedState) {
      return requestAnthropicStructured({
        client,
        stageName: "continuity",
        modelName: continuityModelName,
        maxTokens: STRUCTURED_STAGE_MAX_TOKENS,
        schema: continuityAuditSchema,
        systemBlocks: buildAnthropicSystemPromptBlocks(packet),
        userPrompt: buildContinuityAuditPrompt(
          packet,
          options,
          beatPlan,
          draftText,
          finalSceneText,
          extractedState
        )
      });
    },
    evaluateQuality: function (beatPlan, finalSceneText, extractedState) {
      return requestAnthropicStructured({
        client,
        stageName: "quality_eval",
        modelName: continuityModelName,
        maxTokens: STRUCTURED_STAGE_MAX_TOKENS,
        schema: qualityEvalSchema,
        systemBlocks: buildAnthropicSystemPromptBlocks(packet),
        userPrompt: buildQualityEvalPrompt(packet, options, beatPlan, finalSceneText, extractedState)
      });
    }
  });
}

export function previewAnthropicProsePrompts(
  packet: SceneContextPacket,
  optionsOverrides?: {
    targetSceneWordsMin?: number;
    targetSceneWordsMax?: number;
    directorNote?: string;
    humanEditProfile?: string;
  }
) {
  const targetWordsMin =
    optionsOverrides?.targetSceneWordsMin ?? packet.dynamicContext.wordTargetMin ?? 1200;
  const targetWordsMax =
    optionsOverrides?.targetSceneWordsMax ?? packet.dynamicContext.wordTargetMax ?? 1600;
  const options: DraftGenerationOptions = {
    modelOverrides: undefined,
    targetSceneWordsMin: targetWordsMin,
    targetSceneWordsMax: targetWordsMax,
    directorNote: optionsOverrides?.directorNote ?? "",
    humanEditProfile: optionsOverrides?.humanEditProfile ?? ""
  };
  const beatPlan = buildFallbackBeatPlan(packet, options);
  const systemBlocks = buildAnthropicProseSystemPromptBlocks(packet, options);
  const userPrompt = buildAnthropicScenePrompt({
    mode: "draft",
    packet,
    options,
    beatPlan
  });

  return {
    systemBlocks,
    userPrompt,
    targetSceneWordsMin: options.targetSceneWordsMin,
    targetSceneWordsMax: options.targetSceneWordsMax,
    proseMaxTokens: resolveAnthropicProseMaxTokens(options.targetSceneWordsMax)
  };
}

async function runScenePipeline(
  packet: SceneContextPacket,
  options: DraftGenerationOptions,
  adapter: ScenePipelineAdapter
): Promise<DraftProviderResult> {
  const warnings: string[] = [];
  let beatPlan = buildFallbackBeatPlan(packet, options);
  let outlineNotes = buildOutlineFromBeatPlan(beatPlan);
  let beatPlanStage = createStageRun({
    status: "skipped",
    provider: adapter.provider,
    modelName: adapter.modelName,
    updatedAt: new Date().toISOString(),
    attemptCount: 0,
    notes: ["Beat-Plan deaktiviert. Fallback aus erzählerischen Scene-Card-Ankern verwendet."]
  });

  const draftResult = await adapter.writeDraft(beatPlan);
  const draftText = sanitizeSceneText(draftResult.text);

  if (!draftText) {
    throw new Error("Draft stage returned no prose.");
  }
  const initialSceneText = draftText;
  const lengthControl = await maybeRunLengthControl(packet, options, adapter, beatPlan, initialSceneText);
  const finalSceneText = lengthControl.text;

  if (lengthControl.warning) {
    warnings.push(lengthControl.warning);
  }
  let sceneNotes: string[] = [];
  let extractedState: DraftExtractionState = withDraftMemorySync(
    buildFallbackStateExtraction(
      packet,
      finalSceneText,
      beatPlan
    ).extractedState,
    {
      fallbackCreatedAt: new Date().toISOString(),
      defaultStatus: "pending"
    }
  );
  let extractStage = createStageRun({
    status: "skipped",
    provider: adapter.provider,
    modelName: adapter.modelName,
    updatedAt: new Date().toISOString(),
    attemptCount: 0,
    notes: ["State-Extraktion wurde nicht ausgefuehrt."]
  });

  try {
    const extractionResult = await adapter.extractSceneState(beatPlan, finalSceneText);
    const normalizedExtraction = normalizeStateExtractionPayload(extractionResult.payload);
    const sanitizedExtraction = sanitizeSceneStateExtraction(packet, normalizedExtraction);
    extractedState = withDraftMemorySync(sanitizedExtraction.payload.extractedState, {
      fallbackCreatedAt: new Date().toISOString(),
      defaultStatus: "pending"
    });
    sceneNotes = normalizeSceneNotes(
      sanitizedExtraction.payload.sceneNotes,
      finalSceneText,
      beatPlan
    );

    if (sanitizedExtraction.notes.length) {
      warnings.push(sanitizedExtraction.notes.join(" | "));
    }

    extractStage = createStageRun({
      provider: adapter.provider,
      modelName: extractionResult.metrics.modelName,
      updatedAt: new Date().toISOString(),
      attemptCount: extractionResult.metrics.attemptCount,
      repairCount: extractionResult.metrics.repairCount,
      durationMs: extractionResult.metrics.durationMs,
      inputTokens: extractionResult.metrics.inputTokens,
      outputTokens: extractionResult.metrics.outputTokens,
      stopReason: extractionResult.metrics.stopReason,
      notes: buildExtractionNotes(sceneNotes, sanitizedExtraction.notes)
    });
  } catch (error) {
    const fallbackExtraction = buildFallbackStateExtraction(packet, finalSceneText, beatPlan);
    const message = error instanceof Error ? error.message : "unknown error";
    const fallbackNote = `State-Extraktion fehlgeschlagen; konservativer Fallback verwendet. ${message}`;
    sceneNotes = normalizeSceneNotes(fallbackExtraction.sceneNotes, finalSceneText, beatPlan);
    extractedState = withDraftMemorySync(fallbackExtraction.extractedState, {
      fallbackCreatedAt: new Date().toISOString(),
      defaultStatus: "pending"
    });
    warnings.push(fallbackNote);
    extractStage = createStageRun({
      status: "failed",
      provider: adapter.provider,
      modelName: adapter.extractModelName || adapter.modelName,
      updatedAt: new Date().toISOString(),
      notes: [fallbackNote].concat(buildExtractionNotes(sceneNotes, []))
    });
  }

  let continuityStage = createStageRun({
    status: "skipped",
    provider: adapter.provider,
    modelName: adapter.continuityModelName ?? adapter.modelName,
    updatedAt: new Date().toISOString(),
    attemptCount: 0,
    notes: ["Continuity-Audit wurde nicht ausgefuehrt."]
  });

  try {
    const continuityResult = await adapter.auditContinuity(
      beatPlan,
      draftText,
      finalSceneText,
      extractedState
    );
    extractedState = mergeContinuityAudit(extractedState, continuityResult.payload);
    continuityStage = createStageRun({
      provider: adapter.provider,
      modelName: adapter.continuityModelName ?? continuityResult.metrics.modelName,
      updatedAt: new Date().toISOString(),
      attemptCount: continuityResult.metrics.attemptCount,
      repairCount: continuityResult.metrics.repairCount,
      durationMs: continuityResult.metrics.durationMs,
      inputTokens: continuityResult.metrics.inputTokens,
      outputTokens: continuityResult.metrics.outputTokens,
      stopReason: continuityResult.metrics.stopReason,
      notes:
        extractedState.continuityRisks.concat(extractedState.styleDriftNotes).length > 0
          ? extractedState.continuityRisks.concat(extractedState.styleDriftNotes)
          : ["Keine offenen Continuity-Hinweise."]
    });
  } catch (error) {
    continuityStage = createStageRun({
      status: "failed",
      provider: adapter.provider,
      modelName: adapter.continuityModelName ?? adapter.modelName,
      updatedAt: new Date().toISOString(),
      notes: [
        `Continuity-Audit fehlgeschlagen: ${error instanceof Error ? error.message : "unknown error"}`
      ]
    });
    warnings.push(continuityStage.notes[0]);
  }

  const guardContinuityRisks = auditSceneContinuityGuards(packet, finalSceneText);

  if (guardContinuityRisks.length) {
    extractedState = mergeContinuityAudit(extractedState, {
      continuityRisks: guardContinuityRisks,
      styleDriftNotes: []
    });
    continuityStage = {
      ...continuityStage,
      status: continuityStage.status === "skipped" ? "completed" : continuityStage.status,
      notes: dedupeStrings(
        continuityStage.notes
          .filter(function (note) {
            return note !== "Keine offenen Continuity-Hinweise.";
          })
          .concat(guardContinuityRisks)
      ).slice(0, 10)
    };
    warnings.push(`Continuity-Guard: ${guardContinuityRisks.join(" | ")}`);
  }

  const deterministicStyleNotes = detectStyleDrift(packet, finalSceneText);

  if (deterministicStyleNotes.length) {
    extractedState = {
      ...extractedState,
      styleDriftNotes: dedupeStrings(
        extractedState.styleDriftNotes.concat(deterministicStyleNotes)
      ).slice(0, 6)
    };
    continuityStage = {
      ...continuityStage,
      notes: dedupeStrings(
        continuityStage.notes
          .filter(function (note) {
            return note !== "Keine offenen Continuity-Hinweise.";
          })
          .concat(deterministicStyleNotes)
      ).slice(0, 10)
    };
  }

  let qualityEval = createFallbackQualityEval(options, countWords(finalSceneText));
  let qualityStage = createStageRun({
    status: "skipped",
    provider: adapter.provider,
    modelName: adapter.modelName,
    updatedAt: new Date().toISOString(),
    attemptCount: 0,
    targetWordsMin: options.targetSceneWordsMin,
    targetWordsMax: options.targetSceneWordsMax,
    actualWords: qualityEval.wordActual,
    notes: ["Quality-Eval wurde nicht ausgefuehrt."]
  });

  try {
    const qualityResult = await adapter.evaluateQuality(beatPlan, finalSceneText, extractedState);
    qualityEval = sanitizeQualityEval(qualityResult.payload, options, countWords(finalSceneText));
    const qualityScore = computeQualityScore(qualityEval);
    qualityStage = createStageRun({
      provider: adapter.provider,
      modelName: qualityResult.metrics.modelName,
      updatedAt: new Date().toISOString(),
      attemptCount: qualityResult.metrics.attemptCount,
      repairCount: qualityResult.metrics.repairCount,
      durationMs: qualityResult.metrics.durationMs,
      inputTokens: qualityResult.metrics.inputTokens,
      outputTokens: qualityResult.metrics.outputTokens,
      stopReason: qualityResult.metrics.stopReason,
      targetWordsMin: qualityEval.wordTargetMin,
      targetWordsMax: qualityEval.wordTargetMax,
      actualWords: qualityEval.wordActual,
      qualityScore,
      qualityIssues: qualityEval.issues,
      notes: buildQualityEvalNotes(qualityEval, qualityScore)
    });
  } catch (error) {
    qualityStage = createStageRun({
      status: "failed",
      provider: adapter.provider,
      modelName: adapter.modelName,
      updatedAt: new Date().toISOString(),
      targetWordsMin: options.targetSceneWordsMin,
      targetWordsMax: options.targetSceneWordsMax,
      actualWords: countWords(finalSceneText),
      notes: [
        `Quality-Eval fehlgeschlagen: ${error instanceof Error ? error.message : "unknown error"}`
      ]
    });
    warnings.push(qualityStage.notes[0]);
  }

  return {
    modelName: adapter.modelName,
    continuityModelName: adapter.continuityModelName,
    beatPlan,
    draftText,
    finalSceneText,
    sceneNotes,
    extractedState,
    qualityEval,
    stages: {
      context: createStageRun({
        provider: adapter.provider,
        modelName: adapter.modelName,
        updatedAt: new Date().toISOString(),
        notes: ["Context-Pack vorbereitet."]
      }),
      beat_plan: beatPlanStage,
      draft: createStageRun({
        provider: adapter.provider,
        modelName: draftResult.metrics.modelName,
        updatedAt: new Date().toISOString(),
        attemptCount: draftResult.metrics.attemptCount,
        repairCount: draftResult.metrics.repairCount,
        durationMs: draftResult.metrics.durationMs,
        inputTokens: draftResult.metrics.inputTokens,
        outputTokens: draftResult.metrics.outputTokens,
        stopReason: draftResult.metrics.stopReason,
        targetWordsMin: options.targetSceneWordsMin,
        targetWordsMax: options.targetSceneWordsMax,
        actualWords: countWords(draftText),
        notes: [`Erster Prosa-Pass mit ${countWords(draftText)} Wörtern erstellt.`]
      }),
      rewrite: createStageRun({
        status: "skipped",
        provider: adapter.provider,
        modelName: adapter.modelName,
        updatedAt: new Date().toISOString(),
        attemptCount: 0,
        targetWordsMin: options.targetSceneWordsMin,
        targetWordsMax: options.targetSceneWordsMax,
        actualWords: countWords(initialSceneText),
        notes: [`Rewrite-Pass deaktiviert. Draft direkt mit ${countWords(initialSceneText)} Wörtern übernommen.`]
      }),
      length_control: lengthControl.stage,
      extract: extractStage,
      continuity: continuityStage,
      quality_eval: qualityStage
    },
    warning: combineWarnings(warnings)
  };
}

async function maybeRunLengthControl(
  packet: SceneContextPacket,
  options: DraftGenerationOptions,
  adapter: ScenePipelineAdapter,
  beatPlan: BeatPlanPayload,
  currentSceneText: string
) {
  const actualWords = countWords(currentSceneText);
  const action = resolveLengthControlAction(actualWords, options);

  if (action === "accept") {
    return {
      text: currentSceneText,
      warning: undefined,
      stage: createStageRun({
        status: "skipped",
        provider: adapter.provider,
        modelName: adapter.modelName,
        updatedAt: new Date().toISOString(),
        attemptCount: 0,
        targetWordsMin: options.targetSceneWordsMin,
        targetWordsMax: options.targetSceneWordsMax,
        actualWords,
        notes: [`Length-Control akzeptiert ${actualWords} Wörter ohne Korrektur.`]
      })
    };
  }

  try {
    const result =
      action === "expand"
        ? await adapter.expandScene(beatPlan, currentSceneText)
        : await adapter.compressScene(beatPlan, currentSceneText);
    const candidateText = sanitizeSceneText(result.text);
    const finalText = selectBetterLengthCandidate(currentSceneText, candidateText, options);
    const finalWords = countWords(finalText);
    const notes =
      action === "expand"
        ? [`Expand-Pass abgeschlossen. Wortstand: ${finalWords}.`]
        : [`Compress-Pass abgeschlossen. Wortstand: ${finalWords}.`];
    const warning =
      finalText === currentSceneText
        ? `Length-Control ${action} lieferte keine bessere Fassung und wurde verworfen.`
        : undefined;

    return {
      text: finalText,
      warning,
      stage: createStageRun({
        provider: adapter.provider,
        modelName: result.metrics.modelName,
        updatedAt: new Date().toISOString(),
        attemptCount: result.metrics.attemptCount,
        repairCount: result.metrics.repairCount,
        durationMs: result.metrics.durationMs,
        inputTokens: result.metrics.inputTokens,
        outputTokens: result.metrics.outputTokens,
        stopReason: result.metrics.stopReason,
        targetWordsMin: options.targetSceneWordsMin,
        targetWordsMax: options.targetSceneWordsMax,
        actualWords: finalWords,
        notes
      })
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";

    return {
      text: currentSceneText,
      warning: `Length-Control ${action} fehlgeschlagen: ${message}`,
      stage: createStageRun({
        status: "failed",
        provider: adapter.provider,
        modelName: adapter.modelName,
        updatedAt: new Date().toISOString(),
        targetWordsMin: options.targetSceneWordsMin,
        targetWordsMax: options.targetSceneWordsMax,
        actualWords,
        notes: [`Length-Control ${action} fehlgeschlagen: ${message}`]
      })
    };
  }
}

function resolveLengthControlAction(actualWords: number, options: DraftGenerationOptions): LengthControlAction {
  if (actualWords < LENGTH_CONTROL_EMERGENCY_MIN_WORDS) {
    return "expand";
  }

  if (actualWords > LENGTH_CONTROL_EMERGENCY_MAX_WORDS) {
    return "compress";
  }

  return "accept";
}

function selectBetterLengthCandidate(
  originalText: string,
  candidateText: string,
  options: DraftGenerationOptions
) {
  if (!candidateText.trim()) {
    return originalText;
  }

  const originalPenalty = computeRangePenalty(countWords(originalText), options);
  const candidatePenalty = computeRangePenalty(countWords(candidateText), options);

  return candidatePenalty <= originalPenalty ? candidateText : originalText;
}

function computeRangePenalty(actualWords: number, options: DraftGenerationOptions) {
  if (actualWords < options.targetSceneWordsMin) {
    return options.targetSceneWordsMin - actualWords;
  }

  if (actualWords > options.targetSceneWordsMax) {
    return actualWords - options.targetSceneWordsMax;
  }

  return 0;
}

function hydrateDraftJob(
  sceneId: string,
  packet: SceneContextPacket,
  payload: DraftProviderResult,
  meta: {
    provider: BookDraftJob["provider"];
    mode: BookDraftJob["mode"];
    modelName: string | null;
  }
): BookDraftJob {
  const now = new Date().toISOString();
  const extractedState = withDraftMemorySync(payload.extractedState, {
    fallbackCreatedAt: now,
    defaultStatus: "pending"
  });
  const stateDiff = buildValidatedStateDiff(packet.sceneId, extractedState, packet);

  return {
    id: createLocalId("draft_job"),
    sceneId,
    sceneTitle: packet.dynamicContext.sceneTitle,
    createdAt: now,
    updatedAt: now,
    provider: meta.provider,
    mode: meta.mode,
    modelName: meta.modelName,
    status: "ready" as const,
    acceptedAt: null,
    outline: buildOutlineFromBeatPlan(payload.beatPlan),
    draftText: payload.draftText,
    rewriteText: payload.finalSceneText,
    rewriteNotes: payload.sceneNotes,
    extractedState,
    stateDiff,
    stateDiffStatus: "pending" as const,
    stages: payload.stages,
    contextSnapshot: {
      contextPackId: packet.dynamicContext.contextPackId || null,
      memorySyncedAt: packet.dynamicContext.memorySyncedAt,
      chapterTitle: packet.dynamicContext.chapterTitle,
      sceneSummary: packet.dynamicContext.sceneSummary,
      relevantCodexTitles: packet.dynamicContext.relevantCodex.map(function (entry) {
        return entry.title;
      }),
      relevantCharacterNames: packet.dynamicContext.relevantCharacterStates.map(function (entry) {
        return entry.characterName;
      }),
      activeThreadLabels: packet.dynamicContext.activeThreads.map(function (thread) {
        return thread.label;
      })
    }
  };
}

function buildValidatedStateDiff(
  sceneId: string,
  extractedState: DraftExtractionState,
  packet?: SceneContextPacket
): BookStateDiff {
  const stateDiff = buildStateDiffFromExtraction({
    sceneId,
    extractedState,
    objectCandidates: packet?.dynamicContext.objectCandidates ?? [],
    sceneSoftGuidance: packet?.dynamicContext.sceneSoftGuidance ?? []
  });
  const validation = validateBookStateDiff(null, stateDiff);

  return {
    ...stateDiff,
    conflicts: validation.conflicts,
    requiresHumanReview: validation.requiresHumanReview
  };
}

function createLocalExecution(
  packet: SceneContextPacket,
  targetSceneWordsMin: number,
  targetSceneWordsMax: number,
  warning: string
): BookJobExecution {
  return {
    provider: "local",
    mode: "local_fallback",
    job: createDraftJobFromPacket(packet, targetSceneWordsMin, targetSceneWordsMax),
    warning
  };
}

async function requestOpenAIStructured<T>(params: {
  client: OpenAI;
  modelName: string;
  schema: z.ZodType<T>;
  schemaName: string;
  systemPrompt: string;
  userPrompt: string;
}) {
  const startedAt = Date.now();
  const response = await params.client.responses.parse({
    model: params.modelName,
    store: false,
    reasoning: { effort: "medium" },
    input: buildOpenAIInput(params.systemPrompt, params.userPrompt),
    text: {
      format: zodTextFormat(params.schema, params.schemaName)
    }
  });

  if (!response.output_parsed) {
    throw new Error("OpenAI returned no parsed output.");
  }

  return {
    payload: response.output_parsed,
    metrics: buildOpenAIMetrics(response, params.modelName, startedAt)
  };
}

async function requestOpenAIText(params: {
  client: OpenAI;
  modelName: string;
  systemPrompt: string;
  userPrompt: string;
  maxOutputTokens: number;
}) {
  const startedAt = Date.now();
  const response = await params.client.responses.create({
    model: params.modelName,
    store: false,
    reasoning: { effort: "medium" },
    input: buildOpenAIInput(params.systemPrompt, params.userPrompt),
    max_output_tokens: params.maxOutputTokens
  });
  const text = response.output_text?.trim();

  if (!text) {
    throw new Error("OpenAI returned no text output.");
  }

  return {
    text,
    metrics: buildOpenAIMetrics(response, params.modelName, startedAt)
  };
}

async function requestAnthropicStructured<T>(params: {
  client: Anthropic;
  stageName: AnthropicStructuredStageName;
  modelName: string;
  maxTokens: number;
  schema: z.ZodType<T>;
  systemBlocks: Anthropic.TextBlockParam[];
  userPrompt: string;
}) {
  const startedAt = Date.now();
  try {
    const message = await params.client.messages.parse({
      betas: [...ANTHROPIC_CACHE_BETAS],
      model: params.modelName,
      max_tokens: params.maxTokens + ANTHROPIC_THINKING_HEADROOM_TOKENS,
      system: params.systemBlocks,
      messages: [
        {
          role: "user",
          content: params.userPrompt
        }
      ],
      output_config: {
        format: zodOutputFormat(params.schema)
      }
    });

    if (!message.parsed_output) {
      throw new Error("Anthropic returned no parsed output.");
    }

    return {
      payload: message.parsed_output,
      metrics: buildAnthropicMetrics(message, params.modelName, startedAt)
    };
  } catch (initialError) {
    return requestAnthropicStructuredFallback(params, startedAt, initialError);
  }
}

async function requestAnthropicText(params: {
  client: Anthropic;
  modelName: string;
  maxTokens: number;
  systemBlocks: Anthropic.TextBlockParam[];
  userPrompt: string;
}) {
  const startedAt = Date.now();
  const message = await params.client.messages.create({
    model: params.modelName,
    max_tokens: params.maxTokens + ANTHROPIC_THINKING_HEADROOM_TOKENS,
    system: params.systemBlocks,
    messages: [
      {
        role: "user",
        content: params.userPrompt
      }
    ]
  }, buildAnthropicCacheRequestOptions());
  const text = collectAnthropicText(message).trim();

  if (!text) {
    throw new Error("Anthropic returned no text output.");
  }

  return {
    text,
    metrics: buildAnthropicMetrics(message, params.modelName, startedAt)
  };
}

function buildOpenAIInput(systemPrompt: string, userPrompt: string) {
  return [
    {
      role: "system" as const,
      content: systemPrompt
    },
    {
      role: "user" as const,
      content: userPrompt
    }
  ];
}

function buildOpenAIMetrics(
  response: {
    usage?: { input_tokens: number; output_tokens: number } | null;
    incomplete_details?: { reason?: string | null } | null;
    status?: string | null;
  },
  modelName: string,
  startedAt: number
): StageCallMetrics {
  return {
    modelName,
    attemptCount: 1,
    repairCount: 0,
    durationMs: Date.now() - startedAt,
    inputTokens: response.usage?.input_tokens ?? null,
    outputTokens: response.usage?.output_tokens ?? null,
    stopReason: response.incomplete_details?.reason ?? response.status ?? null
  };
}

function buildAnthropicMetrics(
  message: Anthropic.Message,
  modelName: string,
  startedAt: number
): StageCallMetrics {
  const inputTokens =
    (message.usage.input_tokens ?? 0) +
      (message.usage.cache_creation_input_tokens ?? 0) +
      (message.usage.cache_read_input_tokens ?? 0) || null;

  return {
    modelName,
    attemptCount: 1,
    repairCount: 0,
    durationMs: Date.now() - startedAt,
    inputTokens,
    outputTokens: message.usage.output_tokens ?? null,
    stopReason: message.stop_reason ?? null
  };
}

function resolveOpenAIProseMaxTokens(targetWordMax: number) {
  return clampNumber(Math.round(targetWordMax * 3.2), OPENAI_PROSE_MIN_TOKENS, OPENAI_PROSE_MAX_TOKENS);
}

function resolveAnthropicProseMaxTokens(targetWordMax: number) {
  return clampNumber(
    Math.round(targetWordMax * 3.25),
    ANTHROPIC_PROSE_MIN_TOKENS,
    ANTHROPIC_PROSE_MAX_TOKENS
  );
}

function buildHumanEditProfilePrompt(
  examples: BookHumanEditExample[],
  packet: SceneContextPacket
) {
  const included = dedupeHumanEditExamples(examples)
    .filter(function (example) {
      return example.learningStatus === "included";
    })
    .sort(function (a, b) {
      const laneA = a.categoryLane === packet.stablePrefix.categoryLane ? 1 : 0;
      const laneB = b.categoryLane === packet.stablePrefix.categoryLane ? 1 : 0;

      if (laneA !== laneB) {
        return laneB - laneA;
      }

      return b.updatedAt.localeCompare(a.updatedAt);
    })
    .slice(0, 12);

  if (!included.length) {
    return "";
  }

  const tagCounts = new Map<string, number>();
  included.forEach(function (example) {
    example.editTags.forEach(function (tag) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + Math.max(0.5, example.learningWeight));
    });
  });
  const dominantTags = Array.from(tagCounts.entries())
    .sort(function (a, b) {
      return b[1] - a[1];
    })
    .slice(0, 8)
    .map(function ([tag]) {
      return tag;
    });

  return [
    "Human Edit Memory:",
    "Use these as preference signals from previous accepted human edits. Do not copy old plot content, sentences, names, or scene events.",
    dominantTags.length
      ? `Dominant edit tendencies: ${dominantTags.join(", ")}.`
      : "Dominant edit tendencies: none detected yet.",
    "Apply the pattern only when it improves this scene:",
    ...included.slice(0, 8).map(function (example, index) {
      const tags = example.editTags.length ? ` Tags: ${example.editTags.join(", ")}.` : "";
      const delta = example.diffSummary.wordDelta === 0 ? "no word delta" : `${example.diffSummary.wordDelta > 0 ? "+" : ""}${example.diffSummary.wordDelta} words`;
      const focusedSnippet = buildFocusedHumanEditSnippet(example);

      return [
        `${index + 1}. ${example.sceneTitle || "Untitled scene"}: ${example.diffSummary.summary} (${delta}).${tags}`,
        `Before pattern: ${focusedSnippet.before}`,
        `After pattern: ${focusedSnippet.after}`
      ].join("\n");
    })
  ].join("\n");
}

function buildFocusedHumanEditSnippet(example: BookHumanEditExample) {
  const sourceText = example.sourceText || example.diffSummary.sourcePreview;
  const editedText = example.editedText || example.diffSummary.editedPreview;

  if (!sourceText || !editedText || sourceText === editedText) {
    return {
      before: truncateText(example.diffSummary.sourcePreview, 180),
      after: truncateText(example.diffSummary.editedPreview, 180)
    };
  }

  const sourceWindow = getChangedTextWindow(sourceText, editedText);
  const editedWindow = getChangedTextWindow(editedText, sourceText);

  return {
    before: truncateText(normalizePromptWhitespace(sourceWindow), 260),
    after: truncateText(normalizePromptWhitespace(editedWindow), 260)
  };
}

function getChangedTextWindow(primary: string, secondary: string) {
  let start = 0;

  while (start < primary.length && start < secondary.length && primary[start] === secondary[start]) {
    start += 1;
  }

  let endPrimary = primary.length - 1;
  let endSecondary = secondary.length - 1;

  while (endPrimary >= start && endSecondary >= start && primary[endPrimary] === secondary[endSecondary]) {
    endPrimary -= 1;
    endSecondary -= 1;
  }

  return primary.slice(Math.max(0, start - 140), Math.min(primary.length, endPrimary + 141));
}

function normalizePromptWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function dedupeHumanEditExamples(examples: BookHumanEditExample[]) {
  const byId = new Map<string, BookHumanEditExample>();
  const byBusinessKey = new Map<string, BookHumanEditExample>();

  examples.forEach(function (example) {
    const key = createHumanEditBusinessKey(example);
    const existing = byId.get(example.id) || byBusinessKey.get(key);
    
    const effective = existing ? { ...existing, ...example } : example;

    byId.set(effective.id, effective);
    byBusinessKey.set(key, effective);
  });

  return Array.from(byId.values());
}

function createHumanEditBusinessKey(example: Pick<BookHumanEditExample, "draftJobId" | "acceptedAt">) {
  return `${example.draftJobId}:${normalizeHumanEditTimestampKey(example.acceptedAt)}`;
}

function normalizeHumanEditTimestampKey(value: string | null) {
  if (!value) {
    return "";
  }

  const timestamp = Date.parse(value);

  if (Number.isNaN(timestamp)) {
    return value;
  }

  return new Date(timestamp).toISOString();
}

function buildSystemPrompt(packet: SceneContextPacket, options?: DraftGenerationOptions) {
  return [
    buildCoreSystemPrompt(),
    buildGenreEnginePrompt(packet.stablePrefix.engineMode),
    options ? buildProseStablePrefixPrompt(packet) : buildAuditStablePrefixPrompt(packet),
    options ? buildProseStyleBrakePrompt() : "",
    options?.humanEditProfile || ""
  ].filter(Boolean).join("\n\n");
}

function buildCoreSystemPrompt() {
  return [
    "You are the drafting engine for EMBER Book Studio.",
    "Write all output in German. Use Präteritum throughout. Never switch tense within a scene.",
    "Honor canon, continuity, and scene-level causality.",
    "Hard constraints protect canon. Scene guidance describes intention. Prose belongs to the model.",
    "Hard anchors for names, colors, places, times, and explicitly locked objects are literal constraints, not inspiration.",
    "If context is insufficient, flag risk explicitly instead of inventing hidden facts.",
    "Favor scene truth, subtext, momentum, concrete observation, and readable prose over explanation-heavy interpretation.",
    "Show, do not over-explain. If an image, gesture, or action already carries meaning, do not add a second sentence that explains it.",
    "Narrator and POV discipline: Follow the project-specific narrator contract when one is provided. If no narrator contract is provided, stay within the perceptual boundary of the POV character; do not add knowledge, emotion, or observation the scene cannot support.",
    "Keep inner reflection shorter than the action that triggers it unless the scene is explicitly introspective.",
    "Do not recap the scene to the reader. Let action, objects, interaction, and consequence carry the movement.",
    "The prose should feel immediate and necessary, not over-designed.",
    "Use only abstract technique guidance from EMBER. Never imitate, paraphrase, or echo recognizable phrasing from a specific author, comp title, or reference excerpt.",
    "If the technique profile asks for more pressure, achieve it through original scene construction, not through borrowed stylistic signatures."
  ].join("\n");
}

function buildProseStyleBrakePrompt() {
  return [
    "PROSA-FREIRAUM:",
    "Nutze Kontext als Sicherheitsnetz, nicht als Checkliste.",
    "Schreibe die Szene aus ihrer natuerlichen Bewegung: konkrete Handlung, Dialog, Koerper, Objekt, Reibung, Konsequenz.",
    "Wenn ein Bild, eine Geste oder eine Dialogzeile Bedeutung bereits traegt, vertraue ihr.",
    "Materialdetails sind Szenentextur. Benenne ihre Bedeutung nur, wenn eine Figur das natuerlich sagen wuerde.",
    "Variiere Satzlaenge und Absatzrhythmus nach Szene, Figur und Druck; erzwinge kein mechanisches Muster."
  ].join("\n");
}

function buildProseStablePrefixPrompt(packet: SceneContextPacket) {
  const narratorContract = extractNarratorContractRules(packet.stablePrefix.writerConstitution);
  const writerRules = extractProseWriterRules(packet.stablePrefix.writerConstitution);

  return [
    `Premise: ${packet.stablePrefix.premise}`,
    `Reader promise: ${packet.stablePrefix.readerPromise}`,
    `Thematic core: ${packet.stablePrefix.thematicCore}`,
    `Author intent: ${packet.stablePrefix.authorIntent || "not set"}`,
    `Current focus: ${packet.stablePrefix.currentFocus || "not set"}`,
    formatPromptList("Locked facts", formatLockedFacts(packet)),
    formatPromptList("Narrator contract", narratorContract),
    formatPromptList("Writer rules", writerRules),
    formatPromptList(
      "Prose preferences",
      formatTechniqueProfile(packet.stablePrefix.proseTechniqueProfile).slice(0, 8)
    )
  ].join("\n");
}

function extractNarratorContractRules(rules: string[]) {
  return rules.filter(isNarratorContractRule).slice(0, 16);
}

function extractProseWriterRules(rules: string[]) {
  return rules.filter(function (rule) {
    return !isNarratorContractRule(rule);
  }).slice(0, 12);
}

function isNarratorContractRule(rule: string) {
  return (
    /^NARRATOR:/i.test(rule) ||
    /erzaehler|erzähler|auktorial|figurenfaerbung|figurenfärbung|stilanker|liebevoll-spoettisch|liebevoll-spöttisch|wirklich-jetzt|seltener, leiser|kontrollblick/i.test(rule)
  );
}

function buildAuditStablePrefixPrompt(packet: SceneContextPacket) {
  const narratorContract = extractNarratorContractRules(packet.stablePrefix.writerConstitution);

  return [
    `Premise: ${packet.stablePrefix.premise}`,
    `Reader promise: ${packet.stablePrefix.readerPromise}`,
    `Ending promise: ${packet.stablePrefix.endingPromise}`,
    `Thematic core: ${packet.stablePrefix.thematicCore}`,
    `Author intent: ${packet.stablePrefix.authorIntent || "not set"}`,
    `Current focus: ${packet.stablePrefix.currentFocus || "not set"}`,
    `Commercial lane: ${packet.stablePrefix.categoryLane || "not set"}`,
    `Commercial hook: ${packet.stablePrefix.marketHook || "not set"}`,
    formatPromptList("Locked facts", formatLockedFacts(packet)),
    formatPromptList(
      "Prose technique profile",
      formatTechniqueProfile(packet.stablePrefix.proseTechniqueProfile)
    ),
    formatPromptList(
      "Anti-imitation rules",
      packet.stablePrefix.proseTechniqueProfile.antiImitationRules
    ),
    formatPromptList("Narrator contract", narratorContract),
    formatPromptList("Story architecture", packet.stablePrefix.storyArchitecture),
    formatPromptList("Writer constitution", packet.stablePrefix.writerConstitution),
    formatPromptList("Continuity guardrails", packet.stablePrefix.continuityGuardrails),
    formatPromptList("Publishing guardrails", packet.stablePrefix.publishingGuardrails)
  ].join("\n");
}

function buildAnthropicSystemPromptBlocks(packet: SceneContextPacket) {
  const genrePrompt = buildGenreEnginePrompt(packet.stablePrefix.engineMode);

  return [
    {
      type: "text" as const,
      text: buildCoreSystemPrompt()
    },
    ...(genrePrompt ? [{ type: "text" as const, text: genrePrompt }] : []),
    {
      type: "text" as const,
      text: buildAuditStablePrefixPrompt(packet),
      cache_control: { type: "ephemeral" as const, ttl: ANTHROPIC_CACHE_TTL }
    },
    {
      type: "text" as const,
      text: buildAnthropicDynamicContextPrompt(packet),
      cache_control: { type: "ephemeral" as const, ttl: ANTHROPIC_CACHE_TTL }
    }
  ];
}

function buildAnthropicProseSystemPromptBlocks(packet: SceneContextPacket, options: DraftGenerationOptions) {
  const genrePrompt = buildGenreEnginePrompt(packet.stablePrefix.engineMode);
  const blocks = [
    {
      type: "text" as const,
      text: buildCoreSystemPrompt()
    },
    ...(genrePrompt ? [{ type: "text" as const, text: genrePrompt }] : []),
    {
      type: "text" as const,
      text: buildProseStablePrefixPrompt(packet),
      cache_control: { type: "ephemeral" as const, ttl: ANTHROPIC_CACHE_TTL }
    },
    {
      type: "text" as const,
      text: buildProseStyleBrakePrompt()
    }
  ];

  if (options.humanEditProfile) {
    blocks.push({
      type: "text" as const,
      text: options.humanEditProfile
    });
  }

  return blocks;
}

function buildAnthropicDynamicContextPrompt(packet: SceneContextPacket) {
  return [
    "Scene-bound dynamic context for this job:",
    buildSceneContextPrompt(packet),
    "",
    "Continuity focus:",
    buildContinuityContext(packet)
  ].join("\n");
}

function buildDraftProsePrompt(
  packet: SceneContextPacket,
  options: DraftGenerationOptions,
  beatPlan: BeatPlanPayload
) {
  return [
    "Write the first draft of the selected scene.",
    "Return prose only. No JSON, no headings, no bullet points, no commentary.",
    `Preferred scene range: ${options.targetSceneWordsMin}-${options.targetSceneWordsMax} words.`,
    "If the scene closes naturally before the preferred range or needs more space, follow the scene.",
    "Do not pad the scene to satisfy length. Do not compress away necessary pressure.",
    "Do not summarize the intended scene. Build it through action, dialogue, objects, pressure, silence, and consequence.",
    "Do not explain character psychology before or after the scene has made it visible.",
    "Let the scene turn through a concrete action, discovery, refusal, mistake, interruption, withheld answer, or changed access.",
    "End on a visible change in behavior, access, risk, knowledge, or physical situation; do not end by explaining what the change means.",
    "After a gesture, image, object, or line of dialogue has carried meaning, do not add a second sentence that interprets it for the reader.",
    "This is a fast but complete scene pass. Stay scene-bound and keep exposition compressed.",
    "Write the scene directly from the material at hand. Keep some sentences raw enough that the prose stays alive.",
    "Follow the prose technique profile as an abstract craft brief, not as author imitation.",
    buildProseSceneContextPrompt(packet),
    options.directorNote ? `Director note: ${options.directorNote}` : "Director note: none"
  ].join("\n");
}

function buildExpandPrompt(
  packet: SceneContextPacket,
  options: DraftGenerationOptions,
  beatPlan: BeatPlanPayload,
  finalSceneText: string
) {
  return [
    "Expand the scene while preserving continuity and voice.",
    "Expand only where the current scene skips over a decision, reaction, obstacle, sensory turn, or relationship beat.",
    "Do not add decorative description. Every added paragraph must change access, pressure, knowledge, emotion, or timing.",
    "Return prose only.",
    `Preferred scene range: ${options.targetSceneWordsMin}-${options.targetSceneWordsMax} words.`,
    "This is an emergency length repair. Add only necessary scene substance, not padding.",
    "Deepen the existing scene movement. Add only pressure-bearing physical detail, reaction, and tension. Do not add side plots.",
    "Preserve the technique profile. Do not drift into explanatory filler or recognizable borrowed voice.",
    buildProseSceneContextPrompt(packet),
    `Current scene text: ${finalSceneText}`
  ].join("\n");
}

function buildCompressPrompt(
  packet: SceneContextPacket,
  options: DraftGenerationOptions,
  beatPlan: BeatPlanPayload,
  finalSceneText: string
) {
  return [
    "Compress the scene while preserving all essential story movement.",
    "Return prose only.",
    `Preferred scene range: ${options.targetSceneWordsMin}-${options.targetSceneWordsMax} words.`,
    "This is an emergency length repair. Cut only material that weakens scene pressure.",
    "Cut exposition, repeated reflection, redundant gestures, and duplicate information. Do not cut the dramatic turn or closing hook.",
    "Do not compress away ambiguity, subtext, narrator color, or the emotional consequence of the turn.",
    "Preserve the technique profile. Remove explanation before you remove pressure-bearing objects, reversals, or hook images.",
    buildProseSceneContextPrompt(packet),
    `Current scene text: ${finalSceneText}`
  ].join("\n");
}

function buildStateExtractionPrompt(
  packet: SceneContextPacket,
  options: DraftGenerationOptions,
  beatPlan: BeatPlanPayload,
  finalSceneText: string
) {
  return [
    "Extract scene state from the finished scene text.",
    "Return only structured output matching the requested schema.",
    `Preferred scene range: ${options.targetSceneWordsMin}-${options.targetSceneWordsMax} words.`,
    "Rules:",
    "- Character updates should capture changed behavior, trust, fear, status, secrecy, pressure, or relationship movement, not vague emotions.",
    "- Open threads should prefer unresolved choices, secrets, risks, promises, threats, or unanswered questions created by the scene.",
    "- Foreshadowing must be concrete: object, phrase, behavior, absence, warning, pattern, or contradiction. No thematic guesses.",
    "- Do not extract a fact just because it is beautifully phrased. Extract only if it changes future continuity.",
    "- sceneNotes must describe useful editorial observations, not praise.",
    "- sceneNotes: 1 to 4 items, each under 100 characters.",
    "- Every extractedState list: 0 to 3 items, each under 100 characters.",
    "- Every extractedState entry must be a plain string. No objects.",
    "- extractedState must stay conservative: explicit facts only.",
    "- Extracted facts are review candidates, not canon; do not promote guesses or renamed entities.",
    "- Any mismatch against hard names, colors, proof objects, places, or times belongs in continuityRisks.",
    "- Any drift away from the prose technique profile belongs in styleDriftNotes.",
    "- Prefer empty arrays over speculative entries.",
    "- Uncertainty belongs only in continuityRisks.",
    buildSceneContextPrompt(packet),
    buildSceneIntentionPrompt(packet),
    `Final scene text: ${finalSceneText}`
  ].join("\n");
}

function buildContinuityAuditPrompt(
  packet: SceneContextPacket,
  options: DraftGenerationOptions,
  beatPlan: BeatPlanPayload,
  draftText: string,
  finalSceneText: string,
  extractedState: DraftExtractionState
) {
  return [
    "Audit this scene for continuity and style drift only.",
    "Return only structured output matching the requested schema.",
    `Preferred scene range: ${options.targetSceneWordsMin}-${options.targetSceneWordsMax} words.`,
    "Do not rewrite the scene. Only flag issues that matter for canon or stylistic consistency.",
    "Do not flag theoretical issues. Only flag risks supported by the scene text, packet context, or established rules.",
    "Check style against the prose technique profile and anti-imitation rules, not against named authors.",
    "Keep every listed issue compact.",
    "Check whether character behavior matches established psychology, pressure, fear, desire, and relationship state.",
    "Check whether powers, technology, mentors, institutions, or antagonists solve problems too easily.",
    "Check whether the scene advances or preserves the intended tension instead of flattening it through explanation.",
    "Check whether narrator distance and narrator commentary match the established narrator contract.",
    "Check whether new information changes who knows what, and whether any character reacts to knowledge they should not have.",
    "Check whether escalation is plausible: no institution, threat, power, or relationship should jump ahead without setup.",
    buildSceneContextPrompt(packet),
    buildSceneIntentionPrompt(packet),
    `Initial scene text: ${draftText}`,
    `Final scene text: ${finalSceneText}`,
    `Existing continuity risks: ${extractedState.continuityRisks.join(" | ") || "none"}`,
    `Existing style drift notes: ${extractedState.styleDriftNotes.join(" | ") || "none"}`
  ].join("\n");
}

function buildQualityEvalPrompt(
  packet: SceneContextPacket,
  options: DraftGenerationOptions,
  beatPlan: BeatPlanPayload,
  finalSceneText: string,
  extractedState: DraftExtractionState
) {
  return [
    "Evaluate the final scene quality.",
    "Return only structured output matching the requested schema.",
    "Score from 0 to 10.",
    `wordTargetMin must equal the preferred lower range ${options.targetSceneWordsMin}.`,
    `wordTargetMax must equal the preferred upper range ${options.targetSceneWordsMax}.`,
    `wordActual must equal the actual word count of the scene text.`,
    "Do not penalize organic scene length inside normal bounds. Flag only if the scene feels underdeveloped or bloated.",
    "Issues should be short, concrete, and user-facing.",
    "Each issue should name the problem and the likely repair direction, not just a vague weakness.",
    "Keep every issue compact.",
    "Score harshly. 7 means usable, not excellent. 8 means strong with minor issues. 9-10 require vivid scene movement, specific pressure, clean prose, and no major continuity or style weakness.",
    "Penalize generic emotional explanation, decorative description, exposition disguised as dialogue, and scenes that fulfill plot without changing relationships or pressure.",
    "Market fit means the scene satisfies the project's lane and reader promise, not generic commercial polish.",
    "Specificity means concrete objects, actions, bodily behavior, social pressure, and scene-specific language.",
    "Reward original prose that follows the technique profile without sounding derivative or overdesigned.",
    buildSceneContextPrompt(packet),
    buildSceneIntentionPrompt(packet),
    `Extracted continuity risks: ${extractedState.continuityRisks.join(" | ") || "none"}`,
    `Final scene text: ${finalSceneText}`
  ].join("\n");
}

function buildAnthropicScenePrompt(params: {
  mode: "draft" | "expand" | "compress";
  packet: SceneContextPacket;
  options: DraftGenerationOptions;
  beatPlan: BeatPlanPayload;
  finalSceneText?: string;
}) {
  const modeInstruction =
    params.mode === "draft"
      ? [
          `Write the scene with a preferred range of ${params.options.targetSceneWordsMin}-${params.options.targetSceneWordsMax} words.`,
          "If the scene closes naturally before that or needs more space, follow the scene.",
          "Do not pad for length.",
          "Do not summarize the intended scene. Build it through action, dialogue, objects, pressure, silence, and consequence.",
          "Do not explain character psychology before or after the scene has made it visible.",
          "Let the scene turn through a concrete action, discovery, refusal, mistake, interruption, withheld answer, or changed access.",
          "End on a visible change in behavior, access, risk, knowledge, or physical situation; do not end by explaining what the change means.",
          "After a gesture, image, object, or line of dialogue has carried meaning, do not add a second sentence that interprets it for the reader."
        ].join(" ")
      : params.mode === "expand"
        ? [
            "Emergency-expand the scene only enough to avoid an underdeveloped fragment.",
            "Expand only where the current scene skips over a decision, reaction, obstacle, sensory turn, or relationship beat.",
            "Do not add decorative description.",
            "Every added paragraph must change access, pressure, knowledge, emotion, or timing.",
            "Add necessary pressure, not padding."
          ].join(" ")
        : [
            "Emergency-compress the scene only enough to avoid a bloated outlier.",
            "Preserve necessary pressure.",
            "Cut exposition, repeated reflection, redundant gestures, and duplicate information first.",
            "Do not compress away ambiguity, subtext, narrator color, or the emotional consequence of the turn."
          ].join(" ");

  return [
    `<scene_context>${escapeXml(buildProseSceneContextPrompt(params.packet))}</scene_context>`,
    params.options.directorNote
      ? `<director_note>${escapeXml(params.options.directorNote)}</director_note>`
      : "",
    params.finalSceneText ? `<current_scene_text>${escapeXml(params.finalSceneText)}</current_scene_text>` : "",
    `<output_contract>${escapeXml(`${modeInstruction} Return prose only in German. No headings, no JSON, no commentary.`)}</output_contract>`
  ]
    .filter(Boolean)
    .join("\n");
}

function buildSceneContextPrompt(packet: SceneContextPacket) {
  return [
    `Act: ${packet.dynamicContext.actTitle}`,
    `Chapter: ${packet.dynamicContext.chapterTitle}`,
    `Scene: ${packet.dynamicContext.sceneTitle}`,
    `Scene card id: ${packet.dynamicContext.sceneCardLabel || "not set"}`,
    `Scene header hints: ${packet.dynamicContext.sceneHeaderHints.join(" || ") || "none"}`,
    `Hard scene constraints: ${packet.dynamicContext.sceneHardConstraints.join(" || ") || "none"}`,
    `Soft scene guidance: ${packet.dynamicContext.sceneSoftGuidance.join(" || ") || "none"}`,
    `Scene summary: ${packet.dynamicContext.sceneSummary}`,
    `Scene excerpt: ${packet.dynamicContext.sceneExcerpt}`,
    `Scene card outline: ${packet.dynamicContext.sceneCardOutline.join(" || ") || "none"}`,
    `Context pack id: ${packet.dynamicContext.contextPackId || "generated_locally"}`,
    `Locked facts: ${formatLockedFacts(packet).join(" || ") || "none"}`,
    `Prose technique profile: ${formatTechniqueProfile(packet.stablePrefix.proseTechniqueProfile).join(" || ") || "none"}`,
    `Previous beats: ${packet.dynamicContext.previousBeats
      .map(function (beat) {
        return `${beat.sceneTitle}: ${beat.summary || beat.excerpt}`;
      })
      .join(" || ") || "none"}`,
    `Next beat: ${packet.dynamicContext.nextBeatTitle || "none"}`,
    `Relevant codex: ${packet.dynamicContext.relevantCodex
      .map(function (entry) {
        return `${entry.title}: ${entry.summary}`;
      })
      .join(" || ") || "none"}`,
    `Relevant character states: ${packet.dynamicContext.relevantCharacterStates
      .map(function (entry) {
        return formatCharacterStatePrompt(entry);
      })
      .join(" || ") || "none"}`,
    `Active threads: ${packet.dynamicContext.activeThreads
      .map(function (thread) {
        return `${thread.label}: ${thread.detail}`;
      })
      .join(" || ") || "none"}`
  ].join("\n");
}

function buildProseSceneContextPrompt(packet: SceneContextPacket) {
  const proseConstraints = filterProseHardConstraints(packet.dynamicContext.sceneHardConstraints);
  const narratorContract = extractNarratorContractRules(packet.stablePrefix.writerConstitution).slice(0, 8);
  const sceneNarratorAnchor = findGuidanceValue(packet.dynamicContext.sceneSoftGuidance, "Narrator anchor:");

  return [
    `Act: ${packet.dynamicContext.actTitle}`,
    `Chapter: ${packet.dynamicContext.chapterTitle}`,
    `Scene: ${packet.dynamicContext.sceneTitle}`,
    `Narrator contract for this scene: ${narratorContract.join(" | ") || "none"}`,
    `Scene narrator anchor: ${sceneNarratorAnchor || "none"}`,
    buildSceneIntentionPrompt(packet),
    `Hard scene constraints: ${proseConstraints.join(" || ") || "none"}`,
    `Locked facts: ${formatLockedFacts(packet).join(" || ") || "none"}`,
    `Scene summary: ${packet.dynamicContext.sceneSummary}`,
    `Relevant codex: ${packet.dynamicContext.relevantCodex
      .map(function (entry) {
        return `${entry.title}: ${entry.summary}`;
      })
      .join(" || ") || "none"}`,
    `Relevant character states: ${packet.dynamicContext.relevantCharacterStates
      .map(function (entry) {
        return formatCharacterStatePrompt(entry);
      })
      .join(" || ") || "none"}`,
    `Active threads: ${packet.dynamicContext.activeThreads
      .map(function (thread) {
        return `${thread.label}: ${thread.detail}`;
      })
      .join(" || ") || "none"}`
  ].join("\n");
}

function filterProseHardConstraints(constraints: string[]) {
  return constraints.filter(function (constraint) {
    return !(
      constraint.startsWith("Pflicht-Einstieg:") ||
      constraint.startsWith("Pflicht-Kernaktion:") ||
      constraint.startsWith("Pflicht-Beat:") ||
      constraint.startsWith("Pflicht-Ende:") ||
      constraint.startsWith("Pflicht-Schlusssatz oder Schlussbild:") ||
      constraint.startsWith("Szenenziel:")
    );
  });
}

function buildSceneIntentionPrompt(packet: SceneContextPacket) {
  const intention = buildSceneIntention(packet);

  return [
    "Scene intention:",
    "Do not announce the irreversible change. Let the reader infer it from altered access, behavior, knowledge, relationship, or risk.",
    "Use soft guidance as intention, not as a checklist. Do not mechanically include every listed object, phrase, or beat.",
    "Preserve the scene's irreversible change; find the most natural path there.",
    "Aftertaste is not a required closing sentence.",
    `Situation: ${intention.situation}`,
    `Want: ${intention.want}`,
    `Pressure: ${intention.pressure}`,
    `Concrete material: ${intention.concreteMaterial}`,
    `Intended turn: ${intention.intendedTurn}`,
    `Irreversible change: ${intention.irreversibleChange}`,
    `Narrator anchor: ${intention.narratorAnchor}`,
    `Aftertaste: ${intention.aftertaste}`,
    `Avoid: ${intention.avoid.join(" | ") || "none"}`
  ].join("\n");
}

function buildSceneIntention(packet: SceneContextPacket): SceneIntentionPayload {
  const softGuidance = packet.dynamicContext.sceneSoftGuidance;
  const outline = packet.dynamicContext.sceneCardOutline;
  const summary = packet.dynamicContext.sceneSummary || packet.dynamicContext.sceneTitle;
  const firstOutline = outline[0] || "";
  const lastOutline = outline[outline.length - 1] || "";

  return {
    situation: cleanIntentionValue(findGuidanceValue(softGuidance, "Situation:") || firstOutline || summary),
    want: cleanIntentionValue(findGuidanceValue(softGuidance, "Want:") || "Let the POV character want something concrete in the scene."),
    pressure: cleanIntentionValue(findGuidanceValue(softGuidance, "Pressure:") || "Let another person, institution, object, or routine make the want harder."),
    concreteMaterial: cleanIntentionValue(findGuidanceValue(softGuidance, "Concrete material:") || "Use 1-3 concrete details that naturally belong in the room."),
    intendedTurn: cleanIntentionValue(findGuidanceValue(softGuidance, "Intended turn:") || lastOutline || "Let knowledge, access, relationship, or self-image shift."),
    irreversibleChange: cleanIntentionValue(findGuidanceValue(softGuidance, "Irreversible change:") || findGuidanceValue(softGuidance, "Aftertaste:") || "Make one thing unable to go back to how it was before."),
    narratorAnchor: cleanIntentionValue(findGuidanceValue(softGuidance, "Narrator anchor:") || "Follow the project narrator contract when present; do not flatten narrator color into neutral report."),
    aftertaste: cleanIntentionValue(findGuidanceValue(softGuidance, "Aftertaste:") || lastOutline || "Leave a felt consequence without explaining the theme."),
    avoid: buildAvoidGuidance(packet, softGuidance)
  };
}

function buildAvoidGuidance(packet: SceneContextPacket, softGuidance: string[]) {
  return dedupeStrings([
    findGuidanceValue(softGuidance, "Avoid:"),
    "No recap of facts already visible in documents, objects, dialogue, or action.",
    "No motive explanation after the image or gesture has carried the meaning.",
    "No future summary, diagnosis, or theme sentence at the end.",
    packet.stablePrefix.writerConstitution.some(function (rule) {
      return /subtext|erkl.r|explain|show/i.test(rule);
    })
      ? "Honor subtext rules from the writer constitution; let pressure stay external where possible."
      : ""
  ]).filter(Boolean).slice(0, 4);
}

function findGuidanceValue(guidance: string[], prefix: string) {
  const match = guidance.find(function (entry) {
    return entry.startsWith(prefix);
  });

  if (!match) {
    return "";
  }

  return match.slice(prefix.length).trim();
}

function cleanIntentionValue(value: string) {
  return truncateText(
    value
      .replace(/\s+/g, " ")
      .replace(/\. (Die Szene darf|Dieses [^.]+ darf|Diese [^.]+ muss|[^.]+ bleibt Kind|Farbe, Funktion).+$/u, ".")
      .trim(),
    260
  );
}

function buildSceneContextXml(packet: SceneContextPacket) {
  return escapeXml(buildSceneContextPrompt(packet));
}

function buildContinuityContext(packet: SceneContextPacket) {
  return [
    `Locked facts: ${formatLockedFacts(packet).join(" | ") || "none"}`,
    `Prose technique profile: ${formatTechniqueProfile(packet.stablePrefix.proseTechniqueProfile).join(" | ") || "none"}`,
    `Anti-imitation rules: ${packet.stablePrefix.proseTechniqueProfile.antiImitationRules.join(" | ") || "none"}`,
    `Continuity guardrails: ${packet.stablePrefix.continuityGuardrails.join(" | ") || "none"}`,
    `Relevant codex: ${packet.dynamicContext.relevantCodex
      .map(function (entry) {
        return `${entry.title}: ${entry.summary}`;
      })
      .join(" | ") || "none"}`,
    `Hard scene constraints: ${packet.dynamicContext.sceneHardConstraints.join(" | ") || "none"}`,
    `Relevant character states: ${packet.dynamicContext.relevantCharacterStates
      .map(function (entry) {
        return formatCharacterStatePrompt(entry);
      })
      .join(" | ") || "none"}`,
    `Active threads: ${packet.dynamicContext.activeThreads
      .map(function (thread) {
        return `${thread.label}: ${thread.detail}`;
      })
      .join(" | ") || "none"}`
  ].join("\n");
}

function formatPromptList(label: string, items: string[]) {
  const compactItems = items
    .map(function (item) {
      return item.trim();
    })
    .filter(Boolean);

  if (!compactItems.length) {
    return `${label}: none`;
  }

  return `${label}: ${compactItems.join(" | ")}`;
}

function formatLockedFacts(packet: SceneContextPacket) {
  const lockedFacts = packet.stablePrefix.lockedFacts;
  const common = getCommonLockedFacts(lockedFacts);
  const items = [
    ...formatLockedFactArray("common.protagonistNames", common.protagonistNames),
    ...formatLockedFactArray("common.antagonistNames", common.antagonistNames),
    ...formatLockedFactArray("common.institutionNames", common.institutionNames),
    ...formatLockedFactArray("common.keyObjectNames", common.keyObjectNames),
    ...formatLockedFactArray("common.fixedLocations", common.fixedLocations),
    ...formatLockedFactArray("common.fixedDates", common.fixedDates)
  ];

  if (
    packet.stablePrefix.engineMode === "domestic_suspense_thriller" ||
    packet.stablePrefix.engineMode === "default"
  ) {
    const domestic = getDomesticSuspenseLockedFacts(lockedFacts);
    items.push(
      ...formatLockedFactObject("domestic_suspense_thriller", {
        childName: domestic.childName,
        coparentName: domestic.coparentName,
        institutionName: domestic.institutionName,
        incidentDate: domestic.incidentDate,
        incidentTime: domestic.incidentTime,
        notificationTime: domestic.notificationTime,
        firstOfficeTime: domestic.firstOfficeTime,
        documentedPickupPerson: domestic.documentedPickupPerson,
        alibiLocation: domestic.alibiLocation,
        alibiWindow: domestic.alibiWindow
      })
    );
  }

  if (packet.stablePrefix.engineMode === "ya_superhero_origin") {
    const yaSuperhero = getYaSuperheroLockedFacts(lockedFacts);
    items.push(
      ...formatLockedFactArray("ya_superhero_origin.teamMemberNames", yaSuperhero.teamMemberNames),
      ...formatLockedFactObject("ya_superhero_origin", {
        substanceName: yaSuperhero.substanceName,
        aiCompanionName: yaSuperhero.aiCompanionName,
        experimentLocation: yaSuperhero.experimentLocation,
        organizationName: yaSuperhero.organizationName,
        triggerEvent: yaSuperhero.triggerEvent,
        accidentMechanism: yaSuperhero.accidentMechanism,
        powerOrigin: yaSuperhero.powerOrigin
      })
    );
  }

  return items;
}

function formatLockedFactArray(label: string, values: string[]) {
  return values.length ? [`${label}=${values.join(", ")}`] : [];
}

function formatLockedFactObject(prefix: string, values: Record<string, string | null>) {
  return Object.entries(values)
    .filter(function ([, value]) {
      return typeof value === "string" && value.trim().length > 0;
    })
    .map(function ([key, value]) {
      return `${prefix}.${key}=${value}`;
    });
}

function formatTechniqueProfile(
  profile: SceneContextPacket["stablePrefix"]["proseTechniqueProfile"]
) {
  return [
    `narrativeIntent=${profile.narrativeIntent}`,
    `povDistance=${profile.povDistance}`,
    `tensionMode=${profile.tensionMode}`,
    `expositionMode=${profile.expositionMode}`,
    `sensoryWeight=${profile.sensoryWeight}`,
    `interiorityMode=${profile.interiorityMode}`,
    `sentenceBaseline=${profile.sentenceDynamics.baseline}`,
    `sentenceUnderStress=${profile.sentenceDynamics.underStress}`,
    `fragmentation=${profile.sentenceDynamics.fragmentation}`,
    `openingHook=${profile.sceneHooks.opening}`,
    `endingHook=${profile.sceneHooks.ending}`,
    `dialogueMode=${profile.dialogueMode}`,
    `revealPattern=${profile.revealPattern}`,
    `anchorPolicy=${profile.anchorPolicy}`
  ]
    .concat(profile.techniqueRules.map(function (rule) {
      return `techniqueRule=${rule}`;
    }))
    .filter(Boolean);
}

function sanitizeBeatPlan(
  packet: SceneContextPacket,
  options: DraftGenerationOptions,
  payload: BeatPlanPayload
): BeatPlanPayload {
  const fallback = buildFallbackBeatPlan(packet, options);
  const rawBeats = Array.isArray(payload.beats) && payload.beats.length ? payload.beats : fallback.beats;
  const trimmedBeats = rawBeats.slice(0, 5).map(function (beat, index) {
    return {
      label: truncateText(beat.label.trim() || `Beat ${index + 1}`, 80),
      purpose: truncateText(
        beat.purpose.trim() || fallback.beats[index]?.purpose || packet.dynamicContext.sceneSummary,
        240
      ),
      targetWords: clampNumber(beat.targetWords, 60, options.targetSceneWordsMax),
      mustLand: truncateText(
        beat.mustLand.trim() || fallback.beats[index]?.mustLand || "Die Szene kippt sichtbar.",
        180
      )
    };
  });

  return {
    beats: rebalanceBeatTargets(trimmedBeats, Math.round((options.targetSceneWordsMin + options.targetSceneWordsMax) / 2))
  };
}

function buildFallbackBeatPlan(
  packet: SceneContextPacket,
  options: DraftGenerationOptions
): BeatPlanPayload {
  const narrativeOutline = buildNarrativeSceneCardOutlineSteps(packet.dynamicContext.sceneCardOutline);
  const source = narrativeOutline.length
    ? narrativeOutline
    : [
        `${packet.dynamicContext.sceneTitle} startet in einer konkreten Veraenderung.`,
        packet.dynamicContext.sceneSummary,
        "Die Szene endet mit einer sichtbaren Verschiebung."
      ];
  const selectedSource = source.slice(0, 5);
  const totalTarget = Math.round((options.targetSceneWordsMin + options.targetSceneWordsMax) / 2);
  const perBeat = Math.max(90, Math.round(totalTarget / selectedSource.length));

  return {
    beats: selectedSource.map(function (entry, index) {
      return {
        label: `Beat ${index + 1}`,
        purpose: entry,
        targetWords: perBeat,
        mustLand: index === selectedSource.length - 1
          ? packet.dynamicContext.sceneHardConstraints.at(-1) || entry
          : entry
      };
    })
  };
}

function rebalanceBeatTargets(
  beats: BeatPlanPayload["beats"],
  totalTarget: number
): BeatPlanPayload["beats"] {
  const safeBeats = beats.length ? beats : [{ label: "Beat 1", purpose: "", targetWords: totalTarget, mustLand: "" }];
  const currentTotal = safeBeats.reduce(function (sum, beat) {
    return sum + beat.targetWords;
  }, 0);

  if (!currentTotal) {
    return safeBeats.map(function (beat) {
      return {
        ...beat,
        targetWords: Math.max(80, Math.round(totalTarget / safeBeats.length))
      };
    });
  }

  const scale = totalTarget / currentTotal;

  return safeBeats.map(function (beat, index) {
    const scaled = Math.max(60, Math.round(beat.targetWords * scale));

    return {
      ...beat,
      targetWords: index === safeBeats.length - 1
        ? Math.max(
            60,
            totalTarget -
              safeBeats
                .slice(0, index)
                .reduce(function (sum, currentBeat) {
                  return sum + Math.max(60, Math.round(currentBeat.targetWords * scale));
                }, 0)
          )
        : scaled
    };
  });
}

function buildOutlineFromBeatPlan(beatPlan: BeatPlanPayload) {
  return beatPlan.beats.map(function (beat) {
    return `${beat.label}: ${beat.purpose} (${beat.targetWords}W, Payoff: ${beat.mustLand})`;
  });
}

function normalizeStateExtractionPayload(payload: StateExtractionPayload): StateExtractionPayload {
  return {
    sceneNotes: dedupeStrings(payload.sceneNotes).slice(0, EXTRACT_SCENE_NOTES_MAX_ITEMS),
    extractedState: {
      newCanonFacts: dedupeStrings(payload.extractedState.newCanonFacts).slice(0, EXTRACT_ARRAY_MAX_ITEMS),
      characterStateUpdates: dedupeStrings(payload.extractedState.characterStateUpdates).slice(0, EXTRACT_ARRAY_MAX_ITEMS),
      openThreadsCreated: dedupeStrings(payload.extractedState.openThreadsCreated).slice(0, EXTRACT_ARRAY_MAX_ITEMS),
      openThreadsResolved: dedupeStrings(payload.extractedState.openThreadsResolved).slice(0, EXTRACT_ARRAY_MAX_ITEMS),
      foreshadowingAdded: dedupeStrings(payload.extractedState.foreshadowingAdded).slice(0, EXTRACT_ARRAY_MAX_ITEMS),
      continuityRisks: dedupeStrings(payload.extractedState.continuityRisks).slice(0, EXTRACT_ARRAY_MAX_ITEMS),
      styleDriftNotes: dedupeStrings(payload.extractedState.styleDriftNotes).slice(0, EXTRACT_ARRAY_MAX_ITEMS)
    }
  };
}

function normalizeSceneNotes(
  notes: string[],
  finalSceneText: string,
  beatPlan: BeatPlanPayload
) {
  const sanitized = dedupeStrings(notes).slice(0, EXTRACT_SCENE_NOTES_MAX_ITEMS);

  if (sanitized.length) {
    return sanitized;
  }

  return [
    `Szenenbewegung ${beatPlan.beats.length || 1} Abschnitte sichtbar gehalten.`,
    `Finaler Szenentext auf ${countWords(finalSceneText)} Wörter stabilisiert.`
  ];
}

function sanitizeSceneStateExtraction(
  packet: SceneContextPacket,
  payload: StateExtractionPayload
) {
  const evidenceTerms = buildPacketEvidenceTerms(packet);
  const knownEntities = buildKnownEntityTerms(packet);
  const reviewNotes: string[] = [];
  const movedRisks: string[] = [];
  const filteredCanonFacts = payload.extractedState.newCanonFacts.filter(function (value) {
    const keep = isConservativeExtractorEntry(value, evidenceTerms, knownEntities, {
      requireEntity: false,
      minimumOverlap: 2
    });

    if (!keep) {
      movedRisks.push(`Extractor-Review: Unsicherer Canon-Fact verworfen -> ${value}`);
    }

    return keep;
  });
  const filteredCharacterUpdates = payload.extractedState.characterStateUpdates.filter(function (value) {
    const keep = isConservativeExtractorEntry(value, evidenceTerms, knownEntities, {
      requireEntity: true,
      minimumOverlap: 1
    });

    if (!keep) {
      movedRisks.push(`Extractor-Review: Unsicheres Character-Update verworfen -> ${value}`);
    }

    return keep;
  });
  const filteredForeshadowing = payload.extractedState.foreshadowingAdded.filter(function (value) {
    const keep = isConservativeExtractorEntry(value, evidenceTerms, knownEntities, {
      requireEntity: false,
      minimumOverlap: 1
    });

    if (!keep) {
      movedRisks.push(`Extractor-Review: Unsicheres Foreshadowing verworfen -> ${value}`);
    }

    return keep;
  });
  const filteredOpenThreadsCreated = payload.extractedState.openThreadsCreated.filter(function (value) {
    return isConservativeExtractorEntry(value, evidenceTerms, knownEntities, {
      requireEntity: false,
      minimumOverlap: 1
    });
  });

  if (
    filteredCanonFacts.length !== payload.extractedState.newCanonFacts.length ||
    filteredCharacterUpdates.length !== payload.extractedState.characterStateUpdates.length ||
    filteredForeshadowing.length !== payload.extractedState.foreshadowingAdded.length ||
    filteredOpenThreadsCreated.length !== payload.extractedState.openThreadsCreated.length
  ) {
    reviewNotes.push("Extractor-State wurde gegen den Packet-Kontext konservativ bereinigt.");
  }

  return {
    payload: {
      sceneNotes: payload.sceneNotes,
      extractedState: {
        ...payload.extractedState,
        newCanonFacts: dedupeStrings(filteredCanonFacts).slice(0, EXTRACT_ARRAY_MAX_ITEMS),
        characterStateUpdates: dedupeStrings(filteredCharacterUpdates).slice(0, EXTRACT_ARRAY_MAX_ITEMS),
        openThreadsCreated: dedupeStrings(filteredOpenThreadsCreated).slice(0, EXTRACT_ARRAY_MAX_ITEMS),
        foreshadowingAdded: dedupeStrings(filteredForeshadowing).slice(0, EXTRACT_ARRAY_MAX_ITEMS),
        continuityRisks: dedupeStrings(
          payload.extractedState.continuityRisks.concat(movedRisks.slice(0, 3))
        ).slice(0, EXTRACT_ARRAY_MAX_ITEMS)
      }
    },
    notes: reviewNotes
  };
}

function mergeContinuityAudit(
  extractedState: DraftExtractionState,
  audit: ContinuityAuditPayload
): DraftExtractionState {
  return {
    ...extractedState,
    continuityRisks: dedupeStrings(extractedState.continuityRisks.concat(audit.continuityRisks)).slice(0, 6),
    styleDriftNotes: dedupeStrings(extractedState.styleDriftNotes.concat(audit.styleDriftNotes)).slice(0, 6)
  };
}

function sanitizeQualityEval(
  payload: QualityEvalPayload,
  options: DraftGenerationOptions,
  actualWords: number
): QualityEvalPayload {
  return {
    wordTargetMin: options.targetSceneWordsMin,
    wordTargetMax: options.targetSceneWordsMax,
    wordActual: actualWords,
    hookScore: clampNumber(payload.hookScore, 0, 10),
    tensionScore: clampNumber(payload.tensionScore, 0, 10),
    dialogueScore: clampNumber(payload.dialogueScore, 0, 10),
    specificityScore: clampNumber(payload.specificityScore, 0, 10),
    germanCleanlinessScore: clampNumber(payload.germanCleanlinessScore, 0, 10),
    continuityScore: clampNumber(payload.continuityScore, 0, 10),
    marketFitScore: clampNumber(payload.marketFitScore, 0, 10),
    povDisciplineScore: clampNumber(payload.povDisciplineScore, 0, 10),
    readabilityScore: clampNumber(payload.readabilityScore, 0, 10),
    issues: dedupeStrings(payload.issues).slice(0, 8)
  };
}

function createFallbackQualityEval(
  options: DraftGenerationOptions,
  actualWords: number
): QualityEvalPayload {
  return {
    wordTargetMin: options.targetSceneWordsMin,
    wordTargetMax: options.targetSceneWordsMax,
    wordActual: actualWords,
    hookScore: 0,
    tensionScore: 0,
    dialogueScore: 0,
    specificityScore: 0,
    germanCleanlinessScore: 0,
    continuityScore: 0,
    marketFitScore: 0,
    povDisciplineScore: 0,
    readabilityScore: 0,
    issues: []
  };
}

function computeQualityScore(payload: QualityEvalPayload) {
  const total =
    payload.hookScore +
    payload.tensionScore +
    payload.dialogueScore +
    payload.specificityScore +
    payload.germanCleanlinessScore +
    payload.continuityScore +
    payload.marketFitScore +
    payload.povDisciplineScore +
    payload.readabilityScore;

  return Math.round((total / 9) * 10) / 10;
}

function buildQualityEvalNotes(payload: QualityEvalPayload, qualityScore: number) {
  const notes = [`Quality-Score ${qualityScore}/10 bei ${payload.wordActual} Wörtern.`];

  if (payload.issues.length) {
    return notes.concat(payload.issues.slice(0, 3));
  }

  return notes.concat(["Keine offenen Eval-Issues."]);
}

function buildExtractionNotes(sceneNotes: string[], reviewNotes: string[]) {
  const notes = sceneNotes.slice(0, 2).concat(reviewNotes);
  return notes.length ? notes : ["State-Extraktion abgeschlossen."];
}

function formatCharacterStatePrompt(
  entry: SceneContextPacket["dynamicContext"]["relevantCharacterStates"][number]
) {
  const recentSnapshots = entry.snapshots.slice(-3).map(function (snapshot) {
    return `${snapshot.scope}:${snapshot.sourceLabel || snapshot.currentState} => ${snapshot.currentState}`;
  });

  return [
    `${entry.characterName}: ${entry.currentState}`,
    entry.innerShift ? `inner_shift=${entry.innerShift}` : "",
    entry.agenda ? `agenda=${entry.agenda}` : "",
    recentSnapshots.length ? `snapshot_trail=${recentSnapshots.join(" | ")}` : ""
  ]
    .filter(Boolean)
    .join(" || ");
}

function buildPacketEvidenceTerms(packet: SceneContextPacket) {
  return new Set(
    extractEvidenceTerms(
      [
        packet.dynamicContext.sceneTitle,
        packet.dynamicContext.sceneSummary,
        packet.dynamicContext.sceneExcerpt
      ]
        .concat(packet.dynamicContext.sceneHeaderHints)
        .concat(packet.dynamicContext.sceneHardConstraints)
        .concat(packet.dynamicContext.sceneCardOutline)
        .concat(
          packet.dynamicContext.previousBeats.map(function (beat) {
            return `${beat.sceneTitle} ${beat.summary} ${beat.excerpt}`;
          })
        )
        .concat(
          packet.dynamicContext.relevantCodex.map(function (entry) {
            return `${entry.title} ${entry.summary}`;
          })
        )
        .concat(
          packet.dynamicContext.relevantCharacterStates.map(function (entry) {
            return `${entry.characterName} ${entry.currentState} ${entry.innerShift} ${entry.agenda}`;
          })
        )
        .concat(
          packet.dynamicContext.activeThreads.map(function (thread) {
            return `${thread.label} ${thread.detail}`;
          })
        )
        .concat([
          packet.dynamicContext.nextBeatTitle || "",
          packet.stablePrefix.premise,
          packet.stablePrefix.readerPromise,
          packet.stablePrefix.thematicCore
        ])
    )
  );
}

function buildKnownEntityTerms(packet: SceneContextPacket) {
  return extractEvidenceTerms(
    packet.dynamicContext.relevantCodex
      .map(function (entry) {
        return entry.title;
      })
      .concat(
        packet.dynamicContext.relevantCharacterStates.map(function (entry) {
          return entry.characterName;
        })
      )
      .concat(
        packet.dynamicContext.activeThreads.map(function (thread) {
          return thread.label;
        })
      )
      .concat([packet.dynamicContext.sceneTitle])
  );
}

function extractEvidenceTerms(values: string[]) {
  return values
    .flatMap(function (value) {
      return value
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]+/gu, " ")
        .split(/\s+/)
        .map(function (token) {
          return token.trim();
        });
    })
    .filter(function (token) {
      return token.length >= 4 && !GERMAN_STOPWORDS.has(token);
    });
}

function isConservativeExtractorEntry(
  value: string,
  evidenceTerms: Set<string>,
  knownEntities: string[],
  options: {
    requireEntity: boolean;
    minimumOverlap: number;
  }
) {
  const candidateTerms = extractEvidenceTerms([value]);
  const overlapCount = candidateTerms.filter(function (term) {
    return evidenceTerms.has(term);
  }).length;
  const entityHits = knownEntities.filter(function (entity) {
    return normalizeText(value).includes(normalizeText(entity));
  }).length;
  const unsupportedTerms = candidateTerms.filter(function (term) {
    return !evidenceTerms.has(term) && !knownEntities.includes(term);
  });

  if (options.requireEntity && entityHits === 0) {
    return false;
  }

  if (overlapCount < options.minimumOverlap) {
    return false;
  }

  if (looksLikeHardAssertion(value) && unsupportedTerms.length >= 3) {
    return false;
  }

  return true;
}

function looksLikeHardAssertion(value: string) {
  return /\b(ist|war|hat|wurde|uebernahm|übernahm|bat|bittet|hinterliess|hinterließ|betreibt|fuehrt|führt|gilt|wirkte|verheimlicht)\b/i.test(
    value
  );
}

function combineWarnings(values: string[]) {
  return dedupeStrings(values).join(" | ") || undefined;
}

function sanitizeSceneText(value: string) {
  return value
    .trim()
    .replace(/^```(?:text|markdown)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

async function requestAnthropicStructuredFallback<T>(
  params: {
    client: Anthropic;
    stageName: AnthropicStructuredStageName;
    modelName: string;
    maxTokens: number;
    schema: z.ZodType<T>;
    systemBlocks: Anthropic.TextBlockParam[];
    userPrompt: string;
  },
  startedAt: number,
  initialError: unknown
) {
  const fallbackMessage = await params.client.messages.create({
    model: params.modelName,
    max_tokens: params.maxTokens + ANTHROPIC_THINKING_HEADROOM_TOKENS,
    system: params.systemBlocks,
    messages: [
      {
        role: "user",
        content: buildAnthropicStructuredJsonPrompt(params.stageName, params.userPrompt)
      }
    ]
  }, buildAnthropicCacheRequestOptions());
  const fallbackText = sanitizeSceneText(collectAnthropicText(fallbackMessage));

  try {
    return {
      payload: parseAnthropicStructuredPayload(params.stageName, params.schema, fallbackText),
      metrics: {
        ...buildAnthropicMetrics(fallbackMessage, params.modelName, startedAt),
        attemptCount: 2,
        repairCount: 1
      }
    };
  } catch (fallbackError) {
    const retryMessage = await params.client.messages.create({
      model: params.modelName,
      max_tokens: params.maxTokens + ANTHROPIC_THINKING_HEADROOM_TOKENS,
      system: params.systemBlocks,
      messages: [
        {
          role: "user",
          content: buildAnthropicStructuredRetryPrompt(
            params.stageName,
            params.userPrompt,
            initialError instanceof Error ? initialError.message : String(initialError),
            fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
          )
        }
      ]
    }, buildAnthropicCacheRequestOptions());
    const retryText = sanitizeSceneText(collectAnthropicText(retryMessage));

    return {
      payload: parseAnthropicStructuredPayload(params.stageName, params.schema, retryText),
      metrics: {
        ...buildAnthropicMetrics(retryMessage, params.modelName, startedAt),
        attemptCount: 3,
        repairCount: 2
      }
    };
  }
}

function parseAnthropicStructuredPayload<T>(
  stageName: AnthropicStructuredStageName,
  schema: z.ZodType<T>,
  rawText: string
) {
  const jsonText = extractFirstJsonObject(rawText);
  const parsed = JSON.parse(jsonText);
  const repaired = repairAnthropicStructuredPayload(stageName, parsed);
  return schema.parse(repaired);
}

function buildAnthropicStructuredJsonPrompt(
  stageName: AnthropicStructuredStageName,
  originalPrompt: string
) {
  return [
    originalPrompt,
    "",
    "FORMAT REQUIREMENTS:",
    "- Return exactly one valid JSON object.",
    "- Use double-quoted property names and string values.",
    "- No markdown fences.",
    "- No prose before or after the JSON object.",
    "- Keep all string values compact.",
    describeAnthropicStructuredStageDiscipline(stageName),
    `- Contract: ${describeAnthropicStructuredStageContract(stageName)}`
  ].join("\n");
}

function buildAnthropicStructuredRetryPrompt(
  stageName: AnthropicStructuredStageName,
  originalPrompt: string,
  initialError: string,
  latestError: string
) {
  return [
    originalPrompt,
    "",
    "RETRY INSTRUCTIONS:",
    "Generate a fresh JSON object from scratch.",
    "Return JSON only.",
    "Use double-quoted property names and string values.",
    "Do not add markdown fences or commentary.",
    "Do not reuse or repair prior output.",
    "Prefer fewer items, shorter strings, and empty arrays over speculative detail.",
    describeAnthropicStructuredStageDiscipline(stageName),
    `Contract: ${describeAnthropicStructuredStageContract(stageName)}`,
    `Initial error: ${truncateText(initialError, 600)}`,
    `Latest error: ${truncateText(latestError, 600)}`,
  ].join("\n");
}

function describeAnthropicStructuredStageDiscipline(stageName: AnthropicStructuredStageName) {
  if (stageName === "extract") {
    return `- Extract discipline: sceneNotes 1-${EXTRACT_SCENE_NOTES_MAX_ITEMS}; every extractedState list 0-${EXTRACT_ARRAY_MAX_ITEMS}; every string <= ${EXTRACT_STRING_MAX_LENGTH} chars; plain strings only.`;
  }

  return "- Keep the object compact and schema-first.";
}

function describeAnthropicStructuredStageContract(stageName: AnthropicStructuredStageName) {
  if (stageName === "beat_plan") {
    return '{"beats":[{"label":"string","purpose":"string","targetWords":123,"mustLand":"string"}]}';
  }

  if (stageName === "extract") {
    return '{"sceneNotes":["string"],"extractedState":{"newCanonFacts":[],"characterStateUpdates":[],"openThreadsCreated":[],"openThreadsResolved":[],"foreshadowingAdded":[],"continuityRisks":[],"styleDriftNotes":[]}}';
  }

  if (stageName === "continuity") {
    return '{"continuityRisks":["string"],"styleDriftNotes":["string"]}';
  }

  return '{"wordTargetMin":0,"wordTargetMax":0,"wordActual":0,"hookScore":0,"tensionScore":0,"dialogueScore":0,"specificityScore":0,"germanCleanlinessScore":0,"continuityScore":0,"marketFitScore":0,"povDisciplineScore":0,"readabilityScore":0,"issues":["string"]}';
}

function repairAnthropicStructuredPayload(stageName: AnthropicStructuredStageName, payload: unknown) {
  if (stageName === "beat_plan") {
    return repairBeatPlanPayload(payload);
  }

  if (stageName === "extract") {
    return repairStateExtractionPayload(payload);
  }

  if (stageName === "continuity") {
    return repairContinuityAuditPayload(payload);
  }

  return repairQualityEvalPayload(payload);
}

function repairBeatPlanPayload(payload: unknown): BeatPlanPayload {
  const source = isRecord(payload) && Array.isArray(payload.beats) ? payload.beats : [];

  return {
    beats: source.slice(0, 6).map(function (beat, index) {
      const entry = isRecord(beat) ? beat : {};

      return {
        label: truncateText(coerceString(entry.label, `Beat ${index + 1}`), 120),
        purpose: truncateText(coerceString(entry.purpose, `Beat ${index + 1} haelt den Szenendruck.`), 600),
        targetWords: clampNumber(coerceInteger(entry.targetWords, 120), 50, 1200),
        mustLand: truncateText(coerceString(entry.mustLand, "Die Szene kippt sichtbar."), 320)
      };
    })
  };
}

function repairStateExtractionPayload(payload: unknown): StateExtractionPayload {
  const root = isRecord(payload) ? payload : {};
  const extractedState = isRecord(root.extractedState) ? root.extractedState : {};

  return {
    sceneNotes: coerceStringArray(root.sceneNotes ?? root.rewriteNotes, EXTRACT_SCENE_NOTES_MAX_ITEMS, [
      "Finaler Szenentext automatisch extrahiert und konservativ normalisiert."
    ], EXTRACT_STRING_MAX_LENGTH).slice(0, EXTRACT_SCENE_NOTES_MAX_ITEMS),
    extractedState: {
      newCanonFacts: coerceStringArray(
        extractedState.newCanonFacts,
        EXTRACT_ARRAY_MAX_ITEMS,
        [],
        EXTRACT_STRING_MAX_LENGTH
      ),
      characterStateUpdates: coerceStringArray(
        extractedState.characterStateUpdates,
        EXTRACT_ARRAY_MAX_ITEMS,
        [],
        EXTRACT_STRING_MAX_LENGTH
      ),
      openThreadsCreated: coerceStringArray(
        extractedState.openThreadsCreated,
        EXTRACT_ARRAY_MAX_ITEMS,
        [],
        EXTRACT_STRING_MAX_LENGTH
      ),
      openThreadsResolved: coerceStringArray(
        extractedState.openThreadsResolved,
        EXTRACT_ARRAY_MAX_ITEMS,
        [],
        EXTRACT_STRING_MAX_LENGTH
      ),
      foreshadowingAdded: coerceStringArray(
        extractedState.foreshadowingAdded,
        EXTRACT_ARRAY_MAX_ITEMS,
        [],
        EXTRACT_STRING_MAX_LENGTH
      ),
      continuityRisks: coerceStringArray(
        extractedState.continuityRisks,
        EXTRACT_ARRAY_MAX_ITEMS,
        [],
        EXTRACT_STRING_MAX_LENGTH
      ),
      styleDriftNotes: coerceStringArray(
        extractedState.styleDriftNotes,
        EXTRACT_ARRAY_MAX_ITEMS,
        [],
        EXTRACT_STRING_MAX_LENGTH
      )
    }
  };
}

function repairContinuityAuditPayload(payload: unknown): ContinuityAuditPayload {
  const root = isRecord(payload) ? payload : {};

  return {
    continuityRisks: coerceStringArray(root.continuityRisks, 6),
    styleDriftNotes: coerceStringArray(root.styleDriftNotes, 6)
  };
}

function repairQualityEvalPayload(payload: unknown): QualityEvalPayload {
  const root = isRecord(payload) ? payload : {};

  return {
    wordTargetMin: coerceInteger(root.wordTargetMin, 0),
    wordTargetMax: coerceInteger(root.wordTargetMax, 0),
    wordActual: coerceInteger(root.wordActual, 0),
    hookScore: clampNumber(coerceInteger(root.hookScore, 0), 0, 10),
    tensionScore: clampNumber(coerceInteger(root.tensionScore, 0), 0, 10),
    dialogueScore: clampNumber(coerceInteger(root.dialogueScore, 0), 0, 10),
    specificityScore: clampNumber(coerceInteger(root.specificityScore, 0), 0, 10),
    germanCleanlinessScore: clampNumber(coerceInteger(root.germanCleanlinessScore, 0), 0, 10),
    continuityScore: clampNumber(coerceInteger(root.continuityScore, 0), 0, 10),
    marketFitScore: clampNumber(coerceInteger(root.marketFitScore, 0), 0, 10),
    povDisciplineScore: clampNumber(coerceInteger(root.povDisciplineScore, 0), 0, 10),
    readabilityScore: clampNumber(coerceInteger(root.readabilityScore, 0), 0, 10),
    issues: coerceStringArray(root.issues, 8)
  };
}

function buildFallbackStateExtraction(
  packet: SceneContextPacket,
  finalSceneText: string,
  beatPlan: BeatPlanPayload
): StateExtractionPayload["extractedState"] extends infer _Unused
  ? {
      sceneNotes: string[];
      extractedState: Omit<DraftExtractionState, "memorySync">;
    }
  : never {
  return {
    sceneNotes: [
      "Structured Extractor fiel aus; konservativer Fallback aus Szenentext und Packet verwendet.",
      `Finaler Szenentext auf ${countWords(finalSceneText)} Wörter stabil gehalten.`
    ],
    extractedState: {
      newCanonFacts: [],
      characterStateUpdates: [],
      openThreadsCreated: [],
      openThreadsResolved: [],
      foreshadowingAdded: [],
      continuityRisks: [
        "Structured Extractor fiel aus; neue Canon-Fakten und Thread-Aenderungen manuell pruefen."
      ],
      styleDriftNotes: [
        `Fallback-Extraktion aktiv; Szenenbewegung mit ${beatPlan.beats.length || 1} Abschnitten nur konservativ ausgewertet.`
      ]
    }
  };
}

function extractFirstJsonObject(value: string) {
  const trimmed = value.trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fencedMatch?.[1]?.trim() || trimmed;
  const start = source.indexOf("{");

  if (start === -1) {
    throw new Error("No JSON object found in Anthropic output.");
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }

      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;

      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }

  throw new Error("No complete JSON object found in Anthropic output.");
}

function countWords(value: string) {
  const words = value.trim().match(/\S+/g);
  return words ? words.length : 0;
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function collectAnthropicText(message: Anthropic.Message) {
  return message.content
    .map(function (block) {
      return block.type === "text" ? block.text : "";
    })
    .join("\n");
}

function dedupeStrings(values: string[]) {
  return values
    .map(function (value) {
      return value.trim();
    })
    .filter(Boolean)
    .filter(function (value, index, list) {
      return list.indexOf(value) === index;
    });
}

function truncateText(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, " ").trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd() + "...";
}

function coerceString(value: unknown, fallback: string) {
  return typeof value === "string" ? value.trim() || fallback : fallback;
}

function coerceInteger(value: unknown, fallback: number) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value);
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);

    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return fallback;
}

function coerceStringArray(
  value: unknown,
  maxItems: number,
  fallback: string[] = [],
  maxLength = 240
) {
  if (!Array.isArray(value)) {
    return fallback.slice(0, maxItems);
  }

  return value
    .map(function (entry) {
      return typeof entry === "string" ? truncateText(entry, maxLength) : "";
    })
    .filter(Boolean)
    .slice(0, maxItems);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeAnthropicModelName(value: string) {
  const normalized = value.trim();

  return normalizeKnownModelAlias(normalized) ?? normalized;
}

function normalizeText(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function createLocalId(prefix: string) {
  return createUuid();
}

const GERMAN_STOPWORDS = new Set([
  "aber",
  "auch",
  "beim",
  "dabei",
  "daher",
  "damit",
  "dann",
  "dass",
  "deine",
  "deinen",
  "deiner",
  "dem",
  "den",
  "der",
  "des",
  "dessen",
  "dies",
  "diese",
  "diesem",
  "diesen",
  "dieser",
  "doch",
  "dort",
  "eine",
  "einem",
  "einen",
  "einer",
  "eines",
  "einfach",
  "einst",
  "er",
  "es",
  "etwas",
  "fuer",
  "für",
  "hatte",
  "hier",
  "hinter",
  "ihre",
  "ihren",
  "ihrer",
  "ihres",
  "immer",
  "ihm",
  "ihn",
  "ins",
  "ist",
  "kein",
  "keine",
  "keinen",
  "konnte",
  "mehr",
  "nicht",
  "noch",
  "oder",
  "ohne",
  "schon",
  "sein",
  "seine",
  "seinen",
  "seiner",
  "sich",
  "sie",
  "sind",
  "sofort",
  "statt",
  "ueber",
  "über",
  "und",
  "unter",
  "vom",
  "von",
  "vor",
  "weil",
  "weiter",
  "wenn",
  "wieder",
  "wird",
  "wurde",
  "zum",
  "zur",
  "zwar"
]);
