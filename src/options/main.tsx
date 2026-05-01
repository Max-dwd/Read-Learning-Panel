import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { endpointsMatch, loadSettings, PROVIDER_PRESETS, saveSettings, type ProviderPreset } from "../shared/settings";
import type { DatalabParseMode, ModelConfig, OutputLanguage, Settings } from "../shared/types";
import "./styles.css";

function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [status, setStatus] = useState("");
  const [activeTab, setActiveTab] = useState<"api" | "preferences">("api");

  useEffect(() => {
    void loadSettings().then(setSettings);
  }, []);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settings) return;

    await saveSettings({
      ...settings,
      modelConfigs: trimModelConfigs(settings.modelConfigs),
      deepPdfParserEndpoint: settings.deepPdfParserEndpoint.trim(),
      deepPdfParserApiKey: settings.deepPdfParserApiKey.trim()
    });
    setStatus("Saved.");
    window.setTimeout(() => setStatus(""), 1600);
  }

  if (!settings) {
    return <main className="settings-shell">Loading settings...</main>;
  }

  const modelEntries = Object.entries(settings.modelConfigs);

  function updateModelConfig(id: string, patch: Partial<ModelConfig>) {
    if (!settings) return;
    setSettings({
      ...settings,
      modelConfigs: {
        ...settings.modelConfigs,
        [id]: {
          ...settings.modelConfigs[id],
          ...patch
        }
      }
    });
  }

  function addModel(preset?: ProviderPreset) {
    if (!settings) return;
    const id = `model-${preset?.id ?? "custom"}-${Date.now()}`;
    setSettings({
      ...settings,
      modelConfigs: {
        ...settings.modelConfigs,
        [id]: {
          name: preset?.label ?? "New model",
          endpoint: preset?.endpoint ?? "",
          apiKey: "",
          model: preset?.model ?? "",
          isMultimodal: Boolean(preset?.isMultimodal)
        }
      }
    });
  }

  function applyModelPreset(id: string, presetId: string) {
    if (!settings) return;
    const currentModel = settings.modelConfigs[id];
    if (!currentModel) return;
    if (!presetId) {
      updateModelConfig(id, {
        name: PROVIDER_PRESETS.some((item) => item.label === currentModel.name) ? "Custom model" : currentModel.name,
        endpoint: "",
        model: "",
        isMultimodal: false
      });
      return;
    }

    const preset = PROVIDER_PRESETS.find((item) => item.id === presetId);
    if (!preset) return;
    const shouldUsePresetName =
      !currentModel.name.trim() ||
      currentModel.name === "New model" ||
      PROVIDER_PRESETS.some((item) => item.label === currentModel.name);

    updateModelConfig(id, {
      name: shouldUsePresetName ? preset.label : currentModel.name,
      endpoint: preset.endpoint,
      model: preset.model,
      isMultimodal: Boolean(preset.isMultimodal)
    });
  }

  function deleteModel(id: string) {
    if (!settings) return;
    const { [id]: _removed, ...nextModelConfigs } = settings.modelConfigs;
    const nextSelections = Object.fromEntries(
      Object.entries(settings.featureModelSelections).filter(([, modelId]) => modelId !== id)
    );
    setSettings({
      ...settings,
      modelConfigs: nextModelConfigs,
      featureModelSelections: nextSelections
    });
  }

  return (
    <main className="settings-shell">
      <header>
        <p>Reading Learning Panel</p>
        <h1>Settings</h1>
      </header>

      <form onSubmit={(event) => void onSubmit(event)}>
        <nav className="settings-tabs" aria-label="Settings sections">
          <button className={activeTab === "api" ? "active" : ""} type="button" onClick={() => setActiveTab("api")}>
            模型 API
          </button>
          <button
            className={activeTab === "preferences" ? "active" : ""}
            type="button"
            onClick={() => setActiveTab("preferences")}
          >
            使用偏好
          </button>
        </nav>

        {activeTab === "api" && (
          <section className="settings-tab-panel">
            <div className="model-list-header">
              <div>
                <h2>Models</h2>
                <p>添加模型后，各功能入口旁边的下拉会从这里选择。</p>
              </div>
              <div className="model-add-actions">
                {PROVIDER_PRESETS.map((preset) => (
                  <button className="secondary-button" type="button" key={preset.id} onClick={() => addModel(preset)}>
                    {preset.label}
                  </button>
                ))}
                <button type="button" onClick={() => addModel()}>
                  Custom
                </button>
              </div>
            </div>

            {modelEntries.length === 0 ? (
              <section className="empty-models">
                <p>No models configured.</p>
                <div className="model-add-actions">
                  {PROVIDER_PRESETS.map((preset) => (
                    <button className="secondary-button" type="button" key={preset.id} onClick={() => addModel(preset)}>
                      Add {preset.label}
                    </button>
                  ))}
                  <button type="button" onClick={() => addModel()}>
                    Add custom
                  </button>
                </div>
              </section>
            ) : (
              <div className="model-list">
                {modelEntries.map(([id, model]) => (
                  <fieldset className="model-card" key={id}>
                    <legend>{model.name || model.model || "Untitled model"}</legend>

                    <Field label="Preset">
                      <select value={getModelPresetId(model)} onChange={(event) => applyModelPreset(id, event.target.value)}>
                        <option value="">Custom</option>
                        {PROVIDER_PRESETS.map((preset) => (
                          <option value={preset.id} key={preset.id}>
                            {preset.label}
                          </option>
                        ))}
                      </select>
                    </Field>

                    <Field label="Name">
                      <input value={model.name} onChange={(event) => updateModelConfig(id, { name: event.target.value })} />
                    </Field>

                    <Field label="Endpoint">
                      <input
                        type="url"
                        value={model.endpoint}
                        onChange={(event) => updateModelConfig(id, { endpoint: event.target.value })}
                        placeholder="https://.../v1"
                      />
                    </Field>

                    <Field label="API key">
                      <input
                        type="password"
                        value={model.apiKey}
                        autoComplete="off"
                        onChange={(event) => updateModelConfig(id, { apiKey: event.target.value })}
                      />
                    </Field>

                    <Field label="Model">
                      <input value={model.model} onChange={(event) => updateModelConfig(id, { model: event.target.value })} />
                    </Field>

                    <div className="model-card-actions">
                      <CheckboxField
                        label="Multimodal model"
                        checked={model.isMultimodal}
                        onChange={(checked) => updateModelConfig(id, { isMultimodal: checked })}
                      />
                      <button className="danger-button" type="button" onClick={() => deleteModel(id)}>
                        Delete
                      </button>
                    </div>
                  </fieldset>
                ))}
              </div>
            )}
          </section>
        )}

        {activeTab === "preferences" && (
          <section className="settings-tab-panel">
            <fieldset>
              <legend>阅读偏好</legend>

              <Field label="Output language">
                <select
                  value={settings.outputLanguage}
                  onChange={(event) => setSettings({ ...settings, outputLanguage: event.target.value as OutputLanguage })}
                >
                  <option value="follow-page">Follow page</option>
                  <option value="zh">Chinese</option>
                  <option value="en">English</option>
                </select>
              </Field>
            </fieldset>

            <fieldset>
              <legend>Datalab parser</legend>

              <Field label="Parser endpoint">
                <input
                  type="url"
                  value={settings.deepPdfParserEndpoint}
                  onChange={(event) => setSettings({ ...settings, deepPdfParserEndpoint: event.target.value })}
                />
              </Field>

              <Field label="Parser API key">
                <input
                  type="password"
                  value={settings.deepPdfParserApiKey}
                  autoComplete="off"
                  onChange={(event) => setSettings({ ...settings, deepPdfParserApiKey: event.target.value })}
                  placeholder="Paste Datalab API key"
                />
              </Field>

              <Field label="Parser mode">
                <select
                  value={settings.deepPdfParserMode}
                  onChange={(event) => setSettings({ ...settings, deepPdfParserMode: event.target.value as DatalabParseMode })}
                >
                  <option value="balanced">balanced</option>
                  <option value="fast">fast</option>
                  <option value="accurate">accurate</option>
                </select>
              </Field>
            </fieldset>
          </section>
        )}

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

function CheckboxField({
  label,
  checked,
  onChange
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="checkbox-field">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function getModelPresetId(model: ModelConfig): string {
  const endpoint = model.endpoint.trim();
  return PROVIDER_PRESETS.find((preset) => endpointsMatch(preset.endpoint, endpoint))?.id ?? "";
}

function trimModelConfigs(modelConfigs: Record<string, ModelConfig>): Record<string, ModelConfig> {
  return Object.fromEntries(
    Object.entries(modelConfigs).map(([id, config]) => [
      id,
      {
        name: config.name.trim(),
        endpoint: config.endpoint.trim(),
        apiKey: config.apiKey.trim(),
        model: config.model.trim(),
        isMultimodal: config.isMultimodal
      }
    ])
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
