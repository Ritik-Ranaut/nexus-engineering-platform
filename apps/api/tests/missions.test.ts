import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { createServer } from "node:http";
import request from "supertest";
import { io as createSocketClient, type Socket } from "socket.io-client";
import { createApp } from "../src/app.js";
import { User } from "../src/models/user.model.js";
import { Project } from "../src/models/project.model.js";
import { Mission } from "../src/models/mission.model.js";
import { MissionTask } from "../src/models/mission-task.model.js";
import { AIRequest } from "../src/models/ai-request.model.js";
import { AnalysisRun } from "../src/models/analysis-run.model.js";
import { EngineeringIssue } from "../src/models/engineering-issue.model.js";
import { authService } from "../src/services/auth.service.js";
import { aiProvider } from "../src/services/ai-provider.js";
import { runEngineeringAnalysis } from "../src/services/engineering-analysis.service.js";
import {
  cancelMissionExecution,
  markInterruptedMissionsFailed,
  runMission
} from "../src/services/mission.service.js";
import { attachMissionSocket, closeMissionSocket, emitMissionProgress } from "../src/realtime/mission-socket.js";
import type { EngineeringAnalysisResult } from "../src/services/engineering-analysis.service.js";
import type { SpecialistAgentId } from "../src/agents/agent.types.js";

vi.mock("../src/services/ai-provider.js", () => ({
  aiProvider: {
    name: "test-provider",
    createChatModel: vi.fn(),
    createEmbeddingModel: vi.fn(),
    checkHealth: vi.fn()
  }
}));
vi.mock("../src/services/engineering-analysis.service.js", () => ({
  runEngineeringAnalysis: vi.fn()
}));

const app = createApp();
let database: MongoMemoryServer;

const plan = {
  summary: "Review security and test coverage.",
  rationale: "The goal explicitly names security and testing.",
  tasks: [
    { agent: "security", description: "Inspect authentication and authorization behavior." },
    { agent: "testing", description: "Inspect tests for important uncovered behavior." }
  ]
};

const finding = {
  issueId: "issue-mission-1",
  runId: "analysis-run-1",
  agent: "security" as const,
  category: "security" as const,
  severity: "high" as const,
  title: "Authentication behavior lacks a guard",
  description: "The authentication setting is unconditional.",
  reasoningSummary: "The source sets authentication enabled to a constant true value.",
  affectedFiles: ["src/auth.ts"],
  evidence: [{
    filePath: "src/auth.ts",
    startLine: 10,
    endLine: 10,
    quote: "export const authEnabled = true;",
    explanation: "The setting is always enabled."
  }],
  recommendation: "Use a validated configuration value.",
  confidence: 0.9,
  status: "open" as const,
  createdAt: new Date().toISOString()
};

const createMockModel = (invoke: (...args: unknown[]) => Promise<unknown>) => ({
  withStructuredOutput: vi.fn(() => ({ invoke: vi.fn(invoke) }))
});

const setSuccessfulAnalysis = () => {
  vi.mocked(runEngineeringAnalysis).mockImplementation(async (input) => {
    await input.onActivity?.({
      agent: "context",
      status: "completed",
      summary: "Loaded 3 project context sources."
    });
    for (const agent of input.selectedAgents ?? []) {
      await input.onActivity?.({ agent, status: "started", summary: `${agent} Agent started.` });
      await input.onActivity?.({ agent, status: "started", summary: "Searching indexed code" });
      await input.onActivity?.({ agent, status: "completed", summary: `${agent} Agent completed. 1 finding discovered.` });
    }
    await input.onActivity?.({
      agent: "aggregate",
      status: "completed",
      summary: "1 evidence-backed finding ready for review."
    });
    await input.onActivity?.({
      agent: "reviewer",
      status: "completed",
      summary: "Reviewer retained 1 of 1 candidates after evidence checks."
    });
    await input.onActivity?.({
      agent: "prioritize",
      status: "completed",
      summary: "1 reviewed finding prioritized by severity and confidence."
    });
    return {
      runId: "analysis-run-1",
      status: "completed",
      selectedAgents: input.selectedAgents ?? [],
      issues: [finding],
      failures: [],
      activities: [],
      summaries: {},
      report: {
        summary: "Investigation complete. 1 evidence-backed finding prioritized.",
        issueCount: 1,
        severityCounts: { high: 1 }
      },
      durationMs: 120,
      model: "test-chat-model"
    } satisfies EngineeringAnalysisResult;
  });
};

const waitForMission = async (missionId: string, statuses: string[]) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const mission = await Mission.findById(missionId);
    if (mission && statuses.includes(mission.status)) return mission;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Mission ${missionId} did not reach ${statuses.join(", ")}`);
};

beforeAll(async () => {
  database = await MongoMemoryServer.create();
  await mongoose.connect(database.getUri());
});

afterEach(async () => {
  await Promise.all([
    Mission.deleteMany({}),
    Project.deleteMany({}),
    User.deleteMany({}),
    AIRequest.deleteMany({}),
    AnalysisRun.deleteMany({}),
    EngineeringIssue.deleteMany({}),
    MissionTask.deleteMany({})
  ]);
  vi.mocked(aiProvider.createChatModel).mockReset();
  vi.mocked(runEngineeringAnalysis).mockReset();
  vi.restoreAllMocks();
  await closeMissionSocket();
});

afterAll(async () => {
  await mongoose.disconnect();
  await database.stop();
});

const createOwnerProject = async () => {
  const { user, token } = await authService.register({
    name: "Mission Owner",
    email: `owner-${crypto.randomUUID()}@example.com`,
    password: "correct-horse-battery"
  });
  const project = await Project.create({
    ownerId: user.id,
    name: "Mission Project",
    activeGeneration: 1,
    indexingStatus: "ready"
  });
  return { user, token, project };
};

const createMission = (projectId: string, userId: string, goal = "Improve security and testing") =>
  Mission.create({
    projectId,
    userId,
    goal,
    status: "CREATED",
    progress: { percent: 0, currentStep: "Mission created", events: [] }
  });

describe("engineering missions", () => {
  it("creates and runs a mission, persists plan/tasks/findings, and waits for human approval", async () => {
    const { user, token, project } = await createOwnerProject();
    vi.mocked(aiProvider.createChatModel).mockReturnValue(createMockModel(async () => plan) as never);
    setSuccessfulAnalysis();
    const response = await request(app)
      .post(`/api/projects/${project.id}/missions`)
      .set("Cookie", `nexus_token=${token}`)
      .send({ goal: "Improve security and testing" })
      .expect(202);

    const missionId = response.body.data.mission.id as string;
    expect(response.body.data.mission.status).toBe("CREATED");
    const persisted = await waitForMission(missionId, ["WAITING_FOR_APPROVAL"]);
    expect(String(persisted.userId)).toBe(user.id);
    expect(String(persisted.projectId)).toBe(String(project._id));
    expect(persisted.plan?.summary).toBe(plan.summary);
    expect(persisted.tasks).toHaveLength(2);
    expect(persisted.tasks[0]?.status).toBe("completed");
    expect(persisted.tasks[1]?.dependencies).toEqual([persisted.tasks[0]?.taskId]);
    expect(persisted.findings).toHaveLength(1);
    expect(persisted.report).toMatchObject({
      issueCount: 1,
      severityCounts: { high: 1 }
    });
    expect(persisted.progress.events.map((event) => event.message)).toContain("Searching indexed code");
    expect(persisted.progress.events.map((event) => event.message)).toContain(
      "Reviewer retained 1 of 1 candidates after evidence checks."
    );
    const storedTasks = await MissionTask.find({ missionId }).sort({ createdAt: 1, _id: 1 }).lean();
    expect(storedTasks).toHaveLength(2);
    expect(storedTasks.map((task) => task.status)).toEqual(["completed", "completed"]);
    expect(storedTasks.filter((task) => task.dependencies.length)).toHaveLength(1);
    expect(storedTasks.some((task) => task.dependencies[0] && storedTasks.some((dependency) =>
      dependency.taskId === task.dependencies[0]
    ))).toBe(true);
    const publicMission = await request(app)
      .get(`/api/missions/${missionId}`)
      .set("Cookie", `nexus_token=${token}`)
      .expect(200);
    expect(publicMission.body.data.mission.tasks).toHaveLength(2);
    expect(persisted.actions[0]?.status).toBe("pending");
    expect(persisted.progress.events.length).toBeGreaterThan(2);

    const actionId = persisted.actions[0]?.actionId;
    const decided = await request(app)
      .post(`/api/missions/${missionId}/actions/${actionId}/decision`)
      .set("Cookie", `nexus_token=${token}`)
      .send({ decision: "approved" })
      .expect(200);
    expect(decided.body.data.mission.status).toBe("COMPLETED");
    expect(decided.body.data.mission.actions[0].status).toBe("approved");
    expect(decided.body.data.mission).not.toHaveProperty("userId");
    expect(vi.mocked(runEngineeringAnalysis)).toHaveBeenCalledTimes(1);
  });

  it("rejects unowned and unindexed mission creation", async () => {
    const { token, project } = await createOwnerProject();
    const other = await authService.register({
      name: "Other User",
      email: `other-${crypto.randomUUID()}@example.com`,
      password: "correct-horse-battery"
    });
    await request(app).post(`/api/projects/${project.id}/missions`)
      .set("Cookie", `nexus_token=${other.token}`)
      .send({ goal: "Improve security" })
      .expect(404);
    project.activeGeneration = 0;
    await project.save();
    await request(app).post(`/api/projects/${project.id}/missions`)
      .set("Cookie", `nexus_token=${token}`)
      .send({ goal: "Improve security" })
      .expect(409);
    expect(await Mission.countDocuments()).toBe(0);
  });

  it("cancels a mission while its planner is running", async () => {
    const { user, token, project } = await createOwnerProject();
    let planningSignal: AbortSignal | undefined;
    vi.mocked(aiProvider.createChatModel).mockReturnValue(createMockModel(async (...args) => {
      const options = args[1] as { signal?: AbortSignal } | undefined;
      planningSignal = options?.signal;
      return new Promise((_, reject) => {
        planningSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }) as never);
    const mission = await createMission(String(project._id), user.id);
    const run = runMission(String(mission._id), user.id);
    await waitForMission(String(mission._id), ["PLANNING"]);
    const cancelled = await request(app)
      .post(`/api/missions/${mission.id}/cancel`)
      .set("Cookie", `nexus_token=${token}`)
      .expect(200);
    cancelMissionExecution(String(mission._id));
    await run;
    expect(planningSignal?.aborted).toBe(true);
    expect(cancelled.body.data.mission.status).toBe("CANCELLED");
    expect((await Mission.findById(mission.id))?.status).toBe("CANCELLED");
    expect(runEngineeringAnalysis).not.toHaveBeenCalled();
  });

  it("creates independent task documents and cancels in-progress agent tasks", async () => {
    const { user, token, project } = await createOwnerProject();
    vi.mocked(aiProvider.createChatModel).mockReturnValue(createMockModel(async () => plan) as never);
    vi.mocked(runEngineeringAnalysis).mockImplementation(async (input) =>
      new Promise((_resolve, reject) => {
        input.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      })
    );
    const mission = await createMission(String(project._id), user.id);
    const run = runMission(String(mission._id), user.id);
    const running = await waitForMission(String(mission._id), ["RUNNING"]);
    const persistedTasks = await MissionTask.find({ missionId: mission._id }).lean();
    expect(persistedTasks).toHaveLength(2);
    expect(running.tasks).toHaveLength(2);

    await request(app)
      .post(`/api/missions/${mission.id}/cancel`)
      .set("Cookie", `nexus_token=${token}`)
      .expect(200);
    await run;
    const cancelledTasks = await MissionTask.find({ missionId: mission._id }).lean();
    expect(cancelledTasks.every((task) => task.status === "cancelled")).toBe(true);
    expect((await Mission.findById(mission.id))?.tasks.every((task) => task.status === "cancelled")).toBe(true);
  });

  it("marks the mission failed with a safe timeout when the planning deadline expires", async () => {
    const { user, project } = await createOwnerProject();
    const timeoutController = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    vi.mocked(aiProvider.createChatModel).mockReturnValue(createMockModel(async (...args) => {
      const options = args[1] as { signal?: AbortSignal } | undefined;
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("timed out")), { once: true });
        timeoutController.abort();
      });
    }) as never);
    const mission = await createMission(String(project._id), user.id);
    await runMission(String(mission._id), user.id);
    const saved = await Mission.findById(mission.id);
    expect(saved?.status).toBe("FAILED");
    expect(saved?.errors[0]).toMatchObject({
      code: "MISSION_TIMEOUT",
      message: "The mission exceeded its configured time limit."
    });
  });

  it("persists partial task failures alongside successful findings and recommendations", async () => {
    const { user, project } = await createOwnerProject();
    vi.mocked(aiProvider.createChatModel).mockReturnValue(createMockModel(async () => plan) as never);
    vi.mocked(runEngineeringAnalysis).mockResolvedValue({
      runId: "partial-analysis-run",
      status: "partial",
      selectedAgents: ["security", "testing"],
      issues: [finding],
      failures: [{
        agent: "testing",
        code: "SPECIALIST_FAILED",
        message: "Testing Agent could not complete its investigation."
      }],
      activities: [],
      summaries: {},
      report: {
        summary: "Investigation complete. 1 evidence-backed finding prioritized.",
        issueCount: 1,
        severityCounts: { high: 1 }
      },
      durationMs: 120,
      model: "test-chat-model"
    });
    const mission = await createMission(String(project._id), user.id);
    await runMission(String(mission._id), user.id);
    const persisted = await Mission.findById(mission.id);
    const tasks = await MissionTask.find({ missionId: mission._id }).lean();
    expect(persisted?.status).toBe("WAITING_FOR_APPROVAL");
    expect(persisted?.findings).toHaveLength(1);
    expect(persisted?.errors).toContainEqual(expect.objectContaining({ code: "SPECIALIST_FAILED" }));
    expect(tasks.find((task) => task.agent === "security")?.status).toBe("completed");
    expect(tasks.find((task) => task.agent === "testing")?.status).toBe("failed");
  });

  it("records workflow failure and recovers interrupted missions", async () => {
    const { user, project } = await createOwnerProject();
    vi.mocked(aiProvider.createChatModel).mockReturnValue(createMockModel(async () => plan) as never);
    vi.mocked(runEngineeringAnalysis).mockRejectedValue(new Error("unavailable"));
    const mission = await createMission(String(project._id), user.id);
    await runMission(String(mission._id), user.id);
    const failed = await Mission.findById(mission.id);
    expect(failed?.status).toBe("FAILED");
    expect(failed?.errors[0]?.code).toBe("MISSION_EXECUTION_FAILED");

    const interrupted = await Mission.create({
      projectId: project._id,
      userId: user.id,
      goal: "Recover interrupted run",
      status: "RUNNING",
      progress: { percent: 50, currentStep: "Agent running", events: [] }
    });
    await expect(markInterruptedMissionsFailed()).resolves.toBe(1);
    const recovered = await Mission.findById(interrupted.id);
    expect(recovered?.status).toBe("FAILED");
    expect(recovered?.errors[0]?.code).toBe("MISSION_INTERRUPTED");
  });

  it("runs concurrent missions independently", async () => {
    const { user, project } = await createOwnerProject();
    vi.mocked(aiProvider.createChatModel).mockReturnValue(createMockModel(async () => ({
      summary: "Review security.",
      rationale: "Security is requested.",
      tasks: [{ agent: "security", description: "Inspect security controls." }]
    })) as never);
    setSuccessfulAnalysis();
    const first = await createMission(String(project._id), user.id, "Review authentication security");
    const second = await createMission(String(project._id), user.id, "Review authorization security");
    await Promise.all([
      runMission(String(first._id), user.id),
      runMission(String(second._id), user.id)
    ]);
    const saved = await Mission.find({ _id: { $in: [first._id, second._id] } });
    expect(saved).toHaveLength(2);
    expect(saved.every((mission) => mission.status === "WAITING_FOR_APPROVAL")).toBe(true);
    expect(saved.map((mission) => mission.id)).toContain(first.id);
    expect(saved.map((mission) => mission.id)).toContain(second.id);
  });

  it("rejects invalid agent IDs in planner output and uses a safe bounded fallback", async () => {
    const { user, project } = await createOwnerProject();
    vi.mocked(aiProvider.createChatModel).mockReturnValue(createMockModel(async () => ({
      summary: "Do anything",
      rationale: "bad",
      tasks: [{ agent: "arbitrary_shell", description: "Execute commands now." }]
    })) as never);
    vi.mocked(runEngineeringAnalysis).mockResolvedValue({
      runId: "empty-run",
      status: "completed",
      selectedAgents: ["code_quality", "security", "performance", "testing", "documentation"],
      issues: [],
      failures: [],
      activities: [],
      summaries: {},
      report: {
        summary: "Investigation complete. No evidence-backed findings were retained.",
        issueCount: 0,
        severityCounts: {}
      },
      durationMs: 50,
      model: "test-chat-model"
    });
    const mission = await createMission(String(project._id), user.id);
    await runMission(String(mission._id), user.id);
    const saved = await Mission.findById(mission.id);
    expect(saved?.status).toBe("COMPLETED");
    expect(saved?.tasks).toHaveLength(5);
    expect(saved?.tasks.every((task) => task.status === "completed")).toBe(true);
    expect(saved?.errors[0]?.message).toContain("bounded specialist fallback");
    expect(await MissionTask.countDocuments({ missionId: mission._id })).toBe(5);
  });

  it("authenticates Socket.IO and scopes live progress subscriptions to mission ownership", async () => {
    const owner = await createOwnerProject();
    const other = await createOwnerProject();
    const mission = await Mission.create({
      projectId: owner.project._id,
      userId: owner.user.id,
      goal: "Review security",
      status: "RUNNING",
      progress: { percent: 10, currentStep: "Running", events: [] }
    });
    const server = createServer(app);
    attachMissionSocket(server);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Socket test server failed to bind");
    const url = `http://127.0.0.1:${address.port}`;
    const ownerSocket = createSocketClient(url, {
      transports: ["websocket"],
      extraHeaders: { Cookie: `nexus_token=${owner.token}` }
    });
    const otherSocket = createSocketClient(url, {
      transports: ["websocket"],
      extraHeaders: { Cookie: `nexus_token=${other.token}` }
    });
    try {
      await Promise.all([
        new Promise<void>((resolve, reject) => {
          ownerSocket.once("connect", resolve);
          ownerSocket.once("connect_error", reject);
        }),
        new Promise<void>((resolve, reject) => {
          otherSocket.once("connect", resolve);
          otherSocket.once("connect_error", reject);
        })
      ]);
      const ownerSubscribed = await new Promise<boolean>((resolve) =>
        ownerSocket.emit("mission:subscribe", String(mission._id), (result: { ok: boolean }) => resolve(result.ok))
      );
      const otherSubscribed = await new Promise<boolean>((resolve) =>
        otherSocket.emit("mission:subscribe", String(mission._id), (result: { ok: boolean }) => resolve(result.ok))
      );
      expect(ownerSubscribed).toBe(true);
      expect(otherSubscribed).toBe(false);
      const received = new Promise<{ message: string; progress: number }>((resolve) => {
        ownerSocket.once("mission:progress", resolve);
      });
      emitMissionProgress({
        missionId: String(mission._id),
        status: "RUNNING",
        message: "Security agent completed.",
        progress: 60,
        eventStatus: "completed",
        createdAt: new Date().toISOString()
      });
      await expect(received).resolves.toMatchObject({ message: "Security agent completed.", progress: 60 });

      vi.mocked(aiProvider.createChatModel).mockReturnValue(createMockModel(async () => plan) as never);
      setSuccessfulAnalysis();
      const liveMission = await createMission(String(owner.project._id), owner.user.id);
      const liveSubscription = await new Promise<boolean>((resolve) =>
        ownerSocket.emit("mission:subscribe", String(liveMission._id), (result: { ok: boolean }) => resolve(result.ok))
      );
      expect(liveSubscription).toBe(true);
      const streamedActivity = new Promise<{ message: string; agent?: string }>((resolve) => {
        const handler = (event: { message: string; agent?: string }) => {
          if (event.message !== "Searching indexed code") return;
          ownerSocket.off("mission:progress", handler);
          resolve(event);
        };
        ownerSocket.on("mission:progress", handler);
      });
      await runMission(String(liveMission._id), owner.user.id);
      await expect(streamedActivity).resolves.toMatchObject({
        message: "Searching indexed code",
        agent: "security"
      });
    } finally {
      ownerSocket.disconnect();
      otherSocket.disconnect();
      await closeMissionSocket();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
