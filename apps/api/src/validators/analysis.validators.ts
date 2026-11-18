import { z } from "zod";

export const runAnalysisSchema = z.object({
  goal: z.string().trim().min(3).max(1_000)
}).strict();

export const updateIssueSchema = z.object({
  status: z.enum(["open", "accepted", "dismissed", "resolved"])
}).strict();
