import type { Embeddings } from "@langchain/core/embeddings";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

export interface AIProviderHealth {
  provider: string;
  connected: boolean;
  chatModel: { name: string; available: boolean };
  embeddingModel: { name: string; available: boolean; capable: boolean };
}

export interface AIProvider {
  readonly name: string;
  createChatModel(signal?: AbortSignal): BaseChatModel;
  createEmbeddingModel(signal?: AbortSignal): Embeddings;
  checkHealth(): Promise<AIProviderHealth>;
}
