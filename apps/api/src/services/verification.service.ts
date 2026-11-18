import { randomUUID } from "node:crypto";
import { FixProposal } from "../models/fix-proposal.model.js";
import { VerificationRun } from "../models/verification-run.model.js";
import { emitVerificationProgress } from "../realtime/mission-socket.js";
import { redactSecrets } from "../utils/repository-input.js";
import { AppError } from "../utils/app-error.js";
import { getOwnedProject } from "./project.service.js";

const sandboxUnavailableReason =
  "No isolated verification sandbox is configured. No project commands or repository code were executed.";
const maxSummaryChars = 2_000;

export const sanitizeOutputSummary = (output: string) => redactSecrets(
  output
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
).slice(0, maxSummaryChars);

type CheckResult = {
  checkId: string;
  status: "PASSED" | "FAILED" | "SKIPPED" | "TIMED_OUT" | "CANCELLED";
  exitCode?: number;
};

export const classifyVerificationResults = (
  checks: CheckResult[],
  requiredCheckIds: string[] = ["test", "lint", "build"]
) => {
  if (checks.some((check) => check.status === "CANCELLED")) return "CANCELLED" as const;
  if (checks.some((check) => check.status === "TIMED_OUT")) return "TIMED_OUT" as const;
  const requiredChecks = checks.filter((check) => requiredCheckIds.includes(check.checkId));
  if (requiredChecks.some((check) =>
    check.status === "FAILED" || (check.status === "PASSED" && check.exitCode !== 0)
  )) {
    return "FAILED" as const;
  }
  if (requiredChecks.length === 0) return "PARTIAL";
  const checkById = new Map(requiredChecks.map((check) => [check.checkId, check]));
  if (requiredCheckIds.every((id) =>
    checkById.get(id)?.status === "PASSED" && checkById.get(id)?.exitCode === 0
  )) return "PASSED";
  return "PARTIAL";
};

const safeUnexecutedChecks = () => [
  { checkId: "test" as const, commandIdentifier: "project-test" as const },
  { checkId: "lint" as const, commandIdentifier: "project-lint" as const },
  { checkId: "build" as const, commandIdentifier: "project-build" as const }
].map((check) => ({
  ...check,
  status: "SKIPPED" as const,
  sanitizedOutputSummary: sanitizeOutputSummary(sandboxUnavailableReason),
  durationMs: 0,
  failureReason: "Sandbox unavailable"
}));

export const startVerification = async (
  projectId: string,
  userId: string,
  proposalId: string
) => {
  await getOwnedProject(projectId, userId);
  const proposal = await FixProposal.findOne({ projectId, userId, proposalId }).lean();
  if (!proposal) throw new AppError(404, "Fix proposal not found", "FIX_PROPOSAL_NOT_FOUND");
  const repositoryRevision = proposal.applicationResult?.repositoryRevision;
  if (
    proposal.status !== "APPLIED" ||
    proposal.applicationResult?.status !== "SUCCEEDED" ||
    !repositoryRevision
  ) {
    throw new AppError(409, "Verification requires a successfully applied patch and recorded repository revision.", "FIX_NOT_APPLIED");
  }
  const startedAt = new Date();
  const run = await VerificationRun.create({
    verificationId: randomUUID(),
    projectId,
    userId,
    fixProposalId: proposalId,
    ...(proposal.missionId ? { missionId: proposal.missionId } : {}),
    repositoryRevision,
    expectedRevision: proposal.targetRevision,
    checks: safeUnexecutedChecks(),
    status: classifyVerificationResults(safeUnexecutedChecks()),
    failureReason: sandboxUnavailableReason,
    startedAt,
    completedAt: new Date(),
    durationMs: 0
  });
  emitVerificationProgress({
    verificationId: run.verificationId,
    status: run.status,
    message: "Verification is partial: sandbox unavailable; no checks were executed.",
    createdAt: run.completedAt!.toISOString()
  });
  return run;
};

export const listVerificationRuns = async (
  projectId: string,
  userId: string,
  proposalId: string
) => {
  await getOwnedProject(projectId, userId);
  const proposalExists = await FixProposal.exists({ projectId, userId, proposalId });
  if (!proposalExists) throw new AppError(404, "Fix proposal not found", "FIX_PROPOSAL_NOT_FOUND");
  return VerificationRun.find({ projectId, userId, fixProposalId: proposalId })
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();
};

export const getVerificationRun = async (
  projectId: string,
  userId: string,
  verificationId: string
) => {
  await getOwnedProject(projectId, userId);
  const run = await VerificationRun.findOne({ projectId, userId, verificationId }).lean();
  if (!run) throw new AppError(404, "Verification run not found", "VERIFICATION_RUN_NOT_FOUND");
  return run;
};

export const cancelVerificationRun = async (
  projectId: string,
  userId: string,
  verificationId: string
) => {
  await getOwnedProject(projectId, userId);
  const updated = await VerificationRun.findOneAndUpdate(
    { projectId, userId, verificationId, status: { $in: ["PENDING", "RUNNING"] } },
    {
      $set: {
        status: "CANCELLED",
        failureReason: "Verification was cancelled before checks completed.",
        completedAt: new Date()
      }
    },
    { new: true, runValidators: true }
  );
  if (!updated) throw new AppError(409, "Only a pending or running verification can be cancelled.", "VERIFICATION_NOT_CANCELLABLE");
  emitVerificationProgress({
    verificationId: updated.verificationId,
    status: updated.status,
    message: "Verification cancelled.",
    createdAt: updated.completedAt?.toISOString() ?? new Date().toISOString()
  });
  return updated;
};
