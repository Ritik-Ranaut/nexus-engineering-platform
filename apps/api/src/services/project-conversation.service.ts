import { ProjectConversation } from "../models/project-conversation.model.js";
import { ProjectMessage } from "../models/project-message.model.js";
import { AppError } from "../utils/app-error.js";
import { getOwnedProject } from "./project.service.js";

const conversationFilter = (conversationId: string, projectId: string, ownerId: string) => ({
  _id: conversationId,
  projectId,
  ownerId
});

export const createProjectConversation = async (
  projectId: string,
  ownerId: string,
  title?: string
) => {
  await getOwnedProject(projectId, ownerId);
  const conversation = await ProjectConversation.create({
    projectId,
    ownerId,
    title: title?.trim() || "New conversation",
    lastMessageAt: new Date()
  });
  return {
    id: String(conversation._id),
    projectId: conversation.projectId,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    lastMessageAt: conversation.lastMessageAt
  };
};

export const listProjectConversations = async (projectId: string, ownerId: string) => {
  await getOwnedProject(projectId, ownerId);
  const conversations = await ProjectConversation.find({ projectId, ownerId })
    .sort({ lastMessageAt: -1 })
    .limit(50)
    .lean();
  return conversations.map((conversation) => ({
    id: String(conversation._id),
    projectId: conversation.projectId,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    lastMessageAt: conversation.lastMessageAt
  }));
};

export const getProjectConversationMessages = async (
  projectId: string,
  ownerId: string,
  conversationId: string
) => {
  await getOwnedProject(projectId, ownerId);
  const conversation = await ProjectConversation.findOne(
    conversationFilter(conversationId, projectId, ownerId)
  );
  if (!conversation) {
    throw new AppError(404, "Conversation not found", "CONVERSATION_NOT_FOUND");
  }
  const messages = await ProjectMessage.find({ projectId, ownerId, conversationId })
    .sort({ createdAt: 1, _id: 1 })
    .limit(200)
    .lean();
  return messages.map((message) => ({
    id: String(message._id),
    role: message.role,
    content: message.content,
    status: message.status,
    sources: message.sources,
    model: message.model,
    latencyMs: message.latencyMs,
    createdAt: message.createdAt
  }));
};

export const getOwnedProjectConversation = async (
  projectId: string,
  ownerId: string,
  conversationId: string
) => {
  await getOwnedProject(projectId, ownerId);
  const conversation = await ProjectConversation.findOne(
    conversationFilter(conversationId, projectId, ownerId)
  );
  if (!conversation) {
    throw new AppError(404, "Conversation not found", "CONVERSATION_NOT_FOUND");
  }
  return conversation;
};

export const saveProjectMessage = async (input: {
  ownerId: string;
  projectId: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  status: "completed" | "failed";
  sources?: {
    label: string;
    filePath: string;
    language: string;
    symbolContext: string;
    startLine: number;
    endLine: number;
    score: number;
  }[];
  model?: string;
  latencyMs?: number;
  errorCode?: string;
}) => {
  const message = await ProjectMessage.create(input);
  await ProjectConversation.updateOne(
    { _id: input.conversationId, projectId: input.projectId, ownerId: input.ownerId },
    { $set: { lastMessageAt: message.createdAt } }
  );
  return {
    id: String(message._id),
    role: message.role,
    content: message.content,
    status: message.status,
    sources: message.sources,
    model: message.model,
    latencyMs: message.latencyMs,
    createdAt: message.createdAt
  };
};

export const getRecentConversationHistory = async (
  projectId: string,
  ownerId: string,
  conversationId: string,
  limit = 12
) => {
  const messages = await ProjectMessage.find({
    projectId,
    ownerId,
    conversationId,
    status: "completed"
  })
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit)
    .select("role content")
    .lean();
  return messages.reverse().map((message) => ({
    role: message.role as "user" | "assistant",
    content: message.content
  }));
};
