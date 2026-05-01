import type { FeatureModelKey, ModelConfig, ProviderConfig, Settings } from "./types";

export type ProviderPreset = {
  id: string;
  label: string;
  endpoint: string;
  model: string;
  isMultimodal?: boolean;
};

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "opencode-go",
    label: "OpenCode Go",
    endpoint: "https://opencode.ai/zen/go/v1/chat/completions",
    model: "mimo-v2.5"
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    endpoint: "https://api.deepseek.com/chat/completions",
    model: "deepseek-v4-flash"
  },
  {
    id: "gemini",
    label: "Gemini",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.5-flash",
    isMultimodal: true
  }
];

export const DEFAULT_SETTINGS: Settings = {
  providerId: PROVIDER_PRESETS[0].id,
  apiKeys: {},
  providerConfigs: Object.fromEntries(
    PROVIDER_PRESETS.map((preset) => [
      preset.id,
      { endpoint: preset.endpoint, model: preset.model, isMultimodal: preset.isMultimodal ?? false }
    ])
  ),
  endpoint: PROVIDER_PRESETS[0].endpoint,
  model: PROVIDER_PRESETS[0].model,
  pdfProviderId: PROVIDER_PRESETS[0].id,
  pdfApiKeys: {},
  pdfProviderConfigs: Object.fromEntries(
    PROVIDER_PRESETS.map((preset) => [
      preset.id,
      { endpoint: preset.endpoint, model: preset.model, isMultimodal: preset.isMultimodal ?? true }
    ])
  ),
  pdfEndpoint: PROVIDER_PRESETS[0].endpoint,
  pdfModel: PROVIDER_PRESETS[0].model,
  deepPdfParserEndpoint: "https://www.datalab.to/api/v1/convert",
  deepPdfParserApiKey: "",
  deepPdfParserMode: "balanced",
  deepPdfSummaryProviderId: PROVIDER_PRESETS[0].id,
  deepPdfSummaryApiKeys: {},
  deepPdfSummaryProviderConfigs: Object.fromEntries(
    PROVIDER_PRESETS.map((preset) => [
      preset.id,
      { endpoint: preset.endpoint, model: preset.model, isMultimodal: preset.isMultimodal ?? false }
    ])
  ),
  deepPdfSummaryEndpoint: PROVIDER_PRESETS[0].endpoint,
  deepPdfSummaryModel: PROVIDER_PRESETS[0].model,
  modelConfigs: {},
  featureModelSelections: {},
  outputLanguage: "follow-page"
};

const SETTINGS_KEY = "learnPanelSettings";

type StoredSettings = Partial<Settings> & {
  apiKey?: string;
  deepPdfVisionProviderId?: string;
  deepPdfVisionApiKeys?: Record<string, string>;
  deepPdfVisionProviderConfigs?: Record<string, ProviderConfig>;
  deepPdfVisionEndpoint?: string;
  deepPdfVisionModel?: string;
};

export type ModelCapability = "text" | "multimodal";

export type ConfiguredModelChoice = {
  id: string;
  source: "model";
  providerId: string;
  label: string;
  endpoint: string;
  model: string;
  apiKey: string;
  isMultimodal: boolean;
};

export type FeatureModelClientConfig = ConfiguredModelChoice & {
  missingApiKeyMessage: string;
  missingEndpointMessage: string;
  missingModelMessage: string;
};

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const storedSettings = (stored[SETTINGS_KEY] ?? {}) as StoredSettings;
  const merged = {
    ...DEFAULT_SETTINGS,
    ...storedSettings
  };
  const detectedPreset = PROVIDER_PRESETS.find((preset) => endpointsMatch(preset.endpoint, merged.endpoint));
  const providerId = storedSettings.providerId ?? detectedPreset?.id ?? "custom";
  const detectedPdfPreset = PROVIDER_PRESETS.find((preset) => endpointsMatch(preset.endpoint, merged.pdfEndpoint));
  const pdfProviderId = storedSettings.pdfProviderId ?? detectedPdfPreset?.id ?? "custom";
  const detectedDeepPdfSummaryPreset = PROVIDER_PRESETS.find((preset) =>
    endpointsMatch(preset.endpoint, merged.deepPdfSummaryEndpoint)
  );
  const deepPdfSummaryProviderId =
    storedSettings.deepPdfSummaryProviderId ?? detectedDeepPdfSummaryPreset?.id ?? "custom";
  const apiKeys = {
    ...DEFAULT_SETTINGS.apiKeys,
    ...(storedSettings.apiKeys ?? {})
  };
  const pdfApiKeys = {
    ...DEFAULT_SETTINGS.pdfApiKeys,
    ...(storedSettings.pdfApiKeys ?? {})
  };
  const deepPdfSummaryApiKeys = {
    ...DEFAULT_SETTINGS.deepPdfSummaryApiKeys,
    ...(storedSettings.deepPdfSummaryApiKeys ?? {})
  };
  const providerConfigs = mergeProviderConfigs(DEFAULT_SETTINGS.providerConfigs, storedSettings.providerConfigs, false);
  const pdfProviderConfigs = mergeProviderConfigs(DEFAULT_SETTINGS.pdfProviderConfigs, storedSettings.pdfProviderConfigs, true);
  const deepPdfSummaryProviderConfigs = mergeProviderConfigs(
    DEFAULT_SETTINGS.deepPdfSummaryProviderConfigs,
    storedSettings.deepPdfSummaryProviderConfigs,
    false
  );

  providerConfigs[providerId] = {
    endpoint: merged.endpoint,
    model: merged.model,
    isMultimodal: providerConfigs[providerId]?.isMultimodal ?? false
  };
  pdfProviderConfigs[pdfProviderId] = {
    endpoint: merged.pdfEndpoint,
    model: merged.pdfModel,
    isMultimodal: pdfProviderConfigs[pdfProviderId]?.isMultimodal ?? true
  };
  deepPdfSummaryProviderConfigs[deepPdfSummaryProviderId] = {
    endpoint: merged.deepPdfSummaryEndpoint,
    model: merged.deepPdfSummaryModel,
    isMultimodal: deepPdfSummaryProviderConfigs[deepPdfSummaryProviderId]?.isMultimodal ?? false
  };

  if (storedSettings.apiKey?.trim() && !apiKeys[providerId]) {
    apiKeys[providerId] = storedSettings.apiKey.trim();
  }

  return {
    ...merged,
    providerId,
    pdfProviderId,
    deepPdfSummaryProviderId,
    apiKeys,
    pdfApiKeys,
    deepPdfSummaryApiKeys,
    providerConfigs,
    pdfProviderConfigs,
    deepPdfSummaryProviderConfigs,
    modelConfigs: normalizeModelConfigs(storedSettings, {
      providerId,
      pdfProviderId,
      deepPdfSummaryProviderId,
      apiKeys,
      pdfApiKeys,
      deepPdfSummaryApiKeys,
      providerConfigs,
      pdfProviderConfigs,
      deepPdfSummaryProviderConfigs
    }),
    featureModelSelections: storedSettings.featureModelSelections ?? DEFAULT_SETTINGS.featureModelSelections
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

export function getChatCompletionsEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return "";
  }
  return /\/chat\/completions$/i.test(trimmed) ? trimmed : `${trimmed}/chat/completions`;
}

export function endpointsMatch(left: string, right: string): boolean {
  return normalizeOpenAICompatibleBaseEndpoint(left) === normalizeOpenAICompatibleBaseEndpoint(right);
}

function normalizeOpenAICompatibleBaseEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, "").replace(/\/chat\/completions$/i, "");
}

export function getActiveApiKey(settings: Settings): string {
  return settings.apiKeys[settings.providerId]?.trim() ?? "";
}

export function getActivePdfApiKey(settings: Settings): string {
  return settings.pdfApiKeys[settings.pdfProviderId]?.trim() ?? "";
}

export function getActiveDeepPdfSummaryApiKey(settings: Settings): string {
  return settings.deepPdfSummaryApiKeys[settings.deepPdfSummaryProviderId]?.trim() ?? "";
}

export function getConfiguredModelChoices(settings: Settings): ConfiguredModelChoice[] {
  return Object.entries(settings.modelConfigs)
    .filter(([, config]) => config.endpoint.trim() || config.model.trim() || config.name.trim())
    .map(([id, config]) => ({
      id,
      source: "model",
      providerId: id,
      label: `${config.name || config.model || "Untitled model"} · ${config.model || "No model"}`,
      endpoint: config.endpoint,
      model: config.model,
      apiKey: config.apiKey.trim(),
      isMultimodal: config.isMultimodal
    }));
}

export function getFeatureModelChoice(
  settings: Settings,
  featureKey: FeatureModelKey,
  capability: ModelCapability
): ConfiguredModelChoice | null {
  const choices = getConfiguredModelChoices(settings);
  const selectedId = settings.featureModelSelections[featureKey];
  const selected = selectedId ? choices.find((choice) => choice.id === selectedId) : undefined;
  if (selected && hasCapability(selected, capability)) {
    return selected;
  }

  for (const id of getFallbackModelIds(settings, featureKey)) {
    const fallback = choices.find((choice) => choice.id === id);
    if (fallback && hasCapability(fallback, capability)) {
      return fallback;
    }
  }

  return choices.find((choice) => hasCapability(choice, capability)) ?? null;
}

export function getFeatureModelClientConfig(
  settings: Settings,
  featureKey: FeatureModelKey,
  capability: ModelCapability,
  messages: {
    missingApiKeyMessage: string;
    missingEndpointMessage: string;
    missingModelMessage: string;
  }
): FeatureModelClientConfig {
  const choice = getFeatureModelChoice(settings, featureKey, capability);
  return {
    id: choice?.id ?? "",
    source: choice?.source ?? "model",
    providerId: choice?.providerId ?? "",
    label: choice?.label ?? "",
    endpoint: choice?.endpoint ?? "",
    model: choice?.model ?? "",
    apiKey: choice?.apiKey ?? "",
    isMultimodal: choice?.isMultimodal ?? false,
    ...messages
  };
}

export function hasUsableFeatureModel(
  settings: Settings,
  featureKey: FeatureModelKey,
  capability: ModelCapability
): boolean {
  const choice = getFeatureModelChoice(settings, featureKey, capability);
  return Boolean(choice?.apiKey.trim() && choice.endpoint.trim() && choice.model.trim());
}

function mergeProviderConfigs(
  defaults: Record<string, ProviderConfig>,
  stored: Record<string, ProviderConfig> | undefined,
  defaultMultimodal: boolean
): Record<string, ProviderConfig> {
  const merged = { ...defaults, ...(stored ?? {}) };
  return Object.fromEntries(
    Object.entries(merged).map(([providerId, config]) => [
      providerId,
      {
        endpoint: config.endpoint ?? "",
        model: config.model ?? "",
        isMultimodal: config.isMultimodal ?? defaults[providerId]?.isMultimodal ?? defaultMultimodal
      }
    ])
  );
}

function buildChoicesForScope({
  source,
  sourceLabel,
  providerConfigs,
  apiKeys,
  defaultMultimodal
}: {
  source: ConfiguredModelChoice["source"];
  sourceLabel: string;
  providerConfigs: Record<string, ProviderConfig>;
  apiKeys: Record<string, string>;
  defaultMultimodal: boolean;
}): ConfiguredModelChoice[] {
  return Object.entries(providerConfigs)
    .filter(([, config]) => config.endpoint.trim() || config.model.trim())
    .map(([providerId, config]) => {
      const providerLabel = getProviderLabel(providerId);
      return {
        id: `${source}:${providerId}`,
        source,
        providerId,
        label: `${sourceLabel} / ${providerLabel} · ${config.model || "No model"}`,
        endpoint: config.endpoint,
        model: config.model,
        apiKey: apiKeys[providerId]?.trim() ?? "",
        isMultimodal: config.isMultimodal ?? defaultMultimodal
      };
    });
}

function getFallbackModelIds(settings: Settings, featureKey: FeatureModelKey): string[] {
  switch (featureKey) {
    case "articleAnalysis":
      return findFallbackModelIds(settings, false);
    case "articleQuestion":
      return [
        settings.featureModelSelections.articleAnalysis ?? "",
        ...findFallbackModelIds(settings, false)
      ].filter(Boolean);
    case "pdfVisualAnalysis":
      return findFallbackModelIds(settings, true);
    case "pdfVisualQuestion":
      return [
        settings.featureModelSelections.pdfVisualAnalysis ?? "",
        ...findFallbackModelIds(settings, true)
      ].filter(Boolean);
    case "pdfDeepAnalysis":
      return findFallbackModelIds(settings, false);
  }
}

function hasCapability(choice: ConfiguredModelChoice, capability: ModelCapability): boolean {
  return capability === "text" || choice.isMultimodal;
}

function getProviderLabel(providerId: string): string {
  return PROVIDER_PRESETS.find((preset) => preset.id === providerId)?.label ?? (providerId === "custom" ? "Custom" : providerId);
}

function normalizeModelConfigs(
  storedSettings: StoredSettings,
  legacy: {
    providerId: string;
    pdfProviderId: string;
    deepPdfSummaryProviderId: string;
    apiKeys: Record<string, string>;
    pdfApiKeys: Record<string, string>;
    deepPdfSummaryApiKeys: Record<string, string>;
    providerConfigs: Record<string, ProviderConfig>;
    pdfProviderConfigs: Record<string, ProviderConfig>;
    deepPdfSummaryProviderConfigs: Record<string, ProviderConfig>;
  }
): Record<string, ModelConfig> {
  if (storedSettings.modelConfigs && Object.keys(storedSettings.modelConfigs).length > 0) {
    return Object.fromEntries(
      Object.entries(storedSettings.modelConfigs).map(([id, config]) => [
        id,
        {
          name: config.name?.trim() || config.model || "Untitled model",
          endpoint: config.endpoint ?? "",
          apiKey: config.apiKey ?? "",
          model: config.model ?? "",
          isMultimodal: Boolean(config.isMultimodal)
        }
      ])
    );
  }

  const textConfig = legacy.providerConfigs[legacy.providerId];
  const visionConfig = legacy.pdfProviderConfigs[legacy.pdfProviderId];
  const deepConfig = legacy.deepPdfSummaryProviderConfigs[legacy.deepPdfSummaryProviderId];
  const migrated: Record<string, ModelConfig> = {};

  if (textConfig) {
    migrated["model-text-default"] = {
      name: "Default text model",
      endpoint: textConfig.endpoint,
      apiKey: legacy.apiKeys[legacy.providerId] ?? "",
      model: textConfig.model,
      isMultimodal: Boolean(textConfig.isMultimodal)
    };
  }

  if (visionConfig) {
    migrated["model-vision-default"] = {
      name: "Default multimodal model",
      endpoint: visionConfig.endpoint,
      apiKey: legacy.pdfApiKeys[legacy.pdfProviderId] ?? "",
      model: visionConfig.model,
      isMultimodal: true
    };
  }

  if (deepConfig) {
    migrated["model-deep-summary-default"] = {
      name: "Default deep summary model",
      endpoint: deepConfig.endpoint,
      apiKey: legacy.deepPdfSummaryApiKeys[legacy.deepPdfSummaryProviderId] ?? "",
      model: deepConfig.model,
      isMultimodal: Boolean(deepConfig.isMultimodal)
    };
  }

  return migrated;
}

function findFallbackModelIds(settings: Settings, needsMultimodal: boolean): string[] {
  return Object.entries(settings.modelConfigs)
    .filter(([, config]) => !needsMultimodal || config.isMultimodal)
    .map(([id]) => id);
}
