import { env } from "../config/env.js";
import { CodeChunk } from "../models/code-chunk.model.js";
import type { ProjectDocument } from "./project.service.js";
import { createEmbeddingModel } from "./ollama.service.js";
import { retryEmbeddingOperation } from "./embedding.service.js";
import { AppError } from "../utils/app-error.js";
import { getOwnedProject, type VectorSearchFilters } from "./project.service.js";

export interface RetrievedSource {
  id: string;
  fileId?: string;
  chunkId?: string;
  filePath: string;
  language: string;
  symbolContext: string;
  startLine: number;
  endLine: number;
  lineStart?: number;
  lineEnd?: number;
  content: string;
  score: number;
}

export const buildVectorSearchPipeline = (
  queryVector: number[],
  projectId: string,
  ownerId: string,
  generation: number,
  topK: number,
  metadataFilters: VectorSearchFilters = {}
) => [
  {
    $vectorSearch: {
      index: env.AI_VECTOR_INDEX_NAME,
      path: "embedding",
      queryVector,
      numCandidates: Math.max(topK * 20, 100),
      limit: topK,
      filter: {
        $and: [
          { projectId: { $eq: projectId } },
          { ownerId: { $eq: ownerId } },
          { generation: { $eq: generation } },
          ...(metadataFilters.fileId ? [{ fileId: { $eq: metadataFilters.fileId } }] : []),
          ...(metadataFilters.filePath ? [{ filePath: { $eq: metadataFilters.filePath } }] : []),
          ...(metadataFilters.language ? [{ language: { $eq: metadataFilters.language } }] : [])
        ]
      }
    }
  },
  {
    $project: {
      filePath: 1,
      fileId: 1,
      chunkId: 1,
      language: 1,
      symbolContext: 1,
      lineStart: 1,
      lineEnd: 1,
      startLine: 1,
      endLine: 1,
      content: 1,
      score: { $meta: "vectorSearchScore" }
    }
  }
];

export const retrieveProjectContext = async (
  project: ProjectDocument,
  ownerId: string,
  query: string,
  topK = env.AI_RETRIEVAL_TOP_K,
  signal?: AbortSignal,
  metadataFilters: VectorSearchFilters = {}
): Promise<RetrievedSource[]> => {
  const projectId = String(project._id);
  if (!projectId || projectId === "undefined") {
    throw new AppError(400, "A project identifier is required for vector retrieval", "PROJECT_ID_REQUIRED");
  }
  if (!Number.isInteger(topK) || topK < 1 || topK > 100) {
    throw new AppError(400, "topK must be an integer from 1 to 100", "INVALID_TOP_K");
  }
  if (project.activeGeneration < 1) {
    throw new AppError(409, "Index this project before starting a chat", "PROJECT_NOT_INDEXED");
  }
  const embeddingModel = signal ? createEmbeddingModel(signal) : createEmbeddingModel();
  const queryVector = await retryEmbeddingOperation(
    () => embeddingModel.embedQuery(query),
    env.AI_EMBEDDING_RETRIES,
    signal
  );
  if (signal?.aborted) {
    throw new AppError(499, "Project retrieval was cancelled", "REQUEST_CANCELLED");
  }
  if (
    queryVector.length !== env.AI_VECTOR_DIMENSIONS ||
    queryVector.some((value) => !Number.isFinite(value))
  ) {
    throw new AppError(502, "Embedding dimensions do not match the configured vector index", "EMBEDDING_DIMENSION_MISMATCH");
  }
  let rows: Record<string, unknown>[];
  try {
    rows = await CodeChunk.aggregate(
      buildVectorSearchPipeline(
        queryVector,
        projectId,
        ownerId,
        project.activeGeneration,
        topK,
        metadataFilters
      )
    ).exec();
  } catch (error) {
    console.error("MongoDB vector search failed", {
      projectId: String(project._id),
      errorType: error instanceof Error ? error.name : "UnknownError"
    });
    throw new AppError(
      503,
      "Project retrieval is unavailable. Check the MongoDB Vector Search index configuration.",
      "VECTOR_SEARCH_UNAVAILABLE"
    );
  }
  return rows.map((row) => ({
    id: String(row._id),
    fileId: row.fileId as string,
    chunkId: row.chunkId as string,
    filePath: row.filePath as string,
    language: row.language as string,
    symbolContext: row.symbolContext as string,
    startLine: row.startLine as number,
    endLine: row.endLine as number,
    lineStart: (row.lineStart ?? row.startLine) as number,
    lineEnd: (row.lineEnd ?? row.endLine) as number,
    content: row.content as string,
    score: row.score as number
  }));
};

export const semanticSearch = async (
  projectId: string,
  ownerId: string,
  query: string,
  topK = env.AI_RETRIEVAL_TOP_K,
  metadataFilters: VectorSearchFilters = {},
  signal?: AbortSignal
) => {
  const project = await getOwnedProject(projectId, ownerId);
  return retrieveProjectContext(project, ownerId, query, topK, signal, metadataFilters);
};
