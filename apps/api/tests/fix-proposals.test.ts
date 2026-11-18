import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { createTwoFilesPatch } from "diff";
import { createApp } from "../src/app.js";
import { EngineeringIssue } from "../src/models/engineering-issue.model.js";
import { FixProposal } from "../src/models/fix-proposal.model.js";
import { Mission } from "../src/models/mission.model.js";
import { Project } from "../src/models/project.model.js";
import { ProjectFile } from "../src/models/project-file.model.js";
import { User } from "../src/models/user.model.js";
import { authService } from "../src/services/auth.service.js";
import { generateText } from "../src/services/ai.service.js";
import { retrieveProjectContext } from "../src/services/vector-retriever.service.js";
import { AppError } from "../src/utils/app-error.js";

vi.mock("../src/services/ai.service.js", () => ({
  generateText: vi.fn()
}));
vi.mock("../src/services/vector-retriever.service.js", () => ({
  retrieveProjectContext: vi.fn()
}));

const app = createApp();
let database: MongoMemoryServer;
const source = "export function parseQuantity(value: string) {\n  return Number(value);\n}\n";
const corrected = "export function parseQuantity(value: string) {\n  const quantity = Number(value);\n  if (!Number.isFinite(quantity) || quantity < 1) {\n    throw new Error(\"Quantity must be a positive number\");\n  }\n  return quantity;\n}\n";
const findingData = {
  issueId: "finding-validation-1",
  runId: "analysis-validation-1",
  agent: "code_quality" as const,
  category: "code_quality" as const,
  severity: "medium" as const,
  title: "Input quantity is not validated",
  description: "The function converts user input but accepts invalid quantities.",
  reasoningSummary: "There is no check for non-finite or non-positive values.",
  affectedFiles: ["src/quantity.ts"],
  evidence: [{
    filePath: "src/quantity.ts",
    startLine: 2,
    endLine: 2,
    quote: "  return Number(value);",
    explanation: "The input is converted and returned without validation."
  }],
  recommendation: "Validate the parsed quantity before returning it.",
  confidence: 0.9,
  status: "open" as const
};
const validOutput = {
  rootCause: "The function returns the numeric conversion without checking whether the value is finite or positive.",
  explanation: "The proposal validates the parsed number and rejects values outside the accepted quantity range before returning it.",
  sideEffects: ["Callers may need to handle the validation error for invalid values."],
  assumptions: ["Quantities are expected to be positive finite numbers."],
  changes: [{ filePath: "src/quantity.ts", proposedContent: corrected }]
};

beforeAll(async () => {
  database = await MongoMemoryServer.create();
  await mongoose.connect(database.getUri());
});

afterEach(async () => {
  await Promise.all([
    EngineeringIssue.deleteMany({}),
    Mission.deleteMany({}),
    FixProposal.deleteMany({}),
    ProjectFile.deleteMany({}),
    Project.deleteMany({}),
    User.deleteMany({})
  ]);
  vi.mocked(generateText).mockReset();
  vi.mocked(retrieveProjectContext).mockReset();
});

afterAll(async () => {
  await mongoose.disconnect();
  await database.stop();
});

const createOwnerProject = async () => {
  const { user, token } = await authService.register({
    name: "Fix Owner",
    email: `fix-${crypto.randomUUID()}@example.com`,
    password: "correct-horse-battery"
  });
  const project = await Project.create({
    ownerId: user.id,
    name: "Fix Project",
    activeGeneration: 1,
    indexingStatus: "ready"
  });
  await ProjectFile.create({
    ownerId: user.id,
    projectId: String(project._id),
    generation: 1,
    fileId: "file-quantity",
    filePath: "src/quantity.ts",
    content: source,
    language: "typescript",
    category: "service",
    lineCount: 3,
    sizeBytes: Buffer.byteLength(source),
    contentHash: createHash("sha256").update(source).digest("hex"),
    imports: [],
    symbols: ["parseQuantity"]
  });
  await EngineeringIssue.create({
    ...findingData,
    ownerId: user.id,
    projectId: project._id
  });
  vi.mocked(retrieveProjectContext).mockResolvedValue([{
    id: "chunk-1",
    fileId: "file-quantity",
    chunkId: "chunk-1",
    filePath: "src/quantity.ts",
    language: "typescript",
    symbolContext: "parseQuantity",
    startLine: 1,
    endLine: 3,
    content: source,
    score: 0.91
  }]);
  return { user, token, project };
};

const setGeneratedOutput = () =>
  vi.mocked(generateText).mockResolvedValue(JSON.stringify(validOutput));

const generateRequest = (token: string, projectId: string) =>
  request(app)
    .post(`/api/projects/${projectId}/fix-proposals`)
    .set("Cookie", `nexus_token=${token}`)
    .send({ findingId: findingData.issueId, runId: findingData.runId });

describe("fix proposal APIs", () => {
  it("generates a round-trippable patch while leaving the indexed source unchanged", async () => {
    const { user, token, project } = await createOwnerProject();
    setGeneratedOutput();

    const generated = await generateRequest(token, project.id);
    expect(generated.status, JSON.stringify(generated.body)).toBe(201);
    const proposal = generated.body.data.proposal;
    expect(proposal).toMatchObject({
      status: "AWAITING_APPROVAL",
      validationStatus: "VALID",
      approvalStatus: "PENDING",
      applicationResult: { status: "NOT_SUPPORTED" },
      findingId: findingData.issueId,
      changes: [{
        filePath: "src/quantity.ts",
        originalContent: source,
        proposedContent: corrected
      }]
    });
    expect(proposal.changes[0].patch).toContain("@@");
    expect(proposal.validationMessage).toContain("Tests were not run");
    expect(String(proposal.userId)).toBe(user.id);
    expect((await ProjectFile.findOne({ filePath: "src/quantity.ts", projectId: project._id }))?.content).toBe(source);

    const diff = await request(app)
      .get(`/api/projects/${project.id}/fix-proposals/${proposal.proposalId}/diff`)
      .set("Cookie", `nexus_token=${token}`)
      .expect(200);
    expect(diff.body.data.files[0]).toMatchObject({
      filePath: "src/quantity.ts",
      originalHash: proposal.changes[0].originalHash,
      proposedHash: proposal.changes[0].proposedHash
    });
    expect(diff.body.data.files[0].patch).toContain("+  const quantity");

    const decision = await request(app)
      .post(`/api/projects/${project.id}/fix-proposals/${proposal.proposalId}/decision`)
      .set("Cookie", `nexus_token=${token}`)
      .send({ decision: "approved" })
      .expect(200);
    expect(decision.body.data.proposal.status).toBe("APPROVED");
    expect(decision.body.data.proposal.decision).toMatchObject({
      status: "APPROVED",
      userId: user.id
    });
    expect(decision.body.data.proposal.auditTrail.map((event: { action: string }) => event.action))
      .toContain("APPROVED");
    expect((await ProjectFile.findOne({ filePath: "src/quantity.ts", projectId: project._id }))?.content).toBe(source);

    const application = await request(app)
      .post(`/api/projects/${project.id}/fix-proposals/${proposal.proposalId}/apply`)
      .set("Cookie", `nexus_token=${token}`)
      .send({})
      .expect(409);
    expect(application.body.error.code).toBe("REPOSITORY_WRITE_UNAVAILABLE");
    const stored = await FixProposal.findOne({ proposalId: proposal.proposalId }).lean();
    expect(stored?.applicationResult).toMatchObject({
      status: "NOT_SUPPORTED",
      filesApplied: [],
      filesNotApplied: ["src/quantity.ts"],
      rollbackStatus: "NOT_AVAILABLE"
    });
    expect(stored?.auditTrail.map((event) => event.action)).toContain("APPLICATION_UNAVAILABLE");
    expect((await ProjectFile.findOne({ filePath: "src/quantity.ts", projectId: project._id }))?.content).toBe(source);
    const duplicateApplication = await request(app)
      .post(`/api/projects/${project.id}/fix-proposals/${proposal.proposalId}/apply`)
      .set("Cookie", `nexus_token=${token}`)
      .send({})
      .expect(409);
    expect(duplicateApplication.body.error.code).toBe("FIX_PROPOSAL_APPLICATION_ATTEMPTED");
  });

  it("records review and rejection details and prevents repeat or racing decisions", async () => {
    const { user, token, project } = await createOwnerProject();
    setGeneratedOutput();
    const generated = await generateRequest(token, project.id).expect(201);
    const proposalId = generated.body.data.proposal.proposalId as string;
    await request(app)
      .post(`/api/projects/${project.id}/fix-proposals/${proposalId}/reviewed`)
      .set("Cookie", `nexus_token=${token}`)
      .send({})
      .expect(200);
    const decisions = await Promise.all([
      request(app)
        .post(`/api/projects/${project.id}/fix-proposals/${proposalId}/decision`)
        .set("Cookie", `nexus_token=${token}`)
        .send({ decision: "approved" }),
      request(app)
        .post(`/api/projects/${project.id}/fix-proposals/${proposalId}/decision`)
        .set("Cookie", `nexus_token=${token}`)
        .send({ decision: "rejected", rejectionReason: "Needs a narrower behavior change." })
    ]);
    expect(decisions.map((response) => response.status).sort()).toEqual([200, 409]);
    const stored = await FixProposal.findOne({ proposalId }).lean();
    expect(stored?.decision?.userId?.toString()).toBe(user.id);
    expect(stored?.auditTrail.filter((event) => ["APPROVED", "REJECTED"].includes(event.action))).toHaveLength(1);
    await request(app)
      .post(`/api/projects/${project.id}/fix-proposals/${proposalId}/decision`)
      .set("Cookie", `nexus_token=${token}`)
      .send({ decision: "rejected" })
      .expect(409);
  });

  it("records a rejection reason and prevents applying rejected proposals", async () => {
    const { user, token, project } = await createOwnerProject();
    setGeneratedOutput();
    const generated = await generateRequest(token, project.id).expect(201);
    const proposalId = generated.body.data.proposal.proposalId as string;
    const rejected = await request(app)
      .post(`/api/projects/${project.id}/fix-proposals/${proposalId}/decision`)
      .set("Cookie", `nexus_token=${token}`)
      .send({ decision: "rejected", rejectionReason: "The behavior change is too broad." })
      .expect(200);
    expect(rejected.body.data.proposal).toMatchObject({
      status: "REJECTED",
      approvalStatus: "REJECTED",
      decision: {
        status: "REJECTED",
        userId: user.id,
        rejectionReason: "The behavior change is too broad."
      }
    });
    await request(app)
      .post(`/api/projects/${project.id}/fix-proposals/${proposalId}/apply`)
      .set("Cookie", `nexus_token=${token}`)
      .send({})
      .expect(409);
    expect((await ProjectFile.findOne({ projectId: project._id, filePath: "src/quantity.ts" }))?.content).toBe(source);
  });

  it("does not allow another project user to review or apply an owner's proposal", async () => {
    const { token, project } = await createOwnerProject();
    setGeneratedOutput();
    const generated = await generateRequest(token, project.id).expect(201);
    const proposalId = generated.body.data.proposal.proposalId as string;
    const otherOwner = await authService.register({
      name: "Other Owner",
      email: `other-review-${crypto.randomUUID()}@example.com`,
      password: "correct-horse-battery"
    });
    await request(app)
      .post(`/api/projects/${project.id}/fix-proposals/${proposalId}/decision`)
      .set("Cookie", `nexus_token=${otherOwner.token}`)
      .send({ decision: "approved" })
      .expect(404);
    await request(app)
      .post(`/api/projects/${project.id}/fix-proposals/${proposalId}/apply`)
      .set("Cookie", `nexus_token=${otherOwner.token}`)
      .send({})
      .expect(404);
    expect((await FixProposal.findOne({ proposalId }).lean())?.status).toBe("AWAITING_APPROVAL");
  });

  it("refuses multi-file application without modifying either indexed source file", async () => {
    const { user, token, project } = await createOwnerProject();
    const secondOriginal = "export const mode = \"old\";\n";
    const secondProposed = "export const mode = \"safe\";\n";
    await ProjectFile.create({
      ownerId: user.id,
      projectId: String(project._id),
      generation: 1,
      fileId: "file-mode",
      filePath: "src/mode.ts",
      content: secondOriginal,
      language: "typescript",
      category: "service",
      lineCount: 1,
      sizeBytes: Buffer.byteLength(secondOriginal),
      contentHash: createHash("sha256").update(secondOriginal).digest("hex"),
      imports: [],
      symbols: ["mode"]
    });
    await EngineeringIssue.updateOne(
      { projectId: project._id, issueId: findingData.issueId },
      {
        $set: {
          affectedFiles: ["src/quantity.ts", "src/mode.ts"],
          evidence: [...findingData.evidence, {
            filePath: "src/mode.ts",
            startLine: 1,
            endLine: 1,
            quote: "export const mode = \"old\";",
            explanation: "This value is part of the affected implementation."
          }]
        }
      }
    );
    vi.mocked(generateText).mockResolvedValue(JSON.stringify({
      ...validOutput,
      changes: [
        validOutput.changes[0],
        { filePath: "src/mode.ts", proposedContent: secondProposed }
      ]
    }));
    const generated = await generateRequest(token, project.id).expect(201);
    const proposalId = generated.body.data.proposal.proposalId as string;
    await request(app)
      .post(`/api/projects/${project.id}/fix-proposals/${proposalId}/decision`)
      .set("Cookie", `nexus_token=${token}`)
      .send({ decision: "approved" })
      .expect(200);
    const application = await request(app)
      .post(`/api/projects/${project.id}/fix-proposals/${proposalId}/apply`)
      .set("Cookie", `nexus_token=${token}`)
      .send({})
      .expect(409);
    expect(application.body.error.code).toBe("REPOSITORY_WRITE_UNAVAILABLE");
    const stored = await FixProposal.findOne({ proposalId }).lean();
    expect(stored?.applicationResult?.filesNotApplied.sort()).toEqual(["src/mode.ts", "src/quantity.ts"]);
    expect(await ProjectFile.findOne({ projectId: project._id, filePath: "src/quantity.ts" }).then((file) => file?.content)).toBe(source);
    expect(await ProjectFile.findOne({ projectId: project._id, filePath: "src/mode.ts" }).then((file) => file?.content)).toBe(secondOriginal);
  });

  it("rejects malformed, traversal, unexpected, duplicate, merge-conflicted, and oversized changes", async () => {
    const cases: Array<{
      label: string;
      output: unknown;
      code: string;
      status: number;
    }> = [
      { label: "malformed output", output: "{bad json", code: "INVALID_FIX_RESPONSE", status: 502 },
      {
        label: "traversal path",
        output: { ...validOutput, changes: [{ ...validOutput.changes[0], filePath: "../src/quantity.ts" }] },
        code: "INVALID_FIX_PATH",
        status: 400
      },
      {
        label: "unexpected file",
        output: { ...validOutput, changes: [{ ...validOutput.changes[0], filePath: "src/other.ts" }] },
        code: "UNEXPECTED_FIX_FILE",
        status: 422
      },
      {
        label: "duplicate changes",
        output: { ...validOutput, changes: [validOutput.changes[0], validOutput.changes[0]] },
        code: "DUPLICATE_FIX_CHANGE",
        status: 422
      },
      {
        label: "merge markers",
        output: { ...validOutput, changes: [{ ...validOutput.changes[0], proposedContent: "<<<<<<< ours\n=======\n>>>>>>> theirs\n" }] },
        code: "INVALID_FIX_PATCH",
        status: 422
      },
      {
        label: "secret-like content",
        output: { ...validOutput, changes: [{ ...validOutput.changes[0], proposedContent: "export const API_KEY = \"abcdefghijklmnop\";\n" }] },
        code: "FIX_SECRET_CONTENT_REJECTED",
        status: 422
      },
      {
        label: "unverified test claim",
        output: { ...validOutput, explanation: "The updated test suite passed and confirms this implementation is correct." },
        code: "UNVERIFIED_TEST_CLAIM",
        status: 422
      },
      {
        label: "large patch",
        output: { ...validOutput, changes: [{ ...validOutput.changes[0], proposedContent: "x".repeat(49_000) }] },
        code: "FIX_FILE_TOO_LARGE",
        status: 413
      }
    ];

    for (const testCase of cases) {
      const { token, project } = await createOwnerProject();
      vi.mocked(generateText).mockResolvedValue(typeof testCase.output === "string"
        ? testCase.output
        : JSON.stringify(testCase.output));
      const response = await generateRequest(token, project.id).expect(testCase.status);
      expect(response.body.error.code, testCase.label).toBe(testCase.code);
      await User.deleteMany({});
      await Project.deleteMany({});
      await ProjectFile.deleteMany({});
      await EngineeringIssue.deleteMany({});
      await FixProposal.deleteMany({});
    }
  });

  it("rejects unsafe extensions, secrets, and empty missing code context", async () => {
    const { token, project } = await createOwnerProject();
    vi.mocked(generateText).mockResolvedValue(JSON.stringify({
      ...validOutput,
      changes: [{ filePath: ".env", proposedContent: "API_KEY=not-a-safe-file" }]
    }));
    const unsafe = await generateRequest(token, project.id).expect(400);
    expect(unsafe.body.error.code).toBe("INVALID_FIX_PATH");

    vi.mocked(retrieveProjectContext).mockResolvedValue([]);
    const noContext = await generateRequest(token, project.id).expect(422);
    expect(noContext.body.error.code).toBe("FIX_CONTEXT_INSUFFICIENT");
    expect(generateText).toHaveBeenCalledTimes(1);
    const failed = await FixProposal.findOne({ projectId: project._id }).sort({ createdAt: -1 }).lean();
    expect(failed?.status).toBe("VALIDATION_FAILED");
  });

  it("marks a proposal stale after the project is reindexed and blocks approval", async () => {
    const { token, user, project } = await createOwnerProject();
    setGeneratedOutput();
    const generated = await generateRequest(token, project.id).expect(201);
    const proposalId = generated.body.data.proposal.proposalId as string;
    await ProjectFile.create({
      ownerId: user.id,
      projectId: String(project._id),
      generation: 2,
      fileId: "file-quantity-v2",
      filePath: "src/quantity.ts",
      content: "export function parseQuantity(value: string) { return 7; }\n",
      language: "typescript",
      category: "service",
      lineCount: 1,
      sizeBytes: 60,
      contentHash: "changed-hash",
      imports: [],
      symbols: ["parseQuantity"]
    });
    await Project.updateOne({ _id: project._id }, { $set: { activeGeneration: 2 } });

    const validated = await request(app)
      .post(`/api/projects/${project.id}/fix-proposals/${proposalId}/validate`)
      .set("Cookie", `nexus_token=${token}`)
      .send({})
      .expect(200);
    expect(validated.body.data.proposal).toMatchObject({
      status: "VALIDATION_FAILED",
      validationStatus: "STALE"
    });
    await request(app)
      .post(`/api/projects/${project.id}/fix-proposals/${proposalId}/decision`)
      .set("Cookie", `nexus_token=${token}`)
      .send({ decision: "approved" })
      .expect(409);
  });

  it("records provider failures and returns no success-shaped patch", async () => {
    const { token, project } = await createOwnerProject();
    vi.mocked(generateText).mockRejectedValue(new AppError(503, "Model unavailable", "AI_GENERATION_FAILED"));
    const response = await generateRequest(token, project.id).expect(503);
    expect(response.body.error.code).toBe("AI_GENERATION_FAILED");
    const stored = await FixProposal.findOne({ projectId: project._id }).lean();
    expect(stored).toMatchObject({
      status: "VALIDATION_FAILED",
      validationStatus: "FAILED",
      failureCode: "AI_GENERATION_FAILED",
      changes: []
    });
  });

  it("generates mission-associated proposals from the exact project mission finding", async () => {
    const { user, token, project } = await createOwnerProject();
    const mission = await Mission.create({
      projectId: project._id,
      userId: user.id,
      goal: "Improve input validation",
      status: "COMPLETED",
      findings: [{ ...findingData, createdAt: new Date().toISOString() }],
      tasks: [],
      progress: { percent: 100, currentStep: "Completed", events: [] }
    });
    setGeneratedOutput();

    const response = await request(app)
      .post(`/api/projects/${project.id}/fix-proposals`)
      .set("Cookie", `nexus_token=${token}`)
      .send({
        findingId: findingData.issueId,
        runId: findingData.runId,
        missionId: String(mission._id)
      })
      .expect(201);
    expect(response.body.data.proposal).toMatchObject({
      missionId: String(mission._id),
      findingId: findingData.issueId,
      status: "AWAITING_APPROVAL"
    });
  });

  it("enforces owner isolation, lists metadata, and serializes concurrent generation", async () => {
    const { token, project } = await createOwnerProject();
    const otherOwner = await authService.register({
      name: "Other Owner",
      email: `other-${crypto.randomUUID()}@example.com`,
      password: "correct-horse-battery"
    });
    await request(app)
      .post(`/api/projects/${project.id}/fix-proposals`)
      .set("Cookie", `nexus_token=${otherOwner.token}`)
      .send({ findingId: findingData.issueId, runId: findingData.runId })
      .expect(404);
    await request(app)
      .get(`/api/projects/${project.id}/fix-proposals`)
      .expect(401);

    let releaseGeneration: (() => void) | undefined;
    const waitForGeneration = new Promise<void>((resolve) => { releaseGeneration = resolve; });
    vi.mocked(generateText).mockImplementation(async () => {
      await waitForGeneration;
      return JSON.stringify(validOutput);
    });
    const firstResponsePromise = generateRequest(token, project.id).then((response) => response);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (await FixProposal.exists({ projectId: project._id, status: "GENERATING" })) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const duplicate = await generateRequest(token, project.id).expect(202);
    expect(duplicate.body.data.proposal.status).toBe("GENERATING");
    releaseGeneration?.();
    const firstResponse = await firstResponsePromise;
    expect(firstResponse.status).toBe(201);

    const list = await request(app)
      .get(`/api/projects/${project.id}/fix-proposals`)
      .set("Cookie", `nexus_token=${token}`)
      .expect(200);
    expect(list.body.data.proposals[0].changes[0]).not.toHaveProperty("originalContent");
    expect(list.body.data.total).toBe(1);
  });
});
