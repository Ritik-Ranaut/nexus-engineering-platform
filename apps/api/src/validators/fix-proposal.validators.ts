import { z } from "zod";

export const generateFixProposalSchema = z.object({
  findingId: z.string().trim().min(1).max(128),
  runId: z.string().trim().min(1).max(128),
  missionId: z.string().regex(/^[a-f\d]{24}$/i).optional()
}).strict();

export const proposalDecisionSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  rejectionReason: z.string().trim().max(1_000).optional()
}).strict();

export const proposalListSchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  findingId: z.string().trim().min(1).max(128).optional(),
  status: z.enum([
    "GENERATING",
    "GENERATED",
    "AWAITING_APPROVAL",
    "VALIDATION_FAILED",
    "APPROVED",
    "REJECTED",
    "APPLIED",
    "VERIFICATION_FAILED"
  ]).optional()
}).strict();
