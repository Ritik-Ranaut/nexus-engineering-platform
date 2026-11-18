import type { RequestHandler } from "express";
import { AnalysisRun } from "../models/analysis-run.model.js";
import { EngineeringIssue } from "../models/engineering-issue.model.js";
import { getOwnedProject } from "../services/project.service.js";
import { runEngineeringAnalysis } from "../services/engineering-analysis.service.js";
import { runAnalysisSchema, updateIssueSchema } from "../validators/analysis.validators.js";
import { AppError } from "../utils/app-error.js";
import { asyncHandler } from "../utils/async-handler.js";

const publicIssue = (issue: Record<string, unknown>) => ({
  issueId: issue.issueId,
  runId: issue.runId,
  agent: issue.agent,
  category: issue.category,
  severity: issue.severity,
  title: issue.title,
  description: issue.description,
  reasoningSummary: issue.reasoningSummary,
  affectedFiles: issue.affectedFiles,
  evidence: issue.evidence,
  recommendation: issue.recommendation,
  confidence: issue.confidence,
  status: issue.status,
  createdAt: issue.createdAt
});

export const runAnalysis: RequestHandler = asyncHandler(async (request, response) => {
  const { goal } = runAnalysisSchema.parse(request.body);
  const project = await getOwnedProject(request.params.projectId, request.user!.id);
  const controller = new AbortController();
  request.once("aborted", () => controller.abort());
  const result = await runEngineeringAnalysis({
    project,
    ownerId: request.user!.id,
    goal,
    signal: controller.signal
  });
  await AnalysisRun.create({
    runId: result.runId,
    ownerId: request.user!.id,
    projectId: project._id,
    goal,
    status: result.status,
    selectedAgents: result.selectedAgents,
    summaries: result.summaries,
    activities: result.activities,
    failures: result.failures,
    report: result.report,
    issueCount: result.issues.length,
    durationMs: result.durationMs,
    model: result.model
  });
  if (result.issues.length > 0) {
    await EngineeringIssue.insertMany(result.issues.map((issue) => ({
      ...issue,
      ownerId: request.user!.id,
      projectId: project._id
    })));
  }
  response.status(201).json({
    data: {
      run: {
        runId: result.runId,
        status: result.status,
        selectedAgents: result.selectedAgents,
        failures: result.failures,
        activities: result.activities,
        summaries: result.summaries,
        report: result.report,
        issueCount: result.issues.length,
        durationMs: result.durationMs,
        model: result.model
      },
      issues: result.issues
    }
  });
});

export const listRuns: RequestHandler = asyncHandler(async (request, response) => {
  await getOwnedProject(request.params.projectId, request.user!.id);
  const runs = await AnalysisRun.find({
    projectId: request.params.projectId,
    ownerId: request.user!.id
  }).sort({ createdAt: -1 }).limit(25).lean();
  response.status(200).json({
    data: {
      runs: runs.map((run) => ({
        runId: run.runId,
        status: run.status,
        selectedAgents: run.selectedAgents,
        failures: run.failures,
        issueCount: run.issueCount,
        report: run.report,
        durationMs: run.durationMs,
        model: run.model,
        createdAt: run.createdAt
      }))
    }
  });
});

export const listIssues: RequestHandler = asyncHandler(async (request, response) => {
  await getOwnedProject(request.params.projectId, request.user!.id);
  const query: { ownerId: string; projectId: string; runId?: string } = {
    ownerId: request.user!.id,
    projectId: request.params.projectId
  };
  if (typeof request.query.runId === "string") query.runId = request.query.runId;
  const issues = await EngineeringIssue.find(query)
    .sort({ createdAt: -1, severity: 1 })
    .limit(250)
    .lean();
  response.status(200).json({ data: { issues: issues.map((issue) => publicIssue(issue)) } });
});

export const updateIssue: RequestHandler = asyncHandler(async (request, response) => {
  await getOwnedProject(request.params.projectId, request.user!.id);
  const { status } = updateIssueSchema.parse(request.body);
  const issue = await EngineeringIssue.findOneAndUpdate(
    {
      projectId: request.params.projectId,
      ownerId: request.user!.id,
      issueId: request.params.issueId
    },
    { $set: { status } },
    { new: true, runValidators: true }
  ).lean();
  if (!issue) throw new AppError(404, "Issue not found", "ISSUE_NOT_FOUND");
  response.status(200).json({ data: { issue: publicIssue(issue) } });
});
