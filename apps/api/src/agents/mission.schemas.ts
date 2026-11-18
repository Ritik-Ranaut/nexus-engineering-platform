import { z } from "zod";
import { specialistAgentIds } from "./agent.types.js";

export const missionPlanSchema = z.object({
  summary: z.string().min(12).max(1_000),
  rationale: z.string().min(12).max(1_000),
  tasks: z.array(z.object({
    agent: z.enum(specialistAgentIds),
    description: z.string().min(8).max(500)
  }).strict()).min(1).max(5)
}).strict();

export const createMissionSchema = z.object({
  goal: z.string().trim().min(5).max(1_000)
}).strict();

export const decideActionSchema = z.object({
  decision: z.enum(["approved", "rejected"])
}).strict();

export type MissionPlan = z.infer<typeof missionPlanSchema>;
