import { ChatOllama, OllamaEmbeddings } from "@langchain/ollama";
import { env } from "../config/env.js";
import type { AIProvider, AIProviderHealth } from "./ai-provider.types.js";

const fetchWithTimeout = (additionalSignal?: AbortSignal): typeof fetch => (input, init) => {
  const timeoutSignal = AbortSignal.timeout(env.AI_REQUEST_TIMEOUT_MS);
  const signals = [init?.signal, additionalSignal, timeoutSignal].filter(
    (signal): signal is AbortSignal => signal !== undefined
  );
  const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
  return fetch(input, { ...init, signal }).catch((error: unknown) => {
    if (additionalSignal?.aborted) throw error;
    if (timeoutSignal.aborted) throw timeoutSignal.reason;
    throw error;
  });
};

const modelNameMatches = (installed: string, configured: string) =>
  installed === configured || installed.startsWith(`${configured}:`);

interface ModelTag {
  name: string;
}

const parseModelTags = (body: unknown): ModelTag[] => {
  if (typeof body !== "object" || body === null || !("models" in body) ||
      !Array.isArray(body.models)) return [];
  return body.models.flatMap((model: unknown) =>
    typeof model === "object" && model !== null && "name" in model &&
      typeof model.name === "string" ? [{ name: model.name }] : []
  );
};

const inspectModelCapabilities = async (model: string): Promise<string[]> => {
  const response = await fetchWithTimeout()(new URL("/api/show", env.OLLAMA_BASE_URL), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model })
  });
  if (!response.ok) return [];
  const body: unknown = await response.json();
  return typeof body === "object" && body !== null && "capabilities" in body &&
      Array.isArray(body.capabilities)
    ? body.capabilities.filter((capability: unknown): capability is string =>
      typeof capability === "string"
    )
    : [];
};

export class OllamaProvider implements AIProvider {
  readonly name = "ollama";

  createEmbeddingModel(signal?: AbortSignal) {
    return new OllamaEmbeddings({
      model: env.OLLAMA_EMBEDDING_MODEL,
      baseUrl: env.OLLAMA_BASE_URL,
      dimensions: env.AI_VECTOR_DIMENSIONS,
      fetch: fetchWithTimeout(signal)
    });
  }

  createChatModel(signal?: AbortSignal) {
    return new ChatOllama({
      model: env.OLLAMA_CHAT_MODEL,
      baseUrl: env.OLLAMA_BASE_URL,
      temperature: 0,
      streaming: true,
      think: false,
      fetch: fetchWithTimeout(signal)
    });
  }

  async checkHealth(): Promise<AIProviderHealth> {
    const response = await fetchWithTimeout()(new URL("/api/tags", env.OLLAMA_BASE_URL));
    if (!response.ok) {
      return {
        provider: this.name,
        connected: false,
        chatModel: { name: env.OLLAMA_CHAT_MODEL, available: false },
        embeddingModel: {
          name: env.OLLAMA_EMBEDDING_MODEL,
          available: false,
          capable: false
        }
      };
    }

    const tags = parseModelTags(await response.json());
    const chatTag = tags.find((tag) => modelNameMatches(tag.name, env.OLLAMA_CHAT_MODEL));
    const embeddingTag = tags.find((tag) => modelNameMatches(tag.name, env.OLLAMA_EMBEDDING_MODEL));
    const embeddingCapabilities = embeddingTag
      ? await inspectModelCapabilities(embeddingTag.name)
      : [];
    return {
      provider: this.name,
      connected: true,
      chatModel: { name: env.OLLAMA_CHAT_MODEL, available: chatTag !== undefined },
      embeddingModel: {
        name: env.OLLAMA_EMBEDDING_MODEL,
        available: embeddingTag !== undefined,
        capable: embeddingCapabilities.includes("embedding")
      }
    };
  }
}
