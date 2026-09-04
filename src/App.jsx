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

function NotesBuilder() {
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

const TASK_REVIEW_TEMPLATES = {
  docs: {
    label: "Docs",
    description: "Review document content, writing quality, aesthetics, and real-world usability.",
    sections: [
      {
        title: "Content Quality",
        checks: [
          "Instruction following",
          "AI slop",
          "Writing quality",
          "Organization and storytelling",
          "Comprehensiveness and substance",
          "Groundedness and accuracy",
        ],
      },
      {
        title: "Professional Writing Failure Modes",
        checks: [
          "Formulaic, slogan-like, or figurative language",
          "Vague, inflated, or unsupported substance",
          "Wordy, jargon-filled, or indirect language",
          "Unnecessary framing, repetition, or structure",
        ],
      },
      {
        title: "Aesthetics",
        checks: ["Visual defects (P0)", "Overstyling (P1)", "Readability (P2)"],
      },
      {
        title: "Overall",
        checks: [
          "Overall scores align with dimensional scores",
          "Document is of good quality",
          "Document is ready for real-world use",
          "All key components are editable",
          "Document is appropriate for the intended audience",
          "Amount of revision required is accurately reflected",
          "Weaknesses that limit usability are identified",
        ],
      },
    ],
  },
  sheets: {
    label: "Sheets",
    description: "Review workbook correctness, layout, formulas, visual styling, and maintainability.",
    sections: [
      {
        title: "Correctness",
        checks: [
          "Instruction following",
          "Correct calculations, formulas, and logic",
          "Written content quality",
          "AI slop",
          "Accurate use of source material",
          "Appropriate assumptions",
          "No unsupported conclusions",
          "No misleading or irrelevant content",
        ],
      },
      {
        title: "Layout",
        checks: [
          "Raw data, assumptions, calculations, and outputs are clearly separated",
          "Inputs, outputs, tables, and charts are placed where users expect them",
          "Logical tab order and sheet names",
          "Headers make sections easy to understand",
          "Clear flow from source data to result",
          "No clutter, hidden critical information, or confusing navigation",
        ],
      },
      {
        title: "Formula Usage",
        checks: [
          "Formulas are used instead of hardcoded results",
          "No magic numbers embedded directly in formulas",
          "Absolute and relative references work when copied",
          "Comparable ranges use consistent formulas",
          "Named ranges, helper columns, or tables are used when useful",
          "No broken references, circular references, or avoidable errors",
        ],
      },
      {
        title: "Style and Aesthetics",
        checks: [
          "Appropriate number formats",
          "Clear header styling and hierarchy",
          "Readable fonts and text sizes",
          "Useful borders, fills, and gridline choices",
          "Sensible row heights and column widths",
          "Consistent color scheme",
          "Charts and dashboards are legible and consistent",
          "Polished without unnecessary decoration",
        ],
      },
      {
        title: "Overall",
        checks: [
          "Overall scores align with dimensional scores",
          "Workbook is of good quality",
          "Workbook is ready for real-world use",
          "Workbook outputs can be trusted",
          "Workbook can be maintained",
          "Revision required before use is accurately reflected",
          "Weaknesses that limit usability are identified",
        ],
      },
    ],
  },
  slides: {
    label: "Slides",
    description: "Review presentation content, narrative, visual craft, layout, and editability.",
    sections: [
      {
        title: "Content Quality",
        checks: [
          "Instruction following",
          "Content usefulness and coverage of concepts",
          "AI slop",
          "Accuracy and faithfulness",
          "No incorrect or irrelevant additions",
          "No misleading omissions",
        ],
        sif: [
          "Deck follows template or brand instructions",
          "Required visual elements are present",
          "Reference style is applied to content",
          "Required sections are included",
          "Template placeholders are updated",
          "Design meets prompt intent",
        ],
      },
      {
        title: "Storytelling",
        checks: [
          "Clear structure and progression",
          "Good transitions between slides",
          "Logical or emotional buildup",
          "A sense of purpose and momentum",
          "Deck feels engaging rather than list-like",
        ],
        sif: [
          "Template narrative structure is used",
          "Visual elements connect sections",
          "Style supports the intended tone",
          "Visual hierarchy creates emphasis",
          "Section dividers and visual elements assist with flow",
        ],
      },
      {
        title: "Aesthetics",
        checks: [
          "Consistency across the deck",
          "Typography quality and hierarchy",
          "Color use and visual harmony",
          "Enough visual variety to stay engaging",
          "Quality of visual elements",
          "Appropriate font choice",
          "Provided template aesthetics were followed",
        ],
        sif: [
          "Adaptations remain recognizable as part of the design",
          "New components fit the design reference",
          "Deck design feels intentional and not template-like",
          "Branding is integrated into the content",
        ],
      },
      {
        title: "Layout",
        checks: [
          "Spacing and margins",
          "Alignment",
          "Grouping of related elements",
          "Clear visual hierarchy",
          "No clutter or overlap",
          "Slides are easy to scan",
          "Provided template aesthetics were followed",
        ],
        sif: [
          "Content is adapted to fit the layout",
          "Repeated elements are consistent",
          "Template components are adapted thoughtfully",
          "Layout is consistent with the reference template",
        ],
      },
      {
        title: "Editability",
        checks: [
          "Master template exists and was used",
          "Native PowerPoint elements are used",
          "Elements are movable and editable",
          "Full-slide images are avoided",
          "Deck is practical for real edits",
        ],
      },
      {
        title: "Overall",
        checks: [
          "Overall scores align with dimensional scores",
          "Deck is ready for real-world use",
          "I would be confident presenting or sharing it as-is",
          "Deck feels cohesive and purposeful",
          "Effort required to reach a high standard is accurately reflected",
          "No major weakness undermines the deck",
        ],
        sif: [
          "Response follows the required style and template",
          "Style is adapted thoughtfully to the content",
          "Deck is polished, effective, and editable",
          "Little or no revision is required before use",
        ],
      },
    ],
  },
};

const SHARED_REVIEW_GROUPS = [
  {
    title: "Grounding Checks",
    checks: [
      "Verified Corrupt Files selections",
      "Prompt was addressed",
      "AI Slop included in Rationales",
      "PAI indicators were checked",
    ],
  },
  {
    title: "Rationale Quality Verification",
    checks: [
      "Bullets are concise and specific",
      "Bullets are in the correct dimension",
      "Concrete evidence was provided",
    ],
  },
  {
    title: "Scoring Verification",
    checks: [
      "High and low scores are supported, especially 1s, 2s, 6s, and 7s",
      "Mid-scores include both positives and negatives",
    ],
  },
];

function CommentField({ label, value, onChange, placeholder }) {
  const [copied, setCopied] = useState(false);

  async function copyComment() {
    if (!value.trim()) return;
    await copyWithFallback(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="review-comments">
      <div className="review-comments__header">
        <span>{label}</span>
        <button className="comment-copy-button" type="button" onClick={copyComment} disabled={!value.trim()} aria-label={`Copy ${label}`} title={`Copy ${label}`}>
          <svg aria-hidden="true" viewBox="0 0 24 24"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <textarea aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
    </div>
  );
}

function ReviewChecklist({ title, checks, sif, responseId, values, onToggle, comments, onComments, score, onScore, leadingContent, footerContent }) {
  return (
    <section className="review-card">
      <div className="review-card__heading">
        <h3>{title}</h3>
        {onScore ? (
          <label className="score-field">
            <span>Score</span>
            <input aria-label={`${title} score`} value={score} onChange={(event) => onScore(event.target.value)} placeholder="1–7" />
          </label>
        ) : null}
      </div>
      {leadingContent}
      <div className="review-check-grid">
        {checks.map((check) => {
          const key = `${responseId}:${title}:${check}`;
          return (
            <label className="review-check" key={check}>
              <input type="checkbox" checked={Boolean(values[key])} onChange={() => onToggle(key)} />
              <span>{check}</span>
            </label>
          );
        })}
      </div>
      {sif?.length ? (
        <div className="sif-group">
          <p className="sif-group__label">SIF checks</p>
          <div className="review-check-grid">
            {sif.map((check) => {
              const key = `${responseId}:${title}:SIF:${check}`;
              return (
                <label className="review-check" key={check}>
                  <input type="checkbox" checked={Boolean(values[key])} onChange={() => onToggle(key)} />
                  <span>{check}</span>
                </label>
              );
            })}
          </div>
        </div>
      ) : null}
      {onComments ? (
        <CommentField label={`${title} comments`} value={comments} onChange={onComments} placeholder={`Add evidence and actionable ${title.toLowerCase()} feedback…`} />
      ) : null}
      {footerContent}
    </section>
  );
}

function TaskReviews() {
  const [templateId, setTemplateId] = useState("docs");
  const [responseCount, setResponseCount] = useState(3);
  const [sifRequired, setSifRequired] = useState(false);
  const [activeResponse, setActiveResponse] = useState("A");
  const [details, setDetails] = useState({ taskUrl: "", batch: "", evaluator: "", reviewer: "", reviewDate: "", domainMatch: "" });
  const [checks, setChecks] = useState({});
  const [comments, setComments] = useState({});
  const [scores, setScores] = useState({});
  const [ranking, setRanking] = useState("");
  const [rankingComments, setRankingComments] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const [copiedResponse, setCopiedResponse] = useState("");
  const [clearedReview, setClearedReview] = useState(null);
  const template = TASK_REVIEW_TEMPLATES[templateId];
  const responseLabels = Array.from(
    { length: responseCount },
    (_, index) => String.fromCharCode(65 + index),
  );

  function changeResponseCount(value) {
    const nextCount = Number(value);
    const nextLabels = Array.from(
      { length: nextCount },
      (_, index) => String.fromCharCode(65 + index),
    );
    setResponseCount(nextCount);
    if (!nextLabels.includes(activeResponse)) {
      setActiveResponse(nextLabels[nextLabels.length - 1]);
    }
  }

  function toggleCheck(key) {
    setChecks((current) => ({ ...current, [key]: !current[key] }));
  }

  function resetReview() {
    setClearedReview({ checks, comments, scores, ranking, rankingComments });
    setChecks({});
    setComments({});
    setScores({});
    setRanking("");
    setRankingComments("");
    setCopiedResponse("");
    setCopyStatus("Review cleared.");
  }

  function undoClearReview() {
    if (!clearedReview) return;
    setChecks(clearedReview.checks);
    setComments(clearedReview.comments);
    setScores(clearedReview.scores);
    setRanking(clearedReview.ranking);
    setRankingComments(clearedReview.rankingComments);
    setClearedReview(null);
    setCopyStatus("Review restored.");
  }

  function buildResponseReviewText(response) {
    const lines = [`Response ${response}`];
    template.sections.forEach((section) => {
      const selected = [...section.checks, ...(sifRequired ? section.sif || [] : [])].filter((check) =>
        Object.entries(checks).some(([key, value]) => value && key.startsWith(`${response}:${section.title}:`) && key.endsWith(check)),
      );
      lines.push(`${section.title}${scores[`${response}:${section.title}`] ? ` (${scores[`${response}:${section.title}`]}/7)` : ""}: ${selected.length ? selected.join("; ") : "No checks selected"}`);
      if (comments[`${response}:${section.title}`]) lines.push(`Comments: ${comments[`${response}:${section.title}`]}`);
    });
    return lines.join("\n");
  }

  function buildReviewText() {
    const lines = [
      `${template.label} Task Review`,
      `Task URL: ${details.taskUrl || "—"}`,
      `Batch: ${details.batch || "—"}`,
      `Evaluator: ${details.evaluator || "—"}`,
      `Reviewer: ${details.reviewer || "—"}`,
      `Review Date: ${details.reviewDate || "—"}`,
      `Domain Match: ${details.domainMatch || "—"}`,
      `SIF Requirements: ${sifRequired ? "Yes" : "No"}`,
    ];
    responseLabels.forEach((response) => {
      lines.push(`\n${buildResponseReviewText(response)}`);
    });
    lines.push(`\nOverall Ranking: ${ranking || "—"}`, `Ranking Comments: ${rankingComments || "—"}`);
    return lines.join("\n");
  }

  async function copyReview() {
    await copyWithFallback(buildReviewText());
    setCopyStatus("Task review copied.");
  }

  async function copyResponseReview(response) {
    await copyWithFallback(buildResponseReviewText(response));
    setCopiedResponse(response);
    window.setTimeout(() => setCopiedResponse(""), 1800);
  }

  return (
    <main className="task-review-shell">
      <section className="task-review-hero">
        <div>
          <p className="eyebrow">Artifact verification</p>
          <h1>Task Review Builder</h1>
          <p>Use this review to spot critical submission blockers and give evaluators clear, actionable calibration feedback.</p>
        </div>
        <div className="benchmark-card"><strong>20 min</strong><span>benchmark for 3 reviews</span></div>
      </section>

      <section className="shared-review-panel">
        <div className="shared-review-panel__intro">
          <div>
            <p className="eyebrow">Task Information</p>
            <h2>Review details</h2>
          </div>
        </div>
        <div className="review-detail-grid">
          {[
            ["taskUrl", "Task URL", "url"], ["batch", "Batch", "text"], ["evaluator", "Evaluator", "text"],
            ["reviewer", "Reviewer", "text"], ["reviewDate", "Review Date", "date"],
          ].map(([key, label, type]) => (
            <label className="review-field" key={key}><span>{label}</span><input type={type} value={details[key]} onChange={(event) => setDetails((current) => ({ ...current, [key]: event.target.value }))} /></label>
          ))}
        </div>
      </section>

      <section className="template-panel">
        <div className="template-panel__intro">
          <div className="template-panel__heading">
            <p className="eyebrow">Choose a template</p>
            <h2>What type of artifact are you reviewing?</h2>
          </div>
          <div className="template-settings">
            <label className="response-count-field">
              <span>Number of Responses</span>
              <select value={responseCount} onChange={(event) => changeResponseCount(event.target.value)}>
                {[2, 3, 4, 5, 6, 7, 8].map((count) => (
                  <option key={count} value={count}>{count}</option>
                ))}
              </select>
            </label>
            <label className="response-count-field">
              <span>SIF Requirements</span>
              <select value={sifRequired ? "Yes" : "No"} onChange={(event) => setSifRequired(event.target.value === "Yes")}>
                <option value="No">No</option>
                <option value="Yes">Yes</option>
              </select>
            </label>
          </div>
        </div>
        <div className="template-selector" role="radiogroup" aria-label="Task review template">
          {Object.entries(TASK_REVIEW_TEMPLATES).map(([id, item]) => (
            <button className={`template-option${templateId === id ? " template-option--active" : ""}`} aria-pressed={templateId === id} key={id} onClick={() => setTemplateId(id)} type="button">
              <span className="template-option__icon">{id === "docs" ? "D" : id === "sheets" ? "S" : "P"}</span>
              <span><strong>{item.label}</strong><small>{item.description}</small></span>
            </button>
          ))}
        </div>
      </section>

      <section className="quick-verification-panel">
        <div className="quick-verification-panel__header">
          <p className="eyebrow">Quick Verification</p>
          <h2>Initial review checks</h2>
        </div>
        <div className="shared-check-grid">
          {SHARED_REVIEW_GROUPS.map((group) => {
            const domainMatchField = group.title === "Grounding Checks" ? (
                <label className="domain-match-select">
                  <span>Domain Match</span>
                  <select value={details.domainMatch} onChange={(event) => setDetails((current) => ({ ...current, domainMatch: event.target.value }))}>
                    <option value="">Select an option</option>
                    <option value="Yes">Yes</option>
                    <option value="No">No</option>
                    <option value="Unable to verify">Unable to verify</option>
                  </select>
                </label>
            ) : null;
            return <ReviewChecklist key={group.title} title={group.title} checks={group.checks} responseId="shared" values={checks} onToggle={toggleCheck} leadingContent={domainMatchField} />;
          })}
        </div>
      </section>

      <section className="response-panel">
        <div className="response-panel__top">
          <div><p className="eyebrow">{template.label} review</p><h2>Response {activeResponse}</h2></div>
          <div className="response-tabs" role="tablist" aria-label="Response selection">
            {responseLabels.map((response) => <button className={activeResponse === response ? "response-tab response-tab--active" : "response-tab"} onClick={() => setActiveResponse(response)} key={response} type="button">Response {response}</button>)}
          </div>
        </div>
        <div className="response-sections">
          {template.sections.map((section) => {
            const key = `${activeResponse}:${section.title}`;
            const copyButton = section.title === "Overall" ? (
              <div className="response-copy-footer">
                <button className="button button--primary response-copy-button" onClick={() => copyResponseReview(activeResponse)} type="button">
                  {copiedResponse === activeResponse ? "Response Review Copied" : "Copy Response Review"}
                </button>
                <p>This can be pasted into a single comment in Feather to provide feedback for the evaluator.</p>
              </div>
            ) : null;
            return <ReviewChecklist key={section.title} {...section} sif={sifRequired ? section.sif : undefined} responseId={activeResponse} values={checks} onToggle={toggleCheck} comments={comments[key] || ""} onComments={(value) => setComments((current) => ({ ...current, [key]: value }))} score={scores[key] || ""} onScore={(value) => setScores((current) => ({ ...current, [key]: value }))} footerContent={copyButton} />;
          })}
        </div>
      </section>

      <section className="ranking-panel">
        <div><p className="eyebrow">Close out</p><h2>Overall Ranking</h2></div>
        <div className="ranking-order-row">
          <label className="review-field"><span>Ranking order</span><input value={ranking} onChange={(event) => setRanking(event.target.value)} placeholder={`e.g. ${[...responseLabels].reverse().join(" > ")}`} /></label>
        </div>
        <div className="ranking-checks">
          {["Rankings are consistent with overall scores", "Ranking rationale justifies placement", "Ties or close calls are described", "Evidence from response rationales is cited"].map((check) => {
            const key = `ranking:${check}`;
            return <label className="review-check" key={check}><input type="checkbox" checked={Boolean(checks[key])} onChange={() => toggleCheck(key)} /><span>{check}</span></label>;
          })}
        </div>
        <CommentField label="Overall ranking comments" value={rankingComments} onChange={setRankingComments} placeholder="Explain placement, close calls, and evidence from the response rationales…" />
        <div className="review-actions">
          <div className="task-copy-action">
            <button className="button button--primary" onClick={copyReview} type="button">Copy Task Review</button>
            <p>This can be pasted into Slack for feedback to the evaluator.</p>
          </div>
          <div className="clear-review-action">
            <button className="button button--ghost clear-review-button" onClick={resetReview} type="button">Clear Review</button>
          </div>
          {copyStatus ? (
            <div className="review-status-row">
              <span className="review-status">{copyStatus}</span>
              {clearedReview ? <button className="undo-clear-button" onClick={undoClearReview} type="button">Undo Clear</button> : null}
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}

export default function App() {
  const [page, setPage] = useState("reviews");
  return (
    <>
      <nav className="app-nav" aria-label="Application sections">
        <div className="app-nav__brand"><span className="app-nav__mark">QC</span><span><strong>Quality Control</strong><small>Review workspace</small></span></div>
        <div className="app-nav__links">
          <button className={page === "reviews" ? "app-nav__link app-nav__link--active" : "app-nav__link"} onClick={() => setPage("reviews")} type="button">Task Reviews</button>
          <button className={page === "notes" ? "app-nav__link app-nav__link--active" : "app-nav__link"} onClick={() => setPage("notes")} type="button">QC Notes</button>
        </div>
      </nav>
      {page === "notes" ? <NotesBuilder /> : <TaskReviews />}
    </>
  );
}
