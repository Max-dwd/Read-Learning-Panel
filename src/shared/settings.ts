import type { Settings } from "./types";

export type ProviderPreset = {
  id: string;
  label: string;
  endpoint: string;
  model: string;
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
  }
];

export const DEFAULT_SETTINGS: Settings = {
  providerId: PROVIDER_PRESETS[0].id,
  apiKeys: {},
  providerConfigs: Object.fromEntries(
    PROVIDER_PRESETS.map((preset) => [preset.id, { endpoint: preset.endpoint, model: preset.model }])
  ),
  endpoint: PROVIDER_PRESETS[0].endpoint,
  model: PROVIDER_PRESETS[0].model,
  pdfProviderId: PROVIDER_PRESETS[0].id,
  pdfApiKeys: {},
  pdfProviderConfigs: Object.fromEntries(
    PROVIDER_PRESETS.map((preset) => [preset.id, { endpoint: preset.endpoint, model: preset.model }])
  ),
  pdfEndpoint: PROVIDER_PRESETS[0].endpoint,
  pdfModel: PROVIDER_PRESETS[0].model,
  deepPdfParserEndpoint: "https://www.datalab.to/api/v1/convert",
  deepPdfParserApiKey: "",
  deepPdfParserMode: "balanced",
  deepPdfSummaryProviderId: PROVIDER_PRESETS[0].id,
  deepPdfSummaryApiKeys: {},
  deepPdfSummaryProviderConfigs: Object.fromEntries(
    PROVIDER_PRESETS.map((preset) => [preset.id, { endpoint: preset.endpoint, model: preset.model }])
  ),
  deepPdfSummaryEndpoint: PROVIDER_PRESETS[0].endpoint,
  deepPdfSummaryModel: PROVIDER_PRESETS[0].model,
  deepPdfVisionProviderId: "custom",
  deepPdfVisionApiKeys: {},
  deepPdfVisionProviderConfigs: {
    custom: { endpoint: "", model: "" }
  },
  deepPdfVisionEndpoint: "",
  deepPdfVisionModel: "",
  outputLanguage: "follow-page"
};

const SETTINGS_KEY = "learnPanelSettings";

type StoredSettings = Partial<Settings> & {
  apiKey?: string;
};

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const storedSettings = (stored[SETTINGS_KEY] ?? {}) as StoredSettings;
  const merged = {
    ...DEFAULT_SETTINGS,
    ...storedSettings
  };
  const detectedPreset = PROVIDER_PRESETS.find((preset) => preset.endpoint === merged.endpoint);
  const providerId = storedSettings.providerId ?? detectedPreset?.id ?? "custom";
  const detectedPdfPreset = PROVIDER_PRESETS.find((preset) => preset.endpoint === merged.pdfEndpoint);
  const pdfProviderId = storedSettings.pdfProviderId ?? detectedPdfPreset?.id ?? "custom";
  const detectedDeepPdfSummaryPreset = PROVIDER_PRESETS.find((preset) => preset.endpoint === merged.deepPdfSummaryEndpoint);
  const deepPdfSummaryProviderId =
    storedSettings.deepPdfSummaryProviderId ?? detectedDeepPdfSummaryPreset?.id ?? "custom";
  const detectedDeepPdfVisionPreset = PROVIDER_PRESETS.find((preset) => preset.endpoint === merged.deepPdfVisionEndpoint);
  const deepPdfVisionProviderId =
    storedSettings.deepPdfVisionProviderId ?? detectedDeepPdfVisionPreset?.id ?? "custom";
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
  const deepPdfVisionApiKeys = {
    ...DEFAULT_SETTINGS.deepPdfVisionApiKeys,
    ...(storedSettings.deepPdfVisionApiKeys ?? {})
  };
  const providerConfigs = {
    ...DEFAULT_SETTINGS.providerConfigs,
    ...(storedSettings.providerConfigs ?? {})
  };
  const pdfProviderConfigs = {
    ...DEFAULT_SETTINGS.pdfProviderConfigs,
    ...(storedSettings.pdfProviderConfigs ?? {})
  };
  const deepPdfSummaryProviderConfigs = {
    ...DEFAULT_SETTINGS.deepPdfSummaryProviderConfigs,
    ...(storedSettings.deepPdfSummaryProviderConfigs ?? {})
  };
  const deepPdfVisionProviderConfigs = {
    ...DEFAULT_SETTINGS.deepPdfVisionProviderConfigs,
    ...(storedSettings.deepPdfVisionProviderConfigs ?? {})
  };

  providerConfigs[providerId] = {
    endpoint: merged.endpoint,
    model: merged.model
  };
  pdfProviderConfigs[pdfProviderId] = {
    endpoint: merged.pdfEndpoint,
    model: merged.pdfModel
  };
  deepPdfSummaryProviderConfigs[deepPdfSummaryProviderId] = {
    endpoint: merged.deepPdfSummaryEndpoint,
    model: merged.deepPdfSummaryModel
  };
  deepPdfVisionProviderConfigs[deepPdfVisionProviderId] = {
    endpoint: merged.deepPdfVisionEndpoint,
    model: merged.deepPdfVisionModel
  };

  if (storedSettings.apiKey?.trim() && !apiKeys[providerId]) {
    apiKeys[providerId] = storedSettings.apiKey.trim();
  }

  return {
    ...merged,
    providerId,
    pdfProviderId,
    deepPdfSummaryProviderId,
    deepPdfVisionProviderId,
    apiKeys,
    pdfApiKeys,
    deepPdfSummaryApiKeys,
    deepPdfVisionApiKeys,
    providerConfigs,
    pdfProviderConfigs,
    deepPdfSummaryProviderConfigs,
    deepPdfVisionProviderConfigs
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
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

export function getActiveDeepPdfVisionApiKey(settings: Settings): string {
  return settings.deepPdfVisionApiKeys[settings.deepPdfVisionProviderId]?.trim() ?? "";
}
