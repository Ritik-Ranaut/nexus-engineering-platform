import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { createApp } from "../src/app.js";
import { AnalysisRun } from "../src/models/analysis-run.model.js";
import { EngineeringIssue } from "../src/models/engineering-issue.model.js";
import { EngineeringReport } from "../src/models/engineering-report.model.js";
import { Mission } from "../src/models/mission.model.js";
import { Project } from "../src/models/project.model.js";
import { ProjectFile } from "../src/models/project-file.model.js";
import { User } from "../src/models/user.model.js";
import { authService } from "../src/services/auth.service.js";
import { calculateHealthScore } from "../src/services/engineering-report.service.js";
import { generateText } from "../src/services/ai.service.js";
import { reportToJson, reportToMarkdown } from "../../web/src/utils/report-export.js";
import type { EngineeringReport as EngineeringReportData } from "../../web/src/api/client.js";

vi.mock("../src/services/ai.service.js", () => ({
  generateText: vi.fn()
}));

const app = createApp();
let database: MongoMemoryServer;

const finding = (issueId: string, filePath = "src/auth.ts", quote = "export const authEnabled = true;") => ({
  issueId,
  runId: "run-security",
  agent: "security" as const,
  category: "security" as const,
  severity: "high" as const,
  title: "Authentication behavior lacks a guard",
  description: "The authentication setting is unconditional.",
  reasoningSummary: "The setting is assigned a constant true value.",
  affectedFiles: [filePath],
  evidence: [{
    filePath,
    startLine: 1,
    endLine: 1,
    quote,
    explanation: "This value cannot be disabled by configuration."
  }],
  recommendation: "Use a validated configuration value.",
  confidence: 0.9,
  status: "open" as const
});

beforeAll(async () => {
  database = await MongoMemoryServer.create();
  await mongoose.connect(database.getUri());
});

afterEach(async () => {
  await Promise.all([
    AnalysisRun.deleteMany({}),
    EngineeringIssue.deleteMany({}),
    EngineeringReport.deleteMany({}),
    Mission.deleteMany({}),
    ProjectFile.deleteMany({}),
    Project.deleteMany({}),
    User.deleteMany({})
  ]);
  vi.mocked(generateText).mockReset();
});

afterAll(async () => {
  await mongoose.disconnect();
  await database.stop();
});

const createOwnerProject = async () => {
  const { user, token } = await authService.register({
    name: "Report Owner",
    email: `report-${crypto.randomUUID()}@example.com`,
    password: "correct-horse-battery"
  });
  const project = await Project.create({
    ownerId: user.id,
    name: "Report Project",
    activeGeneration: 1,
    indexingStatus: "ready"
  });
  return { user, token, project };
};

const addIndexedFile = (ownerId: string, projectId: string, filePath = "src/auth.ts", content = "export const authEnabled = true;") =>
  ProjectFile.create({
    ownerId,
    projectId,
    generation: 1,
    fileId: `file-${filePath}`,
    filePath,
    content,
    language: "typescript",
    category: "other",
    lineCount: content.split(/\r?\n/).length,
    sizeBytes: Buffer.byteLength(content),
    contentHash: "hash",
    imports: [],
    symbols: []
  });

const addRun = (ownerId: string, projectId: string, selectedAgents = ["security"]) =>
  AnalysisRun.create({
    runId: "run-security",
    ownerId,
    projectId,
    goal: "Review security.",
    status: "completed",
    selectedAgents,
    summaries: {},
    report: {},
    activities: [],
    failures: [],
    issueCount: 1,
    durationMs: 100,
    model: "test-model"
  });

const setNarrative = () => {
  vi.mocked(generateText).mockResolvedValue(
    JSON.stringify({ executiveSummary: "The investigation identified an authentication configuration concern requiring review." })
  );
};

describe("engineering reports", () => {
  it("generates a project-scoped report with validated evidence, deterministic counts, and idempotent retry", async () => {
    const { user, token, project } = await createOwnerProject();
    await addRun(user.id, String(project._id));
    await addIndexedFile(user.id, String(project._id));
    await EngineeringIssue.create({
      ...finding("finding-security-1"),
      ownerId: user.id,
      projectId: project._id
    });
    setNarrative();

    const first = await request(app)
      .post(`/api/projects/${project.id}/reports`)
      .set("Cookie", `nexus_token=${token}`)
      .send({ reportType: "security_audit" })
      .expect(201);
    expect(first.body.data.report).toMatchObject({
      status: "complete",
      severityCounts: { high: 1, critical: 0 },
      categoryCounts: { security: 1 },
      findingRefs: [{ findingId: "finding-security-1", runId: "run-security", source: "issue" }]
    });

    const reportId = first.body.data.report.reportId as string;
    const detail = await request(app)
      .get(`/api/projects/${project.id}/reports/${reportId}`)
      .set("Cookie", `nexus_token=${token}`)
      .expect(200);
    expect(detail.body.data.report.findings).toHaveLength(1);
    expect(detail.body.data.report.findings[0]).toMatchObject({
      verification: "confirmed",
      source: "issue",
      evidence: [{ filePath: "src/auth.ts", startLine: 1, endLine: 1 }]
    });

    const retry = await request(app)
      .post(`/api/projects/${project.id}/reports`)
      .set("Cookie", `nexus_token=${token}`)
      .send({ reportType: "security_audit" })
      .expect(201);
    expect(retry.body.data.report.reportId).toBe(reportId);
    expect(await EngineeringReport.countDocuments({ projectId: project._id })).toBe(1);
  });

  it("keeps stale evidence unverified and excludes it from counts", async () => {
    const { user, token, project } = await createOwnerProject();
    await addRun(user.id, String(project._id));
    await addIndexedFile(user.id, String(project._id), "src/auth.ts", "export const authEnabled = false;");
    await EngineeringIssue.create({
      ...finding("finding-stale"),
      ownerId: user.id,
      projectId: project._id
    });
    setNarrative();

    const response = await request(app)
      .post(`/api/projects/${project.id}/reports`)
      .set("Cookie", `nexus_token=${token}`)
      .send({ reportType: "security_audit" })
      .expect(201);
    expect(response.body.data.report.status).toBe("partial");
    expect(response.body.data.report.findingRefs).toEqual([]);
    expect(response.body.data.report.unverifiedFindingRefs).toEqual([
      { findingId: "finding-stale", runId: "run-security", source: "issue" }
    ]);
    expect(response.body.data.report.severityCounts.high).toBe(0);
    expect(response.body.data.report.limitations.join(" ")).toMatch(/unverified/i);
  });

  it("reports zero findings without implying the project is issue-free", async () => {
    const { user, token, project } = await createOwnerProject();
    await addRun(user.id, String(project._id));

    const response = await request(app)
      .post(`/api/projects/${project.id}/reports`)
      .set("Cookie", `nexus_token=${token}`)
      .send({ reportType: "security_audit" })
      .expect(201);
    expect(response.body.data.report).toMatchObject({
      status: "complete",
      findingRefs: [],
      severityCounts: { critical: 0, high: 0, medium: 0, low: 0, suggestion: 0 }
    });
    expect(response.body.data.report.summary).toContain("does not mean the project is issue-free");
    expect(generateText).not.toHaveBeenCalled();
  });

  it("marks reports partial when selected analysis runs contain agent failures", async () => {
    const { user, token, project } = await createOwnerProject();
    await AnalysisRun.create({
      runId: "run-security",
      ownerId: user.id,
      projectId: project._id,
      goal: "Review security.",
      status: "partial",
      selectedAgents: ["security"],
      summaries: {},
      report: {},
      activities: [],
      failures: [{ agent: "security", code: "AGENT_FAILED", message: "Specialist failed." }],
      issueCount: 1,
      durationMs: 100,
      model: "test-model"
    });
    await addIndexedFile(user.id, String(project._id));
    await EngineeringIssue.create({
      ...finding("finding-partial"),
      ownerId: user.id,
      projectId: project._id
    });
    setNarrative();

    const response = await request(app)
      .post(`/api/projects/${project.id}/reports`)
      .set("Cookie", `nexus_token=${token}`)
      .send({ reportType: "security_audit" })
      .expect(201);
    expect(response.body.data.report.status).toBe("partial");
    expect(response.body.data.report.findingRefs).toHaveLength(1);
    expect(response.body.data.report.limitations.join(" ")).toMatch(/partial|failure/i);
  });

  it("authorizes project and mission reports against the exact owner and mission scope", async () => {
    const owner = await createOwnerProject();
    const otherOwner = await createOwnerProject();
    const mission = await Mission.create({
      projectId: owner.project._id,
      userId: owner.user.id,
      goal: "Review authentication",
      status: "COMPLETED",
      findings: [{
        ...finding("mission-finding-1"),
        createdAt: new Date().toISOString()
      }],
      tasks: [],
      progress: { percent: 100, currentStep: "Completed", events: [] }
    });
    await addIndexedFile(owner.user.id, String(owner.project._id));
    setNarrative();

    const forbidden = await request(app)
      .get(`/api/projects/${owner.project.id}/missions/${mission.id}/report`)
      .set("Cookie", `nexus_token=${otherOwner.token}`)
      .expect(404);
    expect(forbidden.body.error.code).toBe("PROJECT_NOT_FOUND");

    const generated = await request(app)
      .post(`/api/projects/${owner.project.id}/missions/${mission.id}/report`)
      .set("Cookie", `nexus_token=${owner.token}`)
      .send({})
      .expect(201);
    expect(generated.body.data.report).toMatchObject({
      reportType: "mission",
      missionId: mission.id,
      findingRefs: [{ findingId: "mission-finding-1", runId: "run-security", source: "mission" }]
    });

    await expect(request(app)
      .get(`/api/projects/${otherOwner.project.id}/reports/${generated.body.data.report.reportId}`)
      .set("Cookie", `nexus_token=${otherOwner.token}`))
      .resolves.toMatchObject({ status: 404 });
  });

  it("returns an explicit partial report when model narrative data is invalid", async () => {
    const { user, token, project } = await createOwnerProject();
    await addRun(user.id, String(project._id));
    await addIndexedFile(user.id, String(project._id));
    await EngineeringIssue.create({
      ...finding("finding-invalid-model"),
      ownerId: user.id,
      projectId: project._id
    });
    vi.mocked(generateText).mockResolvedValue("not valid report JSON");

    const response = await request(app)
      .post(`/api/projects/${project.id}/reports`)
      .set("Cookie", `nexus_token=${token}`)
      .send({ reportType: "security_audit" })
      .expect(201);
    expect(response.body.data.report.status).toBe("partial");
    expect(response.body.data.report.generation.narrativeStatus).toBe("fallback");
    expect(response.body.data.report.summary).toContain("evidence-validated finding");
    expect(response.body.data.report.limitations).toContain(
      "Narrative summary generation failed; a deterministic summary is shown."
    );
  });

  it("calculates a documented score only with complete category coverage", () => {
    const incomplete = calculateHealthScore([], new Set(["security"]));
    expect(incomplete.status).toBe("insufficient_data");
    expect(incomplete.value).toBeNull();

    const fullCoverage = calculateHealthScore([], new Set([
      "security",
      "code_quality",
      "performance",
      "testing",
      "documentation"
    ]));
    expect(fullCoverage).toMatchObject({ status: "calculated", value: 100 });
    expect(fullCoverage.formula).toContain("security 30%");
    const securityFinding = { ...finding("score-finding"), source: "issue" as const };
    expect(calculateHealthScore([securityFinding], new Set([
      "security",
      "code_quality",
      "performance",
      "testing",
      "documentation"
    ])).value).toBe(93);
  });

  it("exports report data to Markdown and JSON without losing evidence or unverified status", () => {
    const report: EngineeringReportData = {
      reportId: "report-1",
      projectId: "project-1",
      userId: "user-1",
      reportType: "security_audit",
      title: "Security audit",
      summary: "One authentication concern requires review.",
      status: "partial",
      findingRefs: [{ findingId: "confirmed-1", runId: "run-security", source: "issue" }],
      unverifiedFindingRefs: [{ findingId: "unverified-1", runId: "run-security", source: "issue" }],
      findings: [
        {
          ...finding("confirmed-1"),
          verification: "confirmed",
          source: "issue",
          createdAt: "2025-01-01T00:00:00.000Z"
        },
        {
          ...finding("unverified-1"),
          verification: "unverified",
          source: "issue",
          createdAt: "2025-01-01T00:00:00.000Z"
        }
      ],
      severityCounts: { high: 1 },
      categoryCounts: { security: 1 },
      sections: [{ category: "security", summary: "1 evidence-validated finding(s).", findingIds: ["confirmed-1"] }],
      affectedFiles: [{ filePath: "src/auth.ts", findingIds: ["confirmed-1"] }],
      recommendations: [{
        findingId: "confirmed-1",
        title: "Authentication behavior lacks a guard",
        action: "Use a validated configuration value.",
        category: "security",
        severity: "high",
        affectedFiles: ["src/auth.ts"]
      }],
      limitations: ["One finding could not be verified against current source."],
      healthScore: {
        status: "insufficient_data",
        value: null,
        formula: "Complete all category assessments.",
        rationale: "Insufficient data."
      },
      generation: {
        sourceFingerprint: "fingerprint",
        sourceRunIds: ["run-security"],
        indexedGeneration: 1,
        model: "test-model",
        narrativeStatus: "generated",
        generatedAt: "2025-01-01T00:00:00.000Z"
      },
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z"
    };

    const markdown = reportToMarkdown(report);
    expect(markdown).toContain("## Confirmed findings");
    expect(markdown).toContain("`src/auth.ts:1-1`");
    expect(markdown).toContain("## Unverified suggestions");
    expect(markdown).toContain("Insufficient data");
    expect(JSON.parse(reportToJson(report))).toMatchObject({
      reportId: "report-1",
      findingRefs: [{ findingId: "confirmed-1", runId: "run-security", source: "issue" }],
      unverifiedFindingRefs: [{ findingId: "unverified-1", runId: "run-security", source: "issue" }]
    });
  });

  it("paginates reports and returns a large source-backed finding set without truncation", async () => {
    const { user, token, project } = await createOwnerProject();
    await addRun(user.id, String(project._id));
    const fileDocuments = Array.from({ length: 60 }, (_, index) => {
      const filePath = `src/module-${index}.ts`;
      return {
        ownerId: user.id,
        projectId: String(project._id),
        generation: 1,
        fileId: `file-${index}`,
        filePath,
        content: `export const module${index} = true;`,
        language: "typescript",
        category: "other",
        lineCount: 1,
        sizeBytes: 30,
        contentHash: `hash-${index}`,
        imports: [],
        symbols: []
      };
    });
    await ProjectFile.insertMany(fileDocuments);
    await EngineeringIssue.insertMany(fileDocuments.map((file, index) => ({
      ...finding(`finding-${index}`, file.filePath, file.content),
      ownerId: user.id,
      projectId: project._id
    })));
    setNarrative();

    const first = await request(app)
      .post(`/api/projects/${project.id}/reports`)
      .set("Cookie", `nexus_token=${token}`)
      .send({ reportType: "security_audit" })
      .expect(201);
    const reportId = first.body.data.report.reportId as string;
    const details = await request(app)
      .get(`/api/projects/${project.id}/reports/${reportId}`)
      .set("Cookie", `nexus_token=${token}`)
      .expect(200);
    expect(details.body.data.report.findings).toHaveLength(60);

    const paged = await request(app)
      .get(`/api/projects/${project.id}/reports`)
      .query({ page: 1, pageSize: 1, reportType: "security_audit" })
      .set("Cookie", `nexus_token=${token}`)
      .expect(200);
    expect(paged.body.data).toMatchObject({ page: 1, pageSize: 1, total: 1 });
    expect(paged.body.data.reports).toHaveLength(1);
  });
});
