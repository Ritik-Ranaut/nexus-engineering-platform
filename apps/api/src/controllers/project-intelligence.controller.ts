import type { RequestHandler } from "express";
import { z } from "zod";
import { asyncHandler } from "../utils/async-handler.js";
import {
  getProjectArchitecture,
  getProjectFile,
  getProjectFileMetadata,
  getProjectStructure,
  getArchitectureGraph,
  getArchitectureNode,
  listProjectFiles,
  refreshProjectArchitecture
} from "../services/project-intelligence.service.js";

const searchSchema = z.string().max(200).optional();
const filePathSchema = z.string().min(1).max(512);
const architectureGraphSchema = z.object({
  search: z.string().trim().max(200).optional(),
  layer: z.enum(["all", "frontend", "backend", "data", "tests", "configuration"]).default("all"),
  relationshipType: z.enum(["IMPORTS", "DEPENDS_ON"]).optional(),
  limit: z.coerce.number().int().min(1).max(300).default(150),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  neighborhood: z.string().max(512).optional()
}).strict();
const architectureNodeSchema = z.string().trim().min(1).max(512);

export const structure: RequestHandler = asyncHandler(async (request, response) => {
  const result = await getProjectStructure(request.params.projectId, request.user!.id);
  response.status(200).json({ data: { structure: result } });
});

export const files: RequestHandler = asyncHandler(async (request, response) => {
  const search = searchSchema.parse(request.query.search);
  const result = await listProjectFiles(request.params.projectId, request.user!.id, search);
  response.status(200).json({ data: { files: result } });
});

export const file: RequestHandler = asyncHandler(async (request, response) => {
  const filePath = filePathSchema.parse(request.query.path);
  const result = await getProjectFile(request.params.projectId, request.user!.id, filePath);
  response.status(200).json({ data: { file: result } });
});

export const fileMetadata: RequestHandler = asyncHandler(async (request, response) => {
  const filePath = filePathSchema.parse(request.query.path);
  const metadata = await getProjectFileMetadata(request.params.projectId, request.user!.id, filePath);
  response.status(200).json({ data: { metadata } });
});

export const architectureNodes: RequestHandler = asyncHandler(async (request, response) => {
  const architecture = await getProjectArchitecture(request.params.projectId, request.user!.id);
  response.status(200).json({ data: { nodes: architecture?.nodes ?? [] } });
});

export const architectureRelationships: RequestHandler = asyncHandler(async (request, response) => {
  const architecture = await getProjectArchitecture(request.params.projectId, request.user!.id);
  response.status(200).json({ data: { relationships: architecture?.relationships ?? [] } });
});

export const architectureGraph: RequestHandler = asyncHandler(async (request, response) => {
  const filters = architectureGraphSchema.parse(request.query);
  const graph = await getArchitectureGraph(request.params.projectId, request.user!.id, filters);
  response.status(200).json({ data: { graph } });
});

export const architectureNode: RequestHandler = asyncHandler(async (request, response) => {
  const nodeId = architectureNodeSchema.parse(request.query.nodeId);
  const node = await getArchitectureNode(request.params.projectId, request.user!.id, nodeId);
  response.status(200).json({ data: { node } });
});

export const refreshArchitecture: RequestHandler = asyncHandler(async (request, response) => {
  z.object({}).strict().parse(request.body);
  const result = await refreshProjectArchitecture(request.params.projectId, request.user!.id);
  response.status(200).json({ data: result });
});
