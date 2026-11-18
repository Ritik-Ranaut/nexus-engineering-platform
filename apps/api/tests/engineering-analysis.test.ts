import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeChunk } from "../src/models/code-chunk.model.js";
import { ProjectMessage } from "../src/models/project-message.model.js";
import { ProjectArchitecture } from "../src/models/project-architecture.model.js";
import { ProjectFile } from "../src/models/project-file.model.js";
import type { ProjectDocument } from "../src/services/project.service.js";
import { retrieveProjectContext } from "../src/services/vector-retriever.service.js";
import { aiProvider } from "../src/services/ai-provider.js";
import {
  runEngineeringAnalysis,
  specialistAgents
} from "../src/services/engineering-analysis.service.js";
import { getAgentToolRegistry, runAllowedAgentTool } from "../src/agents/agent-tools.js";
import { agentDefinitions, agentToolNames } from "../src/agents/agent-definitions.js";
import { specialistAgentIds, type SpecialistAgentId } from "../src/agents/agent.types.js";
import {
  plannerOutputSchema,
  reviewerOutputSchema,
  specialistFinalSchema,
  specialistTurnSchema
} from "../src/agents/agent-output.schemas.js";
import type { RetrievedSource } from "../src/services/vector-retriever.service.js";
import { AppError } from "../src/utils/app-error.js";

vi.mock("../src/services/ai-provider.js", () => ({
  aiProvider: {
    name: "test-provider",
    createChatModel: vi.fn(),
    createEmbeddingModel: vi.fn(),
    checkHealth: vi.fn()
  }
}));
vi.mock("../src/services/vector-retriever.service.js", () => ({
  retrieveProjectContext: vi.fn(),
  buildVectorSearchPipeline: vi.fn()
}));

const source: RetrievedSource = {
  id: "chunk-1",
  filePath: "src/auth.ts",
  language: "typescript",
  symbolContext: "authentication",
  startLine: 10,
  endLine: 12,
  content: "export const authEnabled = true;\nexport function verifyToken() { return true; }\n",
  score: 0.9
};
const project = {
  _id: { toString: () => "project-1" },
  activeGeneration: 1
} as unknown as ProjectDocument;

const makeModel = (agent: SpecialistAgentId, options?: {
  plannerFailure?: boolean;
  specialistFailure?: boolean;
  reviewerFailure?: boolean;
  reviewerRejects?: boolean;
  reviewerAcceptsAll?: boolean;
  empty?: boolean;
}) => {
  const withStructuredOutput = vi.fn((schema: unknown) => ({
    invoke: vi.fn(async () => {
      if (schema === plannerOutputSchema) {
        if (options?.plannerFailure) throw new Error("model offline");
        return { selectedAgents: [agent], rationale: "The scope requires this specialist." };
      }
      if (schema === specialistTurnSchema) {
        if (options?.specialistFailure) throw new Error("model offline");
        return {
          toolCalls: [],
          findings: options?.empty ? [] : [{
            category: agent,
            severity: "medium",
            title: "Authentication behavior lacks a guard",
            description: "The authentication-enabled setting is always true.",
            reasoningSummary: "The exact assignment uses a constant true value, so this setting cannot disable authentication.",
            affectedFiles: ["src/auth.ts"],
            evidence: [{
              filePath: "src/auth.ts",
              startLine: 10,
              endLine: 10,
              quote: "export const authEnabled = true;",
              explanation: "This setting unconditionally enables authentication."
            }],
            recommendation: "Make the setting depend on validated configuration.",
            confidence: 0.85
          }],
          summary: "Inspected authentication behavior."
        };
      }
      if (schema === specialistFinalSchema) return { findings: [], summary: "Finalized." };
      if (schema === reviewerOutputSchema) {
        if (options?.reviewerFailure) throw new Error("reviewer offline");
        return {
          acceptedFindingIndexes: options?.reviewerRejects ? []
            : options?.reviewerAcceptsAll ? [0, 1]
              : [0],
          summary: "Reviewed candidates against the source evidence."
        };
      }
      throw new Error("Unexpected structured output schema");
    })
  }));
  return { withStructuredOutput };
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(aiProvider.createChatModel).mockReset();
  vi.mocked(retrieveProjectContext).mockReset();
});

describe("engineering analysis graph", () => {
  it.each(specialistAgentIds)("runs the %s specialist and only keeps evidence-backed findings", async (agent) => {
    vi.mocked(retrieveProjectContext).mockResolvedValue([source]);
    vi.mocked(aiProvider.createChatModel).mockReturnValue(makeModel(agent) as never);
    const activities: string[] = [];

    const result = await runEngineeringAnalysis({
      project,
      ownerId: "owner-1",
      goal: `Investigate ${agent}`,
      signal: new AbortController().signal,
      onActivity: (activity) => activities.push(activity.summary)
    });

    expect(result.status).toBe("completed");
    expect(result.selectedAgents).toEqual([agent]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.agent).toBe(agent);
    expect(result.issues[0]?.evidence[0]?.quote).toBe(source.content.split("\n")[0]);
    expect(result.activities.map((activity) => activity.agent)).toContain("reviewer");
    expect(result.report).toMatchObject({
      issueCount: 1,
      severityCounts: { medium: 1 }
    });
    expect(result.activities.map((activity) => activity.agent)).toEqual(expect.arrayContaining([
      "context",
      "planner",
      "aggregate",
      "reviewer",
      "prioritize",
      "final_report"
    ]));
    expect(activities).toContain("Loaded 1 project context source.");
    expect(activities).toContain(`${agentDefinitions[agent].name} completed. 1 finding discovered.`);
    expect(activities).not.toContain("The scope requires this specialist.");
  });

  it("completes successfully with an empty findings set", async () => {
    vi.mocked(retrieveProjectContext).mockResolvedValue([source]);
    vi.mocked(aiProvider.createChatModel).mockReturnValue(makeModel("testing", { empty: true }) as never);
    const result = await runEngineeringAnalysis({ project, ownerId: "owner-1", goal: "Review tests" });
    expect(result.status).toBe("completed");
    expect(result.issues).toEqual([]);
    expect(result.report.summary).toContain("No evidence-backed findings");
  });

  it("continues after one specialist fails and prioritizes successful agent findings", async () => {
    vi.mocked(retrieveProjectContext).mockResolvedValue([source]);
    const model = makeModel("testing");
    const structured = model.withStructuredOutput;
    model.withStructuredOutput = vi.fn((schema: unknown) => {
      if (schema === plannerOutputSchema) {
        return { invoke: vi.fn(async () => ({
          selectedAgents: ["security", "testing"],
          rationale: "Private planner rationale."
        })) };
      }
      return structured(schema);
    });
    vi.mocked(aiProvider.createChatModel).mockReturnValue(model as never);
    vi.spyOn(specialistAgents.security, "execute").mockRejectedValue(new Error("provider unavailable"));
    const result = await runEngineeringAnalysis({
      project,
      ownerId: "owner-1",
      goal: "Review security and test coverage"
    });
    expect(result.status).toBe("partial");
    expect(result.selectedAgents).toEqual(["security", "testing"]);
    expect(result.failures).toContainEqual(expect.objectContaining({
      agent: "security",
      code: "SPECIALIST_FAILED"
    }));
    expect(result.issues.map((issue) => issue.agent)).toEqual(["testing"]);
  });

  it("prioritizes critical findings before medium findings and reports severity totals", async () => {
    vi.mocked(retrieveProjectContext).mockResolvedValue([source]);
    vi.mocked(aiProvider.createChatModel).mockReturnValue(
      makeModel("security", { empty: true, reviewerAcceptsAll: true }) as never
    );
    vi.spyOn(specialistAgents.security, "execute").mockResolvedValue({
      summary: "Private agent rationale",
      sources: [source],
      findings: [
        {
          category: "security",
          severity: "medium",
          title: "Medium issue",
          description: "A medium severity issue is grounded in the source.",
          reasoningSummary: "The cited source contains the exact setting.",
          affectedFiles: ["src/auth.ts"],
          evidence: [{
            filePath: "src/auth.ts",
            startLine: 10,
            endLine: 10,
            quote: "export const authEnabled = true;",
            explanation: "This source line is the relevant evidence."
          }],
          recommendation: "Use a validated configuration value instead.",
          confidence: 0.9
        },
        {
          category: "security",
          severity: "critical",
          title: "Critical issue",
          description: "A critical severity issue is grounded in the source.",
          reasoningSummary: "The cited source contains the exact setting.",
          affectedFiles: ["src/auth.ts"],
          evidence: [{
            filePath: "src/auth.ts",
            startLine: 10,
            endLine: 10,
            quote: "export const authEnabled = true;",
            explanation: "This source line is the relevant evidence."
          }],
          recommendation: "Use a validated configuration value instead.",
          confidence: 0.8
        }
      ]
    });
    const result = await runEngineeringAnalysis({
      project,
      ownerId: "owner-1",
      goal: "Review security",
      selectedAgents: ["security"]
    });
    expect(result.issues.map((issue) => issue.severity)).toEqual(["critical", "medium"]);
    expect(result.report.severityCounts).toEqual({ critical: 1, medium: 1 });
    expect(result.summaries.security).not.toContain("Private agent rationale");
  });

  it("cancels the graph while a specialist is running", async () => {
    vi.mocked(retrieveProjectContext).mockResolvedValue([source]);
    vi.mocked(aiProvider.createChatModel).mockReturnValue(makeModel("security") as never);
    const controller = new AbortController();
    await expect(runEngineeringAnalysis({
      project,
      ownerId: "owner-1",
      goal: "Review security",
      signal: controller.signal,
      onActivity: (activity) => {
        if (activity.agent === "security" && activity.status === "started") controller.abort();
      }
    })).rejects.toMatchObject<AppError>({ code: "ANALYSIS_CANCELLED_OR_TIMED_OUT" });
  });

  it("surfaces a configured workflow timeout as cancellation", async () => {
    vi.mocked(retrieveProjectContext).mockResolvedValue([source]);
    vi.mocked(aiProvider.createChatModel).mockReturnValue(makeModel("security") as never);
    const timeoutController = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    await expect(runEngineeringAnalysis({
      project,
      ownerId: "owner-1",
      goal: "Review security",
      onActivity: (activity) => {
        if (activity.agent === "security" && activity.status === "started") timeoutController.abort();
      }
    })).rejects.toMatchObject<AppError>({ code: "ANALYSIS_CANCELLED_OR_TIMED_OUT" });
  });

  it("uses the bounded maximum of five specialist executions", async () => {
    vi.mocked(retrieveProjectContext).mockResolvedValue([source]);
    const model = makeModel("security", { empty: true });
    vi.mocked(aiProvider.createChatModel).mockReturnValue(model as never);
    const result = await runEngineeringAnalysis({
      project,
      ownerId: "owner-1",
      goal: "Review project",
      selectedAgents: [...specialistAgentIds, "security"]
    });
    expect(result.selectedAgents).toHaveLength(5);
    expect(result.activities.filter((activity) => specialistAgentIds.includes(activity.agent as SpecialistAgentId) &&
      activity.status === "started")).toHaveLength(5);
  });

  it("records specialist model failure without inventing findings", async () => {
    vi.mocked(retrieveProjectContext).mockResolvedValue([source]);
    vi.mocked(aiProvider.createChatModel).mockReturnValue(makeModel("security", { specialistFailure: true }) as never);
    const result = await runEngineeringAnalysis({ project, ownerId: "owner-1", goal: "Review security" });
    expect(result.status).toBe("failed");
    expect(result.issues).toEqual([]);
    expect(result.failures).toMatchObject([{ agent: "security", code: "SPECIALIST_FAILED" }]);
  });

  it("uses the reviewer agent to discard evidence-backed but weak findings", async () => {
    vi.mocked(retrieveProjectContext).mockResolvedValue([source]);
    vi.mocked(aiProvider.createChatModel).mockReturnValue(
      makeModel("security", { reviewerRejects: true }) as never
    );
    const result = await runEngineeringAnalysis({ project, ownerId: "owner-1", goal: "Review security" });
    expect(result.issues).toEqual([]);
    expect(result.activities.find((activity) =>
      activity.agent === "reviewer" && activity.status === "completed"
    )?.status).toBe("completed");
  });

  it("logs reviewer failure and preserves only deterministically verified findings", async () => {
    vi.mocked(retrieveProjectContext).mockResolvedValue([source]);
    vi.mocked(aiProvider.createChatModel).mockReturnValue(
      makeModel("security", { reviewerFailure: true }) as never
    );
    const result = await runEngineeringAnalysis({ project, ownerId: "owner-1", goal: "Review security" });
    expect(result.issues).toHaveLength(1);
    expect(result.failures).toContainEqual(expect.objectContaining({
      agent: "reviewer",
      code: "REVIEWER_FAILED"
    }));
    expect(result.status).toBe("partial");
  });

  it("cancels before starting project retrieval when the request signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runEngineeringAnalysis({
      project,
      ownerId: "owner-1",
      goal: "Review security",
      signal: controller.signal
    })).rejects.toMatchObject<AppError>({ code: "ANALYSIS_CANCELLED_OR_TIMED_OUT" });
    expect(retrieveProjectContext).not.toHaveBeenCalled();
  });

  it("falls back to the bounded five-agent plan when the planner fails", async () => {
    vi.mocked(retrieveProjectContext).mockResolvedValue([source]);
    vi.mocked(aiProvider.createChatModel).mockReturnValue(makeModel("security", { plannerFailure: true, empty: true }) as never);
    const result = await runEngineeringAnalysis({ project, ownerId: "owner-1", goal: "Review the repository" });
    expect(result.selectedAgents).toHaveLength(5);
    expect(result.selectedAgents).toEqual(specialistAgentIds);
    expect(result.status).toBe("partial");
    expect(result.failures[0]?.code).toBe("PLANNER_FAILED");
    expect(result.activities.filter((activity) =>
      specialistAgentIds.includes(activity.agent as SpecialistAgentId) && activity.status === "started"
    )).toHaveLength(5);
  });

  it("rejects citations with fabricated lines", async () => {
    vi.mocked(retrieveProjectContext).mockResolvedValue([source]);
    const model = makeModel("security");
    const withStructuredOutput = model.withStructuredOutput;
    model.withStructuredOutput = vi.fn((schema: unknown) => {
      const output = withStructuredOutput(schema);
      if (schema !== specialistTurnSchema) return output;
      return {
        invoke: vi.fn(async () => ({
          toolCalls: [],
          findings: [{
            category: "security",
            severity: "high",
            title: "Authentication behavior lacks a guard",
            description: "The authentication-enabled setting is always true.",
            reasoningSummary: "The exact assignment uses a constant true value, so this setting cannot disable authentication.",
            affectedFiles: ["src/auth.ts"],
            evidence: [{
              filePath: "src/auth.ts",
              startLine: 11,
              endLine: 11,
              quote: "export const authEnabled = true;",
              explanation: "This setting unconditionally enables authentication."
            }],
            recommendation: "Make the setting depend on validated configuration.",
            confidence: 0.85
          }],
          summary: "Inspected."
        }))
      };
    });
    vi.mocked(aiProvider.createChatModel).mockReturnValue(model as never);
    const result = await runEngineeringAnalysis({ project, ownerId: "owner-1", goal: "Review security" });
    expect(result.issues).toEqual([]);
  });
});

describe("project-scoped agent tools", () => {
  it("filters project inspection by owner, project, and active generation", async () => {
    const distinct = vi.spyOn(CodeChunk, "distinct")
      .mockResolvedValueOnce(["typescript"] as never);
    const fileFind = vi.spyOn(ProjectFile, "find").mockReturnValue({
      select: vi.fn().mockReturnValue({
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            lean: vi.fn().mockResolvedValue([{
              filePath: "src/auth.ts",
              language: "typescript",
              category: "service",
              lineCount: 12
            }])
          })
        })
      })
    } as never);
    vi.spyOn(ProjectArchitecture, "findOne").mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({ summary: { fileCount: 1 }, relationships: [] })
      })
    } as never);
    const registry = getAgentToolRegistry(project, "owner-1");
    const result = await registry.inspectProject();
    expect(result.files).toEqual([{
      filePath: "src/auth.ts",
      language: "typescript",
      category: "service",
      lineCount: 12
    }]);
    expect(result.languages).toEqual(["typescript"]);
    expect(fileFind.mock.calls[0]?.[0]).toEqual({
      ownerId: "owner-1",
      projectId: "project-1",
      generation: 1
    });
    expect(distinct.mock.calls[0]?.[1]).toEqual({
      ownerId: "owner-1",
      projectId: "project-1",
      generation: 1
    });
  });

  it("rejects tools outside a specialist's allowlist", async () => {
    const registry = getAgentToolRegistry(project, "owner-1");
    await expect(runAllowedAgentTool("code_quality", registry, "searchMemory", { query: "prior analysis" }))
      .rejects.toMatchObject<AppError>({ code: "TOOL_NOT_ALLOWED", statusCode: 403 });
    await expect(runAllowedAgentTool("security", registry, "exec", { query: "whoami" }))
      .rejects.toMatchObject<AppError>({ code: "TOOL_NOT_ALLOWED", statusCode: 403 });
    expect(agentDefinitions.code_quality.allowedTools).not.toContain("searchMemory");
    expect(agentDefinitions.security.allowedTools).toContain("searchMemory");
    expect(agentToolNames).toEqual([
      "searchCode",
      "readFile",
      "findReferences",
      "inspectProject",
      "retrieveContext",
      "searchMemory"
    ]);
  });

  it("keeps source search and file reads inside the active project generation", async () => {
    const findQuery = {
      sort: vi.fn(),
      limit: vi.fn(),
      lean: vi.fn().mockResolvedValue([{
        filePath: source.filePath,
        language: source.language,
        symbolContext: source.symbolContext,
        startLine: source.startLine,
        endLine: source.endLine,
        content: source.content
      }])
    };
    findQuery.sort.mockReturnValue(findQuery);
    findQuery.limit.mockReturnValue(findQuery);
    const find = vi.spyOn(CodeChunk, "find").mockReturnValue({
      select: vi.fn().mockReturnValue(findQuery)
    } as never);
    vi.mocked(retrieveProjectContext).mockResolvedValue([source]);
    const registry = getAgentToolRegistry(project, "owner-1");
    await registry.searchCode({ query: "authentication" });
    await registry.readFile({ filePath: "src/auth.ts" });
    await registry.findReferences({ symbol: "verifyToken" });
    await registry.retrieveContext({ query: "token validation" });
    expect(find).toHaveBeenCalledTimes(3);
    for (const [filter] of find.mock.calls) {
      expect(filter).toMatchObject({
        ownerId: "owner-1",
        projectId: "project-1",
        generation: 1
      });
    }
    expect(find.mock.calls[0]?.[0]).toHaveProperty("content", expect.any(RegExp));
    expect(find.mock.calls[1]?.[0]).toHaveProperty("filePath", "src/auth.ts");
    expect(retrieveProjectContext).toHaveBeenCalledWith(
      project,
      "owner-1",
      "token validation",
      8,
      undefined
    );
  });

  it("searches only completed project-scoped conversation memory", async () => {
    const find = vi.spyOn(ProjectMessage, "find").mockReturnValue({
      select: vi.fn().mockReturnValue({
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            lean: vi.fn().mockResolvedValue([])
          })
        })
      })
    } as never);
    const registry = getAgentToolRegistry(project, "owner-1");
    await registry.searchMemory({ query: "authentication settings" });
    expect(find).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: "owner-1",
      projectId: "project-1",
      status: "completed",
      content: expect.any(RegExp)
    }));
  });
});
