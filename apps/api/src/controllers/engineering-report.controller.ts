import type { RequestHandler } from "express";
import { asyncHandler } from "../utils/async-handler.js";
import {
  createReportSchema,
  listReportsSchema
} from "../validators/report.validators.js";
import {
  deleteEngineeringReport,
  generateEngineeringReport,
  getEngineeringReport,
  getMissionEngineeringReport,
  listEngineeringReports
} from "../services/engineering-report.service.js";

export const generate: RequestHandler = asyncHandler(async (request, response) => {
  const input = createReportSchema.parse(request.body);
  const report = await generateEngineeringReport(
    request.params.projectId,
    request.user!.id,
    input
  );
  response.status(201).json({ data: { report } });
});

export const list: RequestHandler = asyncHandler(async (request, response) => {
  const filter = listReportsSchema.parse(request.query);
  const result = await listEngineeringReports(
    request.params.projectId,
    request.user!.id,
    filter
  );
  response.status(200).json({ data: result });
});

export const get: RequestHandler = asyncHandler(async (request, response) => {
  const report = await getEngineeringReport(
    request.params.projectId,
    request.user!.id,
    request.params.reportId
  );
  response.status(200).json({ data: { report } });
});

export const missionReport: RequestHandler = asyncHandler(async (request, response) => {
  const report = await getMissionEngineeringReport(
    request.params.projectId,
    request.user!.id,
    request.params.missionId
  );
  response.status(200).json({ data: { report } });
});

export const generateMissionReport: RequestHandler = asyncHandler(async (request, response) => {
  const report = await generateEngineeringReport(
    request.params.projectId,
    request.user!.id,
    { reportType: "mission", missionId: request.params.missionId }
  );
  response.status(201).json({ data: { report } });
});

export const remove: RequestHandler = asyncHandler(async (request, response) => {
  await deleteEngineeringReport(
    request.params.projectId,
    request.user!.id,
    request.params.reportId
  );
  response.status(204).end();
});
