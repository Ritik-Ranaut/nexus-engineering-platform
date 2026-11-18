import { z } from "zod";
import { findingDraftSchema, specialistAgentIds } from "./agent.types.js";
import { agentToolNames } from "./agent-definitions.js";

export const plannerOutputSchema = z.object({
  selectedAgents: z.array(z.enum(specialistAgentIds)).min(1).max(5),
  rationale: z.string().max(800)
}).strict();

export const specialistTurnSchema = z.object({
  toolCalls: z.array(z.object({
    name: z.enum(agentToolNames),
    input: z.object({
      query: z.string().max(500).optional(),
      filePath: z.string().max(512).optional(),
      symbol: z.string().max(120).optional()
    }).strict()
  }).strict()).max(4),
  findings: z.array(findingDraftSchema).max(10),
  summary: z.string().max(1_000)
}).strict();

export const specialistFinalSchema = z.object({
  findings: z.array(findingDraftSchema).max(15),
  summary: z.string().max(1_000)
}).strict();

export const reviewerOutputSchema = z.object({
  acceptedFindingIndexes: z.array(z.number().int().min(0).max(14)).max(15),
  summary: z.string().max(1_000)
}).strict();

export type PlannerOutput = z.infer<typeof plannerOutputSchema>;
export type SpecialistTurn = z.infer<typeof specialistTurnSchema>;
