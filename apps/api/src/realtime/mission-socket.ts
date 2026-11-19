import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { env } from "../config/env.js";
import { Mission } from "../models/mission.model.js";
import { VerificationRun } from "../models/verification-run.model.js";
import { Project } from "../models/project.model.js";
import { User } from "../models/user.model.js";
import { verifyToken } from "../services/auth.service.js";

export interface MissionProgressEvent {
  missionId: string;
  status: string;
  message: string;
  progress: number;
  taskId?: string;
  agent?: string;
  eventStatus: "info" | "completed" | "running" | "failed";
  createdAt: string;
}

export interface VerificationProgressEvent {
  verificationId: string;
  status: string;
  message: string;
  checkId?: string;
  createdAt: string;
}

let missionIo: Server | undefined;

export interface ProjectImportProgressEvent {
  projectId: string;
  status: "pending" | "validating" | "discovering" | "cloning" | "indexing" | "analyzing" | "ready" | "failed" | "cancelled";
  message: string;
  error?: string;
  createdAt: string;
}

const authenticatedUser = async (socket: Socket) => {
  const tokenCookie = (socket.handshake.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("nexus_token="));
  const token = tokenCookie?.slice("nexus_token=".length);
  if (!token) return null;
  try {
    const claims = verifyToken(token);
    const user = await User.findById(claims.userId).select("+tokenVersion");
    if (!user || user.tokenVersion !== claims.tokenVersion) return null;
    return String(user._id);
  } catch {
    return null;
  }
};

export const attachMissionSocket = (httpServer: HttpServer) => {
  missionIo = new Server(httpServer, {
    cors: { origin: env.WEB_ORIGIN, credentials: true },
    maxHttpBufferSize: 64 * 1024
  });
  missionIo.use((socket, next) => {
    void authenticatedUser(socket).then((userId) => {
      if (!userId) {
        next(new Error("Authentication required"));
        return;
      }
      socket.data.userId = userId;
      next();
    });
  });
  missionIo.on("connection", (socket) => {
    socket.on("mission:subscribe", (missionId: unknown, acknowledge?: (result: { ok: boolean }) => void) => {
      if (typeof missionId !== "string" || !/^[a-f\d]{24}$/i.test(missionId)) {
        acknowledge?.({ ok: false });
        return;
      }
      void Mission.exists({ _id: missionId, userId: socket.data.userId })
        .then((exists) => {
          if (!exists) {
            acknowledge?.({ ok: false });
            return;
          }
          void socket.join(`mission:${missionId}`);
          acknowledge?.({ ok: true });
        })
        .catch((error: unknown) => {
          console.error("Mission socket subscription failed", {
            errorType: error instanceof Error ? error.name : "UnknownError"
          });
          acknowledge?.({ ok: false });
        });
    });
    socket.on("mission:unsubscribe", (missionId: unknown) => {
      if (typeof missionId === "string" && /^[a-f\d]{24}$/i.test(missionId)) {
        void socket.leave(`mission:${missionId}`);
      }
    });
    socket.on("project:subscribe", (projectId: unknown, acknowledge?: (result: { ok: boolean }) => void) => {
      if (typeof projectId !== "string" || !/^[a-f\d]{24}$/i.test(projectId)) {
        acknowledge?.({ ok: false });
        return;
      }
      void Project.exists({ _id: projectId, ownerId: socket.data.userId }).then((exists) => {
        if (!exists) {
          acknowledge?.({ ok: false });
          return;
        }
        void socket.join(`project:${projectId}`);
        acknowledge?.({ ok: true });
      }).catch(() => acknowledge?.({ ok: false }));
    });
    socket.on("project:unsubscribe", (projectId: unknown) => {
      if (typeof projectId === "string" && /^[a-f\d]{24}$/i.test(projectId)) {
        void socket.leave(`project:${projectId}`);
      }
    });
    socket.on("verification:subscribe", (verificationId: unknown, acknowledge?: (result: { ok: boolean }) => void) => {
      if (typeof verificationId !== "string" || !/^[\da-f-]{36}$/i.test(verificationId)) {
        acknowledge?.({ ok: false });
        return;
      }
      void VerificationRun.exists({ verificationId, userId: socket.data.userId })
        .then((exists) => {
          if (!exists) {
            acknowledge?.({ ok: false });
            return;
          }
          void socket.join(`verification:${verificationId}`);
          acknowledge?.({ ok: true });
        })
        .catch((error: unknown) => {
          console.error("Verification socket subscription failed", {
            errorType: error instanceof Error ? error.name : "UnknownError"
          });
          acknowledge?.({ ok: false });
        });
    });
    socket.on("verification:unsubscribe", (verificationId: unknown) => {
      if (typeof verificationId === "string" && /^[\da-f-]{36}$/i.test(verificationId)) {
        void socket.leave(`verification:${verificationId}`);
      }
    });
  });
  return missionIo;
};

export const emitMissionProgress = (event: MissionProgressEvent) => {
  missionIo?.to(`mission:${event.missionId}`).emit("mission:progress", event);
};

export const emitVerificationProgress = (event: VerificationProgressEvent) => {
  missionIo?.to(`verification:${event.verificationId}`).emit("verification:progress", event);
};

export const emitProjectImportProgress = (event: ProjectImportProgressEvent) => {
  missionIo?.to(`project:${event.projectId}`).emit("project:import-progress", event);
};

export const closeMissionSocket = async () => {
  const io = missionIo;
  missionIo = undefined;
  if (io) await new Promise<void>((resolve) => io.close(() => resolve()));
};
