import { describe, expect, it, vi } from "vitest";
import { embedChunks, retryEmbeddingOperation } from "../src/services/embedding.service.js";
import { createEmbeddingModel } from "../src/services/ollama.service.js";
import type { CodeChunk } from "../src/services/code-chunker.service.js";

vi.mock("../src/services/ollama.service.js", () => ({
  createEmbeddingModel: vi.fn()
}));

describe("embedding request reliability", () => {
  it("retries transient embedding failures and returns the successful result", async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error("temporary model failure"))
      .mockResolvedValueOnce([[0.1, 0.2, 0.3]]);
    const result = await retryEmbeddingOperation(operation, 1);
    expect(result).toEqual([[0.1, 0.2, 0.3]]);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("returns an explicit model-unavailable error when retries are exhausted", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(retryEmbeddingOperation(
      () => Promise.reject(new Error("offline")),
      0
    )).rejects.toMatchObject({ code: "EMBEDDING_UNAVAILABLE", statusCode: 503 });
    warning.mockRestore();
  });

  it("embeds source chunks in asynchronous batches and checks vector dimensions", async () => {
    const embedDocuments = vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]);
    vi.mocked(createEmbeddingModel).mockReturnValue({
      embedDocuments
    } as unknown as ReturnType<typeof createEmbeddingModel>);
    const chunks: CodeChunk[] = [{
      filePath: "src/auth.ts",
      language: "typescript",
      symbolContext: "verifyToken",
      startLine: 1,
      endLine: 2,
      content: "export function verifyToken() {}"
    }];

    await expect(embedChunks(chunks)).resolves.toEqual([[0.1, 0.2, 0.3]]);
    expect(embedDocuments).toHaveBeenCalledWith([chunks[0]?.content]);

    embedDocuments.mockResolvedValueOnce([[0.1, 0.2]]);
    await expect(embedChunks(chunks)).rejects.toMatchObject({
      code: "EMBEDDING_DIMENSION_MISMATCH",
      statusCode: 502
    });
  });
});
