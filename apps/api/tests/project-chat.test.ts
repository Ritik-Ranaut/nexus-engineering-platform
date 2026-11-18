import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { AIMessageChunk } from "@langchain/core/messages";
import type { ProjectDocument } from "../src/services/project.service.js";
import { streamProjectAnswer } from "../src/services/project-chat.service.js";
import { AIRequest } from "../src/models/ai-request.model.js";
import { Project } from "../src/models/project.model.js";
import { User } from "../src/models/user.model.js";
import { CodeChunk } from "../src/models/code-chunk.model.js";
import { aiProvider } from "../src/services/ai-provider.js";
import { retrieveProjectContext } from "../src/services/vector-retriever.service.js";

vi.mock("../src/services/ai-provider.js", () => ({
  aiProvider: {
    name: "test-provider",
    createChatModel: vi.fn(),
    createEmbeddingModel: vi.fn(),
    checkHealth: vi.fn()
  }
}));
vi.mock("../src/services/vector-retriever.service.js", () => ({
  retrieveProjectContext: vi.fn(),
  buildVectorSearchPipeline: vi.fn()
}));

let database: MongoMemoryServer;

beforeAll(async () => {
  database = await MongoMemoryServer.create();
  await mongoose.connect(database.getUri());
});

afterEach(async () => {
  await Promise.all([
    AIRequest.deleteMany({}),
    Project.deleteMany({}),
    User.deleteMany({}),
    CodeChunk.deleteMany({})
  ]);
  vi.mocked(aiProvider.createChatModel).mockReset();
  vi.mocked(retrieveProjectContext).mockReset();
});

afterAll(async () => {
  await mongoose.disconnect();
  await database.stop();
});

describe("project chat streaming", () => {
  it("streams model output and returns only citations from retrieved sources", async () => {
    const user = await User.create({
      name: "Chat Tester",
      email: "chat@example.com",
      passwordHash: "hashed-password"
    });
    const project = await Project.create({ ownerId: user._id, name: "Auth service" });
    project.activeGeneration = 1;
    await project.save();

    vi.mocked(retrieveProjectContext).mockResolvedValue([{
      id: "chunk-1",
      filePath: "src/auth.ts",
      language: "typescript",
      symbolContext: "verifyToken",
      startLine: 10,
      endLine: 16,
      content: "export function verifyToken() { return jwt.verify(token, key); }",
      score: 0.91
    }]);
    const chunks = (async function* () {
      yield new AIMessageChunk({ content: "JWT validation is in src/auth.ts at lines 10-16 [S1]. " });
      yield new AIMessageChunk({ content: "Unsupported source src/missing.ts [S9]." });
    })();
    vi.mocked(aiProvider.createChatModel).mockReturnValue({
      stream: vi.fn().mockResolvedValue(chunks)
    } as never);

    const streamed: string[] = [];
    const result = await streamProjectAnswer({
      project: project as ProjectDocument,
      ownerId: String(user._id),
      question: "Where is JWT validation?",
      signal: new AbortController().signal,
      onSources: () => undefined,
      onToken: (token) => streamed.push(token)
    });

    expect(streamed.join("")).not.toContain("[S9]");
    expect(streamed.join("")).not.toContain("src/missing.ts");
    expect(result.answer).toContain("[S1]");
    expect(result.answer).toContain("src/auth.ts");
    expect(result.answer).not.toContain("[S9]");
    expect(result.answer).not.toContain("src/missing.ts");
    expect(result.answer).toContain("[unverified file reference omitted]");
    expect(result.sources.map((source) => source.filePath)).toEqual(["src/auth.ts"]);
    expect(await AIRequest.countDocuments({ status: "success" })).toBe(1);
  });

  it("returns an explicit safe limitation when no chunks are retrieved", async () => {
    const user = await User.create({
      name: "Chat Tester",
      email: "empty@example.com",
      passwordHash: "hashed-password"
    });
    const project = await Project.create({ ownerId: user._id, name: "Empty project", activeGeneration: 1 });
    vi.mocked(retrieveProjectContext).mockResolvedValue([]);

    const result = await streamProjectAnswer({
      project,
      ownerId: String(user._id),
      question: "Where is payment configuration?",
      signal: new AbortController().signal,
      onSources: () => undefined,
      onToken: () => undefined
    });

    expect(result.sources).toEqual([]);
    expect(result.limitations[0]).toMatch(/No relevant chunks/);
    expect(aiProvider.createChatModel).not.toHaveBeenCalled();
  });

  it("surfaces a safe error when the configured chat model is unavailable", async () => {
    const user = await User.create({
      name: "Chat Tester",
      email: "offline@example.com",
      passwordHash: "hashed-password"
    });
    const project = await Project.create({ ownerId: user._id, name: "Offline model", activeGeneration: 1 });
    vi.mocked(retrieveProjectContext).mockResolvedValue([{
      id: "chunk-1",
      filePath: "src/auth.ts",
      language: "typescript",
      symbolContext: "verifyToken",
      startLine: 1,
      endLine: 1,
      content: "export function verifyToken() {}",
      score: 0.8
    }]);
    vi.mocked(aiProvider.createChatModel).mockReturnValue({
      stream: vi.fn().mockRejectedValue(new Error("connection refused"))
    } as never);

    await expect(streamProjectAnswer({
      project,
      ownerId: String(user._id),
      question: "Where is authentication?",
      signal: new AbortController().signal,
      onSources: () => undefined,
      onToken: () => undefined
    })).rejects.toMatchObject({
      code: "AI_GENERATION_FAILED",
      statusCode: 503,
      message: "The local AI model could not complete this request"
    });
    expect(await AIRequest.countDocuments({ status: "failed" })).toBe(1);
  });

  it("uses a safe fallback when generated citations and file/line references are unsupported", async () => {
    const user = await User.create({
      name: "Chat Tester",
      email: "unsupported-citation@example.com",
      passwordHash: "hashed-password"
    });
    const project = await Project.create({ ownerId: user._id, name: "Evidence project", activeGeneration: 1 });
    vi.mocked(retrieveProjectContext).mockResolvedValue([{
      id: "chunk-1",
      fileId: "file-auth",
      chunkId: "file-auth:0",
      filePath: "src/auth.ts",
      language: "typescript",
      symbolContext: "verifyToken",
      startLine: 10,
      endLine: 16,
      lineStart: 10,
      lineEnd: 16,
      content: "export function verifyToken() {}",
      score: 0.8
    }]);
    const chunks = (async function* () {
      yield new AIMessageChunk({
        content: "Authentication is implemented in src/missing.ts at lines 400-500 [S9]."
      });
    })();
    vi.mocked(aiProvider.createChatModel).mockReturnValue({
      stream: vi.fn().mockResolvedValue(chunks)
    } as never);

    const result = await streamProjectAnswer({
      project,
      ownerId: String(user._id),
      question: "Where is authentication?",
      signal: new AbortController().signal,
      onSources: () => undefined,
      onToken: () => undefined
    });
    expect(result.answer).toContain("couldn't form a source-backed answer");
    expect(result.answer).not.toContain("src/missing.ts");
    expect(result.answer).not.toContain("400-500");
    expect(result.sources.map((source) => source.filePath)).toEqual(["src/auth.ts"]);
  });
});
