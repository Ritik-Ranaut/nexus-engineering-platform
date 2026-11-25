import { env } from "../config/env.js";
import type { CodeChunk as ChunkInput } from "./code-chunker.service.js";
import { createEmbeddingModel } from "./ollama.service.js";
import { AppError } from "../utils/app-error.js";

const wait = (milliseconds: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new Error("Embedding request cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });

export const retryEmbeddingOperation = async <T>(
  operation: () => Promise<T>,
  retries = env.AI_EMBEDDING_RETRIES,
  signal?: AbortSignal
): Promise<T> => {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal?.aborted) throw signal.reason ?? new Error("Embedding request cancelled");
    try {
      return await operation();
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
      const contextOverflow = error instanceof Error &&
        /context (?:length|window)|too many tokens|maximum context/i.test(error.message);
      console.warn("Embedding request failed", {
        model: env.OLLAMA_EMBEDDING_MODEL,
        attempt: attempt + 1,
        willRetry: attempt < retries && !contextOverflow,
        errorType: error instanceof Error ? error.name : "UnknownError"
      });
      if (contextOverflow) break;
      if (attempt < retries) await wait(250 * 2 ** attempt, signal);
    }
  }
  if (
    lastError instanceof Error &&
    /context (?:length|window)|too many tokens|maximum context/i.test(lastError.message)
  ) {
    throw new AppError(413, "A source chunk exceeded the configured embedding context window", "EMBEDDING_CONTEXT_OVERFLOW");
  }
  if (
    lastError instanceof Error &&
    (lastError.name === "TimeoutError" || /timed out|timeout/i.test(lastError.message))
  ) {
    throw new AppError(504, "The local embedding model request timed out", "AI_TIMEOUT");
  }
  throw new AppError(503, "The configured embedding model is unavailable", "EMBEDDING_UNAVAILABLE");
};

export const embedChunks = async (chunks: ChunkInput[]): Promise<number[][]> => {
  const embeddings = createEmbeddingModel();
  const vectors: number[][] = [];
  for (let offset = 0; offset < chunks.length; offset += 16) {
    const batch = chunks.slice(offset, offset + 16);
    const startedAt = Date.now();
    let batchVectors: number[][];
    try {
      batchVectors = await retryEmbeddingOperation(() =>
        embeddings.embedDocuments(batch.map((chunk) => {
          // Bound input text safely to max 3,000 characters to prevent context window overflow
          return chunk.content.length > 3_000 ? chunk.content.slice(0, 3_000) : chunk.content;
        }))
      );
    } catch (error) {
      const isContextOverflow =
        (error instanceof AppError && error.code === "EMBEDDING_CONTEXT_OVERFLOW") ||
        (error instanceof Error && /context (?:length|window)|too many tokens|maximum context/i.test(error.message));
      if (!isContextOverflow) throw error;

      console.warn("Embedding batch exceeded context window; falling back to bounded chunk embedding", {
        batchSize: batch.length,
        model: env.OLLAMA_EMBEDDING_MODEL
      });
      batchVectors = [];
      for (const chunk of batch) {
        const boundedContent = chunk.content.length > 2_000 ? chunk.content.slice(0, 2_000) : chunk.content;
        const single = await retryEmbeddingOperation(() => embeddings.embedDocuments([boundedContent]));
        if (single[0]) batchVectors.push(single[0]);
      }
    }
    if (batchVectors.length !== batch.length) {
      throw new AppError(502, "Embedding model returned an invalid response", "INVALID_EMBEDDING_RESPONSE");
    }
    if (batchVectors.some((vector) =>
      vector.length !== env.AI_VECTOR_DIMENSIONS || vector.some((value) => !Number.isFinite(value))
    )) {
      throw new AppError(
        502,
        "Embedding dimensions do not match the configured vector index",
        "EMBEDDING_DIMENSION_MISMATCH"
      );
    }
    console.info("Code chunks embedded", {
      model: env.OLLAMA_EMBEDDING_MODEL,
      count: batch.length,
      latencyMs: Date.now() - startedAt
    });
    vectors.push(...batchVectors);
  }
  return vectors;
};
