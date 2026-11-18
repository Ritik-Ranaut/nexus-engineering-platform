import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  ApiError,
  projectApi,
  projectConversationApi,
  streamConversationMessage,
  type Project,
  type ProjectConversation,
  type ProjectMessage,
  type ProjectSource
} from "../api/client";
import { useAuthStore } from "../state/auth.store";

type ChatMessage = ProjectMessage & {
  limitations?: string[];
  streaming?: boolean;
  error?: boolean;
};

const suggestedQuestions = [
  "Explain this project.",
  "Where is authentication implemented?",
  "How does the order API work?",
  "Which files handle database access?",
  "Explain this function."
];

export function ProjectChatPage() {
  const { projectId = "" } = useParams();
  const [searchParams] = useSearchParams();
  const requestedQuestion = searchParams.get("question");
  const user = useAuthStore((state) => state.user);
  const [project, setProject] = useState<Project | null>(null);
  const [conversations, setConversations] = useState<ProjectConversation[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [loadingProject, setLoadingProject] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (requestedQuestion) setQuestion(requestedQuestion.slice(0, 2_000));
  }, [requestedQuestion]);

  const loadMessages = useCallback(async (selectedId: string) => {
    setLoadingMessages(true);
    try {
      const history = await projectConversationApi.messages(projectId, selectedId);
      setMessages(history.map((message) => ({
        ...message,
        sources: message.sources ?? [],
        error: message.status === "failed"
      })));
      setError(null);
    } catch (loadError: unknown) {
      setError(loadError instanceof Error ? loadError.message : "Could not load conversation history");
    } finally {
      setLoadingMessages(false);
    }
  }, [projectId]);

  useEffect(() => {
    let active = true;
    Promise.all([projectApi.get(projectId), projectConversationApi.list(projectId)])
      .then(async ([value, savedConversations]) => {
        if (!active) return;
        setProject(value);
        setConversations(savedConversations);
        const selected = savedConversations[0];
        if (selected) {
          setConversationId(selected.id);
          const history = await projectConversationApi.messages(projectId, selected.id);
          if (active) setMessages(history.map((message) => ({
            ...message,
            sources: message.sources ?? [],
            error: message.status === "failed"
          })));
        }
      })
      .catch((loadError: unknown) => {
        if (active) setError(loadError instanceof Error ? loadError.message : "Could not load this project");
      })
      .finally(() => { if (active) setLoadingProject(false); });
    return () => { active = false; abortRef.current?.abort(); };
  }, [projectId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  const openConversation = async (selectedId: string) => {
    if (streaming || selectedId === conversationId) return;
    setConversationId(selectedId);
    setMessages([]);
    await loadMessages(selectedId);
  };

  const startConversation = async () => {
    setError(null);
    try {
      const conversation = await projectConversationApi.create(projectId);
      setConversations((current) => [conversation, ...current]);
      setConversationId(conversation.id);
      setMessages([]);
    } catch (createError: unknown) {
      setError(createError instanceof Error ? createError.message : "Could not start a conversation");
    }
  };

  const submitQuestion = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = question.trim();
    if (!text || streaming) return;
    setError(null);
    setQuestion("");
    setStreaming(true);

    let activeConversationId = conversationId;
    try {
      if (!activeConversationId) {
        const conversation = await projectConversationApi.create(projectId, text.slice(0, 100));
        activeConversationId = conversation.id;
        setConversationId(conversation.id);
        setConversations((current) => [conversation, ...current]);
      }

      const userMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: text,
        status: "completed",
        sources: [],
        createdAt: new Date().toISOString()
      };
      const assistantId = crypto.randomUUID();
      setMessages((current) => [...current, userMessage, {
        id: assistantId,
        role: "assistant",
        content: "",
        status: "completed",
        sources: [],
        createdAt: new Date().toISOString(),
        streaming: true
      }]);

      const updateAssistant = (update: (message: ChatMessage) => ChatMessage) =>
        setMessages((current) => current.map((message) =>
          message.id === assistantId ? update(message) : message
        ));
      const controller = new AbortController();
      abortRef.current = controller;
      await streamConversationMessage(projectId, activeConversationId, text, {
        onSources: (sources) => updateAssistant((message) => ({ ...message, sources })),
        onToken: (token) => updateAssistant((message) => ({ ...message, content: message.content + token })),
        onDone: (result) => {
          updateAssistant((message) => ({
            ...message,
            id: result.messageId ?? message.id,
            content: result.answer,
            sources: result.sources,
            limitations: result.limitations,
            model: result.model,
            latencyMs: result.latencyMs,
            streaming: false
          }));
          void projectConversationApi.list(projectId).then(setConversations);
        },
        onError: (streamError) => updateAssistant((message) => ({
          ...message,
          content: streamError.message,
          status: "failed",
          error: true,
          streaming: false
        }))
      }, controller.signal);
    } catch (chatError) {
      const message = chatError instanceof ApiError
        ? chatError.message
        : chatError instanceof Error ? chatError.message : "The chat request failed";
      setError(message);
      setMessages((current) => [...current, {
        id: crypto.randomUUID(),
        role: "assistant",
        content: message,
        status: "failed",
        sources: [],
        createdAt: new Date().toISOString(),
        error: true
      }]);
    } finally {
      abortRef.current = null;
      setStreaming(false);
    }
  };

  return (
    <main className="project-chat-shell">
      <header className="workspace-header chat-header">
        <Link className="brand" to="/workspace"><span className="brand-mark">N</span><span>NEXUS<span className="brand-period">.</span></span></Link>
        <div className="chat-project-title">
          <span className="project-header-dot" />
          <span>{loadingProject ? "Loading project…" : project?.name ?? "Project unavailable"}</span>
          {project?.indexingStatus === "ready" && <span className="project-header-status">INDEXED</span>}
        </div>
        <nav className="chat-project-nav">
          <Link className="back-link" to={`/projects/${projectId}/explorer`}>Explorer <span>⌘</span></Link>
          <Link className="back-link" to={`/projects/${projectId}/issues`}>Findings <span>→</span></Link>
          <Link className="back-link" to="/workspace">Projects <span>↗</span></Link>
        </nav>
      </header>
      <div className="project-chat-workspace">
        <aside className="conversation-rail">
          <div className="conversation-rail-heading">
            <div><span className="card-overline">PROJECT CONTEXT</span><strong>Conversations</strong></div>
            <button type="button" onClick={() => void startConversation()} disabled={streaming || project?.indexingStatus !== "ready"} aria-label="Start a new conversation">+</button>
          </div>
          <div className="conversation-project-card">
            <span className="conversation-project-glyph">{project?.name.slice(0, 1).toUpperCase() ?? "N"}</span>
            <div><strong>{project?.name ?? "Selected project"}</strong><small>{project?.indexingStatus === "ready" ? "RETRIEVAL READY" : "INDEX REQUIRED"}</small></div>
          </div>
          <div className="conversation-list">
            {conversations.map((conversation) => (
              <button
                type="button"
                key={conversation.id}
                className={`conversation-list-item${conversation.id === conversationId ? " conversation-active" : ""}`}
                onClick={() => void openConversation(conversation.id)}
                disabled={streaming}
              >
                <span>{conversation.title}</span>
                <small>{new Date(conversation.lastMessageAt).toLocaleDateString()}</small>
              </button>
            ))}
            {conversations.length === 0 && <p className="conversation-empty">Start a conversation to explore this codebase.</p>}
          </div>
          <div className="conversation-rail-foot"><span className="status-dot" /> Answers cite retrieved project sources</div>
        </aside>
        <section className="project-chat-main">
          {loadingProject ? (
            <div className="chat-empty"><span className="loading-orbit" /><p>Opening project context…</p></div>
          ) : project?.indexingStatus !== "ready" ? (
            <div className="chat-empty">
              <span className="empty-mark">⌘</span>
              <h1>Project context is not ready</h1>
              <p>{error ?? "Index source files before asking questions about this codebase."}</p>
              <Link className="project-open" to="/workspace">Back to workspace →</Link>
            </div>
          ) : (
            <>
              <div className="project-chat-titlebar">
                <div><span className="workspace-eyebrow"><i className="status-dot" /> GROUNDED ENGINEERING ASSISTANT</span><h1>{messages.length ? conversations.find((item) => item.id === conversationId)?.title ?? "Project discussion" : "Understand the system."}</h1></div>
                <span className="retrieval-state"><i /> {project.indexingStatus.toUpperCase()} · VECTOR RETRIEVAL</span>
              </div>
              {error && <div className="form-alert chat-alert" role="alert">{error}</div>}
              <div className="project-chat-transcript">
                {loadingMessages ? (
                  <div className="chat-empty"><span className="loading-orbit" /><p>Restoring conversation…</p></div>
                ) : messages.length === 0 ? (
                  <div className="chat-empty project-chat-welcome">
                    <span className="welcome-orbit">N</span>
                    <h2>Start with the code,<br /><span>not a blank prompt.</span></h2>
                    <p>Ask about this project. NEXUS retrieves matching source first and shows the files and line ranges behind each answer.</p>
                    <div className="project-question-grid">
                      {suggestedQuestions.map((suggestion, index) => (
                        <button key={suggestion} type="button" onClick={() => setQuestion(suggestion)}>
                          <span>0{index + 1}</span>{suggestion}<i>↗</i>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="message-list project-message-list">
                    {messages.map((message) => (
                      <article className={`chat-message message-${message.role}`} key={message.id}>
                        <div className="message-avatar">{message.role === "user" ? user?.name.slice(0, 1).toUpperCase() : "N"}</div>
                        <div className="message-body">
                          <div className="message-author">{message.role === "user" ? user?.name : "NEXUS ENGINEERING"}{message.model && <span>{message.model}{message.latencyMs ? ` · ${(message.latencyMs / 1000).toFixed(1)}s` : ""}</span>}</div>
                          <div className={`message-text${message.error ? " message-error" : ""}`}>{message.content || (message.streaming ? <span className="typing-indicator"><i /><i /><i /></span> : "")}</div>
                          {message.sources.length > 0 && (
                            <div className="sources-panel">
                              <div className="sources-heading">RETRIEVED EVIDENCE <span>{message.sources.length} SOURCE{message.sources.length === 1 ? "" : "S"}</span></div>
                              {message.sources.map((source: ProjectSource) => (
                                <Link
                                  className="source-row"
                                  key={`${source.label}-${source.filePath}-${source.startLine}`}
                                  to={`/projects/${projectId}/explorer`}
                                  title={`Open ${source.filePath} in Code Explorer`}
                                >
                                  <span className="source-label">[{source.label}]</span>
                                  <span className="source-file">{source.filePath}</span>
                                  <span className="source-lines">L{source.startLine}–{source.endLine}</span>
                                  <span className="source-context">{source.symbolContext}</span>
                                </Link>
                              ))}
                            </div>
                          )}
                          {message.limitations && <p className="message-limitation">{message.limitations.join(" ")}</p>}
                        </div>
                      </article>
                    ))}
                    <div ref={bottomRef} />
                  </div>
                )}
              </div>
              <footer className="project-chat-composer-wrap">
                <form className="project-chat-composer" onSubmit={(event) => void submitQuestion(event)}>
                  <textarea
                    value={question}
                    onChange={(event) => setQuestion(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        event.currentTarget.form?.requestSubmit();
                      }
                    }}
                    placeholder={`Ask about ${project.name}…`}
                    rows={2}
                    maxLength={4_000}
                    disabled={streaming || loadingMessages}
                    aria-label="Ask a question about this project"
                  />
                  <div className="composer-bottom"><span>Project-only retrieval · Enter to send · Shift + Enter for a new line</span><button type="submit" disabled={streaming || !question.trim() || loadingMessages}>{streaming ? <span className="button-spinner" /> : "↑"}</button></div>
                </form>
                <div className="composer-footnote">Source references are retrieved from this project. NEXUS will say when evidence is insufficient.</div>
              </footer>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
