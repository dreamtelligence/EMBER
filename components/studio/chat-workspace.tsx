"use client";

import { useEffect, useMemo, useState } from "react";
import { BOOK_JOB_MODEL_PRESETS, DEFAULT_BOOK_JOB_MODELS, normalizeKnownModelAlias } from "@/lib/book-job-models";
import {
  createDefaultAssistantContextSelection,
  type AssistantContextSelection,
  type AssistantContextScope,
  type AssistantOutputMode,
  type AssistantProvider,
  type AssistantThread,
  type SceneContext,
  type StoryDocument
} from "@/lib/story-schema";

const CHAT_PROVIDERS: Array<{
  id: AssistantProvider;
  label: string;
}> = [
  { id: "auto", label: "Auto" },
  { id: "openai", label: "OpenAI" },
  { id: "anthropic", label: "Anthropic" },
  { id: "local", label: "Gemma lokal" }
];

const QUICK_PROMPTS = [
  "Schärfe den Hook, damit der Stoff kommerzieller und klarer wirkt.",
  "Welche drei Risiken siehst du aktuell im Manuskript?",
  "Erstelle eine pipeline-kompatible Regie-Vorlage für den aktuellen Projektstand."
];

const OUTPUT_MODE_OPTIONS: Array<{
  id: AssistantOutputMode;
  label: string;
}> = [
  { id: "chat", label: "Chatten" },
  { id: "note", label: "Notiz" },
  { id: "regie", label: "Regie erstellen" }
];

const CONTEXT_SCOPE_OPTIONS: Array<{
  id: AssistantContextScope;
  label: string;
}> = [
  { id: "project", label: "Projekt" },
  { id: "act", label: "Act" },
  { id: "chapter", label: "Kapitel" },
  { id: "scene", label: "Szene" }
];

export function ChatWorkspace({
  story,
  selectedThread,
  selectedArtifactId,
  selectedSceneContext,
  isLoading,
  error,
  onSubmit,
  onSelectArtifact,
  onCreateThread,
  onUpdatePreferences
}: {
  story: StoryDocument;
  selectedThread: AssistantThread | null;
  selectedArtifactId: string | null;
  selectedSceneContext: SceneContext | null;
  isLoading: boolean;
  error: string | null;
  onSubmit: (params: {
    prompt: string;
    outputMode: AssistantOutputMode;
    contextSelection: AssistantContextSelection;
  }) => Promise<void>;
  onSelectArtifact: (artifactId: string) => void;
  onCreateThread: () => void;
  onUpdatePreferences: (updater: (preferences: StoryDocument["assistant"]["preferences"]) => StoryDocument["assistant"]["preferences"]) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [contextSelection, setContextSelection] = useState<AssistantContextSelection>(function () {
    return coerceContextSelection(
      selectedThread?.context ??
        (selectedSceneContext
          ? createContextSelectionFromSceneContext(selectedSceneContext)
          : createDefaultAssistantContextSelection()),
      story,
      selectedSceneContext
    );
  });

  useEffect(
    function () {
      const preferredContext =
        selectedThread?.context ??
        (selectedSceneContext
          ? createContextSelectionFromSceneContext(selectedSceneContext)
          : createDefaultAssistantContextSelection());
      const nextSelection = coerceContextSelection(preferredContext, story, selectedSceneContext);

      setContextSelection(function (currentSelection) {
        return areAssistantContextsEqual(currentSelection, nextSelection) ? currentSelection : nextSelection;
      });
    },
    [selectedSceneContext, selectedThread?.id, story]
  );

  const threadArtifacts = useMemo(function () {
    if (!selectedThread) {
      return [];
    }

    return story.assistant.artifacts.filter(function (artifact) {
      return artifact.threadId === selectedThread.id;
    });
  }, [selectedThread, story.assistant.artifacts]);

  const selectedArtifact =
    story.assistant.artifacts.find(function (artifact) {
      return artifact.id === selectedArtifactId;
    }) ?? threadArtifacts[0] ?? null;
  const selectedAct = story.acts.find(function (act) {
    return act.id === contextSelection.actId;
  }) ?? null;
  const selectedChapter = selectedAct?.chapters.find(function (chapter) {
    return chapter.id === contextSelection.chapterId;
  }) ?? null;
  const selectedScene = selectedChapter?.scenes.find(function (scene) {
    return scene.id === contextSelection.sceneId;
  }) ?? null;
  const modelKey = resolveProviderModelKey(story.assistant.preferences.provider);
  const showQuickPrompts = !selectedThread || selectedThread.messages.length === 0;

  async function handleSubmit() {
    const nextPrompt = prompt.trim();

    if (!nextPrompt || isLoading) {
      return;
    }

    await onSubmit({
      prompt: nextPrompt,
      outputMode: story.assistant.preferences.outputMode,
      contextSelection
    });
    setPrompt("");
  }

  return (
    <section className="chat-workspace" aria-label="Assistant Workspace">
      <div className="chat-shell">
        <header className="chat-shell__header">
          <div>
            <span className="scene-editor__eyebrow">Assistant</span>
            <h2>{selectedThread?.title || "Neues Gespräch"}</h2>
            <p>Strategische Fragen, Brainstorming und speicherbare Regie-Dokumente.</p>
          </div>
          <div className="chat-shell__meta">
            <span className="scene-editor__pill">{story.title}</span>
            <span className="scene-editor__pill">
              {selectedThread ? `${selectedThread.messages.length} Nachrichten` : "Noch leer"}
            </span>
            <span className="scene-editor__pill">{threadArtifacts.length} Dokumente</span>
          </div>
        </header>

        <div className="chat-shell__toolbar">
          <div className="chat-control-grid">
            <label className="editor-field chat-control-field">
              <span>Anbieter</span>
              <select
                className="editor-input editor-select"
                value={story.assistant.preferences.provider}
                onChange={function (event) {
                  const provider = event.target.value as AssistantProvider;

                  onUpdatePreferences(function (preferences) {
                    return {
                      ...preferences,
                      provider
                    };
                  });
                }}
              >
                {CHAT_PROVIDERS.map(function (provider) {
                  return (
                    <option key={provider.id} value={provider.id}>
                      {provider.label}
                    </option>
                  );
                })}
              </select>
            </label>

            <label className="editor-field chat-control-field">
              <span>Modell</span>
              <select
                className="editor-input editor-select"
                value={modelKey ? normalizeLegacyChatModel(story.assistant.preferences.modelSelection[modelKey]) : ""}
                disabled={!modelKey}
                onChange={function (event) {
                  if (!modelKey) {
                    return;
                  }

                  onUpdatePreferences(function (preferences) {
                    return {
                      ...preferences,
                      modelSelection: {
                        ...preferences.modelSelection,
                        [modelKey]: event.target.value
                      }
                    };
                  });
                }}
              >
                <option value="">
                  {story.assistant.preferences.provider === "local"
                    ? "MLX lokal"
                    : modelKey
                      ? `Standard (${DEFAULT_BOOK_JOB_MODELS[modelKey]})`
                      : "Automatisch"}
                </option>
                {modelKey
                  ? BOOK_JOB_MODEL_PRESETS[modelKey].map(function (model) {
                      return (
                        <option key={model} value={model}>
                          {model}
                        </option>
                      );
                    })
                  : null}
              </select>
            </label>

            <label className="editor-field chat-control-field">
              <span>Output</span>
              <div className="pill-group" aria-label="Output">
                {OUTPUT_MODE_OPTIONS.map(function (option) {
                  return (
                    <button
                      key={option.id}
                      className={
                        "pill-button" +
                        (story.assistant.preferences.outputMode === option.id ? " pill-button--active" : "")
                      }
                      type="button"
                      onClick={function () {
                        onUpdatePreferences(function (preferences) {
                          return {
                            ...preferences,
                            outputMode: option.id
                          };
                        });
                      }}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
            </label>
          </div>

          <div className="chat-context-grid">
            <label className="editor-field chat-control-field">
              <span>Kontext</span>
              <select
                className="editor-input editor-select"
                value={contextSelection.scope}
                onChange={function (event) {
                  const nextScope = event.target.value as AssistantContextScope;
                  setContextSelection(function (currentSelection) {
                    return coerceContextSelection(
                      {
                        ...currentSelection,
                        scope: nextScope
                      },
                      story,
                      selectedSceneContext
                    );
                  });
                }}
              >
                {CONTEXT_SCOPE_OPTIONS.map(function (scopeOption) {
                  return (
                    <option key={scopeOption.id} value={scopeOption.id}>
                      {scopeOption.label}
                    </option>
                  );
                })}
              </select>
            </label>

            {contextSelection.scope === "act" || contextSelection.scope === "chapter" || contextSelection.scope === "scene" ? (
              <label className="editor-field chat-control-field">
                <span>Act</span>
                <select
                  className="editor-input editor-select"
                  value={selectedAct?.id ?? ""}
                  onChange={function (event) {
                    setContextSelection(function (currentSelection) {
                      return coerceContextSelection(
                        {
                          ...currentSelection,
                          actId: event.target.value || null,
                          chapterId: null,
                          sceneId: null
                        },
                        story,
                        selectedSceneContext
                      );
                    });
                  }}
                >
                  {story.acts.map(function (act) {
                    return (
                      <option key={act.id} value={act.id}>
                        {act.title}
                      </option>
                    );
                  })}
                </select>
              </label>
            ) : null}

            {contextSelection.scope === "chapter" || contextSelection.scope === "scene" ? (
              <label className="editor-field chat-control-field">
                <span>Kapitel</span>
                <select
                  className="editor-input editor-select"
                  value={selectedChapter?.id ?? ""}
                  onChange={function (event) {
                    setContextSelection(function (currentSelection) {
                      return coerceContextSelection(
                        {
                          ...currentSelection,
                          chapterId: event.target.value || null,
                          sceneId: null
                        },
                        story,
                        selectedSceneContext
                      );
                    });
                  }}
                >
                  {(selectedAct?.chapters ?? []).map(function (chapter) {
                    return (
                      <option key={chapter.id} value={chapter.id}>
                        {chapter.title}
                      </option>
                    );
                  })}
                </select>
              </label>
            ) : null}

            {contextSelection.scope === "scene" ? (
              <label className="editor-field chat-control-field">
                <span>Szene</span>
                <select
                  className="editor-input editor-select"
                  value={selectedScene?.id ?? ""}
                  onChange={function (event) {
                    setContextSelection(function (currentSelection) {
                      return coerceContextSelection(
                        {
                          ...currentSelection,
                          sceneId: event.target.value || null
                        },
                        story,
                        selectedSceneContext
                      );
                    });
                  }}
                >
                  {(selectedChapter?.scenes ?? []).map(function (scene) {
                    return (
                      <option key={scene.id} value={scene.id}>
                        {scene.title}
                      </option>
                    );
                  })}
                </select>
              </label>
            ) : null}
          </div>
        </div>

        <div className="chat-shell__body">
          <section className="chat-panel">
            {!selectedThread ? (
              <div className="chat-empty">
                <h3>Kein Gespräch aktiv</h3>
                <p>Thread anlegen und direkt mit einer konkreten Frage oder einem Regieauftrag starten.</p>
                <div className="chat-empty__actions">
                  <button className="flat-button" type="button" onClick={onCreateThread}>
                    + Gespräch anlegen
                  </button>
                </div>
              </div>
            ) : (
              <div className="chat-message-list">
                {selectedThread.messages.map(function (message) {
                  const linkedArtifact = message.artifactId
                    ? story.assistant.artifacts.find(function (artifact) {
                        return artifact.id === message.artifactId;
                      }) ?? null
                    : null;

                  return (
                    <article
                      key={message.id}
                      className={
                        "chat-message" +
                        (message.role === "assistant" ? " chat-message--assistant" : " chat-message--user")
                      }
                    >
                      <div className="chat-message__meta">
                        <strong>{message.role === "assistant" ? "Assistant" : "Du"}</strong>
                        <span>{formatTimestamp(message.createdAt)}</span>
                        <span>{formatOutputModeLabel(message.outputMode)}</span>
                        <span>{formatAssistantContextLabel(message.context, story)}</span>
                        {message.modelName ? <span>{message.modelName}</span> : null}
                      </div>
                      <div className="chat-message__content">
                        {message.content.split("\n").map(function (line, index) {
                          return (
                            <p key={`${message.id}:${index}`}>
                              {line || "\u00a0"}
                            </p>
                          );
                        })}
                      </div>
                      {linkedArtifact ? (
                        <button
                          className="chat-message__artifact"
                          type="button"
                          onClick={function () {
                            onSelectArtifact(linkedArtifact.id);
                          }}
                        >
                          Dokument öffnen: {linkedArtifact.title}
                        </button>
                      ) : null}
                    </article>
                  );
                })}

                {isLoading ? (
                  <div className="chat-message chat-message--pending">
                    <div className="chat-message__meta">
                      <strong>Assistant</strong>
                      <span>arbeitet</span>
                    </div>
                    <div className="chat-message__content">
                      <p>Antwort wird erzeugt...</p>
                    </div>
                  </div>
                ) : null}
              </div>
            )}

            <div className="chat-composer">
              {showQuickPrompts ? (
                <div className="chat-composer__quick">
                  {QUICK_PROMPTS.map(function (entry) {
                    return (
                      <button
                        key={entry}
                        className="chat-quick-action"
                        type="button"
                        onClick={function () {
                          setPrompt(entry);
                        }}
                      >
                        {entry}
                      </button>
                    );
                  })}
                </div>
              ) : null}

              <label className="editor-field">
                <span>{story.assistant.preferences.outputMode === "regie" ? "Regie-Auftrag" : "Prompt"} · {formatAssistantContextLabel(contextSelection, story)}</span>
                <textarea
                  className="editor-textarea chat-composer__textarea"
                  value={prompt}
                  placeholder={
                    story.assistant.preferences.outputMode === "regie"
                      ? "Beschreibe die Ideensammlung oder das Ziel der Regie. Vorhandene Fakten werden gesichert, echte Lücken separat markiert."
                      : "Frage nach Strategie, Figurenlogik, Marktpositionierung oder fordere eine Notiz an."
                  }
                  onChange={function (event) {
                    setPrompt(event.target.value);
                  }}
                />
              </label>

              {error ? <p className="outline-composer__feedback outline-composer__feedback--error">{error}</p> : null}

              <div className="chat-composer__actions">
                <button className="flat-button" type="button" onClick={onCreateThread}>
                  + Thread
                </button>
                <button className="flat-button" type="button" onClick={handleSubmit} disabled={!prompt.trim() || isLoading}>
                  {isLoading
                    ? "Läuft..."
                    : story.assistant.preferences.outputMode === "regie"
                      ? "Regie-Vorlage erzeugen"
                      : story.assistant.preferences.outputMode === "note"
                        ? "Notiz erzeugen"
                        : "Senden"}
                </button>
              </div>
            </div>
          </section>

          <aside className="chat-artifact-panel">
            <div className="chat-artifact-panel__head">
              <div>
                <span className="scene-editor__eyebrow">Dokumente</span>
                <h3>{selectedArtifact?.title || "Kein Dokument"}</h3>
              </div>
              {selectedArtifact ? (
                <span className="scene-editor__pill">{selectedArtifact.kind === "regie" ? "Regie" : "Notiz"}</span>
              ) : null}
            </div>

            {threadArtifacts.length ? (
              <div className="chat-artifact-list">
                {threadArtifacts.map(function (artifact) {
                  return (
                    <button
                      key={artifact.id}
                      className={
                        "chat-artifact-list__item" +
                        (selectedArtifact?.id === artifact.id ? " chat-artifact-list__item--active" : "")
                      }
                      type="button"
                      onClick={function () {
                        onSelectArtifact(artifact.id);
                      }}
                    >
                      <strong>{artifact.title}</strong>
                      <span>{artifact.summary}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}

            {selectedArtifact ? (
              <article className="chat-artifact-viewer">
                <div className="chat-artifact-viewer__meta">
                  <span>{formatTimestamp(selectedArtifact.updatedAt)}</span>
                  <span>{formatAssistantContextLabel(selectedArtifact.context, story)}</span>
                </div>
                <pre>{selectedArtifact.content}</pre>
              </article>
            ) : (
              <div className="chat-artifact-empty">
                <p>Noch kein gespeichertes Dokument in diesem Thread.</p>
                <p>Im Modus `Regie` wird die Antwort direkt als Arbeitsdokument ausgegeben.</p>
              </div>
            )}
          </aside>
        </div>
      </div>
    </section>
  );
}

function formatTimestamp(value: string) {
  if (!value) {
    return "ohne Datum";
  }

  const timestamp = new Date(value);

  if (Number.isNaN(timestamp.getTime())) {
    return "ohne Datum";
  }

  return new Intl.DateTimeFormat("de-DE", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(timestamp);
}

function resolveProviderModelKey(provider: AssistantProvider) {
  if (provider === "openai" || provider === "anthropic") {
    return provider;
  }

  return null;
}

function normalizeLegacyChatModel(value: string) {
  return normalizeKnownModelAlias(value) ?? value;
}

function formatOutputModeLabel(mode: AssistantOutputMode) {
  if (mode === "regie") {
    return "Regie";
  }

  if (mode === "note") {
    return "Notiz";
  }

  return "Antwort";
}

function createContextSelectionFromSceneContext(sceneContext: SceneContext): AssistantContextSelection {
  return {
    scope: "scene",
    actId: sceneContext.act.id,
    chapterId: sceneContext.chapter.id,
    sceneId: sceneContext.scene.id
  };
}

function coerceContextSelection(
  selection: AssistantContextSelection,
  story: StoryDocument,
  selectedSceneContext: SceneContext | null
): AssistantContextSelection {
  const fallbackAct = selectedSceneContext?.act ?? story.acts[0] ?? null;
  const act =
    selection.actId
      ? story.acts.find(function (entry) {
          return entry.id === selection.actId;
        }) ?? fallbackAct
      : fallbackAct;
  const chapter =
    act && selection.chapterId
      ? act.chapters.find(function (entry) {
          return entry.id === selection.chapterId;
        }) ?? act.chapters[0] ?? null
      : act?.chapters[0] ?? null;
  const scene =
    chapter && selection.sceneId
      ? chapter.scenes.find(function (entry) {
          return entry.id === selection.sceneId;
        }) ?? chapter.scenes[0] ?? null
      : chapter?.scenes[0] ?? null;

  if (selection.scope === "project") {
    return createDefaultAssistantContextSelection("project");
  }

  if (selection.scope === "act") {
    return createDefaultAssistantContextSelection("act", {
      actId: act?.id ?? null
    });
  }

  if (selection.scope === "chapter") {
    return createDefaultAssistantContextSelection("chapter", {
      actId: act?.id ?? null,
      chapterId: chapter?.id ?? null
    });
  }

  return createDefaultAssistantContextSelection("scene", {
    actId: act?.id ?? null,
    chapterId: chapter?.id ?? null,
    sceneId: scene?.id ?? null
  });
}

function areAssistantContextsEqual(left: AssistantContextSelection, right: AssistantContextSelection) {
  return (
    left.scope === right.scope &&
    left.actId === right.actId &&
    left.chapterId === right.chapterId &&
    left.sceneId === right.sceneId
  );
}

function formatAssistantContextLabel(
  selection: AssistantContextSelection,
  story: StoryDocument
) {
  if (selection.scope === "project") {
    return "Projektweit";
  }

  const act = story.acts.find(function (entry) {
    return entry.id === selection.actId;
  });

  if (!act) {
    return "Projektweit";
  }

  if (selection.scope === "act") {
    return `Act · ${act.title}`;
  }

  const chapter = act.chapters.find(function (entry) {
    return entry.id === selection.chapterId;
  });

  if (!chapter) {
    return `Act · ${act.title}`;
  }

  if (selection.scope === "chapter") {
    return `Kapitel · ${chapter.title}`;
  }

  const scene = chapter.scenes.find(function (entry) {
    return entry.id === selection.sceneId;
  });

  return scene ? `Szene · ${scene.title}` : `Kapitel · ${chapter.title}`;
}
