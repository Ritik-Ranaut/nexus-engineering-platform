import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { io } from "socket.io-client";
import {
  ApiError,
  engineeringApi,
  fixProposalApi,
  missionApi,
  projectApi,
  type EngineeringIssue,
  type FixProposal,
  type FixProposalListItem,
  type Project,
  type VerificationRun
} from "../api/client";

type DiffRow = { kind: "addition" | "deletion" | "context" | "header"; text: string };

const patchRows = (patch: string): DiffRow[] => patch.split(/\r?\n/).flatMap((line): DiffRow[] => {
  if (line.startsWith("+++") || line.startsWith("---")) return [];
  if (line.startsWith("@@")) return [{ kind: "header", text: line }];
  if (line.startsWith("+")) return [{ kind: "addition", text: line }];
  if (line.startsWith("-")) return [{ kind: "deletion", text: line }];
  if (line.startsWith(" ")) return [{ kind: "context", text: line }];
  return line ? [{ kind: "context", text: line }] : [];
});

export function FixProposalsPage() {
  const { projectId = "" } = useParams();
  const [searchParams] = useSearchParams();
  const requestedFindingId = searchParams.get("findingId");
  const requestedRunId = searchParams.get("runId");
  const missionId = searchParams.get("missionId");
  const requestedProposalId = searchParams.get("proposalId");
  const [project, setProject] = useState<Project | null>(null);
  const [issues, setIssues] = useState<EngineeringIssue[]>([]);
  const [selectedIssueKey, setSelectedIssueKey] = useState<string | null>(null);
  const [proposals, setProposals] = useState<FixProposalListItem[]>([]);
  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(requestedProposalId);
  const [proposal, setProposal] = useState<FixProposal | null>(null);
  const [verificationRuns, setVerificationRuns] = useState<VerificationRun[]>([]);
  const [verificationBusy, setVerificationBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadProposalList = useCallback(async () => {
    const result = await fixProposalApi.list(projectId);
    setProposals(result.proposals);
    setSelectedProposalId((current) =>
      current && result.proposals.some((item) => item.proposalId === current)
        ? current
        : requestedProposalId && result.proposals.some((item) => item.proposalId === requestedProposalId)
          ? requestedProposalId
          : result.proposals[0]?.proposalId ?? null
    );
  }, [projectId, requestedProposalId]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const [currentProject, result, findings] = await Promise.all([
          projectApi.get(projectId),
          fixProposalApi.list(projectId),
          missionId ? missionApi.get(missionId).then((mission) => mission.findings) : engineeringApi.listIssues(projectId)
        ]);
        if (!active) return;
        setProject(currentProject);
        setIssues(findings);
        setProposals(result.proposals);
        setSelectedProposalId(requestedProposalId && result.proposals.some((item) =>
          item.proposalId === requestedProposalId
        ) ? requestedProposalId : result.proposals[0]?.proposalId ?? null);
        const matchingFinding = findings.find((finding) =>
          finding.issueId === requestedFindingId &&
          (!requestedRunId || finding.runId === requestedRunId)
        );
        if (matchingFinding) {
          setSelectedIssueKey(`${matchingFinding.runId}:${matchingFinding.issueId}`);
        } else if (findings[0]) {
          setSelectedIssueKey(`${findings[0].runId}:${findings[0].issueId}`);
        }
        setError(null);
      } catch (loadError: unknown) {
        if (active) setError(loadError instanceof Error ? loadError.message : "Could not load fix proposals");
      } finally {
        if (active) setLoading(false);
      }
    };

    void load();
    return () => { active = false; };
  }, [projectId, missionId, requestedFindingId, requestedRunId, requestedProposalId]);

  const selectedIssue = useMemo(() => issues.find((finding) =>
    `${finding.runId}:${finding.issueId}` === selectedIssueKey
  ) ?? null, [issues, selectedIssueKey]);

  useEffect(() => {
    if (!selectedProposalId) {
      setProposal(null);
      setVerificationRuns([]);
      return;
    }
    let active = true;
    Promise.all([
      fixProposalApi.get(projectId, selectedProposalId),
      fixProposalApi.listVerifications(projectId, selectedProposalId)
    ]).then(async ([value, runs]) => {
      if (!active) return;
      const reviewed = await fixProposalApi.reviewed(projectId, value.proposalId);
      if (!active) return;
      setProposal(reviewed);
      setVerificationRuns(runs);
      setError(null);
    }).catch((loadError: unknown) => {
      if (active) setError(loadError instanceof Error ? loadError.message : "Could not load proposal details");
    });
    return () => { active = false; };
  }, [projectId, selectedProposalId]);

  const activeVerification = verificationRuns.find((run) =>
    run.status === "PENDING" || run.status === "RUNNING"
  );
  useEffect(() => {
    if (!activeVerification) return;
    const socket = io({ withCredentials: true, reconnection: true });
    const subscribe = () => socket.emit("verification:subscribe", activeVerification.verificationId);
    socket.on("connect", subscribe);
    socket.on("verification:progress", (event: {
      verificationId: string;
      status: VerificationRun["status"];
      message: string;
      createdAt: string;
    }) => {
      setVerificationRuns((current) => current.map((run) => run.verificationId === event.verificationId
        ? { ...run, status: event.status, failureReason: event.message, updatedAt: event.createdAt }
        : run));
    });
    return () => {
      socket.emit("verification:unsubscribe", activeVerification.verificationId);
      socket.disconnect();
    };
  }, [activeVerification?.verificationId]);

  useEffect(() => {
    if (proposal?.status !== "GENERATING") return;
    const timer = window.setInterval(() => {
      void fixProposalApi.get(projectId, proposal.proposalId).then((updated) => {
        setProposal(updated);
        if (updated.status !== "GENERATING") void loadProposalList();
      }).catch((pollError: unknown) => {
        setError(pollError instanceof Error ? pollError.message : "Could not refresh proposal status");
      });
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [projectId, proposal?.proposalId, proposal?.status, loadProposalList]);

  const generate = async () => {
    if (!selectedIssue || generating) return;
    setGenerating(true);
    setError(null);
    setNotice(null);
    try {
      const generated = await fixProposalApi.generate(projectId, {
        findingId: selectedIssue.issueId,
        runId: selectedIssue.runId,
        ...(missionId ? { missionId } : {})
      });
      setProposal(generated);
      setSelectedProposalId(generated.proposalId);
      await loadProposalList();
      setNotice(generated.status === "GENERATING"
        ? "A proposal for this finding is already being generated."
        : generated.status === "AWAITING_APPROVAL"
          ? "Proposal generated. Review the diff before deciding."
          : generated.validationMessage ?? "The fix proposal could not be generated.");
    } catch (generationError: unknown) {
      setError(generationError instanceof ApiError
        ? generationError.message
        : generationError instanceof Error ? generationError.message : "Fix generation failed");
      void loadProposalList();
    } finally {
      setGenerating(false);
    }
  };

  const validate = async () => {
    if (!proposal) return;
    setError(null);
    setNotice(null);
    try {
      const updated = await fixProposalApi.validate(projectId, proposal.proposalId);
      setProposal(updated);
      setNotice(updated.validationMessage ?? "Proposal validation completed.");
      await loadProposalList();
    } catch (validationError: unknown) {
      setError(validationError instanceof Error ? validationError.message : "Could not validate this proposal");
    }
  };

  const decide = async (decision: "approved" | "rejected") => {
    if (!proposal) return;
    setError(null);
    setNotice(null);
    try {
      if (!window.confirm(decision === "approved"
        ? "Approve this proposal for tracking? This does not modify any files."
        : "Reject this proposal?")) return;
      const rejectionReason = decision === "rejected"
        ? window.prompt("Optional reason for rejecting this proposal:") ?? undefined
        : undefined;
      const updated = await fixProposalApi.decide(projectId, proposal.proposalId, decision, rejectionReason);
      setProposal(updated);
      setNotice(decision === "approved"
        ? "Proposal approved for human tracking. Source files were not changed."
        : "Proposal rejected. Source files were not changed.");
      await loadProposalList();
    } catch (decisionError: unknown) {
      setError(decisionError instanceof Error ? decisionError.message : "Could not save your decision");
    }
  };

  const startVerification = async () => {
    if (!proposal || proposal.status !== "APPLIED" || proposal.applicationResult?.status !== "SUCCEEDED") return;
    setVerificationBusy(true);
    setError(null);
    try {
      const run = await fixProposalApi.startVerification(projectId, proposal.proposalId);
      setVerificationRuns((current) => [run, ...current]);
    } catch (verificationError: unknown) {
      setError(verificationError instanceof Error ? verificationError.message : "Could not start verification");
    } finally {
      setVerificationBusy(false);
    }
  };

  const cancelVerification = async (verificationId: string) => {
    try {
      const updated = await fixProposalApi.cancelVerification(projectId, verificationId);
      setVerificationRuns((current) => current.map((run) =>
        run.verificationId === verificationId ? updated : run
      ));
    } catch (verificationError: unknown) {
      setError(verificationError instanceof Error ? verificationError.message : "Could not cancel verification");
    }
  };

  const codeExplorerUrl = (filePath: string) =>
    `/projects/${projectId}/explorer?${new URLSearchParams({ file: filePath })}`;

  return (
    <main className="fix-shell">
      <header className="workspace-header fix-header">
        <Link className="brand" to="/workspace"><span className="brand-mark">N</span><span>NEXUS<span className="brand-period">.</span></span></Link>
        <div className="chat-project-title"><span className="project-header-dot" /><span>{project?.name ?? "Fix proposals"}</span></div>
        <nav className="mission-nav">
          <Link className="back-link" to={`/projects/${projectId}/issues`}>Findings <span>→</span></Link>
          <Link className="back-link" to={`/projects/${projectId}/explorer`}>Code <span>⌘</span></Link>
          <Link className="back-link" to="/workspace">Workspace <span>↗</span></Link>
        </nav>
      </header>
      <section className="fix-content">
        <div className="workspace-eyebrow"><span className="status-dot" /> ENGINEERING INTELLIGENCE · PROPOSED CHANGES</div>
        <div className="fix-title-row">
          <div><h1>Fix <span>proposals.</span></h1><p className="workspace-lede">Review a source-grounded patch before making any change. NEXUS does not apply proposals to your project.</p></div>
        </div>
        {error && <div className="form-alert" role="alert">{error}</div>}
        {notice && <div className="analysis-notice" role="status">{notice}</div>}
        {loading ? (
          <div className="project-empty"><span className="loading-orbit" /><span>Loading findings and proposals…</span></div>
        ) : (
          <div className="fix-layout">
            <aside className="fix-sidebar">
              <section className="fix-finding-picker">
                <header className="fix-sidebar-heading"><span>SELECT FINDING</span><strong>{issues.length}</strong></header>
                {issues.length === 0 ? (
                  <div className="fix-empty-note">No findings in this scope. Run an engineering investigation first.</div>
                ) : (
                  <div className="fix-finding-list">
                    {issues.map((finding) => (
                      <button
                        type="button"
                        key={`${finding.runId}:${finding.issueId}`}
                        className={`fix-finding-choice${selectedIssueKey === `${finding.runId}:${finding.issueId}` ? " fix-finding-choice-active" : ""}`}
                        onClick={() => setSelectedIssueKey(`${finding.runId}:${finding.issueId}`)}
                      >
                        <span className={`severity-mark severity-${finding.severity}`} />
                        <span><strong>{finding.title}</strong><small>{finding.severity.toUpperCase()} · {finding.affectedFiles[0]}</small></span>
                      </button>
                    ))}
                  </div>
                )}
                {selectedIssue && (
                  <div className="fix-generate-action">
                    <p>Generate a bounded proposal from the finding and active indexed source.</p>
                    <button className="primary-button" type="button" onClick={() => void generate()} disabled={generating}>
                      {generating ? <><span className="button-spinner" /> Generating…</> : <>Generate fix proposal <span>→</span></>}
                    </button>
                  </div>
                )}
              </section>
              <section className="fix-history">
                <header className="fix-sidebar-heading"><span>PROPOSAL HISTORY</span><strong>{proposals.length}</strong></header>
                {proposals.length === 0 ? <div className="fix-empty-note">Generated proposals will appear here.</div> : proposals.map((item) => (
                  <button
                    type="button"
                    key={item.proposalId}
                    className={`fix-history-item${selectedProposalId === item.proposalId ? " fix-history-item-active" : ""}`}
                    onClick={() => setSelectedProposalId(item.proposalId)}
                  >
                    <span className={`fix-status-dot fix-status-${item.status.toLowerCase()}`} />
                    <span><strong>{item.finding.title}</strong><small>{item.status.replaceAll("_", " ")} · {new Date(item.createdAt).toLocaleString()}</small></span>
                  </button>
                ))}
              </section>
            </aside>
            <section className="fix-detail">
              {!proposal ? (
                <div className="fix-detail-empty"><span>⌁</span><h2>Review a proposed change</h2><p>Select a finding to generate a proposal, or choose one from proposal history.</p></div>
              ) : (
                <>
                  <header className="fix-detail-header">
                    <div><span className="card-overline">FIX PROPOSAL · {proposal.status}</span><h2>{proposal.finding.title}</h2><p>Finding {proposal.findingId} · source generation {proposal.targetGeneration}</p></div>
                    <div className="fix-detail-actions">
                      <span className={`fix-validation-badge fix-validation-${proposal.validationStatus.toLowerCase()}`}>{proposal.validationStatus}</span>
                      {proposal.changes.length > 0 && <button type="button" onClick={() => void validate()}>Revalidate source</button>}
                    </div>
                  </header>
                  <div className="verification-lifecycle" aria-label="Fix lifecycle">
                    <span className="verification-step">FIX GENERATED</span>
                    <span className={proposal.approvalStatus === "APPROVED" ? "verification-step verification-step-done" : "verification-step"}>FIX APPROVED</span>
                    <span className={proposal.status === "APPLIED" ? "verification-step verification-step-done" : "verification-step"}>FIX APPLIED</span>
                    <span className={`verification-step${verificationRuns.some((run) => run.status === "PASSED") ? " verification-step-done" : ""}`}>
                      VERIFICATION {verificationRuns[0]?.status ?? "NOT RUN"}
                    </span>
                  </div>
                  {proposal.status === "GENERATING" && <div className="fix-generating-state"><span className="loading-orbit" />Generation is in progress. This page will refresh its status.</div>}
                  {proposal.status === "VALIDATION_FAILED" && (
                    <div className={`fix-warning${proposal.validationStatus === "STALE" ? " fix-warning-stale" : ""}`} role="alert">
                      <strong>{proposal.validationStatus === "STALE" ? "Stale proposal" : "Proposal validation failed"}</strong>
                      <span>{proposal.validationMessage ?? "Generate a new proposal from the current indexed source."}</span>
                    </div>
                  )}
                  {proposal.status === "AWAITING_APPROVAL" && (
                    <div className="fix-review-reminder" role="status">Validated and awaiting your decision. Approval is separate from application; no source file has been changed.</div>
                  )}
                  <section className="fix-section">
                    <div className="fix-section-heading"><span>01</span><h3>Original finding</h3></div>
                    <p>{proposal.finding.description}</p>
                    <div className="fix-finding-evidence">
                      {proposal.finding.evidence.map((evidence, index) => (
                        <Link key={`${evidence.filePath}-${evidence.startLine}-${index}`} to={`${codeExplorerUrl(evidence.filePath)}&line=${evidence.startLine}`}>
                          <code>{evidence.filePath}:{evidence.startLine}-{evidence.endLine}</code><blockquote>{evidence.quote}</blockquote>
                        </Link>
                      ))}
                    </div>
                    <p className="fix-finding-recommendation"><strong>Original recommendation:</strong> {proposal.finding.recommendation}</p>
                  </section>
                  {proposal.rootCause && (
                    <section className="fix-section">
                      <div className="fix-section-heading"><span>02</span><h3>Root cause and proposed change</h3></div>
                      <p><strong>Root cause:</strong> {proposal.rootCause}</p>
                      <p>{proposal.explanation}</p>
                      <div className="fix-uncertainty-grid">
                        <div><strong>Potential side effects</strong>{proposal.sideEffects.length ? <ul>{proposal.sideEffects.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul> : <p>None identified by the generator; review remains required.</p>}</div>
                        <div><strong>Assumptions and uncertainties</strong>{proposal.assumptions.length ? <ul>{proposal.assumptions.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul> : <p>No assumptions were recorded.</p>}</div>
                      </div>
                    </section>
                  )}
                  <section className="fix-section">
                    <div className="fix-section-heading"><span>03</span><h3>Proposed file changes</h3><span>{proposal.changes.length} file(s)</span></div>
                    {proposal.changes.length === 0 ? (
                      <div className="fix-validation-error">{proposal.validationMessage ?? "No validated patch is available. Review the failure details and run a focused investigation."}</div>
                    ) : proposal.changes.map((change) => {
                      const rows = patchRows(change.patch);
                      const additions = rows.filter((row) => row.kind === "addition").length;
                      const deletions = rows.filter((row) => row.kind === "deletion").length;
                      return (
                        <article className="fix-file-diff" key={change.filePath}>
                          <header><Link to={codeExplorerUrl(change.filePath)}>{change.filePath}</Link><span className="diff-additions">+{additions}</span><span className="diff-deletions">-{deletions}</span></header>
                          <pre aria-label={`Proposed diff for ${change.filePath}`}><code>{rows.map((row, index) => (
                            <span className={`diff-row diff-row-${row.kind}`} key={`${index}-${row.text}`}>{row.text}</span>
                          ))}</code></pre>
                          <details className="fix-source-comparison">
                            <summary>View original and proposed source</summary>
                            <div>
                              <section><strong>Original</strong><pre><code>{change.originalContent}</code></pre></section>
                              <section><strong>Proposed</strong><pre><code>{change.proposedContent}</code></pre></section>
                            </div>
                          </details>
                          <footer>Base SHA-256 <code>{change.originalHash}</code> · proposed <code>{change.proposedHash}</code></footer>
                        </article>
                      );
                    })}
                  </section>
                  <section className="fix-section fix-validation-section">
                    <div className="fix-section-heading"><span>04</span><h3>Validation and review</h3></div>
                    <div className="fix-validation-details"><span className={`fix-validation-badge fix-validation-${proposal.validationStatus.toLowerCase()}`}>{proposal.validationStatus}</span><p>{proposal.validationMessage ?? "Patch validation has not completed."}</p></div>
                    <p className="fix-not-run-note">Validation checks path, file scope, patch integrity, size, source hashes, and active revision. It does not execute tests or apply changes.</p>
                    <div className="fix-review-controls">
                      <span>Decision: {proposal.approvalStatus}</span>
                      {proposal.status === "AWAITING_APPROVAL" && proposal.validationStatus === "VALID" && (
                        <>
                          <button type="button" className="fix-reject-button" onClick={() => void decide("rejected")}>Reject</button>
                          <button type="button" className="fix-approve-button" onClick={() => void decide("approved")}>Approve for tracking</button>
                        </>
                      )}
                      {proposal.status === "APPROVED" && (
                        <button type="button" disabled title="NEXUS has no writable repository checkout">
                          Apply unavailable
                        </button>
                      )}
                    </div>
                    {proposal.decision?.decidedAt && (
                      <p className="fix-not-run-note">
                        {proposal.decision.status === "APPROVED" ? "Approved" : "Rejected"} by {proposal.decision.userId} on {new Date(proposal.decision.decidedAt).toLocaleString()}
                        {proposal.decision.rejectionReason ? ` · ${proposal.decision.rejectionReason}` : ""}
                      </p>
                    )}
                    {proposal.applicationResult?.message && (
                      <div className="fix-warning" role="status">{proposal.applicationResult.message}</div>
                    )}
                    <div className="fix-audit-trail" aria-label="Proposal audit history">
                      <strong>Audit trail</strong>
                      {(proposal.auditTrail ?? []).map((event, index) => (
                        <p key={`${event.action}-${event.createdAt}-${index}`}>
                          <span>{event.action.replaceAll("_", " ")}</span> · {new Date(event.createdAt).toLocaleString()} · {event.message}
                        </p>
                      ))}
                    </div>
                  </section>
                  <section className="fix-section verification-panel">
                    <div className="fix-section-heading"><span>05</span><h3>Automated verification</h3></div>
                    <p className="fix-not-run-note">
                      Verification requires a successfully applied patch, an identified repository revision, and an isolated execution sandbox. NEXUS currently has no writable repository checkout or sandbox; it will not execute project scripts on the API host.
                    </p>
                    <button
                      type="button"
                      className="verification-start-button"
                      disabled={verificationBusy || proposal.status !== "APPLIED" || proposal.applicationResult?.status !== "SUCCEEDED"}
                      onClick={() => void startVerification()}
                    >
                      {verificationBusy ? "Starting…" : "Verify applied change"}
                    </button>
                    {verificationRuns.length === 0 ? (
                      <div className="fix-empty-note">No verification attempts recorded for this proposal.</div>
                    ) : (
                      <div className="verification-history">
                        {verificationRuns.map((run) => (
                          <article className="verification-run" key={run.verificationId}>
                            <header>
                              <strong>{run.status}</strong>
                              <span>{new Date(run.createdAt).toLocaleString()} · {run.durationMs} ms</span>
                              {(run.status === "PENDING" || run.status === "RUNNING") && (
                                <button type="button" onClick={() => void cancelVerification(run.verificationId)}>Cancel</button>
                              )}
                            </header>
                            <p>Repository revision: <code>{run.repositoryRevision}</code></p>
                            {run.failureReason && <p className="verification-failure">{run.failureReason}</p>}
                            <ul>
                              {run.checks.map((check) => (
                                <li key={`${run.verificationId}-${check.checkId}`}>
                                  <span className={`verification-check-status verification-check-${check.status.toLowerCase()}`}>{check.status}</span>
                                  <span>{check.checkId} · {check.commandIdentifier}</span>
                                  {check.exitCode !== undefined && <code>exit {check.exitCode}</code>}
                                  {check.failureReason && <small>{check.failureReason}</small>}
                                  {check.sanitizedOutputSummary && <pre>{check.sanitizedOutputSummary}</pre>}
                                </li>
                              ))}
                            </ul>
                          </article>
                        ))}
                      </div>
                    )}
                  </section>
                  <div className="fix-footer-note">NEXUS stores indexed snapshots and has no writable repository checkout. Approval records a human decision only; application and rollback are unavailable and no source is changed.</div>
                </>
              )}
            </section>
          </div>
        )}
      </section>
    </main>
  );
}
