import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ApiError,
  engineeringApi,
  projectApi,
  type EngineeringIssue,
  type EngineeringRun,
  type IssueSeverity,
  type IssueStatus,
  type Project
} from "../api/client";

const severityOrder: IssueSeverity[] = ["critical", "high", "medium", "low", "suggestion"];
const severityLabels: Record<IssueSeverity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  suggestion: "Suggestions"
};
const agentLabels: Record<EngineeringIssue["agent"], string> = {
  code_quality: "Code Quality",
  security: "Security",
  performance: "Performance",
  testing: "Testing",
  documentation: "Documentation"
};

export function EngineeringIssuesPage() {
  const { projectId = "" } = useParams();
  const [project, setProject] = useState<Project | null>(null);
  const [issues, setIssues] = useState<EngineeringIssue[]>([]);
  const [runs, setRuns] = useState<EngineeringRun[]>([]);
  const [selectedIssue, setSelectedIssue] = useState<string | null>(null);
  const [goal, setGoal] = useState("Review this project for actionable engineering issues.");
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runNotice, setRunNotice] = useState<string | null>(null);
  const analysisAbort = useRef<AbortController | null>(null);

  useEffect(() => () => analysisAbort.current?.abort(), []);

  useEffect(() => {
    let active = true;
    Promise.all([
      projectApi.get(projectId),
      engineeringApi.listIssues(projectId),
      engineeringApi.listRuns(projectId)
    ]).then(([currentProject, currentIssues, currentRuns]) => {
      if (!active) return;
      setProject(currentProject);
      setIssues(currentIssues);
      setRuns(currentRuns);
    }).catch((loadError: unknown) => {
      if (active) setError(loadError instanceof Error ? loadError.message : "Could not load project analysis");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [projectId]);

  const groupedIssues = useMemo(() => Object.fromEntries(
    severityOrder.map((severity) => [severity, issues.filter((issue) => issue.severity === severity)])
  ) as Record<IssueSeverity, EngineeringIssue[]>, [issues]);
  const activeIssue = issues.find((issue) => issue.issueId === selectedIssue) ?? null;

  const runAnalysis = async () => {
    setAnalyzing(true);
    setError(null);
    setRunNotice(null);
    const controller = new AbortController();
    analysisAbort.current = controller;
    try {
      const result = await engineeringApi.run(projectId, goal, controller.signal);
      setIssues((current) => [...result.issues, ...current]);
      setRuns((current) => [result.run, ...current]);
      setRunNotice(result.run.status === "failed"
        ? "The analysis could not complete. Review agent errors below and try again later."
        : `${result.issues.length} evidence-backed issue${result.issues.length === 1 ? "" : "s"} found.`);
      if (result.issues.length) setSelectedIssue(result.issues[0]?.issueId ?? null);
    } catch (runError: unknown) {
      if (runError instanceof ApiError && runError.code === "REQUEST_CANCELLED") {
        setRunNotice("Analysis cancelled.");
      } else setError(runError instanceof ApiError
        ? runError.message
        : runError instanceof Error ? runError.message : "Analysis failed");
    } finally {
      if (analysisAbort.current === controller) analysisAbort.current = null;
      setAnalyzing(false);
    }
  };

  const updateStatus = async (issue: EngineeringIssue, status: IssueStatus) => {
    setError(null);
    try {
      const updated = await engineeringApi.updateIssue(projectId, issue.issueId, status);
      setIssues((current) => current.map((item) => item.issueId === updated.issueId ? updated : item));
    } catch (updateError: unknown) {
      setError(updateError instanceof Error ? updateError.message : "Could not update issue status");
    }
  };

  return (
    <main className="issues-shell">
      <header className="workspace-header issues-header">
        <Link className="brand" to="/workspace"><span className="brand-mark">N</span><span>NEXUS<span className="brand-period">.</span></span></Link>
        <div className="chat-project-title"><span className="project-header-dot" /><span>{project?.name ?? (loading ? "Loading project…" : "Project analysis")}</span></div>
        <nav className="issues-nav">
          <Link className="back-link" to={`/projects/${projectId}/chat`}>Project chat <span>→</span></Link>
          <Link className="back-link" to="/workspace">Workspace <span>↗</span></Link>
        </nav>
      </header>
      <section className="issues-content">
        <div className="workspace-eyebrow"><span className="status-dot" /> ENGINEERING INTELLIGENCE</div>
        <div className="issues-title-row">
          <div>
            <h1>Project <span>findings.</span></h1>
            <p className="workspace-lede">Focused specialist investigations with source-backed evidence. NEXUS does not execute code or change your project.</p>
          </div>
          <span className="issues-model-note">{runs[0]?.model ?? "Local model"} · bounded agents</span>
        </div>
        <section className="analysis-launch">
          <label className="field">
            <span>Analysis scope</span>
            <input value={goal} onChange={(event) => setGoal(event.target.value)} maxLength={1_000} />
          </label>
          {analyzing ? (
            <button className="analysis-cancel-button" type="button" onClick={() => analysisAbort.current?.abort()}>
              <span className="button-spinner" /> Cancel analysis
            </button>
          ) : (
            <button className="primary-button" type="button" disabled={project?.indexingStatus !== "ready"} onClick={() => void runAnalysis()}>
              <>Run engineering analysis <span>→</span></>
            </button>
          )}
          {project?.indexingStatus !== "ready" && <p className="issues-hint">Index project source files before running an analysis.</p>}
        </section>
        {error && <div className="form-alert" role="alert">{error}</div>}
        {runNotice && <div className="analysis-notice" role="status">{runNotice}</div>}
        {runs[0]?.failures.length ? (
          <div className="analysis-notice analysis-warning" role="status">
            {runs[0].failures.map((failure) => <p key={`${failure.agent}-${failure.code}`}>{failure.agent}: {failure.message}</p>)}
          </div>
        ) : null}
        {loading ? (
          <div className="chat-empty"><span className="loading-orbit" /><p>Loading project findings…</p></div>
        ) : issues.length === 0 ? (
          <div className="issues-empty">
            <span className="empty-mark">⌕</span>
            <h2>No findings yet</h2>
            <p>Run a bounded analysis to inspect indexed project context with the available engineering specialists.</p>
          </div>
        ) : (
          <div className="issues-layout">
            <div className="issue-groups">
              {severityOrder.map((severity) => groupedIssues[severity].length > 0 && (
                <section className="issue-group" key={severity}>
                  <div className="issue-group-heading">
                    <h2>{severityLabels[severity]}</h2>
                    <span>{groupedIssues[severity].length}</span>
                  </div>
                  {groupedIssues[severity].map((issue) => (
                    <button className={`issue-card${selectedIssue === issue.issueId ? " issue-card-active" : ""}`} key={issue.issueId} onClick={() => setSelectedIssue(issue.issueId)}>
                      <span className={`severity-mark severity-${issue.severity}`} />
                      <span className="issue-card-copy">
                        <strong>{issue.title}</strong>
                        <small>{agentLabels[issue.agent]} · {issue.affectedFiles[0]}</small>
                      </span>
                      <span className={`issue-status issue-status-${issue.status}`}>{issue.status}</span>
                    </button>
                  ))}
                </section>
              ))}
            </div>
            {activeIssue && (
              <article className="issue-detail">
                <div className="issue-detail-top">
                  <span className={`issue-severity-label severity-text-${activeIssue.severity}`}>{severityLabels[activeIssue.severity]}</span>
                  <span>{agentLabels[activeIssue.agent]} · {Math.round(activeIssue.confidence * 100)}% confidence</span>
                </div>
                <h2>{activeIssue.title}</h2>
                <h3>Problem</h3>
                <p>{activeIssue.description}</p>
                <h3>AI reasoning summary</h3>
                <p>{activeIssue.reasoningSummary}</p>
                <h3>Evidence</h3>
                {activeIssue.evidence.map((evidence, index) => (
                  <div className="issue-evidence" key={`${evidence.filePath}-${evidence.startLine}-${index}`}>
                    <div className="issue-evidence-file">{evidence.filePath}<span>Lines {evidence.startLine}-{evidence.endLine}</span></div>
                    <pre><code>{evidence.quote}</code></pre>
                    <p>{evidence.explanation}</p>
                  </div>
                ))}
                <h3>Affected files</h3>
                <ul className="issue-files">{activeIssue.affectedFiles.map((file) => <li key={file}>{file}</li>)}</ul>
                <h3>Recommendation</h3>
                <p>{activeIssue.recommendation}</p>
                <Link
                  className="issue-fix-link"
                  to={`/projects/${projectId}/fixes?${new URLSearchParams({
                    findingId: activeIssue.issueId,
                    runId: activeIssue.runId
                  })}`}
                >
                  Generate fix proposal <span>→</span>
                </Link>
                <label className="issue-status-field">
                  <span>Finding status</span>
                  <select value={activeIssue.status} onChange={(event) => void updateStatus(activeIssue, event.target.value as IssueStatus)}>
                    <option value="open">Open</option>
                    <option value="accepted">Accepted</option>
                    <option value="dismissed">Dismissed</option>
                    <option value="resolved">Resolved</option>
                  </select>
                </label>
              </article>
            )}
          </div>
        )}
      </section>
    </main>
  );
}
