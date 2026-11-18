import type { RequestHandler } from "express";
import { chatSchema } from "../validators/project.validators.js";
import { getOwnedProject } from "../services/project.service.js";
import { streamProjectAnswer } from "../services/project-chat.service.js";
import { asyncHandler } from "../utils/async-handler.js";

const sendEvent = (response: Parameters<RequestHandler>[1], event: string, data: unknown) => {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};

export const chat: RequestHandler = asyncHandler(async (request, response) => {
  const input = chatSchema.parse(request.body);
  const project = await getOwnedProject(request.params.projectId, request.user!.id);
  const controller = new AbortController();
  response.status(200);
  response.set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  response.flushHeaders();
  response.on("close", () => {
    if (!response.writableEnded) controller.abort();
  });

  try {
    const result = await streamProjectAnswer({
      project,
      ownerId: request.user!.id,
      question: input.question,
      topK: input.topK,
      signal: controller.signal,
      onSources: (sources) => sendEvent(response, "sources", { sources }),
      onToken: (text) => sendEvent(response, "token", { text })
    });
    sendEvent(response, "done", result);
    response.end();
  } catch (error) {
    if (response.writableEnded || controller.signal.aborted) return;
    const statusCode = error instanceof Error && "statusCode" in error
      ? Number(error.statusCode)
      : 503;
    const code = error instanceof Error && "code" in error
      ? String(error.code)
      : "AI_REQUEST_FAILED";
    const message = error instanceof Error ? error.message : "The AI request failed";
    console.warn("Project chat stream failed", { projectId: request.params.projectId, code });
    sendEvent(response, "error", { statusCode, code, message });
    response.end();
  }
});
