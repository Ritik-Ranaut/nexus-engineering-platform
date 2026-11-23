import { Project } from "../models/project.model.js";
import { emitProjectImportProgress } from "../realtime/mission-socket.js";
import { AppError } from "../utils/app-error.js";
import { fetchPublicGitHubRepositoryFiles } from "./github-repository.service.js";
import {
  activeImportStatuses,
  getOwnedProject,
  indexProjectFiles
} from "./project.service.js";

const importControllers = new Map<string, AbortController>();

const inFlightStatuses = ["pending", ...activeImportStatuses];

type ImportStatus =
  | "pending"
  | "validating"
  | "cloning"
  | "discovering"
  | "indexing"
  | "analyzing"
  | "ready"
  | "failed"
  | "cancelled";

const publishStatus = (projectId: string, status: ImportStatus, error?: string) => {
  emitProjectImportProgress({
    projectId,
    status,
    message: status === "ready"
      ? "Repository import completed"
      : status === "cancelled"
        ? "Repository import was cancelled"
        : status === "failed"
          ? "Repository import failed"
          : `Repository import status: ${status}`,
    error,
    createdAt: new Date().toISOString()
  });
};

export const startRepositoryImport = async (projectId: string, ownerId: string) => {
  const project = await getOwnedProject(projectId, ownerId);
  if (!project.repositoryUrl) {
    throw new AppError(400, "Add a GitHub repository URL before importing", "REPOSITORY_URL_REQUIRED");
  }
  const repositoryUrl = project.repositoryUrl;
  const claimed = await Project.updateOne(
    {
      _id: projectId,
      ownerId,
      indexingStatus: { $nin: activeImportStatuses }
    },
    { $set: { indexingStatus: "validating" }, $unset: { indexingError: 1 } }
  );
  if (claimed.modifiedCount !== 1) {
    throw new AppError(409, "Project indexing is already in progress", "INDEXING_IN_PROGRESS");
  }

  const previous = importControllers.get(projectId);
  previous?.abort();
  const controller = new AbortController();
  importControllers.set(projectId, controller);
  publishStatus(projectId, "validating");

  const runImport = async () => {
    try {
      const files = await fetchPublicGitHubRepositoryFiles(
        repositoryUrl,
        (stage) => {
          void Project.updateOne(
            { _id: projectId, ownerId },
            { $set: { indexingStatus: stage } }
          );
          publishStatus(projectId, stage);
        },
        controller.signal
      );
      await Project.updateOne(
        { _id: projectId, ownerId },
        { $set: { indexingStatus: "indexing" } }
      );
      publishStatus(projectId, "indexing");
      await indexProjectFiles(projectId, ownerId, files, {
        alreadyClaimed: true,
        signal: controller.signal,
        onStatus: (stage) => {
          void Project.updateOne(
            { _id: projectId, ownerId },
            { $set: { indexingStatus: stage } }
          );
          publishStatus(projectId, stage);
        }
      });
      publishStatus(projectId, "ready");
    } catch (error) {
      const cancelled = error instanceof AppError && error.code === "IMPORT_CANCELLED";
      const importError = error instanceof AppError
        ? error.message
        : "Repository import failed unexpectedly. Check the API logs and retry.";
      const currentProject = await Project.findOne({
        _id: projectId,
        ownerId,
        indexingStatus: { $in: inFlightStatuses }
      }).select("activeGeneration");
      if (currentProject) {
        const nextStatus = cancelled
          ? "cancelled"
          : currentProject.activeGeneration > 0 ? "ready" : "failed";
        await Project.updateOne(
          {
            _id: projectId,
            ownerId,
            indexingStatus: { $in: inFlightStatuses }
          },
          {
            $set: {
              indexingStatus: nextStatus,
              indexingError: importError
            }
          }
        );
        publishStatus(projectId, nextStatus, cancelled ? undefined : importError);
      }
      if (!cancelled) {
        console.error("GitHub repository import failed", {
          projectId,
          errorType: error instanceof Error ? error.name : "UnknownError"
        });
      }
    } finally {
      if (importControllers.get(projectId) === controller) {
        importControllers.delete(projectId);
      }
    }
  };

  void runImport().catch((error: unknown) => {
    console.error("Could not finalize GitHub repository import", {
      projectId,
      errorType: error instanceof Error ? error.name : "UnknownError"
    });
  });

  return { status: "indexing" as const };
};

export const cancelRepositoryImport = async (projectId: string, ownerId: string) => {
  await getOwnedProject(projectId, ownerId);
  const controller = importControllers.get(projectId);
  controller?.abort();
  const updated = await Project.findOneAndUpdate(
    {
      _id: projectId,
      ownerId,
      indexingStatus: { $in: inFlightStatuses }
    },
    {
      $set: {
        indexingStatus: "cancelled",
        indexingError: "Repository import was cancelled"
      }
    },
    { new: true }
  );
  if (!updated) {
    throw new AppError(409, "No repository import is in progress", "IMPORT_NOT_IN_PROGRESS");
  }
  publishStatus(projectId, "cancelled");
  return {
    id: String(updated._id),
    indexingStatus: updated.indexingStatus,
    indexingError: updated.indexingError
  };
};
