import { createHash } from "node:crypto";
import { Project } from "../models/project.model.js";
import { CodeChunk } from "../models/code-chunk.model.js";
import { ProjectFile } from "../models/project-file.model.js";
import { ProjectArchitecture } from "../models/project-architecture.model.js";
import { AppError } from "../utils/app-error.js";
import {
  normalizeRepositoryPath,
  prepareRepositoryFiles,
  type RepositoryFileInput
} from "../utils/repository-input.js";
import { chunkSourceFile } from "./code-chunker.service.js";
import { embedChunks } from "./embedding.service.js";
import { analyzeProjectFiles } from "./project-architecture.service.js";

export type ProjectDocument = Awaited<ReturnType<typeof getOwnedProject>>;
export interface VectorSearchFilters {
  fileId?: string;
  filePath?: string;
  language?: string;
}

const stableFileId = (projectId: string, filePath: string) =>
  createHash("sha256").update(`${projectId}:${filePath}`).digest("hex");

export const getOwnedProject = async (projectId: string, ownerId: string) => {
  const project = await Project.findOne({ _id: projectId, ownerId });
  if (!project) {
    throw new AppError(404, "Project not found", "PROJECT_NOT_FOUND");
  }
  return project;
};

export const createProject = (ownerId: string, input: { name: string; repositoryUrl?: string }) =>
  Project.create({ ownerId, ...input });

export const listProjects = (ownerId: string) =>
  Project.find({ ownerId })
    .select("name repositoryUrl indexingStatus indexingError createdAt updatedAt")
    .sort({ updatedAt: -1 })
    .lean();

export const recoverInterruptedProjectIndexing = async () => {
  const interruptedMessage = "Indexing was interrupted by an API restart. Retry the import.";
  const interruptedStatuses = ["pending", "validating", "discovering", "cloning", "indexing", "analyzing"];
  await Promise.all([
    Project.updateMany(
      { indexingStatus: { $in: interruptedStatuses }, activeGeneration: 0 },
      { $set: { indexingStatus: "failed", indexingError: interruptedMessage } }
    ),
    Project.updateMany(
      { indexingStatus: { $in: interruptedStatuses }, activeGeneration: { $gt: 0 } },
      { $set: { indexingStatus: "ready", indexingError: interruptedMessage } }
    )
  ]);
};

export const indexProjectFiles = async (
  projectId: string,
  ownerId: string,
  inputFiles: RepositoryFileInput[],
  options: {
    incremental?: boolean;
    deletedPaths?: string[];
    alreadyClaimed?: boolean;
    onStatus?: (stage: "indexing" | "analyzing") => void;
  } = {}
) => {
  const safeFiles = inputFiles.length > 0
    ? prepareRepositoryFiles(inputFiles)
    : options.incremental && (options.deletedPaths?.length ?? 0) > 0
      ? []
      : prepareRepositoryFiles(inputFiles);
  const project = await Project.findOneAndUpdate(
    {
      _id: projectId,
      ownerId,
      indexingStatus: options.alreadyClaimed
        ? { $in: ["pending", "validating", "discovering", "cloning", "indexing", "analyzing"] }
        : { $nin: ["pending", "validating", "discovering", "cloning", "indexing", "analyzing"] }
    },
    {
      $inc: { generationCounter: 1 },
      $set: { indexingStatus: "indexing" },
      $unset: { indexingError: 1 }
    },
    { new: true }
  );
  if (!project) {
    if (!await Project.exists({ _id: projectId, ownerId })) {
      throw new AppError(404, "Project not found", "PROJECT_NOT_FOUND");
    }
    throw new AppError(409, "Project indexing is already in progress", "INDEXING_IN_PROGRESS");
  }

  const generation = project.generationCounter;
  const previousGeneration = project.activeGeneration;
  options.onStatus?.("indexing");
  try {
    const previousFiles = previousGeneration > 0
      ? await ProjectFile.find({ ownerId, projectId, generation: previousGeneration }).lean()
      : [];
    const previousByPath = new Map(previousFiles.map((file) => [file.filePath, file]));
    const deletedPaths = new Set((options.deletedPaths ?? []).map(normalizeRepositoryPath));
    const nextByPath = new Map<string, { path: string; content: string; fileId: string; contentHash: string }>();

    if (options.incremental) {
      for (const previous of previousFiles) {
        if (!deletedPaths.has(previous.filePath)) {
          nextByPath.set(previous.filePath, {
            path: previous.filePath,
            content: previous.content,
            fileId: previous.fileId || stableFileId(projectId, previous.filePath),
            contentHash: previous.contentHash
          });
        }
      }
    }

    for (const file of safeFiles) {
      const fileId = stableFileId(projectId, file.path);
      const contentHash = createHash("sha256").update(file.content).digest("hex");
      nextByPath.set(file.path, { ...file, fileId, contentHash });
    }
    for (const deletedPath of deletedPaths) nextByPath.delete(deletedPath);

    const nextFiles = [...nextByPath.values()].sort((left, right) => left.path.localeCompare(right.path));
    if (nextFiles.length === 0) {
      throw new AppError(400, "The supplied files contain no indexable text", "EMPTY_CODEBASE");
    }
    const unchangedFiles = nextFiles.filter((file) =>
      Boolean(previousByPath.get(file.path)?.fileId) &&
      previousByPath.get(file.path)?.contentHash === file.contentHash
    );
    const unchangedFileIds = new Set(unchangedFiles.map((file) => file.fileId));
    const changedFiles = nextFiles.filter((file) => !unchangedFileIds.has(file.fileId));
    const changedChunks = changedFiles.flatMap((file) => chunkSourceFile(file.path, file.content).map((chunk, index) => ({
      ...chunk,
      fileId: file.fileId,
      chunkId: `${file.fileId}:${index}`
    })));

    const carriedChunks = unchangedFileIds.size > 0
      ? await CodeChunk.find({
        ownerId,
        projectId,
        generation: previousGeneration,
        fileId: { $in: [...unchangedFileIds] }
      }).select("+embedding").lean()
      : [];
    const vectors = changedChunks.length > 0 ? await embedChunks(changedChunks) : [];
    if (vectors.length !== changedChunks.length) {
      throw new AppError(502, "Embedding model returned an invalid response", "INVALID_EMBEDDING_RESPONSE");
    }
    const newChunkDocs = changedChunks.map((chunk, index) => ({
      ownerId,
      projectId,
      generation,
      fileId: chunk.fileId,
      filePath: chunk.filePath,
      chunkId: chunk.chunkId,
      language: chunk.language,
      symbolContext: chunk.symbolContext,
      lineStart: chunk.startLine,
      lineEnd: chunk.endLine,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      content: chunk.content,
      embedding: vectors[index],
      metadata: {
        sourceHash: createHash("sha256").update(chunk.content).digest("hex"),
        indexedAt: new Date()
      }
    }));
    const copiedChunkDocs = carriedChunks.map((chunk) => ({
      ownerId,
      projectId,
      generation,
      fileId: chunk.fileId,
      filePath: chunk.filePath,
      chunkId: chunk.chunkId,
      language: chunk.language,
      symbolContext: chunk.symbolContext,
      lineStart: chunk.lineStart,
      lineEnd: chunk.lineEnd,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      content: chunk.content,
      embedding: chunk.embedding,
      metadata: chunk.metadata
    }));
    const allChunkDocs = [...copiedChunkDocs, ...newChunkDocs];
    if (allChunkDocs.length === 0) {
      throw new AppError(400, "The supplied files contain no indexable text", "EMPTY_CODEBASE");
    }
    await CodeChunk.insertMany(allChunkDocs, { ordered: true });

    const safeNextFiles = nextFiles.map(({ path, content }) => ({ path, content }));
    const architecture = analyzeProjectFiles(safeNextFiles);
    options.onStatus?.("analyzing");
    await ProjectFile.insertMany(nextFiles.map((file, index) => ({
      ownerId,
      projectId,
      generation,
      fileId: file.fileId,
      ...architecture.files[index],
      content: file.content
    })), { ordered: true });
    await ProjectArchitecture.create({
      ownerId,
      projectId,
      generation,
      nodes: architecture.nodes,
      relationships: architecture.relationships,
      summary: architecture.summary
    });

    const activated = await Project.updateOne(
      { _id: projectId, ownerId, generationCounter: generation },
      {
        $set: { activeGeneration: generation, indexingStatus: "ready" },
        $unset: { indexingError: 1 }
      }
    );
    if (activated.modifiedCount !== 1) {
      throw new AppError(409, "A newer indexing run superseded this one", "INDEXING_SUPERSEDED");
    }
    await CodeChunk.deleteMany({
      ownerId,
      projectId,
      generation: { $lt: generation }
    }).catch((error: unknown) => {
      console.error("Could not remove stale project code chunks", {
        projectId,
        errorType: error instanceof Error ? error.name : "UnknownError"
      });
    });
    await Promise.all([
      ProjectFile.deleteMany({ ownerId, projectId, generation: { $lt: generation } }),
      ProjectArchitecture.deleteMany({ ownerId, projectId, generation: { $lt: generation } })
    ]).catch((error: unknown) => {
      console.error("Could not remove stale project architecture metadata", {
        projectId,
        errorType: error instanceof Error ? error.name : "UnknownError"
      });
    });
    return {
      filesIndexed: nextFiles.length,
      changedFilesIndexed: changedFiles.length,
      unchangedFilesReused: unchangedFiles.length,
      chunksIndexed: allChunkDocs.length,
      chunksEmbedded: changedChunks.length,
      architectureNodes: architecture.nodes.length,
      architectureRelationships: architecture.relationships.length
    };
  } catch (error) {
    await Project.updateOne(
      { _id: projectId, ownerId, generationCounter: generation },
      {
        $set: {
          indexingStatus: previousGeneration > 0 ? "ready" : "failed",
          indexingError: error instanceof AppError
            ? error.message
            : "Indexing failed unexpectedly. Check the API logs and retry."
        }
      }
    );
    await CodeChunk.deleteMany({ ownerId, projectId, generation }).catch((cleanupError: unknown) => {
      console.error("Could not remove incomplete project code chunks", {
        projectId,
        errorType: cleanupError instanceof Error ? cleanupError.name : "UnknownError"
      });
    });
    await Promise.all([
      ProjectFile.deleteMany({ ownerId, projectId, generation }),
      ProjectArchitecture.deleteMany({ ownerId, projectId, generation })
    ]).catch((cleanupError: unknown) => {
      console.error("Could not remove incomplete project architecture metadata", {
        projectId,
        errorType: cleanupError instanceof Error ? cleanupError.name : "UnknownError"
      });
    });
    throw error;
  }
};

export const deleteProjectVectors = async (projectId: string, ownerId: string) => {
  const project = await getOwnedProject(projectId, ownerId);
  await Project.updateOne(
    { _id: project._id, ownerId },
    {
      $inc: { generationCounter: 1 },
      $set: { activeGeneration: 0, indexingStatus: "empty" },
      $unset: { indexingError: 1 }
    }
  );
  const [chunksDeleted] = await Promise.all([
    CodeChunk.deleteMany({ ownerId, projectId }),
    ProjectFile.deleteMany({ ownerId, projectId }),
    ProjectArchitecture.deleteMany({ ownerId, projectId })
  ]);
  return { vectorsDeleted: chunksDeleted.deletedCount };
};
