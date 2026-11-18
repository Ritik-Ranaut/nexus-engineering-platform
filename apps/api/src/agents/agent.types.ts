import { z } from "zod";
import type { ProjectDocument } from "../services/project.service.js";
import type { RetrievedSource } from "../services/vector-retriever.service.js";

export const specialistAgentIds = [
  "code_quality",
  "security",
  "performance",
  "testing",
  "documentation"
] as const;

export type SpecialistAgentId = typeof specialistAgentIds[number];
export type IssueCategory = "code_quality" | "security" | "performance" | "testing" | "documentation";
export type IssueSeverity = "critical" | "high" | "medium" | "low" | "suggestion";

export const evidenceSchema = z.object({
  filePath: z.string().min(1).max(512),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  quote: z.string().min(1).max(2_000),
  explanation: z.string().min(1).max(1_000)
}).strict();

export const findingDraftSchema = z.object({
  category: z.enum(["code_quality", "security", "performance", "testing", "documentation"]),
  severity: z.enum(["critical", "high", "medium", "low", "suggestion"]),
  title: z.string().min(4).max(160),
  description: z.string().min(8).max(2_000),
  reasoningSummary: z.string().min(8).max(500),
  affectedFiles: z.array(z.string().min(1).max(512)).max(20),
  evidence: z.array(evidenceSchema).min(1).max(8),
  recommendation: z.string().min(8).max(1_500),
  confidence: z.number().min(0).max(1)
}).strict();

export const agentOutputSchema = z.object({
  findings: z.array(findingDraftSchema).max(15),
  summary: z.string().max(1_000)
}).strict();

export type FindingDraft = z.infer<typeof findingDraftSchema>;
export type AgentOutput = z.infer<typeof agentOutputSchema>;

export interface AgentIssue extends FindingDraft {
  issueId: string;
  runId: string;
  agent: SpecialistAgentId;
  status: "open" | "accepted" | "dismissed" | "resolved";
  createdAt: string;
}

export interface AgentFailure {
  agent: string;
  code: string;
  message: string;
}

export interface AgentActivity {
  agent: string;
  status: "started" | "completed" | "failed";
  summary: string;
}

export interface EngineeringAgentInput {
  goal: string;
  project: ProjectDocument;
  ownerId: string;
  context: RetrievedSource[];
  signal: AbortSignal;
  onStatus?: (message: string) => Promise<void> | void;
}

export interface EngineeringAgentOutput {
  findings: FindingDraft[];
  summary: string;
  sources: RetrievedSource[];
}

export interface EngineeringAgent {
  id: SpecialistAgentId;
  execute(input: EngineeringAgentInput): Promise<EngineeringAgentOutput>;
}
