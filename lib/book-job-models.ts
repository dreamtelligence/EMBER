export type BookJobProviderOption = "auto" | "openai" | "anthropic";
export type BookJobModelKey = "openai" | "anthropic" | "anthropicContinuity";

export type BookJobModelSelection = Record<BookJobModelKey, string>;
export type BookJobModelOverrides = Partial<BookJobModelSelection>;

export const BOOK_JOB_PROVIDER_STORAGE_KEY = "ember_book_job_provider";
export const BOOK_JOB_MODEL_STORAGE_KEY = "ember_book_job_models";

export const DEFAULT_BOOK_JOB_MODELS: Record<BookJobModelKey, string> = {
  openai: "gpt-6.1-sol",
  anthropic: "claude-sonnet-5-5",
  anthropicContinuity: "claude-sonnet-5-5"
};

export const BOOK_JOB_MODEL_PRESETS: Record<BookJobModelKey, string[]> = {
  openai: ["gpt-6.1-sol", "gpt-6-astra"],
  anthropic: ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
  anthropicContinuity: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1", "claude-haiku-5-5"]
};

// Model ids saved in browser storage, stories or env vars before the upgrade
// resolve to their current successor.
const LEGACY_MODEL_SUCCESSORS: Record<string, string> = {
  "gpt-5.5": "gpt-6.1-sol",
  "gpt-5.4": "gpt-6.1-sol",
  "gpt-5.4-pro": "gpt-6.1-sol",
  "gpt-5.4-thinking": "gpt-6.1-sol",
  "gpt-5.4-mini": "gpt-6.1-sol",
  "claude-opus-4-7": "claude-opus-5-5",
  "claude-opus-4-6": "claude-opus-5-5",
  "claude-sonnet-4-6": "claude-sonnet-5-5",
  "claude-haiku-4-5": "claude-haiku-5-5",
  "claude-haiku-4-5-20251001": "claude-haiku-5-5",
  "claude-3-5-haiku-20241022": "claude-haiku-5-5"
};

export function createEmptyBookJobModelSelection(): BookJobModelSelection {
  return {
    openai: "",
    anthropic: "",
    anthropicContinuity: ""
  };
}

export function parseBookJobModelSelection(value: string | null): BookJobModelSelection {
  try {
    const parsed = value ? JSON.parse(value) : {};
    return {
      openai: typeof parsed.openai === "string" ? normalizeKnownModelAlias(parsed.openai) ?? "" : "",
      anthropic: typeof parsed.anthropic === "string" ? normalizeKnownModelAlias(parsed.anthropic) ?? "" : "",
      anthropicContinuity:
        typeof parsed.anthropicContinuity === "string"
          ? normalizeKnownModelAlias(parsed.anthropicContinuity) ?? ""
          : ""
    };
  } catch {
    return createEmptyBookJobModelSelection();
  }
}

export function buildBookJobModelOverrides(selection: BookJobModelSelection): BookJobModelOverrides {
  const overrides: BookJobModelOverrides = {};

  if (selection.openai) overrides.openai = selection.openai;
  if (selection.anthropic) overrides.anthropic = selection.anthropic;
  if (selection.anthropicContinuity) overrides.anthropicContinuity = selection.anthropicContinuity;

  return overrides;
}

export function resolveBookJobModelValue(
  overrideValue: string | undefined,
  environmentValue: string | undefined | null,
  fallbackValue: string
) {
  const override = normalizeKnownModelAlias(overrideValue?.trim());

  if (override) {
    return override;
  }

  const environment = normalizeKnownModelAlias(environmentValue?.trim());

  if (environment) {
    return environment;
  }

  return fallbackValue;
}

export function normalizeKnownModelAlias(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  return LEGACY_MODEL_SUCCESSORS[value] ?? value;
}

export function isBookJobProviderOption(value: string): value is BookJobProviderOption {
  return (
    value === "auto" ||
    value === "openai" ||
    value === "anthropic"
  );
}
