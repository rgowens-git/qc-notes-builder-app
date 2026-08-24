import { useEffect, useRef, useState } from "react";

const CONFIG_URL = "/config.json";
const FALLBACK_STORAGE_KEY = "qc-notes-builder-config-v2";
const LAYOUT_MODE_STORAGE_KEY = "qc-notes-builder-layout-mode";

function slugify(value) {
  return (
    value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "item"
  );
}

function uniqueId(base, usedIds) {
  let candidate = slugify(base);
  let suffix = 2;

  while (usedIds.has(candidate)) {
    candidate = `${slugify(base)}-${suffix}`;
    suffix += 1;
  }

  return candidate;
}

function normalizeConfig(rawConfig) {
  const meta = {
    title: rawConfig?.meta?.title || "QC Note Builder",
    subtitle:
      rawConfig?.meta?.subtitle ||
      "Build semicolon-ready review notes from a flexible set of sections.",
    storageKey: rawConfig?.meta?.storageKey || FALLBACK_STORAGE_KEY,
  };

  const sectionIds = new Set();

  const sections = (rawConfig?.sections || []).map((section, sectionIndex) => {
    const sectionId = uniqueId(
      section?.id || section?.label || `section-${sectionIndex + 1}`,
      sectionIds,
    );
    sectionIds.add(sectionId);

    const optionIds = new Set();

    const options = (section?.options || []).map((option, optionIndex) => {
      const optionId = uniqueId(
        option?.id || option?.label || `option-${optionIndex + 1}`,
        optionIds,
      );
      optionIds.add(optionId);

      return {
        id: optionId,
        label: option?.label || `Option ${optionIndex + 1}`,
        note: option?.note || option?.label || `Option ${optionIndex + 1}`,
      };
    });

    return {
      id: sectionId,
      label: section?.label || `Section ${sectionIndex + 1}`,
      type: section?.type === "multi" ? "multi" : "single",
      required: Boolean(section?.required),
      includeLabelInStructuredText:
        section?.includeLabelInStructuredText !== false,
      helper: section?.helper || "",
      options,
    };
  });

  return { meta, sections };
}

function getStorageKey(config, defaultConfig) {
  return (
    config?.meta?.storageKey ||
    defaultConfig?.meta?.storageKey ||
    FALLBACK_STORAGE_KEY
  );
}

function getSelectedOptions(section, selections) {
  const selection = selections[section.id];

  if (section.type === "multi") {
    const selectedIds = Array.isArray(selection) ? selection : [];
    return section.options.filter((option) => selectedIds.includes(option.id));
  }

  return section.options.filter((option) => option.id === selection);
}

function sanitizeSelections(config, currentSelections) {
  const nextSelections = {};

  for (const section of config.sections) {
    const previousValue = currentSelections?.[section.id];

    if (section.type === "multi") {
      const validIds = new Set(section.options.map((option) => option.id));
      nextSelections[section.id] = Array.isArray(previousValue)
        ? previousValue.filter((id) => validIds.has(id))
        : [];
      continue;
    }

    const selectedId = typeof previousValue === "string" ? previousValue : "";
    nextSelections[section.id] = section.options.some(
      (option) => option.id === selectedId,
    )
      ? selectedId
      : "";
  }

  return nextSelections;
}

function getMissingRequiredSections(config, selections) {
  return config.sections
    .filter((section) => section.required)
    .filter((section) => getSelectedOptions(section, selections).length === 0)
    .map((section) => section.label);
}

function buildOutputs(config, selections) {
  const structuredSegments = [];
  const rationaleSegments = [];
  let selectedOptionCount = 0;

  for (const section of config.sections) {
    const chosenOptions = getSelectedOptions(section, selections);

    if (chosenOptions.length === 0) {
      continue;
    }

    selectedOptionCount += chosenOptions.length;

    const structuredValue = chosenOptions.map((option) => option.label).join(", ");

    structuredSegments.push(
      section.includeLabelInStructuredText
        ? `${section.label}: ${structuredValue}`
        : structuredValue,
    );

    rationaleSegments.push(
      `${section.label}: ${chosenOptions
        .map((option) => option.note?.trim() || option.label)
        .join(", ")}`,
    );
  }

  return {
    structuredText: structuredSegments.join("; "),
    rationaleText: rationaleSegments.join("; "),
    completedSections: structuredSegments.length,
    selectedOptionCount,
  };
}

function createOption(section) {
  const usedIds = new Set(section.options.map((option) => option.id));
  const optionNumber = section.options.length + 1;
  const label = `New Option ${optionNumber}`;

  return {
    id: uniqueId(label, usedIds),
    label,
    note: `${label} note`,
  };
}

function createSection(existingSections) {
  const usedIds = new Set(existingSections.map((section) => section.id));
  const label = `New Section ${existingSections.length + 1}`;

  return {
    id: uniqueId(label, usedIds),
    label,
    type: "single",
    required: false,
    helper: "Describe what this section is checking.",
    options: [
      {
        id: "new-option-1",
        label: "New Option 1",
        note: "New Option 1 note",
      },
    ],
  };
}

function moveItem(items, currentIndex, nextIndex) {
  if (nextIndex < 0 || nextIndex >= items.length) {
    return items;
  }

  const reordered = [...items];
  const [movedItem] = reordered.splice(currentIndex, 1);
  reordered.splice(nextIndex, 0, movedItem);
  return reordered;
}

function copyWithFallback(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }

  return new Promise((resolve, reject) => {
    const temp = document.createElement("textarea");
    temp.value = text;
    temp.setAttribute("readonly", "true");
    temp.style.position = "absolute";
    temp.style.left = "-9999px";
    document.body.appendChild(temp);
    temp.select();

    try {
      document.execCommand("copy");
      resolve();
    } catch (error) {
      reject(error);
    } finally {
      document.body.removeChild(temp);
    }
  });
}

export default function App() {
  const importRef = useRef(null);
  const [layoutMode, setLayoutMode] = useState(() => {
    if (typeof window === "undefined") {
      return "v1";
    }

    return window.localStorage.getItem(LAYOUT_MODE_STORAGE_KEY) === "condensed"
      ? "condensed"
      : "v1";
  });
  const [config, setConfig] = useState(null);
  const [defaultConfig, setDefaultConfig] = useState(null);
  const [selections, setSelections] = useState({});
  const [showPreview, setShowPreview] = useState(false);
  const [previewMode, setPreviewMode] = useState("structured");
  const [missingRequired, setMissingRequired] = useState([]);
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [copiedLabel, setCopiedLabel] = useState("");
  const [loadedFromSavedConfig, setLoadedFromSavedConfig] = useState(false);

  useEffect(() => {
    async function loadConfig() {
      try {
        const response = await fetch(CONFIG_URL);

        if (!response.ok) {
          throw new Error(`Unable to load config (${response.status})`);
        }

        const fileConfig = normalizeConfig(await response.json());
        const storageKey = getStorageKey(fileConfig, fileConfig);
        const savedConfig = localStorage.getItem(storageKey);
        let activeConfig = fileConfig;
        let loadedSavedConfig = false;

        if (savedConfig) {
          try {
            activeConfig = normalizeConfig(JSON.parse(savedConfig));
            loadedSavedConfig = true;
          } catch {
            localStorage.removeItem(storageKey);
          }
        }

        setDefaultConfig(fileConfig);
        setConfig(activeConfig);
        setSelections(sanitizeSelections(activeConfig, {}));
        setLoadedFromSavedConfig(loadedSavedConfig);
      } catch (error) {
        setErrorMessage(
          `The app could not load config.json. ${error instanceof Error ? error.message : ""}`.trim(),
        );
      }
    }

    loadConfig();
  }, []);

  useEffect(() => {
    if (!config) {
      return;
    }

    setSelections((currentSelections) =>
      sanitizeSelections(config, currentSelections),
    );
  }, [config]);

  useEffect(() => {
    if (!copiedLabel) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      setCopiedLabel("");
    }, 2200);

    return () => window.clearTimeout(timer);
  }, [copiedLabel]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(LAYOUT_MODE_STORAGE_KEY, layoutMode);
  }, [layoutMode]);

  const outputs = config
    ? buildOutputs(config, selections)
    : {
        structuredText: "",
        rationaleText: "",
        completedSections: 0,
        selectedOptionCount: 0,
      };
  const activePreviewText =
    previewMode === "structured" ? outputs.structuredText : outputs.rationaleText;
  const activePreviewLabel =
    previewMode === "structured" ? "Structured Search String" : "Rationale Preview";

  function updateSingleSelection(sectionId, optionId) {
    setSelections((currentSelections) => ({
      ...currentSelections,
      [sectionId]: optionId,
    }));
    setMissingRequired([]);
  }

  function toggleMultiSelection(sectionId, optionId) {
    setSelections((currentSelections) => {
      const currentValues = Array.isArray(currentSelections[sectionId])
        ? currentSelections[sectionId]
        : [];

      return {
        ...currentSelections,
        [sectionId]: currentValues.includes(optionId)
          ? currentValues.filter((value) => value !== optionId)
          : [...currentValues, optionId],
      };
    });
    setMissingRequired([]);
  }

  function handleGenerate() {
    if (!config) {
      return;
    }

    const missing = getMissingRequiredSections(config, selections);
    setMissingRequired(missing);

    if (missing.length > 0) {
      setStatusMessage("Complete the highlighted required sections, then generate again.");
      setShowPreview(false);
      return;
    }

    setStatusMessage("");
    setPreviewMode("structured");
    setShowPreview(true);
  }

  function clearSelections() {
    if (!config) {
      return;
    }

    setSelections(sanitizeSelections(config, {}));
    setShowPreview(false);
    setMissingRequired([]);
    setStatusMessage("Selections cleared.");
  }

  async function handleCopy(text, label) {
    try {
      await copyWithFallback(text);
      setCopiedLabel(label);
      setStatusMessage("");
    } catch {
      setStatusMessage(`Copy failed for ${label}.`);
    }
  }

  function updateSection(sectionId, updates) {
    setConfig((currentConfig) => ({
      ...currentConfig,
      sections: currentConfig.sections.map((section) =>
        section.id === sectionId ? { ...section, ...updates } : section,
      ),
    }));
  }

  function updateSectionOptions(sectionId, transform) {
    setConfig((currentConfig) => ({
      ...currentConfig,
      sections: currentConfig.sections.map((section) =>
        section.id === sectionId
          ? { ...section, options: transform(section) }
          : section,
      ),
    }));
  }

  function updateOption(sectionId, optionId, updates) {
    updateSectionOptions(sectionId, (section) =>
      section.options.map((option) =>
        option.id === optionId ? { ...option, ...updates } : option,
      ),
    );
  }

  function addSection() {
    setConfig((currentConfig) => ({
      ...currentConfig,
      sections: [...currentConfig.sections, createSection(currentConfig.sections)],
    }));
    setStatusMessage("New section added below.");
  }

  function removeSection(sectionId) {
    setConfig((currentConfig) => ({
      ...currentConfig,
      sections: currentConfig.sections.filter((section) => section.id !== sectionId),
    }));

    setSelections((currentSelections) => {
      const nextSelections = { ...currentSelections };
      delete nextSelections[sectionId];
      return nextSelections;
    });

    setStatusMessage("Section removed.");
  }

  function moveSection(sectionId, direction) {
    setConfig((currentConfig) => {
      const index = currentConfig.sections.findIndex(
        (section) => section.id === sectionId,
      );

      return {
        ...currentConfig,
        sections: moveItem(currentConfig.sections, index, index + direction),
      };
    });
  }

  function addOption(sectionId) {
    updateSectionOptions(sectionId, (section) => [
      ...section.options,
      createOption(section),
    ]);
    setStatusMessage("Option added.");
  }

  function removeOption(sectionId, optionId) {
    updateSectionOptions(sectionId, (section) =>
      section.options.filter((option) => option.id !== optionId),
    );
    setStatusMessage("Option removed.");
  }

  function moveOption(sectionId, optionId, direction) {
    updateSectionOptions(sectionId, (section) => {
      const index = section.options.findIndex((option) => option.id === optionId);
      return moveItem(section.options, index, index + direction);
    });
  }

  function saveConfigToBrowser() {
    if (!config) {
      return;
    }

    localStorage.setItem(
      getStorageKey(config, defaultConfig),
      JSON.stringify(config, null, 2),
    );
    setLoadedFromSavedConfig(true);
    setStatusMessage("Config saved in this browser.");
  }

  function resetToWorkbookDefaults() {
    if (!defaultConfig) {
      return;
    }

    localStorage.removeItem(getStorageKey(config, defaultConfig));
    setConfig(defaultConfig);
    setSelections(sanitizeSelections(defaultConfig, {}));
    setShowPreview(false);
    setMissingRequired([]);
    setLoadedFromSavedConfig(false);
    setStatusMessage("Workbook defaults restored.");
  }

  function downloadConfig() {
    if (!config) {
      return;
    }

    const blob = new Blob([JSON.stringify(config, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "config.json";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    setStatusMessage("config.json downloaded.");
  }

  async function importConfig(event) {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    try {
      const importedConfig = normalizeConfig(JSON.parse(await file.text()));
      setConfig(importedConfig);
      setSelections(sanitizeSelections(importedConfig, {}));
      setShowPreview(false);
      setMissingRequired([]);
      setStatusMessage(
        "Config imported for this session. Save in browser if you want it to load automatically next time.",
      );
    } catch (error) {
      setStatusMessage(
        `Config import failed. ${error instanceof Error ? error.message : ""}`.trim(),
      );
    } finally {
      event.target.value = "";
    }
  }

  if (errorMessage) {
    return (
      <main className="shell shell--centered">
        <section className="feedback-card feedback-card--error">
          <p className="eyebrow">Load Error</p>
          <h1>QC Note Builder could not start</h1>
          <p>{errorMessage}</p>
        </section>
      </main>
    );
  }

  if (!config) {
    return (
      <main className="shell shell--centered">
        <section className="feedback-card">
          <p className="eyebrow">Loading</p>
          <h1>Preparing your builder</h1>
          <p>Loading sections from config.json…</p>
        </section>
      </main>
    );
  }

  return (
    <main
      className={`shell shell--compact${
        layoutMode === "condensed" ? " shell--condensed" : ""
      }`}
    >
      <section className="hero hero--compact">
        <div className="hero__copy">
          <h1>{config.meta.title}</h1>
          <div className="hero__layout">
            <span className="hero__layout-label">Layout</span>
            <div className="view-switcher" role="tablist" aria-label="Layout mode">
              <button
                aria-pressed={layoutMode === "v1"}
                className={`view-switcher__button${
                  layoutMode === "v1" ? " view-switcher__button--active" : ""
                }`}
                onClick={() => setLayoutMode("v1")}
                type="button"
              >
                Version 1
              </button>
              <button
                aria-pressed={layoutMode === "condensed"}
                className={`view-switcher__button${
                  layoutMode === "condensed" ? " view-switcher__button--active" : ""
                }`}
                onClick={() => setLayoutMode("condensed")}
                type="button"
              >
                Condensed
              </button>
            </div>
          </div>
        </div>

        <div className="hero__stats">
          <div className="stat-card">
            <span className="stat-card__label">Sections</span>
            <strong>{config.sections.length}</strong>
          </div>
          <div className="stat-card">
            <span className="stat-card__label">Selected Items</span>
            <strong>{outputs.selectedOptionCount}</strong>
          </div>
          <div className="stat-card">
            <span className="stat-card__label">Saved Config</span>
            <strong>{loadedFromSavedConfig ? "Yes" : "Default"}</strong>
          </div>
        </div>
      </section>

      {missingRequired.length > 0 ? (
        <section className="alert-strip">
          <strong>Required sections still open:</strong> {missingRequired.join(", ")}
        </section>
      ) : null}

      <section className="workspace">
        <div className="workspace__main">
          <section className="builder-grid">
            {config.sections.map((section, sectionIndex) => {
              const chosenOptions = getSelectedOptions(section, selections);
              const isMissing = missingRequired.includes(section.label);

              return (
                <article
                  className={`section-card section-card--compact${
                    isMissing ? " section-card--missing" : ""
                  }`}
                  key={section.id}
                  style={{ animationDelay: `${sectionIndex * 55}ms` }}
                >
                  <header className="section-card__header">
                    <div>
                      <div className="section-card__title-row">
                        <h2>{section.label}</h2>
                        <span className={`type-pill type-pill--${section.type}`}>
                          {section.type === "single" ? "Single" : "Multi"}
                        </span>
                        {section.required ? (
                          <span className="required-pill">Required</span>
                        ) : null}
                      </div>
                      {section.helper ? (
                        <p className="section-card__helper">{section.helper}</p>
                      ) : null}
                    </div>

                    <span className="count-pill">
                      {section.type === "single"
                        ? chosenOptions[0]?.label || "No selection"
                        : `${chosenOptions.length} selected`}
                    </span>
                  </header>

                  <div className="option-chip-list">
                    {section.options.length === 0 ? (
                      <div className="empty-state">
                        This section has no options yet. Add options below in Manage Config.
                      </div>
                    ) : (
                      section.options.map((option) => {
                        const inputId = `${section.id}-${option.id}`;
                        const checked =
                          section.type === "single"
                            ? selections[section.id] === option.id
                            : (selections[section.id] || []).includes(option.id);

                        return (
                          <label
                            className={`option-chip${checked ? " option-chip--active" : ""}`}
                            htmlFor={inputId}
                            key={option.id}
                            title={option.note}
                          >
                            <input
                              checked={checked}
                              className="visually-hidden"
                              id={inputId}
                              name={section.id}
                              onChange={() =>
                                section.type === "single"
                                  ? updateSingleSelection(section.id, option.id)
                                  : toggleMultiSelection(section.id, option.id)
                              }
                              type={section.type === "single" ? "radio" : "checkbox"}
                            />
                            <span>{option.label}</span>
                          </label>
                        );
                      })
                    )}
                  </div>
                </article>
              );
            })}
          </section>
        </div>

        <aside className="workspace__side">
          <section className="preview-panel preview-panel--sticky">
            <div className="preview-actions">
              <div className="toolbar__actions">
                <button className="button button--primary" type="button" onClick={handleGenerate}>
                  Generate Rationale
                </button>
                <button className="button button--ghost" type="button" onClick={clearSelections}>
                  Clear Selections
                </button>
              </div>

              {statusMessage ? <p className="toolbar__message">{statusMessage}</p> : null}
            </div>

            <div className="preview-panel__header preview-panel__header--compact">
              <div>
                <p className="eyebrow">Preview</p>
                <h2>Generated Notes</h2>
                <p>Build once, copy fast, and keep the output searchable.</p>
              </div>
              <div className="preview-panel__meta">
                <span>{outputs.completedSections} populated sections</span>
              </div>
            </div>

            {showPreview ? (
              <>
                <div className="preview-tabs" role="tablist" aria-label="Preview type">
                  <button
                    className={`preview-tab${
                      previewMode === "structured" ? " preview-tab--active" : ""
                    }`}
                    onClick={() => setPreviewMode("structured")}
                    role="tab"
                    type="button"
                  >
                    Structured
                  </button>
                  <button
                    className={`preview-tab${
                      previewMode === "rationale" ? " preview-tab--active" : ""
                    }`}
                    onClick={() => setPreviewMode("rationale")}
                    role="tab"
                    type="button"
                  >
                    Rationale
                  </button>
                </div>

                <article className="preview-card preview-card--single">
                  <div className="preview-card__topline">
                    <h3>{activePreviewLabel}</h3>
                    <button
                      className="button button--ghost button--small"
                      type="button"
                      onClick={() => handleCopy(activePreviewText, activePreviewLabel)}
                    >
                      Copy
                    </button>
                  </div>
                  <textarea readOnly value={activePreviewText} />
                </article>

                {copiedLabel ? <p className="copy-banner">{copiedLabel} copied.</p> : null}
              </>
            ) : (
              <div className="preview-placeholder">
                <strong>No preview yet.</strong>
                <span>
                  Make your selections on the left, then use <em>Generate Rationale</em>.
                </span>
              </div>
            )}
          </section>
        </aside>
      </section>

      <details className="config-drawer">
        <summary className="config-drawer__summary">
          <div>
            <p className="eyebrow">Manage Config</p>
            <h2>Edit Sections and Options</h2>
            <p>Open only when you want to change the builder structure.</p>
          </div>
          <span className="config-drawer__summary-meta">
            {config.sections.length} sections configured
          </span>
        </summary>

        <section className="config-panel">
          <div className="config-panel__header">
            <div>
              <p>
                Change labels, add new sections, reorder the output, and save the config in
                your browser or download a fresh <code>config.json</code>.
              </p>
            </div>

            <div className="config-panel__actions">
              <button className="button button--primary" type="button" onClick={saveConfigToBrowser}>
                Save in Browser
              </button>
              <button className="button button--ghost" type="button" onClick={downloadConfig}>
                Download config.json
              </button>
              <button
                className="button button--ghost"
                type="button"
                onClick={() => importRef.current?.click()}
              >
                Import config.json
              </button>
              <button className="button button--ghost" type="button" onClick={resetToWorkbookDefaults}>
                Reset to Workbook Defaults
              </button>
              <input
                accept="application/json"
                className="visually-hidden"
                onChange={importConfig}
                ref={importRef}
                type="file"
              />
            </div>
          </div>

          <div className="config-panel__callout">
            <strong>Tip:</strong> Save in Browser keeps your edits on this machine. Downloading
            the file gives you a version you can archive or replace in <code>public/config.json</code>.
          </div>

          <div className="config-sections">
            {config.sections.map((section, sectionIndex) => (
              <details className="config-section" key={section.id}>
                <summary>
                  <span>
                    {sectionIndex + 1}. {section.label}
                  </span>
                  <span className="config-section__summary-meta">
                    {section.options.length} options
                  </span>
                </summary>

                <div className="config-section__body">
                  <div className="config-field-grid">
                    <label className="field">
                      <span>Section Label</span>
                      <input
                        type="text"
                        value={section.label}
                        onChange={(event) =>
                          updateSection(section.id, { label: event.target.value })
                        }
                      />
                    </label>

                    <label className="field">
                      <span>Selection Type</span>
                      <select
                        value={section.type}
                        onChange={(event) =>
                          updateSection(section.id, { type: event.target.value })
                        }
                      >
                        <option value="single">Single</option>
                        <option value="multi">Multi</option>
                      </select>
                    </label>

                    <label className="field">
                      <span>Required</span>
                      <select
                        value={section.required ? "yes" : "no"}
                        onChange={(event) =>
                          updateSection(section.id, {
                            required: event.target.value === "yes",
                          })
                        }
                      >
                        <option value="yes">Yes</option>
                        <option value="no">No</option>
                      </select>
                    </label>
                  </div>

                  <label className="field field--full">
                    <span>Helper Text</span>
                    <textarea
                      rows="2"
                      value={section.helper}
                      onChange={(event) =>
                        updateSection(section.id, { helper: event.target.value })
                      }
                    />
                  </label>

                  <div className="config-actions">
                    <button
                      className="button button--ghost button--small"
                      type="button"
                      onClick={() => moveSection(section.id, -1)}
                    >
                      Move Up
                    </button>
                    <button
                      className="button button--ghost button--small"
                      type="button"
                      onClick={() => moveSection(section.id, 1)}
                    >
                      Move Down
                    </button>
                    <button
                      className="button button--danger button--small"
                      type="button"
                      onClick={() => removeSection(section.id)}
                    >
                      Remove Section
                    </button>
                  </div>

                  <div className="option-editor-list">
                    {section.options.map((option) => (
                      <article className="option-editor" key={option.id}>
                        <div className="option-editor__controls">
                          <button
                            className="button button--ghost button--small"
                            type="button"
                            onClick={() => moveOption(section.id, option.id, -1)}
                          >
                            Up
                          </button>
                          <button
                            className="button button--ghost button--small"
                            type="button"
                            onClick={() => moveOption(section.id, option.id, 1)}
                          >
                            Down
                          </button>
                          <button
                            className="button button--danger button--small"
                            type="button"
                            onClick={() => removeOption(section.id, option.id)}
                          >
                            Remove
                          </button>
                        </div>

                        <div className="config-field-grid">
                          <label className="field">
                            <span>Option Label</span>
                            <input
                              type="text"
                              value={option.label}
                              onChange={(event) =>
                                updateOption(section.id, option.id, {
                                  label: event.target.value,
                                })
                              }
                            />
                          </label>

                          <label className="field field--wide">
                            <span>Generated Note</span>
                            <textarea
                              rows="2"
                              value={option.note}
                              onChange={(event) =>
                                updateOption(section.id, option.id, {
                                  note: event.target.value,
                                })
                              }
                            />
                          </label>
                        </div>
                      </article>
                    ))}
                  </div>

                  <button
                    className="button button--primary button--small"
                    type="button"
                    onClick={() => addOption(section.id)}
                  >
                    Add Option
                  </button>
                </div>
              </details>
            ))}
          </div>

          <button className="button button--primary" type="button" onClick={addSection}>
            Add Section
          </button>
        </section>
      </details>
    </main>
  );
}
