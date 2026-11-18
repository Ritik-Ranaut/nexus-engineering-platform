import { aiProvider } from "./ai-provider.js";

export const createEmbeddingModel = (signal?: AbortSignal) =>
  aiProvider.createEmbeddingModel(signal);

export const createChatModel = (signal?: AbortSignal) =>
  aiProvider.createChatModel(signal);

export const checkOllamaHealth = () => aiProvider.checkHealth();
