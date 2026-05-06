/**
 * Model Mapping Configuration
 * Maps equivalent models across different providers
 */

export interface ModelMapping {
  original: string;
  anthropic?: string;
  zai?: string;
  openrouter?: string;
}

/**
 * Model equivalence mappings
 * When a provider fails, the system can try equivalent models on other providers
 */
export const MODEL_MAPPINGS: Record<string, ModelMapping> = {
  // Claude Sonnet 4.6 → GLM 4 (similar capabilities)
  "claude-sonnet-4-6": {
    original: "claude-sonnet-4-6",
    anthropic: "claude-sonnet-4-6",
    zai: "glm-4",
    openrouter: "anthropic/claude-sonnet-4-20250514",
  },
  "claude-sonnet-4-5": {
    original: "claude-sonnet-4-5",
    anthropic: "claude-sonnet-4-5",
    zai: "glm-4",
    openrouter: "anthropic/claude-sonnet-4-20250514",
  },

  // Claude Opus 4.5 → GLM 4 (high-end models)
  "claude-opus-4-5": {
    original: "claude-opus-4-5",
    anthropic: "claude-opus-4-5",
    zai: "glm-4",
    openrouter: "anthropic/claude-opus-4-20250514",
  },

  // Claude Haiku 4.5 → GLM 3-Air (lightweight models)
  "claude-haiku-4-5": {
    original: "claude-haiku-4-5",
    anthropic: "claude-haiku-4-5",
    zai: "glm-3-air",
    openrouter: "anthropic/claude-haiku-4-20250514",
  },

  // GLM models (primary for Z.AI)
  "glm-4": {
    original: "glm-4",
    anthropic: "claude-sonnet-4-6",
    zai: "glm-4",
    openrouter: "glm/glm-4",
  },
  "glm-3-air": {
    original: "glm-3-air",
    anthropic: "claude-haiku-4-5",
    zai: "glm-3-air",
    openrouter: "glm/glm-3-air",
  },
};

/**
 * Provider-specific model support
 * Defines which models each provider natively supports
 */
export const PROVIDER_MODEL_SUPPORT = {
  anthropic: [
    "claude-sonnet-4-6",
    "claude-sonnet-4-5",
    "claude-opus-4-5",
    "claude-haiku-4-5",
    "claude-3-haiku-20240307",
    "claude-3-sonnet-20240229",
    "claude-3-opus-20240229",
  ],
  zai: [
    "glm-4",
    "glm-3-air",
    "glm-3-turbo",
    "glm-4-plus",
  ],
  openrouter: [
    "anthropic/claude-sonnet-4-20250514",
    "anthropic/claude-opus-4-20250514",
    "anthropic/claude-haiku-4-20250514",
    "glm/glm-4",
    "glm/glm-3-air",
    "google/gemini-pro-1.5",
    "meta-llama/llama-3.1-70b-instruct",
  ],
};

/**
 * Get the equivalent model for a specific provider
 */
export function getMappedModel(
  originalModel: string,
  targetProvider: "anthropic" | "zai" | "openrouter"
): string {
  const mapping = MODEL_MAPPINGS[originalModel];
  if (!mapping) {
    // No mapping found, try using original model
    return originalModel;
  }

  const mappedModel = mapping[targetProvider];
  return mappedModel || originalModel;
}

/**
 * Check if a provider natively supports a model
 */
export function isModelSupported(
  model: string,
  provider: "anthropic" | "zai" | "openrouter"
): boolean {
  const supportedModels = PROVIDER_MODEL_SUPPORT[provider];
  return supportedModels.includes(model);
}

/**
 * Get model family (claude, glm, etc.)
 */
export function getModelFamily(model: string): string {
  const modelLower = model.toLowerCase();
  if (modelLower.startsWith("claude-")) return "claude";
  if (modelLower.startsWith("glm-")) return "glm";
  if (modelLower.includes("gemini")) return "gemini";
  if (modelLower.includes("llama")) return "llama";
  return "unknown";
}

/**
 * Model capability tiers for intelligent fallback
 */
export enum ModelTier {
  PREMIUM = "premium", // claude-opus, glm-4
  STANDARD = "standard", // claude-sonnet, glm-4
  LIGHTWEIGHT = "lightweight", // claude-haiku, glm-3-air
}

/**
 * Get model capability tier
 */
export function getModelTier(model: string): ModelTier {
  const modelLower = model.toLowerCase();
  if (
    modelLower.includes("opus") ||
    modelLower === "glm-4" ||
    modelLower === "glm-4-plus"
  ) {
    return ModelTier.PREMIUM;
  }
  if (
    modelLower.includes("sonnet") ||
    modelLower === "glm-4"
  ) {
    return ModelTier.STANDARD;
  }
  if (
    modelLower.includes("haiku") ||
    modelLower.includes("-air") ||
    modelLower.includes("-turbo")
  ) {
    return ModelTier.LIGHTWEIGHT;
  }
  return ModelTier.STANDARD;
}
