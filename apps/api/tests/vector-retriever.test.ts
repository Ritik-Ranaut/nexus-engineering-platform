import { afterEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { CodeChunk } from "../src/models/code-chunk.model.js";
import { createEmbeddingModel } from "../src/services/ollama.service.js";
import { retrieveProjectContext } from "../src/services/vector-retriever.service.js";
import type { ProjectDocument } from "../src/services/project.service.js";

vi.mock("../src/services/ollama.service.js", () => ({
  createEmbeddingModel: vi.fn(),
  createChatModel: vi.fn(),
  checkOllamaHealth: vi.fn()
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(createEmbeddingModel).mockReset();
});

describe("project vector retrieval", () => {
  it("embeds the query, returns source metadata, and scopes the Atlas search", async () => {
    vi.mocked(createEmbeddingModel).mockReturnValue({
      embedQuery: vi.fn().mockResolvedValue([0.1, 0.2, 0.3])
    } as unknown as ReturnType<typeof createEmbeddingModel>);
    const aggregateResult = {
      exec: vi.fn().mockResolvedValue([{
        _id: new mongoose.Types.ObjectId(),
        fileId: "file-auth",
        chunkId: "file-auth:0",
        filePath: "src/auth.ts",
        language: "typescript",
        symbolContext: "verifyToken",
        lineStart: 10,
        lineEnd: 16,
        startLine: 10,
        endLine: 16,
        content: "return jwt.verify(token, key);",
        score: 0.87
      }])
    };
    const aggregate = vi.spyOn(CodeChunk, "aggregate").mockReturnValue(
      aggregateResult as unknown as ReturnType<typeof CodeChunk.aggregate>
    );
    const project = {
      _id: new mongoose.Types.ObjectId(),
      activeGeneration: 4
    } as unknown as ProjectDocument;

    const result = await retrieveProjectContext(project, "owner-1", "How is the JWT checked?", 2);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      fileId: "file-auth",
      chunkId: "file-auth:0",
      filePath: "src/auth.ts",
      symbolContext: "verifyToken",
      lineStart: 10,
      lineEnd: 16,
      startLine: 10,
      endLine: 16,
      score: 0.87
    });
    const pipeline = aggregate.mock.calls[0]?.[0];
    expect(pipeline?.[0]?.$vectorSearch?.filter).toMatchObject({
      $and: [
        { projectId: { $eq: String(project._id) } },
        { ownerId: { $eq: "owner-1" } },
        { generation: { $eq: 4 } }
      ]
    });
  });

  it("returns an empty result without inventing chunks", async () => {
    vi.mocked(createEmbeddingModel).mockReturnValue({
      embedQuery: vi.fn().mockResolvedValue([0.1, 0.2, 0.3])
    } as unknown as ReturnType<typeof createEmbeddingModel>);
    vi.spyOn(CodeChunk, "aggregate").mockReturnValue({
      exec: vi.fn().mockResolvedValue([])
    } as unknown as ReturnType<typeof CodeChunk.aggregate>);
    const project = {
      _id: new mongoose.Types.ObjectId(),
      activeGeneration: 1
    } as unknown as ProjectDocument;

    await expect(retrieveProjectContext(project, "owner-1", "unmatched question"))
      .resolves.toEqual([]);
  });
});
