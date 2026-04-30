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
  const apiKeys = {
    ...DEFAULT_SETTINGS.apiKeys,
    ...(storedSettings.apiKeys ?? {})
  };
  const pdfApiKeys = {
    ...DEFAULT_SETTINGS.pdfApiKeys,
    ...(storedSettings.pdfApiKeys ?? {})
  };
  const providerConfigs = {
    ...DEFAULT_SETTINGS.providerConfigs,
    ...(storedSettings.providerConfigs ?? {})
  };
  const pdfProviderConfigs = {
    ...DEFAULT_SETTINGS.pdfProviderConfigs,
    ...(storedSettings.pdfProviderConfigs ?? {})
  };

  providerConfigs[providerId] = {
    endpoint: merged.endpoint,
    model: merged.model
  };
  pdfProviderConfigs[pdfProviderId] = {
    endpoint: merged.pdfEndpoint,
    model: merged.pdfModel
  };

  if (storedSettings.apiKey?.trim() && !apiKeys[providerId]) {
    apiKeys[providerId] = storedSettings.apiKey.trim();
  }

  return {
    ...merged,
    providerId,
    pdfProviderId,
    apiKeys,
    pdfApiKeys,
    providerConfigs,
    pdfProviderConfigs
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
