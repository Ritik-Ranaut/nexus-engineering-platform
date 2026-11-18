import { HumanMessage } from "@langchain/core/messages";
import type { AIMessageChunk, BaseMessage } from "@langchain/core/messages";
import { env } from "../config/env.js";
import { AppError } from "../utils/app-error.js";
import { aiProvider } from "./ai-provider.js";
import { retryEmbeddingOperation } from "./embedding.service.js";

const isTimeoutError = (error: unknown) =>
  error instanceof Error &&
  (error.name === "TimeoutError" || error.name === "AbortError" &&
    /timeout|timed out/i.test(error.message));

const wait = (milliseconds: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new Error("AI request cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });

const logRetry = (operation: string, attempt: number, willRetry: boolean, error: unknown) => {
  console.warn("AI provider request failed", {
    provider: aiProvider.name,
    operation,
    attempt,
    willRetry,
    errorType: error instanceof Error ? error.name : "UnknownError"
  });
};

const providerError = (error: unknown): AppError => isTimeoutError(error)
  ? new AppError(504, "The local AI model request timed out", "AI_TIMEOUT")
  : new AppError(503, "The local AI model could not complete this request", "AI_GENERATION_FAILED");

export const invokeWithRetry = async <T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
  retries = env.AI_CHAT_RETRIES
): Promise<T> => {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal?.aborted) throw signal.reason ?? new AppError(499, "AI request cancelled", "REQUEST_CANCELLED");
    try {
      return await operation();
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
      logRetry("invoke", attempt + 1, attempt < retries, error);
      if (attempt < retries) await wait(250 * 2 ** attempt, signal);
    }
  }
  throw providerError(lastError);
};

export const generateText = async (prompt: string, signal?: AbortSignal) => {
  const result = await invokeWithRetry(
    () => aiProvider.createChatModel(signal).invoke([new HumanMessage(prompt)], { signal }),
    signal
  );
  const content = result.content;
  if (typeof content === "string" && content.trim()) return content.trim();
  if (Array.isArray(content)) {
    const text = content.flatMap((part) =>
      typeof part === "object" && part !== null && "type" in part &&
        part.type === "text" && "text" in part && typeof part.text === "string"
        ? [part.text]
        : []
    ).join("").trim();
    if (text) return text;
  }
  throw new AppError(502, "The configured chat model returned an empty response", "EMPTY_MODEL_RESPONSE");
};

export const embedText = async (text: string, signal?: AbortSignal) => {
  const embedding = await retryEmbeddingOperation(
    () => aiProvider.createEmbeddingModel(signal).embedQuery(text),
    env.AI_EMBEDDING_RETRIES,
    signal
  );
  if (
    embedding.length !== env.AI_VECTOR_DIMENSIONS ||
    embedding.some((value) => !Number.isFinite(value))
  ) {
    throw new AppError(
      502,
      "Embedding dimensions do not match the configured vector index",
      "EMBEDDING_DIMENSION_MISMATCH"
    );
  }
  return embedding;
};

export async function* streamChat(
  messages: BaseMessage[],
  signal?: AbortSignal
): AsyncGenerator<AIMessageChunk> {
  for (let attempt = 0; attempt <= env.AI_CHAT_RETRIES; attempt += 1) {
    let emitted = false;
    try {
      const stream = await aiProvider.createChatModel(signal).stream(messages, { signal });
      for await (const chunk of stream) {
        emitted = true;
        yield chunk;
      }
      return;
    } catch (error) {
      if (signal?.aborted) {
        throw new AppError(499, "The AI request was cancelled", "REQUEST_CANCELLED");
      }
      logRetry("stream", attempt + 1, !emitted && attempt < env.AI_CHAT_RETRIES, error);
      if (emitted || attempt >= env.AI_CHAT_RETRIES) throw providerError(error);
      await wait(250 * 2 ** attempt, signal);
    }
  }
}

export const checkAIProviderHealth = () => aiProvider.checkHealth();
