import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  getActiveApiKey,
  getActiveDeepPdfSummaryApiKey,
  getActiveDeepPdfVisionApiKey,
  getActivePdfApiKey,
  loadSettings,
  PROVIDER_PRESETS,
  saveSettings
} from "../shared/settings";
import type { DatalabParseMode, OutputLanguage, Settings } from "../shared/types";
import "./styles.css";

function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [status, setStatus] = useState("");

  useEffect(() => {
    void loadSettings().then(setSettings);
  }, []);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settings) {
      return;
    }

    await saveSettings({
      ...settings,
      apiKeys: trimApiKeys(settings.apiKeys),
      pdfApiKeys: trimApiKeys(settings.pdfApiKeys),
      providerConfigs: trimProviderConfigs(settings.providerConfigs),
      pdfProviderConfigs: trimProviderConfigs(settings.pdfProviderConfigs),
      deepPdfSummaryProviderConfigs: trimProviderConfigs(settings.deepPdfSummaryProviderConfigs),
      deepPdfVisionProviderConfigs: trimProviderConfigs(settings.deepPdfVisionProviderConfigs),
      endpoint: settings.endpoint.trim(),
      model: settings.model.trim(),
      pdfEndpoint: settings.pdfEndpoint.trim(),
      pdfModel: settings.pdfModel.trim(),
      deepPdfParserEndpoint: settings.deepPdfParserEndpoint.trim(),
      deepPdfParserApiKey: settings.deepPdfParserApiKey.trim(),
      deepPdfSummaryApiKeys: trimApiKeys(settings.deepPdfSummaryApiKeys),
      deepPdfSummaryEndpoint: settings.deepPdfSummaryEndpoint.trim(),
      deepPdfSummaryModel: settings.deepPdfSummaryModel.trim(),
      deepPdfVisionApiKeys: trimApiKeys(settings.deepPdfVisionApiKeys),
      deepPdfVisionEndpoint: settings.deepPdfVisionEndpoint.trim(),
      deepPdfVisionModel: settings.deepPdfVisionModel.trim()
    });
    setStatus("Saved.");
    window.setTimeout(() => setStatus(""), 1600);
  }

  if (!settings) {
    return <main className="settings-shell">Loading settings...</main>;
  }

  const currentSettings = settings;
  const activePreset = currentSettings.providerId;
  const activeApiKey = getActiveApiKey(currentSettings);
  const activePdfPreset = currentSettings.pdfProviderId;
  const activePdfApiKey = getActivePdfApiKey(currentSettings);
  const activeDeepPdfSummaryPreset = currentSettings.deepPdfSummaryProviderId;
  const activeDeepPdfSummaryApiKey = getActiveDeepPdfSummaryApiKey(currentSettings);
  const activeDeepPdfVisionPreset = currentSettings.deepPdfVisionProviderId;
  const activeDeepPdfVisionApiKey = getActiveDeepPdfVisionApiKey(currentSettings);

  function applyPreset(presetId: string) {
    const preset = PROVIDER_PRESETS.find((item) => item.id === presetId);
    const savedConfig = currentSettings.providerConfigs[presetId];
    if (presetId === "custom") {
      setSettings({
        ...currentSettings,
        providerId: "custom",
        endpoint: currentSettings.providerConfigs.custom?.endpoint ?? currentSettings.endpoint,
        model: currentSettings.providerConfigs.custom?.model ?? currentSettings.model
      });
      return;
    }
    if (!preset) {
      return;
    }

    setSettings({
      ...currentSettings,
      providerId: preset.id,
      endpoint: savedConfig?.endpoint ?? preset.endpoint,
      model: savedConfig?.model ?? preset.model
    });
  }

  function updateActiveApiKey(apiKey: string) {
    setSettings({
      ...currentSettings,
      apiKeys: {
        ...currentSettings.apiKeys,
        [currentSettings.providerId]: apiKey
      }
    });
  }

  function updateEndpoint(endpoint: string) {
    setSettings({
      ...currentSettings,
      endpoint,
      providerConfigs: {
        ...currentSettings.providerConfigs,
        [currentSettings.providerId]: {
          endpoint,
          model: currentSettings.model
        }
      }
    });
  }

  function updateModel(model: string) {
    setSettings({
      ...currentSettings,
      model,
      providerConfigs: {
        ...currentSettings.providerConfigs,
        [currentSettings.providerId]: {
          endpoint: currentSettings.endpoint,
          model
        }
      }
    });
  }

  function applyPdfPreset(presetId: string) {
    const preset = PROVIDER_PRESETS.find((item) => item.id === presetId);
    const savedConfig = currentSettings.pdfProviderConfigs[presetId];
    if (presetId === "custom") {
      setSettings({
        ...currentSettings,
        pdfProviderId: "custom",
        pdfEndpoint: currentSettings.pdfProviderConfigs.custom?.endpoint ?? currentSettings.pdfEndpoint,
        pdfModel: currentSettings.pdfProviderConfigs.custom?.model ?? currentSettings.pdfModel
      });
      return;
    }
    if (!preset) {
      return;
    }

    setSettings({
      ...currentSettings,
      pdfProviderId: preset.id,
      pdfEndpoint: savedConfig?.endpoint ?? preset.endpoint,
      pdfModel: savedConfig?.model ?? preset.model
    });
  }

  function updateActivePdfApiKey(apiKey: string) {
    setSettings({
      ...currentSettings,
      pdfApiKeys: {
        ...currentSettings.pdfApiKeys,
        [currentSettings.pdfProviderId]: apiKey
      }
    });
  }

  function updatePdfEndpoint(endpoint: string) {
    setSettings({
      ...currentSettings,
      pdfEndpoint: endpoint,
      pdfProviderConfigs: {
        ...currentSettings.pdfProviderConfigs,
        [currentSettings.pdfProviderId]: {
          endpoint,
          model: currentSettings.pdfModel
        }
      }
    });
  }

  function updatePdfModel(model: string) {
    setSettings({
      ...currentSettings,
      pdfModel: model,
      pdfProviderConfigs: {
        ...currentSettings.pdfProviderConfigs,
        [currentSettings.pdfProviderId]: {
          endpoint: currentSettings.pdfEndpoint,
          model
        }
      }
    });
  }

  function applyDeepPdfSummaryPreset(presetId: string) {
    const preset = PROVIDER_PRESETS.find((item) => item.id === presetId);
    const savedConfig = currentSettings.deepPdfSummaryProviderConfigs[presetId];
    if (presetId === "custom") {
      setSettings({
        ...currentSettings,
        deepPdfSummaryProviderId: "custom",
        deepPdfSummaryEndpoint:
          currentSettings.deepPdfSummaryProviderConfigs.custom?.endpoint ?? currentSettings.deepPdfSummaryEndpoint,
        deepPdfSummaryModel:
          currentSettings.deepPdfSummaryProviderConfigs.custom?.model ?? currentSettings.deepPdfSummaryModel
      });
      return;
    }
    if (!preset) return;
    setSettings({
      ...currentSettings,
      deepPdfSummaryProviderId: preset.id,
      deepPdfSummaryEndpoint: savedConfig?.endpoint ?? preset.endpoint,
      deepPdfSummaryModel: savedConfig?.model ?? preset.model
    });
  }

  function updateDeepPdfSummaryApiKey(apiKey: string) {
    setSettings({
      ...currentSettings,
      deepPdfSummaryApiKeys: {
        ...currentSettings.deepPdfSummaryApiKeys,
        [currentSettings.deepPdfSummaryProviderId]: apiKey
      }
    });
  }

  function updateDeepPdfSummaryEndpoint(endpoint: string) {
    setSettings({
      ...currentSettings,
      deepPdfSummaryEndpoint: endpoint,
      deepPdfSummaryProviderConfigs: {
        ...currentSettings.deepPdfSummaryProviderConfigs,
        [currentSettings.deepPdfSummaryProviderId]: {
          endpoint,
          model: currentSettings.deepPdfSummaryModel
        }
      }
    });
  }

  function updateDeepPdfSummaryModel(model: string) {
    setSettings({
      ...currentSettings,
      deepPdfSummaryModel: model,
      deepPdfSummaryProviderConfigs: {
        ...currentSettings.deepPdfSummaryProviderConfigs,
        [currentSettings.deepPdfSummaryProviderId]: {
          endpoint: currentSettings.deepPdfSummaryEndpoint,
          model
        }
      }
    });
  }

  function applyDeepPdfVisionPreset(presetId: string) {
    const preset = PROVIDER_PRESETS.find((item) => item.id === presetId);
    const savedConfig = currentSettings.deepPdfVisionProviderConfigs[presetId];
    if (presetId === "custom") {
      setSettings({
        ...currentSettings,
        deepPdfVisionProviderId: "custom",
        deepPdfVisionEndpoint:
          currentSettings.deepPdfVisionProviderConfigs.custom?.endpoint ?? currentSettings.deepPdfVisionEndpoint,
        deepPdfVisionModel:
          currentSettings.deepPdfVisionProviderConfigs.custom?.model ?? currentSettings.deepPdfVisionModel
      });
      return;
    }
    if (!preset) return;
    setSettings({
      ...currentSettings,
      deepPdfVisionProviderId: preset.id,
      deepPdfVisionEndpoint: savedConfig?.endpoint ?? preset.endpoint,
      deepPdfVisionModel: savedConfig?.model ?? preset.model
    });
  }

  function updateDeepPdfVisionApiKey(apiKey: string) {
    setSettings({
      ...currentSettings,
      deepPdfVisionApiKeys: {
        ...currentSettings.deepPdfVisionApiKeys,
        [currentSettings.deepPdfVisionProviderId]: apiKey
      }
    });
  }

  function updateDeepPdfVisionEndpoint(endpoint: string) {
    setSettings({
      ...currentSettings,
      deepPdfVisionEndpoint: endpoint,
      deepPdfVisionProviderConfigs: {
        ...currentSettings.deepPdfVisionProviderConfigs,
        [currentSettings.deepPdfVisionProviderId]: {
          endpoint,
          model: currentSettings.deepPdfVisionModel
        }
      }
    });
  }

  function updateDeepPdfVisionModel(model: string) {
    setSettings({
      ...currentSettings,
      deepPdfVisionModel: model,
      deepPdfVisionProviderConfigs: {
        ...currentSettings.deepPdfVisionProviderConfigs,
        [currentSettings.deepPdfVisionProviderId]: {
          endpoint: currentSettings.deepPdfVisionEndpoint,
          model
        }
      }
    });
  }

  return (
    <main className="settings-shell">
      <header>
        <p>Reading Learning Panel</p>
        <h1>Settings</h1>
      </header>

      <form onSubmit={(event) => void onSubmit(event)}>
        <fieldset>
          <legend>Text analysis API</legend>

          <Field label="Provider">
            <select value={activePreset} onChange={(event) => applyPreset(event.target.value)}>
              {PROVIDER_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
              <option value="custom">Custom</option>
            </select>
          </Field>

          <Field label="API key">
            <input
              type="password"
              value={activeApiKey}
              autoComplete="off"
              onChange={(event) => updateActiveApiKey(event.target.value)}
              placeholder="Paste the selected text provider key"
            />
          </Field>

          <Field label="Endpoint">
            <input
              type="url"
              value={currentSettings.endpoint}
              onChange={(event) => updateEndpoint(event.target.value)}
            />
          </Field>

          <Field label="Model">
            <input value={currentSettings.model} onChange={(event) => updateModel(event.target.value)} />
          </Field>
        </fieldset>

        <fieldset>
          <legend>PDF visual API</legend>

          <Field label="Provider">
            <select value={activePdfPreset} onChange={(event) => applyPdfPreset(event.target.value)}>
              {PROVIDER_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
              <option value="custom">Custom</option>
            </select>
          </Field>

          <Field label="API key">
            <input
              type="password"
              value={activePdfApiKey}
              autoComplete="off"
              onChange={(event) => updateActivePdfApiKey(event.target.value)}
              placeholder="Paste the selected PDF provider key"
            />
          </Field>

          <Field label="Endpoint">
            <input
              type="url"
              value={currentSettings.pdfEndpoint}
              onChange={(event) => updatePdfEndpoint(event.target.value)}
            />
          </Field>

          <Field label="Model">
            <input value={currentSettings.pdfModel} onChange={(event) => updatePdfModel(event.target.value)} />
          </Field>
        </fieldset>

        <fieldset>
          <legend>PDF deep analysis</legend>

          <Field label="Parser endpoint">
            <input
              type="url"
              value={currentSettings.deepPdfParserEndpoint}
              onChange={(event) => setSettings({ ...currentSettings, deepPdfParserEndpoint: event.target.value })}
            />
          </Field>

          <Field label="Parser API key">
            <input
              type="password"
              value={currentSettings.deepPdfParserApiKey}
              autoComplete="off"
              onChange={(event) => setSettings({ ...currentSettings, deepPdfParserApiKey: event.target.value })}
              placeholder="Paste Datalab API key"
            />
          </Field>

          <Field label="Parser mode">
            <select
              value={currentSettings.deepPdfParserMode}
              onChange={(event) =>
                setSettings({ ...currentSettings, deepPdfParserMode: event.target.value as DatalabParseMode })
              }
            >
              <option value="balanced">balanced</option>
              <option value="fast">fast</option>
              <option value="accurate">accurate</option>
            </select>
          </Field>

          <Field label="Summary provider">
            <select value={activeDeepPdfSummaryPreset} onChange={(event) => applyDeepPdfSummaryPreset(event.target.value)}>
              {PROVIDER_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
              <option value="custom">Custom</option>
            </select>
          </Field>

          <Field label="Summary API key">
            <input
              type="password"
              value={activeDeepPdfSummaryApiKey}
              autoComplete="off"
              onChange={(event) => updateDeepPdfSummaryApiKey(event.target.value)}
              placeholder="Paste the selected summary provider key"
            />
          </Field>

          <Field label="Summary endpoint">
            <input
              type="url"
              value={currentSettings.deepPdfSummaryEndpoint}
              onChange={(event) => updateDeepPdfSummaryEndpoint(event.target.value)}
            />
          </Field>

          <Field label="Summary model">
            <input
              value={currentSettings.deepPdfSummaryModel}
              onChange={(event) => updateDeepPdfSummaryModel(event.target.value)}
            />
          </Field>

          <Field label="Further vision provider">
            <select value={activeDeepPdfVisionPreset} onChange={(event) => applyDeepPdfVisionPreset(event.target.value)}>
              <option value="custom">Custom / unused</option>
              {PROVIDER_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Further vision API key">
            <input
              type="password"
              value={activeDeepPdfVisionApiKey}
              autoComplete="off"
              onChange={(event) => updateDeepPdfVisionApiKey(event.target.value)}
              placeholder="Optional"
            />
          </Field>

          <Field label="Further vision endpoint">
            <input
              type="url"
              value={currentSettings.deepPdfVisionEndpoint}
              onChange={(event) => updateDeepPdfVisionEndpoint(event.target.value)}
              placeholder="Optional"
            />
          </Field>

          <Field label="Further vision model">
            <input
              value={currentSettings.deepPdfVisionModel}
              onChange={(event) => updateDeepPdfVisionModel(event.target.value)}
              placeholder="Optional"
            />
          </Field>
        </fieldset>

        <Field label="Output language">
          <select
            value={currentSettings.outputLanguage}
            onChange={(event) =>
              setSettings({ ...currentSettings, outputLanguage: event.target.value as OutputLanguage })
            }
          >
            <option value="follow-page">Follow page</option>
            <option value="zh">Chinese</option>
            <option value="en">English</option>
          </select>
        </Field>

        <footer>
          <button type="submit">Save settings</button>
          {status && <span>{status}</span>}
        </footer>
      </form>
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function trimApiKeys(apiKeys: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(apiKeys).map(([providerId, apiKey]) => [providerId, apiKey.trim()]));
}

function trimProviderConfigs(settings: Settings["providerConfigs"]): Settings["providerConfigs"] {
  return Object.fromEntries(
    Object.entries(settings).map(([providerId, config]) => [
      providerId,
      {
        endpoint: config.endpoint.trim(),
        model: config.model.trim()
      }
    ])
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
