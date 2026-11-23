import type { RequestHandler } from "express";
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
import {
  cancelRepositoryImport,
  startRepositoryImport
} from "../services/project-import.service.js";

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
  const result = await startRepositoryImport(request.params.projectId, request.user!.id);
  response.status(202).json({ data: result });
});

export const cancelImport: RequestHandler = asyncHandler(async (request, response) => {
  const project = await cancelRepositoryImport(request.params.projectId, request.user!.id);
  response.status(200).json({ data: { project } });
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
