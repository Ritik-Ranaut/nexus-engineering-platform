import { z } from "zod";

export const reportTypes = [
  "project_health",
  "security_audit",
  "code_quality",
  "performance_analysis",
  "testing_coverage",
  "documentation",
  "mission"
] as const;

export const reportTypeSchema = z.enum(reportTypes);

export const createReportSchema = z.object({
  reportType: reportTypeSchema,
  missionId: z.string().regex(/^[a-f\d]{24}$/i).optional()
}).strict().superRefine((input, context) => {
  if ((input.reportType === "mission") !== Boolean(input.missionId)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["missionId"],
      message: "Mission reports require missionId; other report types cannot include it."
    });
  }
});

export const listReportsSchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  reportType: reportTypeSchema.optional(),
  missionId: z.string().regex(/^[a-f\d]{24}$/i).optional()
}).strict();

export const reportNarrativeSchema = z.object({
  executiveSummary: z.string().trim().min(20).max(1_800)
}).strict();

export type ReportType = typeof reportTypes[number];
