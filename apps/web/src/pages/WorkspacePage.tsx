import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { io } from "socket.io-client";
import { aiApi, ApiError, engineeringApi, projectApi, type Project } from "../api/client";
import { useAuthStore } from "../state/auth.store";
import {
  githubRepositoryUrlError,
  normalizeGitHubRepositoryUrlInput
} from "../utils/github-url";

const importInProgress = (status: Project["indexingStatus"]) =>
  ["pending", "validating", "discovering", "cloning", "indexing", "analyzing"].includes(status);

const statusLabel: Record<Project["indexingStatus"], string> = {
  empty: "Awaiting source",
  pending: "Pending",
  validating: "Validating repository",
  cloning: "Cloning repository",
  discovering: "Discovering project",
  indexing: "Indexing source",
  analyzing: "Analyzing architecture",
  ready: "Ready for intelligence",
  failed: "Index failed",
  cancelled: "Import cancelled"
};

const STAGES: Project["indexingStatus"][] = ["validating", "cloning", "discovering", "indexing", "analyzing", "ready"];

interface ProjectSummaryData {
  fileCount: number;
  languages: string[];
  runsCount: number;
  criticalIssues: number;
  highIssues: number;
  analyzing: boolean;
  analyzed: boolean;
}

export function WorkspacePage() {
  const { user, logout, loading: authLoading } = useAuthStore();
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectName, setProjectName] = useState("");
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [retryingProjectId, setRetryingProjectId] = useState<string | null>(null);
  const [cancellingProjectId, setCancellingProjectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [aiStatus, setAiStatus] = useState("Checking local model…");
  const [summaries, setSummaries] = useState<Record<string, ProjectSummaryData>>({});
  const fileInput = useRef<HTMLInputElement>(null);
  const directoryInput = useRef<HTMLInputElement>(null);

  const loadProjects = useCallback(async () => {
    setProjectsLoading(true);
    try {
      setProjects(await projectApi.list());
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load projects");
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  useEffect(() => { void loadProjects(); }, [loadProjects]);

  // Load project summaries (structure & engineering runs) for ready projects
  useEffect(() => {
    const readyProjects = projects.filter((p) => p.indexingStatus === "ready");
    if (readyProjects.length === 0) return;

    for (const p of readyProjects) {
      if (summaries[p.id]) continue;
      Promise.allSettled([
        projectApi.structure(p.id),
        engineeringApi.listRuns(p.id)
      ]).then(([structRes, runsRes]) => {
        const structure = structRes.status === "fulfilled" ? structRes.value : null;
        const runs = runsRes.status === "fulfilled" ? runsRes.value : [];
        const latestRun = runs[0];
        const criticalIssues = latestRun?.report?.severityCounts?.critical ?? 0;
        const highIssues = latestRun?.report?.severityCounts?.high ?? 0;

        setSummaries((prev) => ({
          ...prev,
          [p.id]: {
            fileCount: structure?.fileCount ?? 0,
            languages: structure?.languages ?? [],
            runsCount: runs.length,
            criticalIssues,
            highIssues,
            analyzing: false,
            analyzed: runs.length > 0
          }
        }));
      });
    }
  }, [projects]);

  const runProjectAudit = async (projectId: string) => {
    setSummaries((prev) => ({
      ...prev,
      [projectId]: { ...(prev[projectId] ?? { fileCount: 0, languages: [], runsCount: 0, criticalIssues: 0, highIssues: 0, analyzed: false }), analyzing: true }
    }));
    try {
      const result = await engineeringApi.run(projectId, "Comprehensive security and architecture analysis");
      const criticalIssues = result.issues.filter((i) => i.severity === "critical").length;
      const highIssues = result.issues.filter((i) => i.severity === "high").length;
      setSummaries((prev) => ({
        ...prev,
        [projectId]: {
          ...(prev[projectId] ?? { fileCount: 0, languages: [] }),
          runsCount: (prev[projectId]?.runsCount ?? 0) + 1,
          criticalIssues,
          highIssues,
          analyzing: false,
          analyzed: true
        }
      }));
      setSuccessMessage("AI Engineering Analysis completed successfully!");
    } catch (auditErr) {
      setSummaries((prev) => ({
        ...prev,
        [projectId]: { ...(prev[projectId] ?? { fileCount: 0, languages: [], runsCount: 0, criticalIssues: 0, highIssues: 0, analyzed: false }), analyzing: false }
      }));
      setError(auditErr instanceof Error ? auditErr.message : "AI analysis failed");
    }
  };

  const hasIndexingProjects = projects.some((project) => importInProgress(project.indexingStatus));
  const importingProjectIds = projects
    .filter((project) => importInProgress(project.indexingStatus))
    .map((project) => project.id)
    .join(",");

  useEffect(() => {
    if (!hasIndexingProjects) return;
    const intervalId = window.setInterval(() => {
      projectApi.list().then(setProjects).catch((loadError: unknown) => {
        setError(loadError instanceof Error ? loadError.message : "Could not refresh project status");
      });
    }, 3000);
    return () => window.clearInterval(intervalId);
  }, [hasIndexingProjects]);

  useEffect(() => {
    const importingProjects = projects.filter((project) => importInProgress(project.indexingStatus));
    if (importingProjects.length === 0) return;
    const socket = io({ withCredentials: true, reconnection: true, path: "/socket.io" });
    const subscribe = () => {
      for (const project of importingProjects) {
        socket.emit("project:subscribe", project.id);
      }
    };
    socket.on("connect", subscribe);
    socket.on("project:import-progress", (event: {
      projectId: string;
      status: Project["indexingStatus"];
      error?: string;
    }) => {
      setProjects((current) => current.map((project) => project.id === event.projectId
        ? { ...project, indexingStatus: event.status, indexingError: event.error }
        : project
      ));
    });
    return () => { void socket.close(); };
  }, [importingProjectIds]);

  useEffect(() => {
    if (projectName.trim()) return;
    const normalized = normalizeGitHubRepositoryUrlInput(repositoryUrl);
    const repositoryName = normalized
      .match(/^https:\/\/(?:www\.)?github\.com\/[^/]+\/([^/?#]+)/i)?.[1]
      ?.replace(/\.git$/i, "")
      .replace(/[-_]+/g, " ");
    if (repositoryName) setProjectName(repositoryName);
  }, [projectName, repositoryUrl]);

  useEffect(() => {
    directoryInput.current?.setAttribute("webkitdirectory", "");
    directoryInput.current?.setAttribute("directory", "");
  }, []);

  useEffect(() => {
    let active = true;
    aiApi.health().then((health) => {
      if (!active) return;
      if (!health.ollama.connected) setAiStatus("Ollama offline");
      else if (!health.ollama.chatModelAvailable) setAiStatus("Chat model unavailable");
      else if (!health.ollama.embeddingModelAvailable) setAiStatus("Embedding model unavailable");
      else setAiStatus("Local models ready");
    }).catch((healthError: unknown) => {
      if (active) setAiStatus(healthError instanceof Error ? healthError.message : "AI service unavailable");
    });
    return () => { active = false; };
  }, []);

  const createAndIndex = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSuccessMessage(null);
    const normalizedRepositoryUrl = normalizeGitHubRepositoryUrlInput(repositoryUrl);
    const hasRepositoryUrl = normalizedRepositoryUrl.length > 0;
    if (hasRepositoryUrl && files.length > 0) {
      setError("Choose a public GitHub URL or local files, not both.");
      return;
    }
    if (hasRepositoryUrl) {
      const urlError = githubRepositoryUrlError(normalizedRepositoryUrl);
      if (urlError) {
        setError(urlError);
        return;
      }
    }
    if (!hasRepositoryUrl && files.length === 0) {
      setError("Choose source or documentation files to index.");
      return;
    }
    if (!hasRepositoryUrl && (
      files.length > 100 ||
      files.reduce((total, file) => total + file.size, 0) > 4_000_000
    )) {
      setError("Select up to 100 files with a combined size under 4 MB.");
      return;
    }
    const derivedName = normalizedRepositoryUrl
      ? normalizedRepositoryUrl
          .match(/^https:\/\/(?:www\.)?github\.com\/[^/]+\/([^/?#]+)/i)?.[1]
          ?.replace(/\.git$/i, "")
          ?.replace(/[-_]+/g, " ")
      : "";
    const finalProjectName = projectName.trim() || derivedName || "Imported Project";
    setSubmitting(true);
    try {
      const project = await projectApi.create({
        name: finalProjectName,
        ...(hasRepositoryUrl ? { repositoryUrl: normalizedRepositoryUrl } : {})
      });
      setProjects((current) => [project, ...current]);
      if (hasRepositoryUrl) {
        await projectApi.importRepository(project.id);
        setSuccessMessage("Repository import started. It may take several minutes to finish indexing.");
      } else {
        const sourceFiles = await Promise.all(files.map(async (file) => ({
          path: file.webkitRelativePath || file.name,
          content: await file.text()
        })));
        await projectApi.index(project.id, sourceFiles);
      }
      setProjectName("");
      setRepositoryUrl("");
      setFiles([]);
      if (fileInput.current) fileInput.current.value = "";
      if (directoryInput.current) directoryInput.current.value = "";
      await loadProjects();
    } catch (submitError) {
      const message = submitError instanceof ApiError
        ? submitError.message
        : submitError instanceof Error ? submitError.message : "Project setup failed";
      await loadProjects();
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const cancelRepositoryImport = async (projectId: string) => {
    setCancellingProjectId(projectId);
    setError(null);
    setSuccessMessage(null);
    try {
      await projectApi.cancelImport(projectId);
      await loadProjects();
      setSuccessMessage("Repository import cancelled.");
    } catch (importError) {
      const message = importError instanceof ApiError
        ? importError.message
        : importError instanceof Error ? importError.message : "Could not cancel the import";
      await loadProjects();
      setError(message);
    } finally {
      setCancellingProjectId(null);
    }
  };

  const retryRepositoryImport = async (projectId: string) => {
    setRetryingProjectId(projectId);
    setError(null);
    setSuccessMessage(null);
    try {
      await projectApi.importRepository(projectId);
      await loadProjects();
      setSuccessMessage("Repository import restarted. This project will be available when indexing finishes.");
    } catch (importError) {
      const message = importError instanceof ApiError
        ? importError.message
        : importError instanceof Error ? importError.message : "Repository import failed";
      await loadProjects();
      setError(message);
    } finally {
      setRetryingProjectId(null);
    }
  };

  const handleLogout = async () => {
    try {
      await logout();
    } catch {
      setError("Could not sign out. Please try again.");
    }
  };

  const totalFiles = Object.values(summaries).reduce((acc, s) => acc + s.fileCount, 0);
  const totalAudits = Object.values(summaries).reduce((acc, s) => acc + s.runsCount, 0);

  return (
    <main className="workspace">
      <header className="workspace-header">
        <Link className="brand" to="/workspace"><span className="brand-mark">N</span><span>NEXUS<span className="brand-period">.</span></span></Link>
        <div className="account-menu">
          <span className="avatar">{user?.name.slice(0, 1).toUpperCase()}</span>
          <span className="account-name">{user?.name}</span>
          <button className="signout-button" onClick={() => void handleLogout()} disabled={authLoading}>Sign out</button>
        </div>
      </header>
      <section className="workspace-content project-dashboard">
        <div className="workspace-eyebrow"><span className="status-dot" /> ENGINEERING INTELLIGENCE PLATFORM</div>
        <h1>Deep architectural analysis<br /><span>grounded in your code.</span></h1>
        <p className="workspace-lede">Import any GitHub repository or local snapshot to inspect code structure, run multi-agent architectural audits, and generate grounded engineering solutions.</p>

        {/* Global intelligence strip */}
        <div className="engineering-stats-strip">
          <div className="stat-card">
            <span className="stat-label">Indexed Projects</span>
            <span className="stat-value">{projects.length}</span>
            <span className="stat-sub">{projects.filter((p) => p.indexingStatus === "ready").length} ready for intelligence</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Source Files</span>
            <span className="stat-value">{totalFiles > 0 ? totalFiles : "—"}</span>
            <span className="stat-sub">Parsed & chunked vectors</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">AI Engineering Audits</span>
            <span className="stat-value">{totalAudits}</span>
            <span className="stat-sub">Multi-agent inspections</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">AI Engine</span>
            <span className={`stat-value ${aiStatus === "Local models ready" ? "text-success" : "text-warn"}`}>{aiStatus === "Local models ready" ? "Online" : "Connecting"}</span>
            <span className="stat-sub">{aiStatus}</span>
          </div>
        </div>

        <section className="project-create-card">
          <div className="section-heading">
            <div><span className="card-overline">REPOSITORY & SOURCE INGESTION</span><h2>Ingest a Project</h2></div>
            <span className={`local-badge${aiStatus === "Local models ready" ? " ai-ready" : " ai-unavailable"}`}><i className="status-dot" /> {aiStatus.toUpperCase()}</span>
          </div>
          <form className="project-form" onSubmit={(event) => void createAndIndex(event)}>
            <label className="field">
              <span>Project name {repositoryUrl.trim() && <small className="field-hint">(auto-derived if left blank)</small>}</span>
              <input
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
                maxLength={120}
                required={!repositoryUrl.trim()}
                placeholder="e.g. Payments Microservice"
              />
            </label>
            <label className="field">
              <span>Public GitHub repository URL <em>imports & indexes automatically</em></span>
              <input
                type="text"
                value={repositoryUrl}
                onChange={(event) => setRepositoryUrl(event.target.value)}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="https://github.com/octocat/Spoon-Knife"
              />
            </label>
            <div className="field source-picker">
              <span>Or upload source and documentation files</span>
              <label className="file-picker-face">
                <input ref={fileInput} type="file" multiple onChange={(event) => setFiles(Array.from(event.target.files ?? []))} />
                <span className="upload-symbol">↑</span><span className="file-picker-copy"><strong>{files.length ? `${files.length} file${files.length === 1 ? "" : "s"} selected` : "Choose source files"}</strong><small>Local uploads: up to 100 files · 4 MB total · secrets and binaries excluded automatically</small></span>
              </label>
              <input ref={directoryInput} className="directory-file-input" type="file" multiple onChange={(event) => setFiles(Array.from(event.target.files ?? []))} />
              <button className="folder-picker-button" type="button" onClick={() => directoryInput.current?.click()}>Or choose a local folder</button>
            </div>
            {aiStatus !== "Local models ready" && <div className="ai-notice" role="status">{aiStatus}. Ensure Ollama chat & embedding models are active before indexing or chatting.</div>}
            {error && <div className="form-alert" role="alert">{error}</div>}
            {successMessage && <div className="form-success" role="status">{successMessage}</div>}
            <button className="primary-button" type="submit" disabled={submitting}>
              {submitting ? <><span className="button-spinner" /> {repositoryUrl.trim() ? "Cloning & indexing repository…" : "Preparing project…"}</> : <>Import and Analyze Project <span aria-hidden="true">→</span></>}
            </button>
          </form>
        </section>

        <section className="projects-section">
          <div className="section-heading">
            <div><span className="card-overline">PROJECT PORTFOLIO</span><h2>Active Intelligence Cards <span className="count-pill">{projects.length}</span></h2></div>
            <span className="project-caption">ISOLATED VECTOR EMBEDDINGS & MEMORY</span>
          </div>
          {projectsLoading ? (
            <div className="project-empty"><span className="loading-orbit" /><span>Loading engineering intelligence cards…</span></div>
          ) : projects.length === 0 ? (
            <div className="project-empty"><span className="empty-mark">＋</span><strong>No projects indexed</strong><span>Import a GitHub repository URL or upload source files above to begin.</span></div>
          ) : (
            <div className="project-cards-grid">
              {projects.map((project) => {
                const summary = summaries[project.id];
                const isImporting = importInProgress(project.indexingStatus);
                const currentStageIdx = STAGES.indexOf(project.indexingStatus);

                return (
                  <article className="project-intelligence-card" key={project.id}>
                    <div className="card-header-row">
                      <div className="project-avatar" aria-hidden="true">{project.name.slice(0, 1).toUpperCase()}</div>
                      <div className="project-title-area">
                        <h3>{project.name}</h3>
                        <span className="project-repo-link" title={project.repositoryUrl ?? "Local files"}>
                          {project.repositoryUrl ? (
                            <>🔗 {project.repositoryUrl.replace(/^https:\/\/(?:www\.)?github\.com\//i, "")}</>
                          ) : (
                            <>📁 Local source files</>
                          )}
                        </span>
                      </div>
                      <span className={`project-status-pill status-${project.indexingStatus}`}>
                        <i /> {statusLabel[project.indexingStatus]}
                      </span>
                    </div>

                    {/* Live import stepper if import in progress */}
                    {isImporting && (
                      <div className="import-stepper">
                        <div className="stepper-title">Ingestion Pipeline Progress</div>
                        <div className="stepper-track">
                          {["validating", "cloning", "discovering", "indexing", "analyzing"].map((step, idx) => {
                            const isDone = currentStageIdx > idx;
                            const isCurrent = project.indexingStatus === step;
                            return (
                              <div key={step} className={`step-node ${isDone ? "step-done" : isCurrent ? "step-active" : "step-pending"}`}>
                                <div className="step-circle">{isDone ? "✓" : idx + 1}</div>
                                <span className="step-name">{step}</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {project.indexingError && (
                      <div className="project-card-error">
                        <strong>Pipeline Error:</strong> {project.indexingError}
                      </div>
                    )}

                    {/* Metrics Matrix */}
                    <div className="metrics-matrix">
                      <div className="metric-box">
                        <span className="metric-label">Files</span>
                        <span className="metric-val">{summary ? summary.fileCount : "—"}</span>
                      </div>
                      <div className="metric-box">
                        <span className="metric-label">Audits</span>
                        <span className="metric-val">{summary ? summary.runsCount : 0}</span>
                      </div>
                      <div className="metric-box">
                        <span className="metric-label">Critical</span>
                        <span className={`metric-val ${summary && summary.criticalIssues > 0 ? "text-danger" : ""}`}>
                          {summary ? summary.criticalIssues : 0}
                        </span>
                      </div>
                      <div className="metric-box">
                        <span className="metric-label">High</span>
                        <span className={`metric-val ${summary && summary.highIssues > 0 ? "text-warn" : ""}`}>
                          {summary ? summary.highIssues : 0}
                        </span>
                      </div>
                    </div>

                    {/* Detected Languages */}
                    {summary && summary.languages && summary.languages.length > 0 && (
                      <div className="languages-strip">
                        <span className="strip-title">Stack:</span>
                        {summary.languages.map((lang) => (
                          <span key={lang} className="lang-tag">{lang}</span>
                        ))}
                      </div>
                    )}

                    {/* Card Actions */}
                    <div className="project-card-footer">
                      {project.indexingStatus === "ready" && (
                        <>
                          <div className="quick-audit-row">
                            <button
                              type="button"
                              className="quick-audit-button"
                              disabled={summary?.analyzing}
                              onClick={() => void runProjectAudit(project.id)}
                            >
                              {summary?.analyzing ? "⚡ Running Multi-Agent Audit…" : summary?.analyzed ? "⚡ Re-run AI Analysis" : "⚡ Trigger AI Analysis"}
                            </button>
                          </div>
                          <div className="project-action-commands">
                            <Link className="action-pill primary" to={`/projects/${project.id}/chat`}>Ask AI <span>→</span></Link>
                            <Link className="action-pill" to={`/projects/${project.id}/explorer`}>Code <span>⌘</span></Link>
                            <Link className="action-pill" to={`/projects/${project.id}/architecture`}>Graph <span>◇</span></Link>
                            <Link className="action-pill" to={`/projects/${project.id}/issues`}>Issues <span>↗</span></Link>
                            <Link className="action-pill" to={`/projects/${project.id}/missions`}>Missions</Link>
                            <Link className="action-pill" to={`/projects/${project.id}/reports`}>Reports <span>▤</span></Link>
                          </div>
                        </>
                      )}

                      {project.repositoryUrl && ["failed", "cancelled"].includes(project.indexingStatus) && (
                        <div className="retry-row">
                          <button
                            className="retry-button"
                            type="button"
                            disabled={retryingProjectId === project.id}
                            onClick={() => void retryRepositoryImport(project.id)}
                          >
                            {retryingProjectId === project.id ? "Retrying Ingestion…" : "↻ Retry Ingestion"}
                          </button>
                        </div>
                      )}

                      {project.repositoryUrl && isImporting && (
                        <div className="cancel-row">
                          <button
                            className="cancel-button"
                            type="button"
                            disabled={cancellingProjectId === project.id}
                            onClick={() => void cancelRepositoryImport(project.id)}
                          >
                            {cancellingProjectId === project.id ? "Cancelling…" : "✕ Cancel Pipeline"}
                          </button>
                        </div>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
        <div className="workspace-meta"><span>Signed in as <strong>{user?.email}</strong></span><span>Local isolated vector search & memory <i className="status-dot" /></span></div>
      </section>
      <footer className="workspace-footer"><span>NEXUS<span className="brand-period">.</span></span><span>Engineering Intelligence grounded in your code.</span></footer>
    </main>
  );
}
