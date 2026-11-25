import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { io } from "socket.io-client";
import { aiApi, ApiError, projectApi, type Project } from "../api/client";
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
  ready: "Ready to chat",
  failed: "Index failed",
  cancelled: "Import cancelled"
};

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
        <div className="workspace-eyebrow"><span className="status-dot" /> ENGINEERING WORKSPACE</div>
        <h1>A searchable map<br /><span>of your codebase.</span></h1>
        <p className="workspace-lede">Index source files to explore project structure and ask questions grounded in the code you provide.</p>

        <section className="project-create-card">
          <div className="section-heading">
            <div><span className="card-overline">SOURCE SNAPSHOT</span><h2>Add a project</h2></div>
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
                placeholder="e.g. Payments service"
              />
            </label>
            <label className="field">
              <span>Public GitHub repository URL <em>imports recursively</em></span>
              <input
                type="text"
                value={repositoryUrl}
                onChange={(event) => setRepositoryUrl(event.target.value)}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="https://github.com/team/repository"
              />
            </label>
            <div className="field source-picker">
              <span>Source and documentation files</span>
              <label className="file-picker-face">
                <input ref={fileInput} type="file" multiple onChange={(event) => setFiles(Array.from(event.target.files ?? []))} />
                <span className="upload-symbol">↑</span><span className="file-picker-copy"><strong>{files.length ? `${files.length} file${files.length === 1 ? "" : "s"} selected` : "Choose source files"}</strong><small>Local uploads: up to 100 files · 4 MB total · secrets and generated files are excluded</small></span>
              </label>
              <input ref={directoryInput} className="directory-file-input" type="file" multiple onChange={(event) => setFiles(Array.from(event.target.files ?? []))} />
              <button className="folder-picker-button" type="button" onClick={() => directoryInput.current?.click()}>Or choose a project folder</button>
            </div>
            {aiStatus !== "Local models ready" && <div className="ai-notice" role="status">{aiStatus}. Configure the chat and embedding models in the API environment before indexing or chatting.</div>}
            {error && <div className="form-alert" role="alert">{error}</div>}
            {successMessage && <div className="form-success" role="status">{successMessage}</div>}
            <button className="primary-button" type="submit" disabled={submitting}>
              {submitting ? <><span className="button-spinner" /> {repositoryUrl.trim() ? "Starting import…" : "Preparing project…"}</> : <>Create and index project <span aria-hidden="true">→</span></>}
            </button>
          </form>
        </section>

        <section className="projects-section">
          <div className="section-heading">
            <div><span className="card-overline">YOUR WORKSPACE</span><h2>Projects <span className="count-pill">{projects.length}</span></h2></div>
            <span className="project-caption">PRIVATE TO YOUR ACCOUNT</span>
          </div>
          {projectsLoading ? (
            <div className="project-empty"><span className="loading-orbit" /><span>Loading your projects…</span></div>
          ) : projects.length === 0 ? (
            <div className="project-empty"><span className="empty-mark">＋</span><strong>No projects yet</strong><span>Add a source snapshot above to explore its structure and indexed code.</span></div>
          ) : (
            <div className="project-list">
              {projects.map((project) => (
                <article className="project-row" key={project.id}>
                  <div className="project-glyph" aria-hidden="true">{project.name.slice(0, 1).toUpperCase()}</div>
                  <div className="project-copy"><h3>{project.name}</h3><span>{project.repositoryUrl ?? "Local source files"}</span>{project.indexingError && <small className="project-index-error">{project.indexingError}</small>}</div>
                  <span className={`project-status status-${project.indexingStatus}`}><i />{statusLabel[project.indexingStatus]}</span>
                  <div className="project-actions">
                    {project.indexingStatus === "ready" && <>
                      <Link className="project-open" to={`/projects/${project.id}/chat`}>Ask this project <span>→</span></Link>
                      <Link className="project-open" to={`/projects/${project.id}/explorer`}>Code explorer <span>⌘</span></Link>
                      <Link className="project-open" to={`/projects/${project.id}/architecture`}>Architecture <span>◇</span></Link>
                      <Link className="project-open" to={`/projects/${project.id}/issues`}>AI analysis <span>↗</span></Link>
                      <Link className="project-open" to={`/projects/${project.id}/missions`}>Missions <span>↗</span></Link>
                      <Link className="project-open" to={`/projects/${project.id}/reports`}>Reports <span>▤</span></Link>
                    </>}
                    {project.repositoryUrl && ["failed", "cancelled"].includes(project.indexingStatus) &&
                      (project.indexingStatus !== "ready" || project.indexingError) && <button
                        className="project-open project-import-retry"
                        type="button"
                        disabled={retryingProjectId === project.id}
                        onClick={() => void retryRepositoryImport(project.id)}
                      >
                        {retryingProjectId === project.id ? "Importing…" : "Retry repository import"}
                      </button>}
                    {project.repositoryUrl && importInProgress(project.indexingStatus) && <button
                      className="project-open project-import-retry"
                      type="button"
                      disabled={cancellingProjectId === project.id}
                      onClick={() => void cancelRepositoryImport(project.id)}
                    >
                      {cancellingProjectId === project.id ? "Cancelling…" : "Cancel import"}
                    </button>}
                    {project.indexingStatus !== "ready" && (!project.repositoryUrl || project.indexingStatus === "indexing") &&
                      <span className="project-open-disabled">Chat unavailable</span>}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
        <div className="workspace-meta"><span>Signed in as <strong>{user?.email}</strong></span><span>Project context stays isolated <i className="status-dot" /></span></div>
      </section>
      <footer className="workspace-footer"><span>NEXUS<span className="brand-period">.</span></span><span>Answers linked to your indexed source.</span></footer>
    </main>
  );
}
