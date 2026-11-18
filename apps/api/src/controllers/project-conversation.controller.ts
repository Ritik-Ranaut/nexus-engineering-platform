import type { RequestHandler } from "express";
import {
  conversationMessageSchema,
  conversationSchema
} from "../validators/project.validators.js";
import {
  createProjectConversation,
  getOwnedProjectConversation,
  getProjectConversationMessages,
  getRecentConversationHistory,
  listProjectConversations,
  saveProjectMessage
} from "../services/project-conversation.service.js";
import { getOwnedProject } from "../services/project.service.js";
import { streamProjectAnswer } from "../services/project-chat.service.js";
import { asyncHandler } from "../utils/async-handler.js";

const sendEvent = (response: Parameters<RequestHandler>[1], event: string, data: unknown) => {
  if (!response.writableEnded && !response.destroyed) {
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
};

export const create: RequestHandler = asyncHandler(async (request, response) => {
  const { title } = conversationSchema.parse(request.body);
  const conversation = await createProjectConversation(
    request.params.projectId,
    request.user!.id,
    title
  );
  response.status(201).json({ data: { conversation } });
});

export const list: RequestHandler = asyncHandler(async (request, response) => {
  const conversations = await listProjectConversations(
    request.params.projectId,
    request.user!.id
  );
  response.status(200).json({ data: { conversations } });
});

export const messages: RequestHandler = asyncHandler(async (request, response) => {
  const result = await getProjectConversationMessages(
    request.params.projectId,
    request.user!.id,
    request.params.conversationId
  );
  response.status(200).json({ data: { messages: result } });
});

export const sendMessage: RequestHandler = asyncHandler(async (request, response) => {
  const input = conversationMessageSchema.parse(request.body);
  const project = await getOwnedProject(request.params.projectId, request.user!.id);
  const conversation = await getOwnedProjectConversation(
    request.params.projectId,
    request.user!.id,
    request.params.conversationId
  );
  const ownerId = request.user!.id;
  const history = await getRecentConversationHistory(
    request.params.projectId,
    ownerId,
    String(conversation._id)
  );
  await saveProjectMessage({
    ownerId,
    projectId: String(project._id),
    conversationId: String(conversation._id),
    role: "user",
    content: input.question,
    status: "completed"
  });
  if (conversation.title === "New conversation") {
    conversation.title = input.question.slice(0, 100);
    await conversation.save();
  }

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

  let responseSources: Parameters<typeof saveProjectMessage>[0]["sources"] = [];
  try {
    const result = await streamProjectAnswer({
      project,
      ownerId,
      question: input.question,
      history,
      topK: input.topK,
      signal: controller.signal,
      onSources: (sources) => {
        responseSources = sources;
        sendEvent(response, "sources", { sources });
      },
      onToken: (text) => sendEvent(response, "token", { text })
    });
    const assistantMessage = await saveProjectMessage({
      ownerId,
      projectId: String(project._id),
      conversationId: String(conversation._id),
      role: "assistant",
      content: result.answer,
      status: "completed",
      sources: result.sources,
      model: result.model,
      latencyMs: result.latencyMs
    });
    sendEvent(response, "done", { ...result, conversationId: String(conversation._id), messageId: assistantMessage.id });
    response.end();
  } catch (error) {
    const statusCode = error instanceof Error && "statusCode" in error
      ? Number(error.statusCode)
      : 503;
    const code = error instanceof Error && "code" in error
      ? String(error.code)
      : "AI_REQUEST_FAILED";
    const message = error instanceof Error ? error.message : "The AI request failed";
    if (!controller.signal.aborted) {
      await saveProjectMessage({
        ownerId,
        projectId: String(project._id),
        conversationId: String(conversation._id),
        role: "assistant",
        content: message,
        status: "failed",
        sources: responseSources,
        errorCode: code
      });
      sendEvent(response, "error", { statusCode, code, message });
      response.end();
    }
  }
});
