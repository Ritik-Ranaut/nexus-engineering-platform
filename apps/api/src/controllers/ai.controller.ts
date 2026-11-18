import type { RequestHandler } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { checkAIProviderHealth, embedText, generateText } from "../services/ai.service.js";
import { asyncHandler } from "../utils/async-handler.js";

export const health: RequestHandler = asyncHandler(async (_request, response) => {
  try {
    const provider = await checkAIProviderHealth();
    const status = provider.connected && provider.chatModel.available &&
      provider.embeddingModel.available && provider.embeddingModel.capable;
    response.status(status ? 200 : 503).json({
      data: {
        provider: provider.provider,
        ollama: {
          connected: provider.connected,
          chatModelAvailable: provider.chatModel.available,
          embeddingModelAvailable: provider.embeddingModel.available && provider.embeddingModel.capable
        },
        models: {
          chat: provider.chatModel.name,
          embedding: provider.embeddingModel.name
        }
      }
    });
  } catch (error) {
    console.warn("Ollama health check failed", {
      errorType: error instanceof Error ? error.name : "UnknownError",
      timedOut: error instanceof Error && error.name === "TimeoutError"
    });
    response.status(503).json({
      data: {
        provider: env.AI_PROVIDER,
        ollama: {
          connected: false,
          chatModelAvailable: false,
          embeddingModelAvailable: false
        },
        models: { chat: env.OLLAMA_CHAT_MODEL, embedding: env.OLLAMA_EMBEDDING_MODEL }
      }
    });
  }
});

const playgroundSchema = z.object({
  prompt: z.string().trim().min(1).max(2_000)
}).strict();

export const playground: RequestHandler = asyncHandler(async (request, response) => {
  const { prompt } = playgroundSchema.parse(request.body);
  const text = await generateText(prompt);
  const embedding = await embedText(prompt);
  response.status(200).json({
    data: {
      provider: env.AI_PROVIDER,
      chatModel: env.OLLAMA_CHAT_MODEL,
      embeddingModel: env.OLLAMA_EMBEDDING_MODEL,
      text,
      embeddingDimensions: embedding.length
    }
  });
});
