import type { RequestHandler } from "express";
import { AppError } from "../utils/app-error.js";
import { asyncHandler } from "../utils/async-handler.js";
import {
  createProjectSchema,
  indexFilesSchema,
  updateFilesSchema
} from "../validators/project.validators.js";
import {
  createProject,
  deleteProjectVectors,
  getOwnedProject,
  indexProjectFiles,
  listProjects
} from "../services/project.service.js";
import { fetchPublicGitHubRepositoryFiles } from "../services/github-repository.service.js";
import { Project } from "../models/project.model.js";
import { emitProjectImportProgress } from "../realtime/mission-socket.js";

export const create: RequestHandler = asyncHandler(async (request, response) => {
  const input = createProjectSchema.parse(request.body);
  const project = await createProject(request.user!.id, input);
  response.status(201).json({
    data: {
      project: {
        id: String(project._id),
        name: project.name,
        repositoryUrl: project.repositoryUrl,
        indexingStatus: project.indexingStatus,
        indexingError: project.indexingError,
        createdAt: project.createdAt
      }
    }
  });
});

export const list: RequestHandler = asyncHandler(async (request, response) => {
  const projects = await listProjects(request.user!.id);
  response.status(200).json({
    data: {
      projects: projects.map((project) => ({
        id: String(project._id),
        name: project.name,
        repositoryUrl: project.repositoryUrl,
        indexingStatus: project.indexingStatus,
        indexingError: project.indexingError,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt
      }))
    }
  });
});

export const get: RequestHandler = asyncHandler(async (request, response) => {
  const project = await getOwnedProject(request.params.projectId, request.user!.id);
  response.status(200).json({
    data: {
      project: {
        id: String(project._id),
        name: project.name,
        repositoryUrl: project.repositoryUrl,
        indexingStatus: project.indexingStatus,
        indexingError: project.indexingError,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt
      }
    }
  });
});

export const index: RequestHandler = asyncHandler(async (request, response) => {
  const { files } = indexFilesSchema.parse(request.body);
  const result = await indexProjectFiles(
    request.params.projectId,
    request.user!.id,
    files
  );
  response.status(200).json({ data: result });
});

export const importRepository: RequestHandler = asyncHandler(async (request, response) => {
  const project = await getOwnedProject(request.params.projectId, request.user!.id);
  if (!project.repositoryUrl) {
    throw new AppError(400, "Add a GitHub repository URL before importing", "REPOSITORY_URL_REQUIRED");
  }
  const repositoryUrl = project.repositoryUrl;
  const projectId = request.params.projectId;
  const ownerId = request.user!.id;
  const claimed = await Project.updateOne(
    {
      _id: projectId,
      ownerId,
      indexingStatus: { $nin: ["pending", "validating", "discovering", "cloning", "indexing", "analyzing"] }
    },
    { $set: { indexingStatus: "validating" }, $unset: { indexingError: 1 } }
  );
  if (claimed.modifiedCount !== 1) {
    throw new AppError(409, "Project indexing is already in progress", "INDEXING_IN_PROGRESS");
  }

  const runImport = async () => {
    try {
      const updateStatus = (status: "validating" | "discovering" | "indexing" | "analyzing" | "ready" | "failed") => {
        emitProjectImportProgress({
          projectId,
          status,
          message: status === "ready"
            ? "Repository import completed"
            : `Repository import status: ${status}`,
          createdAt: new Date().toISOString()
        });
      };
      await Project.updateOne(
        { _id: projectId, ownerId, indexingStatus: "validating" },
        { $set: { indexingStatus: "validating" } }
      );
      updateStatus("validating");
      const files = await fetchPublicGitHubRepositoryFiles(repositoryUrl, (stage) => {
        void Project.updateOne(
          { _id: projectId, ownerId },
          { $set: { indexingStatus: stage } }
        );
        updateStatus(stage);
      });
      await Project.updateOne(
        { _id: projectId, ownerId },
        { $set: { indexingStatus: "indexing" } }
      );
      await indexProjectFiles(projectId, ownerId, files, {
        alreadyClaimed: true,
        onStatus: (stage) => {
          void Project.updateOne(
            { _id: projectId, ownerId },
            { $set: { indexingStatus: stage } }
          );
          updateStatus(stage);
        }
      });
      updateStatus("ready");
    } catch (error) {
      const importError = error instanceof AppError
        ? error.message
        : "Repository import failed unexpectedly. Check the API logs and retry.";
      emitProjectImportProgress({
        projectId,
        status: "failed",
        message: "Repository import failed",
        error: importError,
        createdAt: new Date().toISOString()
      });
      const currentProject = await Project.findOne({
        _id: projectId,
        ownerId,
        indexingStatus: { $in: ["pending", "validating", "discovering", "cloning", "indexing", "analyzing"] }
      }).select("activeGeneration");
      if (currentProject) {
        await Project.updateOne(
          {
            _id: projectId,
            ownerId,
            indexingStatus: { $in: ["pending", "validating", "discovering", "cloning", "indexing", "analyzing"] }
          },
          {
            $set: {
              indexingStatus: currentProject.activeGeneration > 0 ? "ready" : "failed",
              indexingError: error instanceof AppError
                ? error.message
                : "Repository import failed unexpectedly. Check the API logs and retry."
            }
          }
        );
        emitProjectImportProgress({
          projectId,
          status: "failed",
          message: "Repository import failed",
          error: error instanceof AppError ? error.message : "Repository import failed unexpectedly",
          createdAt: new Date().toISOString()
        });
      }
      console.error("GitHub repository import failed", {
        projectId,
        errorType: error instanceof Error ? error.name : "UnknownError"
      });
    }
  };
  void runImport().catch((error: unknown) => {
    console.error("Could not finalize GitHub repository import", {
      projectId,
      errorType: error instanceof Error ? error.name : "UnknownError"
    });
  });

  response.status(202).json({ data: { status: "indexing" } });
});

export const updateIndex: RequestHandler = asyncHandler(async (request, response) => {
  const { files, deletedPaths } = updateFilesSchema.parse(request.body);
  const result = await indexProjectFiles(
    request.params.projectId,
    request.user!.id,
    files,
    { incremental: true, deletedPaths }
  );
  response.status(200).json({ data: result });
});

export const deleteVectors: RequestHandler = asyncHandler(async (request, response) => {
  const result = await deleteProjectVectors(request.params.projectId, request.user!.id);
  response.status(200).json({ data: result });
});
