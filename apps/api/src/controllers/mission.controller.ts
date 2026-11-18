import type { RequestHandler } from "express";
import { randomUUID } from "node:crypto";
import { Mission } from "../models/mission.model.js";
import { MissionTask } from "../models/mission-task.model.js";
import { getOwnedProject } from "../services/project.service.js";
import { cancelMissionExecution, runMission } from "../services/mission.service.js";
import { createMissionSchema, decideActionSchema } from "../agents/mission.schemas.js";
import { emitMissionProgress } from "../realtime/mission-socket.js";
import { AppError } from "../utils/app-error.js";
import { asyncHandler } from "../utils/async-handler.js";

const serializeMission = (
  mission: Record<string, unknown>,
  taskDocuments?: Record<string, unknown>[]
) => ({
  id: String(mission._id),
  projectId: String(mission.projectId),
  goal: mission.goal,
  status: mission.status,
  plan: mission.plan,
  tasks: taskDocuments?.length
    ? taskDocuments.map((task) => ({
      taskId: task.taskId,
      agent: task.agent,
      description: task.description,
      status: task.status,
      result: task.result,
      dependencies: task.dependencies
    }))
    : mission.tasks,
  findings: mission.findings,
  report: mission.report,
  actions: mission.actions,
  errors: mission.errors,
  startedAt: mission.startedAt,
  completedAt: mission.completedAt,
  progress: {
    ...(mission.progress as Record<string, unknown> | undefined),
    percent: (mission.progress as { percent?: number } | undefined)?.percent ?? 0,
    currentStep: (mission.progress as { currentStep?: string } | undefined)?.currentStep ?? ""
  },
  createdAt: mission.createdAt,
  updatedAt: mission.updatedAt
});

export const createMission: RequestHandler = asyncHandler(async (request, response) => {
  const { goal } = createMissionSchema.parse(request.body);
  const project = await getOwnedProject(request.params.projectId, request.user!.id);
  if (project.activeGeneration < 1) {
    throw new AppError(409, "Index this project before creating a mission", "PROJECT_NOT_INDEXED");
  }
  const mission = await Mission.create({
    projectId: project._id,
    userId: request.user!.id,
    goal,
    status: "CREATED",
    progress: {
      percent: 0,
      currentStep: "Mission created",
      events: [{
        eventId: randomUUID(),
        message: "Mission queued for planning.",
        status: "info",
        createdAt: new Date()
      }]
    }
  });
  const userId = request.user!.id;
  setImmediate(() => void runMission(String(mission._id), userId));
  response.status(202).json({ data: { mission: serializeMission(mission.toObject()) } });
});

export const listMissions: RequestHandler = asyncHandler(async (request, response) => {
  await getOwnedProject(request.params.projectId, request.user!.id);
  const missions = await Mission.find({
    projectId: request.params.projectId,
    userId: request.user!.id
  }).sort({ createdAt: -1 }).limit(50).lean();
  const taskDocuments = await MissionTask.find({
    missionId: { $in: missions.map((mission) => mission._id) },
    projectId: request.params.projectId,
    userId: request.user!.id
  }).sort({ createdAt: 1 }).lean();
  const tasksByMission = new Map<string, Record<string, unknown>[]>();
  for (const task of taskDocuments) {
    const key = String(task.missionId);
    tasksByMission.set(key, [...(tasksByMission.get(key) ?? []), task as unknown as Record<string, unknown>]);
  }
  response.status(200).json({
    data: {
      missions: missions.map((mission) =>
        serializeMission(mission, tasksByMission.get(String(mission._id)))
      )
    }
  });
});

export const getMission: RequestHandler = asyncHandler(async (request, response) => {
  const mission = await Mission.findOne({
    _id: request.params.missionId,
    userId: request.user!.id
  }).lean();
  if (!mission) throw new AppError(404, "Mission not found", "MISSION_NOT_FOUND");
  await getOwnedProject(String(mission.projectId), request.user!.id);
  const tasks = await MissionTask.find({
    missionId: mission._id,
    projectId: mission.projectId,
    userId: request.user!.id
  }).sort({ createdAt: 1 }).lean();
  response.status(200).json({
    data: { mission: serializeMission(mission, tasks as unknown as Record<string, unknown>[]) }
  });
});

export const cancelMission: RequestHandler = asyncHandler(async (request, response) => {
  const mission = await Mission.findOneAndUpdate(
    {
      _id: request.params.missionId,
      userId: request.user!.id,
      status: { $in: ["CREATED", "PLANNING", "RUNNING", "WAITING_FOR_APPROVAL"] }
    },
    {
      $set: {
        status: "CANCELLED",
        completedAt: new Date(),
        "progress.currentStep": "Mission cancelled by user",
        "tasks.$[task].status": "cancelled",
        "tasks.$[task].result": "Task cancelled by user."
      },
      $push: {
        "progress.events": {
          eventId: randomUUID(),
          message: "Mission cancelled by user.",
          status: "info",
          createdAt: new Date()
        }
      }
    },
    {
      new: true,
      arrayFilters: [{ "task.status": { $in: ["pending", "running"] } }]
    }
  ).lean();
  if (!mission) throw new AppError(409, "Mission is no longer cancellable", "MISSION_NOT_CANCELLABLE");
  cancelMissionExecution(String(mission._id));
  await MissionTask.updateMany(
    {
      missionId: mission._id,
      userId: request.user!.id,
      status: { $in: ["pending", "running"] }
    },
    { $set: { status: "cancelled", result: "Task cancelled by user." } }
  );
  emitMissionProgress({
    missionId: String(mission._id),
    status: "CANCELLED",
    message: "Mission cancelled by user.",
    progress: mission.progress?.percent ?? 0,
    eventStatus: "info",
    createdAt: new Date().toISOString()
  });
  response.status(200).json({ data: { mission: serializeMission(mission) } });
});

export const decideMissionAction: RequestHandler = asyncHandler(async (request, response) => {
  const { decision } = decideActionSchema.parse(request.body);
  const mission = await Mission.findOneAndUpdate(
    {
      _id: request.params.missionId,
      userId: request.user!.id,
      status: "WAITING_FOR_APPROVAL",
      actions: {
        $elemMatch: {
          actionId: request.params.actionId,
          status: "pending"
        }
      }
    },
    {
      $set: {
        "actions.$.status": decision,
        "actions.$.decidedAt": new Date()
      }
    },
    { new: true }
  );
  if (!mission) throw new AppError(404, "Pending mission recommendation not found", "MISSION_ACTION_NOT_FOUND");
  const unresolved = mission.actions.some((action) => action.status === "pending");
  if (!unresolved) {
    mission.status = "COMPLETED";
    mission.completedAt = new Date();
    mission.set("progress.percent", 100);
    mission.set("progress.currentStep", "Approval decisions recorded");
    mission.set("progress.events", [...(mission.progress?.events ?? []), {
      eventId: randomUUID(),
      message: "All recommendation decisions have been recorded.",
      status: "completed",
      createdAt: new Date()
    }]);
    await mission.save();
  }
  emitMissionProgress({
    missionId: String(mission._id),
    status: mission.status,
    message: unresolved
      ? `Recommendation ${decision}. Other recommendations still need your decision.`
      : "All recommendation decisions have been recorded.",
    progress: mission.progress?.percent ?? 0,
    eventStatus: unresolved ? "info" : "completed",
    createdAt: new Date().toISOString()
  });
  response.status(200).json({ data: { mission: serializeMission(mission.toObject()) } });
});
