import type { SpecialistAgentId } from "./agent.types.js";

export interface AgentDefinition {
  id: SpecialistAgentId;
  name: string;
  responsibility: string;
  allowedTools: readonly AgentToolName[];
  focus: string;
}

export const agentToolNames = [
  "searchCode",
  "readFile",
  "findReferences",
  "inspectProject",
  "retrieveContext",
  "searchMemory"
] as const;
export type AgentToolName = typeof agentToolNames[number];

export const agentDefinitions: Record<SpecialistAgentId, AgentDefinition> = {
  code_quality: {
    id: "code_quality",
    name: "Code Quality Agent",
    responsibility: "Find concrete correctness bugs, maintainability problems, and meaningful duplication.",
    allowedTools: ["searchCode", "readFile", "findReferences", "inspectProject", "retrieveContext"],
    focus: "Report only actionable defects or clear maintainability risks supported by source evidence."
  },
  security: {
    id: "security",
    name: "Security Agent",
    responsibility: "Investigate authentication, authorization, injection, secrets, and unsafe patterns.",
    allowedTools: ["searchCode", "readFile", "findReferences", "inspectProject", "retrieveContext", "searchMemory"],
    focus: "Prioritize exploitable security weaknesses. Do not claim a vulnerability without concrete evidence."
  },
  performance: {
    id: "performance",
    name: "Performance Agent",
    responsibility: "Identify evidenced algorithmic, database, network, or resource bottlenecks.",
    allowedTools: ["searchCode", "readFile", "inspectProject", "retrieveContext"],
    focus: "Report specific measurable or structurally evident inefficiencies; avoid generic optimization advice."
  },
  testing: {
    id: "testing",
    name: "Testing Agent",
    responsibility: "Assess test coverage, test reliability, and missing high-value behavior tests.",
    allowedTools: ["searchCode", "readFile", "inspectProject", "retrieveContext", "searchMemory"],
    focus: "Use observed test files and source behavior. Do not claim tests were run or coverage measured."
  },
  documentation: {
    id: "documentation",
    name: "Documentation Agent",
    responsibility: "Assess setup, API, architecture, and user-facing documentation against project structure.",
    allowedTools: ["searchCode", "readFile", "inspectProject", "retrieveContext", "searchMemory"],
    focus: "Report actionable documentation gaps grounded in observed files, not assumptions about intended behavior."
  }
};

export const maxSpecialistIterations = 5;
