import type { RequestHandler } from "express";
import { semanticSearchSchema } from "../validators/project.validators.js";
import { semanticSearch } from "../services/vector-retriever.service.js";
import { asyncHandler } from "../utils/async-handler.js";

export const search: RequestHandler = asyncHandler(async (request, response) => {
  const input = semanticSearchSchema.parse(request.body);
  const results = await semanticSearch(
    request.params.projectId,
    request.user!.id,
    input.query,
    input.topK,
    {
      ...(input.fileId ? { fileId: input.fileId } : {}),
      ...(input.filePath ? { filePath: input.filePath } : {}),
      ...(input.language ? { language: input.language } : {})
    }
  );
  response.status(200).json({ data: { results } });
});
