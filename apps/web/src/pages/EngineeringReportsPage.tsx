import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  ApiError,
  engineeringReportApi,
  projectApi,
  type EngineeringReport,
  type EngineeringReportType,
  type Project
} from "../api/client";
import { reportToJson, reportToMarkdown } from "../utils/report-export";

const reportOptions: { value: EngineeringReportType; label: string }[] = [
  { value: "project_health", label: "Project health" },
  { value: "security_audit", label: "Security audit" },
  { value: "code_quality", label: "Code quality" },
  { value: "performance_analysis", label: "Performance analysis" },
  { value: "testing_coverage", label: "Testing and coverage" },
  { value: "documentation", label: "Documentation" }
];
const severityOrder = ["critical", "high", "medium", "low", "suggestion"] as const;
const categoryLabels: Record<string, string> = {
  security: "Security",
  code_quality: "Code quality",
  performance: "Performance",
  testing: "Testing",
  documentation: "Documentation"
};
const reportTypeLabels: Record<EngineeringReportType, string> = {
  project_health: "Project health report",
  security_audit: "Security audit",
  code_quality: "Code quality report",
  performance_analysis: "Performance analysis report",
  testing_coverage: "Testing and coverage report",
  documentation: "Documentation report",
  mission: "Mission-specific report"
};
const severityLabels: Record<string, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  suggestion: "Suggestion"
};

const downloadFile = (name: string, content: string, mimeType: string) => {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
};

export function EngineeringReportsPage() {
  const { projectId = "" } = useParams();
  const [searchParams] = useSearchParams();
  const missionId = searchParams.get("missionId");
  const [project, setProject] = useState<Project | null>(null);
  const [reportType, setReportType] = useState<EngineeringReportType>("project_health");
  const [reports, setReports] = useState<EngineeringReport[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [report, setReport] = useState<EngineeringReport | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadReports = useCallback(async (nextPage = page) => {
    const result = await engineeringReportApi.list(projectId, {
      page: nextPage,
      pageSize: 15,
      ...(missionId ? { reportType: "mission", missionId } : {})
    });
    setReports(result.reports);
    setTotal(result.total);
    setPage(result.page);
    setSelectedId((current) =>
      current && result.reports.some((item) => item.reportId === current)
        ? current
        : result.reports[0]?.reportId ?? null
    );
  }, [missionId, page, projectId]);

  useEffect(() => {
    let active = true;
    Promise.all([
      projectApi.get(projectId),
      engineeringReportApi.list(projectId, {
        page: 1,
        pageSize: 15,
        ...(missionId ? { reportType: "mission", missionId } : {})
      })
    ]).then(([currentProject, result]) => {
      if (!active) return;
      setProject(currentProject);
      setReports(result.reports);
      setTotal(result.total);
      setSelectedId(result.reports[0]?.reportId ?? null);
      setError(null);
    }).catch((loadError: unknown) => {
      if (active) setError(loadError instanceof Error ? loadError.message : "Could not load reports");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [missionId, projectId]);

  useEffect(() => {
    if (!selectedId) {
      setReport(null);
      return;
    }
    let active = true;
    engineeringReportApi.get(projectId, selectedId).then((value) => {
      if (active) {
        setReport(value);
        setError(null);
      }
    }).catch((loadError: unknown) => {
      if (active) setError(loadError instanceof Error ? loadError.message : "Could not load this report");
    });
    return () => { active = false; };
  }, [projectId, selectedId]);

  const generate = async () => {
    setGenerating(true);
    setError(null);
    try {
      const generated = missionId
        ? await engineeringReportApi.generateMission(projectId, missionId)
        : await engineeringReportApi.generate(projectId, reportType);
      const detailed = await engineeringReportApi.get(projectId, generated.reportId);
      await loadReports(1);
      setReports((current) => [
        detailed,
        ...current.filter((item) => item.reportId !== detailed.reportId)
      ]);
      setSelectedId(detailed.reportId);
      setReport(detailed);
    } catch (generateError: unknown) {
      setError(generateError instanceof ApiError
        ? generateError.message
        : generateError instanceof Error ? generateError.message : "Report generation failed");
    } finally {
      setGenerating(false);
    }
  };

  const confirmed = useMemo(
    () => report?.findings?.filter((finding) => finding.verification === "confirmed") ?? [],
    [report]
  );
  const unverified = useMemo(
    () => report?.findings?.filter((finding) => finding.verification === "unverified") ?? [],
    [report]
  );

  const openFile = (filePath: string, line?: number) => {
    const query = new URLSearchParams({ file: filePath });
    if (line) query.set("line", String(line));
    return `/projects/${projectId}/explorer?${query}`;
  };

  const reportTypeLabel = report
    ? reportTypeLabels[report.reportType]
    : missionId ? "Mission-specific report" : "Engineering report";

  return (
    <main className="reports-shell">
      <header className="workspace-header reports-header">
        <Link className="brand" to="/workspace"><span className="brand-mark">N</span><span>NEXUS<span className="brand-period">.</span></span></Link>
        <div className="chat-project-title"><span className="project-header-dot" /><span>{project?.name ?? "Engineering reports"}</span></div>
        <nav className="mission-nav">
          <Link className="back-link" to={`/projects/${projectId}/missions`}>Missions <span>→</span></Link>
          <Link className="back-link" to={`/projects/${projectId}/issues`}>Findings <span>→</span></Link>
          <Link className="back-link" to="/workspace">Workspace <span>↗</span></Link>
        </nav>
      </header>
      <section className="reports-content">
        <div className="workspace-eyebrow"><span className="status-dot" /> ENGINEERING INTELLIGENCE · REPORTS</div>
        <div className="reports-title-row">
          <div>
            <h1>Engineering <span>reports.</span></h1>
            <p className="workspace-lede">Structured assessments from stored investigations. Findings are counted deterministically and only confirmed when their evidence matches the active indexed source.</p>
          </div>
          <span className="report-project-label">{project?.name ?? "Project"}</span>
        </div>
        <section className="report-generation-panel">
          <div>
            <span className="card-overline">{missionId ? "MISSION REPORT" : "NEW REPORT"}</span>
            <h2>{missionId ? "Generate a report from this mission" : "Build a project report"}</h2>
            <p>{missionId ? "Only this project’s finished mission findings are considered." : "Choose the investigation area to summarize its latest available results."}</p>
          </div>
          <div className="report-generate-controls">
            {!missionId && (
              <label className="report-select-label">
                <span>Report type</span>
                <select value={reportType} onChange={(event) => setReportType(event.target.value as EngineeringReportType)}>
                  {reportOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
                </select>
              </label>
            )}
            <button type="button" className="primary-button" onClick={() => void generate()} disabled={generating || loading}>
              {generating ? <><span className="button-spinner" /> Building report…</> : <>Generate report <span>→</span></>}
            </button>
          </div>
        </section>
        {error && <div className="form-alert" role="alert">{error}</div>}
        {loading ? (
          <div className="project-empty"><span className="loading-orbit" /><span>Loading reports…</span></div>
        ) : (
          <div className="reports-layout">
            <aside className="report-history">
              <div className="report-history-heading"><span>REPORT HISTORY</span><strong>{total.toString().padStart(2, "0")}</strong></div>
              {reports.length === 0 ? (
                <div className="report-history-empty">No reports yet. Generate one from an existing completed investigation.</div>
              ) : reports.map((item) => (
                <button
                  type="button"
                  className={`report-history-item${selectedId === item.reportId ? " report-history-item-active" : ""}`}
                  key={item.reportId}
                  onClick={() => setSelectedId(item.reportId)}
                >
                  <span className={`report-state-dot report-state-${item.status}`} />
                  <span><strong>{item.title}</strong><small>{new Date(item.createdAt).toLocaleString()}</small></span>
                  <small>{item.status}</small>
                </button>
              ))}
              {total > 15 && (
                <div className="report-pagination">
                  <button type="button" disabled={page <= 1} onClick={() => void loadReports(page - 1)}>Previous</button>
                  <span>{page} / {Math.ceil(total / 15)}</span>
                  <button type="button" disabled={page >= Math.ceil(total / 15)} onClick={() => void loadReports(page + 1)}>Next</button>
                </div>
              )}
            </aside>
            <section className="report-detail">
              {!report ? (
                <div className="report-empty"><span>▤</span><h2>Choose a report</h2><p>Generate an assessment above, or select a previous report from the history.</p></div>
              ) : (
                <>
                  <header className="report-detail-header">
                    <div><span className="card-overline">{reportTypeLabel.toUpperCase()}</span><h2>{report.title}</h2><p>{new Date(report.createdAt).toLocaleString()} · generation {report.generation.indexedGeneration}</p></div>
                    <div className="report-actions">
                      <span className={`report-status report-status-${report.status}`}>{report.status === "complete" ? "COMPLETE" : "PARTIAL"}</span>
                      <button type="button" onClick={() => downloadFile(`${report.reportType}-${report.reportId}.md`, reportToMarkdown(report), "text/markdown;charset=utf-8")}>Export Markdown</button>
                      <button type="button" onClick={() => downloadFile(`${report.reportType}-${report.reportId}.json`, reportToJson(report), "application/json;charset=utf-8")}>Export JSON</button>
                    </div>
                  </header>
                  {report.status === "partial" && report.limitations.length > 0 && (
                    <div className="report-partial-notice" role="status"><strong>Partial report</strong><span>Some required checks or processing steps were incomplete. Review the limitations before drawing conclusions.</span></div>
                  )}
                  <section className="report-section report-summary">
                    <div className="report-section-heading"><span>01</span><h3>Executive summary</h3></div>
                    <p>{report.summary}</p>
                    <small className="report-source-caveat">Evidence validation confirms that quoted text and line ranges match the active indexed source; it does not independently prove a finding's interpretation or severity.</small>
                  </section>
                  <div className={`report-overview-grid${report.reportType === "project_health" ? "" : " report-overview-single"}`}>
                    <section className="report-section">
                      <div className="report-section-heading"><span>02</span><h3>Severity breakdown</h3></div>
                      <div className="report-severity-grid">
                        {severityOrder.map((severity) => (
                          <div className={`report-severity report-severity-${severity}`} key={severity}>
                            <span>{severityLabels[severity]}</span><strong>{report.severityCounts[severity] ?? 0}</strong>
                          </div>
                        ))}
                      </div>
                    </section>
                    {report.reportType === "project_health" && <section className="report-section report-score">
                      <div className="report-section-heading"><span>03</span><h3>Health score</h3></div>
                      <strong>{report.healthScore.status === "calculated" ? `${report.healthScore.value}/100` : "Insufficient data"}</strong>
                      <p>{report.healthScore.rationale}</p>
                      <details><summary>Scoring method and limitations</summary><p>{report.healthScore.formula}</p></details>
                    </section>}
                  </div>
                  <section className="report-section">
                    <div className="report-section-heading"><span>04</span><h3>Findings by category</h3><span className="report-count">{confirmed.length} confirmed</span></div>
                    {confirmed.length === 0 ? (
                      <div className="report-inline-empty">No findings could be confirmed against the active indexed source. This does not mean the project is issue-free.</div>
                    ) : (
                      <div className="report-category-list">
                        {report.sections.map((section) => {
                          const sectionFindings = confirmed.filter((finding) => finding.category === section.category);
                          if (sectionFindings.length === 0) return null;
                          return (
                            <section className="report-category-group" key={section.category}>
                              <header><h4>{categoryLabels[section.category] ?? section.category}</h4><span>{sectionFindings.length}</span></header>
                              <div className="report-finding-list">
                                {sectionFindings.map((finding) => (
                                  <article className="report-finding" key={`${finding.source}-${finding.issueId}`}>
                            <header><span className={`severity-mark severity-${finding.severity}`} /><div><strong>{finding.title}</strong><small>{categoryLabels[finding.category] ?? finding.category} · {severityLabels[finding.severity] ?? finding.severity} · {Math.round(finding.confidence * 100)}% confidence</small></div></header>
                            <p>{finding.description}</p>
                            <div className="report-evidence"><strong>Evidence</strong>
                              {finding.evidence.map((evidence, index) => (
                                <Link key={`${evidence.filePath}-${evidence.startLine}-${index}`} to={openFile(evidence.filePath, evidence.startLine)}>
                                  <code>{evidence.filePath}:{evidence.startLine}-{evidence.endLine}</code><span>{evidence.explanation}</span>
                                </Link>
                              ))}
                            </div>
                            <div className="report-recommendation"><strong>Recommended action</strong><p>{finding.recommendation}</p></div>
                                  </article>
                                ))}
                              </div>
                            </section>
                          );
                        })}
                      </div>
                    )}
                  </section>
                  {unverified.length > 0 && (
                    <section className="report-section report-unverified-section">
                      <div className="report-section-heading"><span>05</span><h3>Unverified suggestions</h3><span className="report-count">{unverified.length}</span></div>
                      <p className="report-unverified-note">These original AI findings are shown for review only. Their evidence did not match the active source or they were dismissed, so they are excluded from confirmed counts and scoring.</p>
                      {unverified.map((finding) => (
                        <article className="report-unverified-item" key={`${finding.source}-${finding.issueId}`}>
                          <strong>{finding.title}</strong><p>{finding.description}</p>
                          {finding.affectedFiles.map((filePath) => <Link key={filePath} to={openFile(filePath)}>{filePath}</Link>)}
                        </article>
                      ))}
                    </section>
                  )}
                  <section className="report-section">
                    <div className="report-section-heading"><span>06</span><h3>Prioritized actions</h3></div>
                    {report.recommendations.length === 0
                      ? <div className="report-inline-empty">No confirmed recommendations are available.</div>
                      : <ol className="report-actions-list">{report.recommendations.map((recommendation) => (
                        <li key={recommendation.findingId}>
                          <span className={`severity-mark severity-${recommendation.severity}`} />
                          <div><strong>{recommendation.title}</strong><p>{recommendation.action}</p>
                            {recommendation.affectedFiles.map((filePath) => <Link key={filePath} to={openFile(filePath)}>{filePath}</Link>)}
                          </div>
                        </li>
                      ))}</ol>}
                  </section>
                  <section className="report-section">
                    <div className="report-section-heading"><span>07</span><h3>Limitations and coverage</h3></div>
                    {report.limitations.length > 0
                      ? <ul className="report-limitations">{report.limitations.map((limitation, index) => <li key={`${index}-${limitation}`}>{limitation}</li>)}</ul>
                      : <p className="report-no-limitations">No incomplete checks were recorded for this report.</p>}
                    <div className="report-metadata">Source runs: {report.generation.sourceRunIds.length} · Narrative: {report.generation.narrativeStatus} · Model: {report.generation.model ?? "not recorded"}</div>
                  </section>
                </>
              )}
            </section>
          </div>
        )}
      </section>
    </main>
  );
}
