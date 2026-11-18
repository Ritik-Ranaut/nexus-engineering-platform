import type { RequestHandler } from "express";
import { asyncHandler } from "../utils/async-handler.js";
import {
  decideFixProposal,
  applyApprovedFixProposal,
  generateFixProposal,
  getFixProposal,
  getFixProposalDiff,
  listFixProposals,
  recordFixProposalReview,
  validateFixProposal
} from "../services/fix-proposal.service.js";
import {
  generateFixProposalSchema,
  proposalDecisionSchema,
  proposalListSchema
} from "../validators/fix-proposal.validators.js";

export const generate: RequestHandler = asyncHandler(async (request, response) => {
  const input = generateFixProposalSchema.parse(request.body);
  const controller = new AbortController();
  request.once("aborted", () => controller.abort());
  const proposal = await generateFixProposal(
    request.params.projectId,
    request.user!.id,
    input,
    controller.signal
  );
  response.status(proposal.status === "GENERATING" ? 202 : 201).json({
    data: { proposal }
  });
});

export const list: RequestHandler = asyncHandler(async (request, response) => {
  const filter = proposalListSchema.parse(request.query);
  const result = await listFixProposals(
    request.params.projectId,
    request.user!.id,
    filter
  );
  response.status(200).json({ data: result });
});

export const get: RequestHandler = asyncHandler(async (request, response) => {
  const proposal = await getFixProposal(
    request.params.projectId,
    request.user!.id,
    request.params.proposalId
  );
  response.status(200).json({ data: { proposal } });
});

export const diff: RequestHandler = asyncHandler(async (request, response) => {
  const patch = await getFixProposalDiff(
    request.params.projectId,
    request.user!.id,
    request.params.proposalId
  );
  response.status(200).json({ data: patch });
});

export const validate: RequestHandler = asyncHandler(async (request, response) => {
  const proposal = await validateFixProposal(
    request.params.projectId,
    request.user!.id,
    request.params.proposalId
  );
  response.status(200).json({ data: { proposal } });
});

export const decide: RequestHandler = asyncHandler(async (request, response) => {
  const { decision, rejectionReason } = proposalDecisionSchema.parse(request.body);
  const proposal = await decideFixProposal(
    request.params.projectId,
    request.user!.id,
    request.params.proposalId,
    decision,
    rejectionReason
  );
  response.status(200).json({ data: { proposal } });
});

export const reviewed: RequestHandler = asyncHandler(async (request, response) => {
  const proposal = await recordFixProposalReview(
    request.params.projectId,
    request.user!.id,
    request.params.proposalId
  );
  response.status(200).json({ data: { proposal } });
});

export const apply: RequestHandler = asyncHandler(async (request, response) => {
  const proposal = await applyApprovedFixProposal(
    request.params.projectId,
    request.user!.id,
    request.params.proposalId
  );
  response.status(200).json({ data: { proposal } });
});
