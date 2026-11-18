import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { createApp } from "../src/app.js";
import { FixProposal } from "../src/models/fix-proposal.model.js";
import { Project } from "../src/models/project.model.js";
import { User } from "../src/models/user.model.js";
import { VerificationRun } from "../src/models/verification-run.model.js";
import { authService } from "../src/services/auth.service.js";
import {
  classifyVerificationResults,
  sanitizeOutputSummary
} from "../src/services/verification.service.js";

const app = createApp();
let database: MongoMemoryServer;

beforeAll(async () => {
  database = await MongoMemoryServer.create();
  await mongoose.connect(database.getUri());
});

afterEach(async () => {
  await Promise.all([
    VerificationRun.deleteMany({}),
    FixProposal.deleteMany({}),
    Project.deleteMany({}),
    User.deleteMany({})
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await database.stop();
});

const createContext = async () => {
  const { user, token } = await authService.register({
    name: "Verification Owner",
    email: `verify-${crypto.randomUUID()}@example.com`,
    password: "correct-horse-battery"
  });
  const project = await Project.create({
    ownerId: user.id,
    name: "Verification Project",
    activeGeneration: 1,
    indexingStatus: "ready"
  });
  const proposal = await FixProposal.create({
    proposalId: crypto.randomUUID(),
    findingKey: "issue:run:finding",
    projectId: project._id,
    userId: user.id,
    findingId: "finding",
    runId: "run",
    finding: {
      title: "Test finding",
      category: "code_quality",
      severity: "low",
      description: "Test description",
      recommendation: "Test recommendation",
      evidence: []
    },
    targetGeneration: 1,
    targetRevision: "indexed-revision",
    changes: [],
    status: "APPROVED",
    validationStatus: "VALID",
    approvalStatus: "APPROVED",
    applicationResult: {
      status: "NOT_SUPPORTED",
      filesApplied: [],
      filesNotApplied: [],
      rollbackStatus: "NOT_AVAILABLE"
    }
  });
  return { user, token, project, proposal };
};

const allPassing = [
  { checkId: "test", status: "PASSED" as const, exitCode: 0 },
  { checkId: "lint", status: "PASSED" as const, exitCode: 0 },
  { checkId: "build", status: "PASSED" as const, exitCode: 0 }
];

describe("verification result classification", () => {
  it("passes only when every required check has a zero exit code", () => {
    expect(classifyVerificationResults(allPassing)).toBe("PASSED");
    expect(classifyVerificationResults([
      ...allPassing.slice(0, 2),
      { checkId: "build", status: "PASSED", exitCode: 1 }
    ])).toBe("FAILED");
  });

  it("classifies failures, missing checks, timeouts, cancellations, and no work deterministically", () => {
    expect(classifyVerificationResults([
      { checkId: "test", status: "FAILED", exitCode: 1 }
    ])).toBe("FAILED");
    expect(classifyVerificationResults([
      ...allPassing.slice(0, 2),
      { checkId: "build", status: "SKIPPED" }
    ])).toBe("PARTIAL");
    expect(classifyVerificationResults([])).toBe("PARTIAL");
    expect(classifyVerificationResults([
      { checkId: "test", status: "TIMED_OUT" }
    ])).toBe("TIMED_OUT");
    expect(classifyVerificationResults([
      { checkId: "test", status: "CANCELLED" }
    ])).toBe("CANCELLED");
  });

  it("strips terminal control sequences, redacts credentials, and caps stored output", () => {
    const output = sanitizeOutputSummary(
      `${"\u001b[31m"}password="sensitive-value"${"\u001b[0m"}${"x".repeat(4_000)}`
    );
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("sensitive-value");
    expect(output.length).toBeLessThanOrEqual(2_000);
  });
});

describe("verification APIs", () => {
  it("refuses an un-applied proposal and rejects caller-supplied commands", async () => {
    const { token, project, proposal } = await createContext();
    const response = await request(app)
      .post(`/api/projects/${project.id}/fix-proposals/${proposal.proposalId}/verifications`)
      .set("Cookie", `nexus_token=${token}`)
      .send({ command: "npm test" })
      .expect(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(await VerificationRun.countDocuments({})).toBe(0);

    const notApplied = await request(app)
      .post(`/api/projects/${project.id}/fix-proposals/${proposal.proposalId}/verifications`)
      .set("Cookie", `nexus_token=${token}`)
      .send({})
      .expect(409);
    expect(notApplied.body.error.code).toBe("FIX_NOT_APPLIED");
    expect(await VerificationRun.countDocuments({})).toBe(0);
  });

  it("records sandbox unavailability as partial and never executes untrusted project scripts", async () => {
    const { token, project, proposal } = await createContext();
    await FixProposal.updateOne(
      { _id: proposal._id },
      {
        $set: {
          status: "APPLIED",
          "applicationResult.status": "SUCCEEDED",
          "applicationResult.repositoryRevision": "applied-revision"
        }
      }
    );
    const response = await request(app)
      .post(`/api/projects/${project.id}/fix-proposals/${proposal.proposalId}/verifications`)
      .set("Cookie", `nexus_token=${token}`)
      .send({})
      .expect(201);
    const run = response.body.data.run;
    expect(run).toMatchObject({
      status: "PARTIAL",
      repositoryRevision: "applied-revision",
      expectedRevision: "indexed-revision",
      checks: [
        { checkId: "test", status: "SKIPPED" },
        { checkId: "lint", status: "SKIPPED" },
        { checkId: "build", status: "SKIPPED" }
      ]
    });
    expect(run.failureReason).toContain("No isolated verification sandbox");
    expect(run.checks.every((check: { sanitizedOutputSummary: string }) =>
      check.sanitizedOutputSummary.includes("No project commands")
    )).toBe(true);

    const history = await request(app)
      .get(`/api/projects/${project.id}/fix-proposals/${proposal.proposalId}/verifications`)
      .set("Cookie", `nexus_token=${token}`)
      .expect(200);
    expect(history.body.data.runs).toHaveLength(1);
    expect(history.body.data.runs[0].status).toBe("PARTIAL");
  });

  it("allows concurrent unavailable attempts to be recorded separately without executing commands", async () => {
    const { token, project, proposal } = await createContext();
    await FixProposal.updateOne(
      { _id: proposal._id },
      {
        $set: {
          status: "APPLIED",
          "applicationResult.status": "SUCCEEDED",
          "applicationResult.repositoryRevision": "applied-revision"
        }
      }
    );
    const endpoint = `/api/projects/${project.id}/fix-proposals/${proposal.proposalId}/verifications`;
    const responses = await Promise.all([
      request(app).post(endpoint).set("Cookie", `nexus_token=${token}`).send({}),
      request(app).post(endpoint).set("Cookie", `nexus_token=${token}`).send({})
    ]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    expect(responses.every((response) => response.body.data.run.status === "PARTIAL")).toBe(true);
    expect(await VerificationRun.countDocuments({ fixProposalId: proposal.proposalId })).toBe(2);
  });

  it("enforces project ownership and records cancellation only for active runs", async () => {
    const { user, token, project, proposal } = await createContext();
    const otherOwner = await authService.register({
      name: "Unrelated User",
      email: `other-verify-${crypto.randomUUID()}@example.com`,
      password: "correct-horse-battery"
    });
    await request(app)
      .get(`/api/projects/${project.id}/fix-proposals/${proposal.proposalId}/verifications`)
      .set("Cookie", `nexus_token=${otherOwner.token}`)
      .expect(404);

    const run = await VerificationRun.create({
      verificationId: crypto.randomUUID(),
      projectId: project._id,
      userId: user.id,
      fixProposalId: proposal.proposalId,
      repositoryRevision: "revision",
      expectedRevision: "revision",
      checks: [],
      status: "RUNNING",
      startedAt: new Date()
    });
    const cancelled = await request(app)
      .post(`/api/projects/${project.id}/verifications/${run.verificationId}/cancel`)
      .set("Cookie", `nexus_token=${token}`)
      .send({})
      .expect(200);
    expect(cancelled.body.data.run.status).toBe("CANCELLED");
    await request(app)
      .post(`/api/projects/${project.id}/verifications/${run.verificationId}/cancel`)
      .set("Cookie", `nexus_token=${token}`)
      .send({})
      .expect(409);
  });
});
