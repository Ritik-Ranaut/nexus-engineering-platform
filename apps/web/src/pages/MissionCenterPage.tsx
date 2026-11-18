import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { io, type Socket } from "socket.io-client";
import {
  ApiError,
  missionApi,
  projectApi,
  type Mission,
  type MissionProgressEvent,
  type Project
} from "../api/client";

const activeStatuses: Mission["status"][] = ["CREATED", "PLANNING", "RUNNING"];
const canCancel = (status: Mission["status"]) =>
  [...activeStatuses, "WAITING_FOR_APPROVAL"].includes(status);

const statusLabel: Record<Mission["status"], string> = {
  CREATED: "Queued",
  PLANNING: "Planning",
  RUNNING: "Investigating",
  WAITING_FOR_APPROVAL: "Awaiting approval",
  COMPLETED: "Completed",
  FAILED: "Failed",
  CANCELLED: "Cancelled"
};

const agentLabel = (agent: string) => ({
  code_quality: "Code Quality",
  security: "Security",
  performance: "Performance",
  testing: "Testing",
  documentation: "Documentation"
}[agent] ?? agent);

const suggestedGoals = [
  "Improve security.",
  "Find performance problems.",
  "Prepare the application for production.",
  "Improve test coverage.",
  "Review the architecture."
];

const severityOrder = ["critical", "high", "medium", "low", "suggestion"] as const;

export function MissionCenterPage() {
  const { projectId = "" } = useParams();
  const [project, setProject] = useState<Project | null>(null);
  const [missions, setMissions] = useState<Mission[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedMission, setSelectedMission] = useState<Mission | null>(null);
  const [goal, setGoal] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [socketConnected, setSocketConnected] = useState(false);
  const socketRef = useRef<Socket | null>(null);

  const refreshSelected = useCallback(async () => {
    if (!selectedId) return;
    const mission = await missionApi.get(selectedId);
    setSelectedMission(mission);
    setMissions((current) => current.map((item) => item.id === mission.id ? mission : item));
  }, [selectedId]);

  useEffect(() => {
    let active = true;
    Promise.all([projectApi.get(projectId), missionApi.list(projectId)])
      .then(([currentProject, currentMissions]) => {
        if (!active) return;
        setProject(currentProject);
        setMissions(currentMissions);
        const initial = currentMissions.find((mission) => activeStatuses.includes(mission.status)) ??
          currentMissions[0];
        if (initial) setSelectedId(initial.id);
      })
      .catch((loadError: unknown) => {
        if (active) setError(loadError instanceof Error ? loadError.message : "Could not load missions");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [projectId]);

  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    void missionApi.get(selectedId).then((mission) => {
      if (active) setSelectedMission(mission);
    }).catch((loadError: unknown) => {
      if (active) setError(loadError instanceof Error ? loadError.message : "Could not load mission details");
    });

    const socket = io({ withCredentials: true, reconnection: true });
    socketRef.current = socket;
    const subscribe = () => socket.emit(
      "mission:subscribe",
      selectedId,
      (result: { ok: boolean }) => {
        setSocketConnected(result.ok);
        if (result.ok) void refreshSelected();
      }
    );
    socket.on("connect", subscribe);
    socket.on("disconnect", () => setSocketConnected(false));
    socket.on("connect_error", () => setSocketConnected(false));
    socket.on("mission:progress", (event: MissionProgressEvent) => {
      if (event.missionId !== selectedId) return;
      setSelectedMission((current) => current ? ({
        ...current,
        status: event.status,
        progress: {
          ...current.progress,
          percent: event.progress,
          currentStep: event.message,
          events: current.progress.events.some((item) => item.createdAt === event.createdAt && item.message === event.message)
            ? current.progress.events
            : [...current.progress.events, {
              eventId: `${event.createdAt}-${event.message}`,
              message: event.message,
              status: event.eventStatus,
              createdAt: event.createdAt
            }]
        }
      }) : current);
      void refreshSelected();
    });
    if (socket.connected) subscribe();
    const polling = window.setInterval(() => {
      if (active && selectedMission && activeStatuses.includes(selectedMission.status)) {
        void refreshSelected().catch(() => undefined);
      }
    }, 5_000);
    return () => {
      active = false;
      window.clearInterval(polling);
      socket.emit("mission:unsubscribe", selectedId);
      socket.disconnect();
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [selectedId, refreshSelected, selectedMission?.status]);

  const sortedEvents = useMemo(() => selectedMission?.progress.events
    ? [...selectedMission.progress.events].sort((a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    )
    : [], [selectedMission?.progress.events]);

  const createMission = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedGoal = goal.trim();
    if (!trimmedGoal || creating) return;
    setCreating(true);
    setError(null);
    try {
      const mission = await missionApi.create(projectId, trimmedGoal);
      setGoal("");
      setSelectedId(mission.id);
      setSelectedMission(mission);
      setMissions((current) => [mission, ...current]);
    } catch (createError: unknown) {
      setError(createError instanceof ApiError
        ? createError.message
        : createError instanceof Error ? createError.message : "Could not create mission");
    } finally {
      setCreating(false);
    }
  };

  const cancel = async () => {
    if (!selectedMission) return;
    setError(null);
    try {
      const updated = await missionApi.cancel(selectedMission.id);
      setSelectedMission(updated);
      setMissions((current) => current.map((mission) => mission.id === updated.id ? updated : mission));
    } catch (cancelError: unknown) {
      setError(cancelError instanceof Error ? cancelError.message : "Could not cancel this mission");
    }
  };

  const decide = async (actionId: string, decision: "approved" | "rejected") => {
    if (!selectedMission) return;
    setError(null);
    try {
      const updated = await missionApi.decide(selectedMission.id, actionId, decision);
      setSelectedMission(updated);
      setMissions((current) => current.map((mission) => mission.id === updated.id ? updated : mission));
    } catch (decisionError: unknown) {
      setError(decisionError instanceof Error ? decisionError.message : "Could not record approval decision");
    }
  };

  return (
    <main className="mission-shell">
      <header className="workspace-header mission-header">
        <Link className="brand" to="/workspace"><span className="brand-mark">N</span><span>NEXUS<span className="brand-period">.</span></span></Link>
        <div className="chat-project-title"><span className="project-header-dot" /><span>{project?.name ?? (loading ? "Loading project…" : "Mission Center")}</span></div>
        <nav className="mission-nav">
          <Link className="back-link" to={`/projects/${projectId}/chat`}>Chat <span>→</span></Link>
          <Link className="back-link" to={`/projects/${projectId}/issues`}>Findings <span>→</span></Link>
          <Link className="back-link" to="/workspace">Workspace <span>↗</span></Link>
        </nav>
      </header>
      <section className="mission-content">
        <div className="workspace-eyebrow"><span className="status-dot" /> MISSION CONTROL <span className={`realtime-indicator${socketConnected ? " realtime-connected" : ""}`}><i />{socketConnected ? "LIVE" : "RECONNECTING"}</span></div>
        <div className="mission-page-title">
          <div>
            <h1>Engineering <span>missions.</span></h1>
            <p className="workspace-lede">Turn a high-level goal into a bounded, evidence-backed engineering investigation. Nothing changes in your source without your action.</p>
          </div>
        </div>
        <form className="mission-create" onSubmit={(event) => void createMission(event)}>
          <label className="field">
            <span>What should NEXUS investigate?</span>
            <textarea
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              maxLength={1_000}
              minLength={5}
              required
              placeholder="Improve application security, find performance bottlenecks, review architecture…"
            />
          </label>
          <div className="mission-goal-suggestions" aria-label="Suggested mission goals">
            {suggestedGoals.map((suggestion) => (
              <button
                type="button"
                key={suggestion}
                onClick={() => setGoal(suggestion)}
                disabled={creating}
              >
                {suggestion}
              </button>
            ))}
          </div>
          <div className="mission-create-bottom">
            <span>Read-only investigation · up to five specialist agents</span>
            <button className="primary-button" disabled={creating || project?.indexingStatus !== "ready"}>
              {creating ? <><span className="button-spinner" /> Creating mission…</> : <>Create mission <span>→</span></>}
            </button>
          </div>
          {project?.indexingStatus !== "ready" && <p className="issues-hint">Index this project before creating a mission.</p>}
        </form>
        {error && <div className="form-alert" role="alert">{error}</div>}
        <div className="mission-workspace">
          <aside className="mission-list-panel">
            <div className="mission-panel-heading"><span>MISSION LOG</span><span>{missions.length.toString().padStart(2, "0")}</span></div>
            {loading ? <div className="mission-list-empty">Loading missions…</div> : missions.length === 0 ? (
              <div className="mission-list-empty">Your mission log is clear.<br />Create an investigation to begin.</div>
            ) : missions.map((mission) => (
              <button
                className={`mission-list-item${selectedId === mission.id ? " mission-list-item-active" : ""}`}
                key={mission.id}
                onClick={() => setSelectedId(mission.id)}
              >
                <span className={`mission-state-dot mission-state-${mission.status.toLowerCase()}`} />
                <span className="mission-list-copy"><strong>{mission.goal}</strong><small>{statusLabel[mission.status]} · {new Date(mission.createdAt).toLocaleString()}</small></span>
              </button>
            ))}
          </aside>
          <section className="mission-detail-panel">
            {!selectedMission ? (
              <div className="mission-placeholder"><span>◇</span><h2>Select a mission</h2><p>Create a mission or select one from the log to see its plan and progress.</p></div>
            ) : (
              <>
                <div className="mission-detail-heading">
                  <div>
                    <span className="card-overline">MISSION BRIEF</span>
                    <h2>{selectedMission.goal}</h2>
                  </div>
                  <span className={`mission-status-pill mission-pill-${selectedMission.status.toLowerCase()}`}>{statusLabel[selectedMission.status]}</span>
                </div>
                <div className="mission-progress-line"><div style={{ width: `${selectedMission.progress.percent}%` }} /></div>
                <div className="mission-progress-meta"><span>{selectedMission.progress.currentStep}</span><strong>{selectedMission.progress.percent}%</strong></div>
                {selectedMission.report && (
                  <div className="analysis-notice" role="status">
                    {selectedMission.report.summary}
                    <div className="mission-report-counts">
                      {severityOrder.map((severity) => {
                        const count = selectedMission.report?.severityCounts[severity] ?? 0;
                        return count > 0 ? (
                          <span key={severity} className={`severity-text-${severity}`}>
                            {count} {severity}
                          </span>
                        ) : null;
                      })}
                    </div>
                  </div>
                )}

                {selectedMission.plan && (
                  <section className="mission-section">
                    <div className="mission-section-title"><span>01</span><h3>Execution plan</h3></div>
                    <p className="mission-plan-summary">{selectedMission.plan.summary}</p>
                    {selectedMission.plan.rationale && <p className="mission-plan-rationale">{selectedMission.plan.rationale}</p>}
                    <div className="mission-task-list">
                      {selectedMission.tasks.map((task, index) => (
                        <article className="mission-task" key={task.taskId}>
                          <span className={`mission-task-state task-${task.status}`} aria-label={task.status}>{task.status === "completed" ? "✓" : task.status === "running" ? "→" : task.status === "failed" ? "!" : String(index + 1).padStart(2, "0")}</span>
                          <div><strong>{agentLabel(task.agent)}</strong><p>{task.description}</p>{task.result && <small>{task.result}</small>}</div>
                        </article>
                      ))}
                    </div>
                  </section>
                )}

                {selectedMission.findings.length > 0 && (
                  <section className="mission-section">
                    <div className="mission-section-title"><span>02</span><h3>Prioritized findings</h3><span className="mission-count">{selectedMission.findings.length}</span></div>
                    <div className="mission-finding-list">
                      {selectedMission.findings.map((finding) => (
                        <article className="mission-finding" key={finding.issueId}>
                          <span className={`severity-mark severity-${finding.severity}`} />
                          <div>
                            <strong>{finding.title}</strong><small>{finding.severity.toUpperCase()} · {agentLabel(finding.agent)} · {finding.affectedFiles.join(", ")}</small><p>{finding.recommendation}</p>
                            <Link className="mission-fix-link" to={`/projects/${projectId}/fixes?${new URLSearchParams({
                              findingId: finding.issueId,
                              runId: finding.runId,
                              missionId: selectedMission.id
                            })}`}>Generate fix proposal <span>→</span></Link>
                          </div>
                        </article>
                      ))}
                    </div>
                  </section>
                )}

                {selectedMission.actions.length > 0 && (
                  <section className="mission-section">
                    <div className="mission-section-title"><span>03</span><h3>Human approval</h3><span className="mission-count">{selectedMission.actions.filter((action) => action.status === "pending").length} pending</span></div>
                    <p className="mission-approval-note">These are recommendations only. Approving a recommendation records your decision; NEXUS will not modify files or execute it.</p>
                    <div className="mission-action-list">
                      {selectedMission.actions.map((action) => {
                        const finding = selectedMission.findings.find((item) => item.issueId === action.issueId);
                        return (
                          <article className="mission-action" key={action.actionId}>
                            <div><strong>{finding?.title ?? "Engineering recommendation"}</strong><p>{action.description}</p></div>
                            {action.status === "pending" && selectedMission.status === "WAITING_FOR_APPROVAL" ? (
                              <div className="mission-decision-buttons">
                                <button type="button" className="mission-approve" onClick={() => void decide(action.actionId, "approved")}>Approve</button>
                                <button type="button" className="mission-reject" onClick={() => void decide(action.actionId, "rejected")}>Reject</button>
                              </div>
                            ) : <span className={`mission-decision decision-${action.status}`}>{action.status}</span>}
                          </article>
                        );
                      })}
                    </div>
                  </section>
                )}

                {selectedMission.errors.length > 0 && (
                  <div className="analysis-warning mission-errors" role="status">
                    {selectedMission.errors.map((item, index) => <p key={`${item.code}-${index}`}>{item.message}</p>)}
                  </div>
                )}

                {["COMPLETED", "FAILED", "CANCELLED"].includes(selectedMission.status) && (
                  <div className="mission-report-link">
                    <span>Turn this investigation into a structured, evidence-checked report.</span>
                    <Link to={`/projects/${projectId}/reports?missionId=${encodeURIComponent(selectedMission.id)}`}>
                      Open mission report <span>→</span>
                    </Link>
                  </div>
                )}

                <section className="mission-section mission-timeline-section">
                  <div className="mission-section-title"><span>04</span><h3>Activity timeline</h3></div>
                  <ol className="mission-timeline">
                    {sortedEvents.map((event) => (
                      <li className={`timeline-${event.status}`} key={event.eventId}>
                        <span className="timeline-marker" />
                        <div><p>{event.message}</p><time>{new Date(event.createdAt).toLocaleTimeString()}</time></div>
                      </li>
                    ))}
                  </ol>
                </section>

                {canCancel(selectedMission.status) && (
                  <div className="mission-controls">
                    <span>Cancel stops the current investigation. No source changes have been made.</span>
                    <button type="button" className="analysis-cancel-button" onClick={() => void cancel()}>Cancel mission</button>
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      </section>
    </main>
  );
}
