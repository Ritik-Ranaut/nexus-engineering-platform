import { z } from "zod";

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  repositoryUrl: z.string().trim().url().max(2048).optional()
}).strict();

export const indexFilesSchema = z.object({
  files: z.array(z.object({
    path: z.string().min(1).max(512),
    content: z.string().max(300_000)
  }).strict()).min(1).max(100)
}).strict().refine(
  ({ files }) => files.reduce((total, file) => total + Buffer.byteLength(file.content, "utf8"), 0) <= 4_000_000,
  { message: "Combined file contents must be 4 MB or smaller", path: ["files"] }
);

export const updateFilesSchema = z.object({
  files: z.array(z.object({
    path: z.string().min(1).max(512),
    content: z.string().max(300_000)
  }).strict()).max(100).default([]),
  deletedPaths: z.array(z.string().min(1).max(512)).max(100).default([])
}).strict().refine(
  ({ files, deletedPaths }) => files.length > 0 || deletedPaths.length > 0,
  { message: "Provide at least one changed file or deleted path" }
).refine(
  ({ files }) => files.reduce((total, file) => total + Buffer.byteLength(file.content, "utf8"), 0) <= 4_000_000,
  { message: "Combined file contents must be 4 MB or smaller", path: ["files"] }
);

export const semanticSearchSchema = z.object({
  query: z.string().trim().min(1).max(4_000),
  topK: z.number().int().min(1).max(100).optional(),
  fileId: z.string().min(1).max(128).optional(),
  filePath: z.string().min(1).max(512).optional(),
  language: z.string().min(1).max(40).optional()
}).strict();

export const chatSchema = z.object({
  question: z.string().trim().min(3).max(4_000),
  topK: z.number().int().min(1).max(20).optional()
}).strict();

export const conversationSchema = z.object({
  title: z.string().trim().min(1).max(120).optional()
}).strict();

export const conversationMessageSchema = z.object({
  question: z.string().trim().min(3).max(4_000),
  topK: z.number().int().min(1).max(20).optional()
}).strict();
