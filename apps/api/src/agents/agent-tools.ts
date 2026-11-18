import { CodeChunk } from "../models/code-chunk.model.js";
import { ProjectArchitecture } from "../models/project-architecture.model.js";
import { ProjectFile } from "../models/project-file.model.js";
import { ProjectMessage } from "../models/project-message.model.js";
import type { ProjectDocument } from "../services/project.service.js";
import { retrieveProjectContext } from "../services/vector-retriever.service.js";
import type { AgentToolName } from "./agent-definitions.js";
import type { SpecialistAgentId } from "./agent.types.js";
import { agentDefinitions } from "./agent-definitions.js";
import { AppError } from "../utils/app-error.js";

export type { AgentToolName } from "./agent-definitions.js";

export interface AgentToolInput {
  query?: string;
  filePath?: string;
  symbol?: string;
}

export interface AgentToolSource {
  filePath: string;
  language: string;
  symbolContext: string;
  startLine: number;
  endLine: number;
  content: string;
}

const escapedRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const getQueryTokens = (query: string) => [...new Set(
  query.trim().split(/\s+/).filter((token) => token.length >= 2).slice(0, 6)
)];

export const getAgentToolRegistry = (
  project: ProjectDocument,
  ownerId: string,
  signal?: AbortSignal
) => {
  const projectId = String(project._id);
  const baseFilter = {
    ownerId,
    projectId,
    generation: project.activeGeneration
  };
  const asSource = (chunk: {
    filePath: string;
    language: string;
    symbolContext: string;
    startLine: number;
    endLine: number;
    content: string;
  }): AgentToolSource => ({
    filePath: chunk.filePath,
    language: chunk.language,
    symbolContext: chunk.symbolContext,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    content: chunk.content
  });

  return {
    async searchCode(input: AgentToolInput): Promise<AgentToolSource[]> {
      if (!input.query?.trim() || input.query.length > 500) {
        throw new AppError(400, "searchCode requires a query up to 500 characters", "INVALID_TOOL_INPUT");
      }
      const terms = getQueryTokens(input.query);
      if (terms.length === 0) return [];
      const expression = new RegExp(terms.map(escapedRegex).join("|"), "i");
      return CodeChunk.find({ ...baseFilter, content: expression })
        .select("filePath language symbolContext startLine endLine content")
        .limit(8)
        .lean()
        .then((chunks) => chunks.map(asSource));
    },
    async readFile(input: AgentToolInput): Promise<AgentToolSource[]> {
      if (!input.filePath) throw new AppError(400, "readFile requires a file path", "INVALID_TOOL_INPUT");
      return CodeChunk.find({ ...baseFilter, filePath: input.filePath })
        .select("filePath language symbolContext startLine endLine content")
        .sort({ startLine: 1 })
        .limit(12)
        .lean()
        .then((chunks) => chunks.map(asSource));
    },
    async findReferences(input: AgentToolInput): Promise<AgentToolSource[]> {
      if (!input.symbol?.trim() || input.symbol.length > 120) {
        throw new AppError(400, "findReferences requires a short symbol name", "INVALID_TOOL_INPUT");
      }
      const exactSymbol = new RegExp(`\\b${escapedRegex(input.symbol)}\\b`, "i");
      return CodeChunk.find({
        ...baseFilter,
        $or: [{ symbolContext: exactSymbol }, { content: exactSymbol }]
      })
        .select("filePath language symbolContext startLine endLine content")
        .limit(12)
        .lean()
        .then((chunks) => chunks.map(asSource));
    },
    async inspectProject(): Promise<{
      files: { filePath: string; language: string; category: string; lineCount: number }[];
      languages: string[];
      architecture: { summary: unknown; relationships: unknown[] };
    }> {
      const metadataFilter = { ownerId, projectId, generation: project.activeGeneration };
      const [files, languages, architecture] = await Promise.all([
        ProjectFile.find(metadataFilter)
          .select("filePath language category lineCount")
          .sort({ filePath: 1 })
          .limit(500)
          .lean(),
        CodeChunk.distinct("language", baseFilter),
        ProjectArchitecture.findOne(metadataFilter).select("summary relationships").lean()
      ]);
      return {
        files: files.map(({ filePath, language, category, lineCount }) => ({
          filePath, language, category, lineCount
        })),
        languages: languages.slice(0, 40),
        architecture: {
          summary: architecture?.summary ?? {},
          relationships: (architecture?.relationships ?? []).slice(0, 200)
        }
      };
    },
    async retrieveContext(input: AgentToolInput): Promise<AgentToolSource[]> {
      if (!input.query?.trim() || input.query.length > 500) {
        throw new AppError(400, "retrieveContext requires a query up to 500 characters", "INVALID_TOOL_INPUT");
      }
      const results = await retrieveProjectContext(project, ownerId, input.query, 8, signal);
      return results.map(asSource);
    },
    async searchMemory(input: AgentToolInput): Promise<{
      role: "user" | "assistant";
      content: string;
      createdAt: Date;
    }[]> {
      if (!input.query?.trim() || input.query.length > 500) {
        throw new AppError(400, "searchMemory requires a query up to 500 characters", "INVALID_TOOL_INPUT");
      }
      const tokens = getQueryTokens(input.query);
      if (tokens.length === 0) return [];
      const expression = new RegExp(tokens.map(escapedRegex).join("|"), "i");
      return ProjectMessage.find({
        ownerId,
        projectId,
        content: expression,
        status: "completed"
      })
        .select("role content createdAt")
        .sort({ createdAt: -1 })
        .limit(10)
        .lean();
    }
  };
};

export type AgentToolRegistry = ReturnType<typeof getAgentToolRegistry>;

export const runAllowedAgentTool = async (
  agent: SpecialistAgentId,
  registry: AgentToolRegistry,
  toolName: string,
  input: AgentToolInput
): Promise<unknown> => {
  const definition = agentDefinitions[agent];
  if (!definition.allowedTools.some((allowedTool) => allowedTool === toolName)) {
    throw new AppError(403, `${definition.name} is not permitted to use ${toolName}`, "TOOL_NOT_ALLOWED");
  }
  switch (toolName) {
    case "searchCode":
      return registry.searchCode(input);
    case "readFile":
      return registry.readFile(input);
    case "findReferences":
      return registry.findReferences(input);
    case "inspectProject":
      return registry.inspectProject();
    case "retrieveContext":
      return registry.retrieveContext(input);
    case "searchMemory":
      return registry.searchMemory(input);
    default:
      throw new AppError(400, "Unknown code intelligence tool", "UNKNOWN_TOOL");
  }
};
