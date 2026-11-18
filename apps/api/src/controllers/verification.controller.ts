import type { RequestHandler } from "express";
import { z } from "zod";
import { asyncHandler } from "../utils/async-handler.js";
import {
  cancelVerificationRun,
  getVerificationRun,
  listVerificationRuns,
  startVerification
} from "../services/verification.service.js";

const emptyRequestSchema = z.object({}).strict();

export const start: RequestHandler = asyncHandler(async (request, response) => {
  emptyRequestSchema.parse(request.body);
  const run = await startVerification(
    request.params.projectId,
    request.user!.id,
    request.params.proposalId
  );
  response.status(201).json({ data: { run } });
});

export const list: RequestHandler = asyncHandler(async (request, response) => {
  const runs = await listVerificationRuns(
    request.params.projectId,
    request.user!.id,
    request.params.proposalId
  );
  response.status(200).json({ data: { runs } });
});

export const get: RequestHandler = asyncHandler(async (request, response) => {
  const run = await getVerificationRun(
    request.params.projectId,
    request.user!.id,
    request.params.verificationId
  );
  response.status(200).json({ data: { run } });
});

export const cancel: RequestHandler = asyncHandler(async (request, response) => {
  emptyRequestSchema.parse(request.body);
  const run = await cancelVerificationRun(
    request.params.projectId,
    request.user!.id,
    request.params.verificationId
  );
  response.status(200).json({ data: { run } });
});
