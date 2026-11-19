import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { createApp } from "../src/app.js";
import { User } from "../src/models/user.model.js";
import { Project } from "../src/models/project.model.js";
import { CodeChunk } from "../src/models/code-chunk.model.js";
import { ProjectFile } from "../src/models/project-file.model.js";
import { ProjectArchitecture } from "../src/models/project-architecture.model.js";
import { ProjectConversation } from "../src/models/project-conversation.model.js";
import { ProjectMessage } from "../src/models/project-message.model.js";
import { AIRequest } from "../src/models/ai-request.model.js";
import { AnalysisRun } from "../src/models/analysis-run.model.js";
import { EngineeringIssue } from "../src/models/engineering-issue.model.js";
import { embedChunks } from "../src/services/embedding.service.js";
import { streamProjectAnswer } from "../src/services/project-chat.service.js";
import { aiProvider } from "../src/services/ai-provider.js";
import { createEmbeddingModel } from "../src/services/ollama.service.js";
import { fetchPublicGitHubRepositoryFiles } from "../src/services/github-repository.service.js";
import { AppError } from "../src/utils/app-error.js";

vi.mock("../src/services/embedding.service.js", () => ({
  embedChunks: vi.fn(),
  retryEmbeddingOperation: vi.fn(async (operation: () => Promise<unknown>) => operation())
}));
vi.mock("../src/services/project-chat.service.js", () => ({
  streamProjectAnswer: vi.fn()
}));
vi.mock("../src/services/ollama.service.js", () => ({
  createChatModel: vi.fn(),
  createEmbeddingModel: vi.fn(),
  checkOllamaHealth: vi.fn()
}));
vi.mock("../src/services/ai-provider.js", () => ({
  aiProvider: {
    name: "ollama",
    createChatModel: vi.fn(),
    createEmbeddingModel: vi.fn(),
    checkHealth: vi.fn()
  }
}));
vi.mock("../src/services/github-repository.service.js", () => ({
  fetchPublicGitHubRepositoryFiles: vi.fn(),
  parsePublicGitHubRepositoryUrl: vi.fn((repositoryUrl: string) => {
    const url = new URL(repositoryUrl);
    const segments = url.pathname.split("/").filter(Boolean);
    return {
      owner: segments[0],
      repository: segments[1]?.replace(/\.git$/i, ""),
      branch: segments.length >= 4 ? segments.slice(3).join("/") : undefined
    };
  })
}));

const app = createApp();
let database: MongoMemoryServer;

beforeAll(async () => {
  database = await MongoMemoryServer.create();
  await mongoose.connect(database.getUri());
});

afterEach(async () => {
  await Promise.all([
    User.deleteMany({}),
    Project.deleteMany({}),
    CodeChunk.deleteMany({}),
    ProjectFile.deleteMany({}),
    ProjectArchitecture.deleteMany({}),
    ProjectConversation.deleteMany({}),
    ProjectMessage.deleteMany({}),
    AIRequest.deleteMany({}),
    AnalysisRun.deleteMany({}),
    EngineeringIssue.deleteMany({})
  ]);
  vi.mocked(embedChunks).mockReset();
  vi.mocked(streamProjectAnswer).mockReset();
  vi.mocked(aiProvider.checkHealth).mockReset();
  vi.mocked(fetchPublicGitHubRepositoryFiles).mockReset();
});

afterAll(async () => {
  await mongoose.disconnect();
  await database.stop();
});

const register = async (agent: ReturnType<typeof request.agent>, email: string) =>
  agent.post("/api/auth/register").send({
    name: "Code Engineer",
    email,
    password: "correct-horse-battery"
  }).expect(201);

describe("project context API", () => {
  it("accepts a complete repository import without waiting for indexing", async () => {
    vi.mocked(embedChunks).mockImplementation(async (chunks) =>
      chunks.map(() => [0.1, 0.2, 0.3])
    );
    const repositoryUrl = "https://github.com/acme/service";
    const files = Array.from({ length: 101 }, (_, index) => ({
      path: `packages/service/src/file-${index}.ts`,
      content: `export const value${index} = ${index};`
    }));
    vi.mocked(fetchPublicGitHubRepositoryFiles).mockResolvedValue(files);

    const owner = request.agent(app);
    await register(owner, `github-import-${crypto.randomUUID()}@example.com`);
    const project = await owner.post("/api/projects")
      .send({ name: "GitHub Import", repositoryUrl })
      .expect(201);
    const projectId = project.body.data.project.id as string;

    const imported = await owner.post(`/api/projects/${projectId}/import`)
      .expect(202);

    expect(imported.body.data.status).toBe("indexing");
    await vi.waitFor(async () => {
      expect(await ProjectFile.countDocuments({ projectId, generation: 1 })).toBe(101);
    });
    expect(await ProjectFile.countDocuments({ projectId, generation: 1 })).toBe(101);
    expect(fetchPublicGitHubRepositoryFiles).toHaveBeenCalledWith(
      repositoryUrl,
      expect.any(Function)
    );
  });

  it("stores an asynchronous repository import failure for the project owner", async () => {
    vi.mocked(fetchPublicGitHubRepositoryFiles).mockRejectedValue(
      new AppError(502, "GitHub could not provide this repository", "GITHUB_IMPORT_FAILED")
    );
    const owner = request.agent(app);
    await register(owner, `failed-github-import-${crypto.randomUUID()}@example.com`);
    const project = await owner.post("/api/projects")
      .send({ name: "Unavailable Repository", repositoryUrl: "https://github.com/acme/private" })
      .expect(201);
    const projectId = project.body.data.project.id as string;

    await owner.post(`/api/projects/${projectId}/import`).expect(202);
    await vi.waitFor(async () => {
      const savedProject = await Project.findById(projectId);
      expect(savedProject).toMatchObject({
        indexingStatus: "failed",
        indexingError: "GitHub could not provide this repository"
      });
    });

    const listed = await owner.get("/api/projects").expect(200);
    expect(listed.body.data.projects[0]).toMatchObject({
      id: projectId,
      indexingStatus: "failed",
      indexingError: "GitHub could not provide this repository"
    });
  });

  it("prevents duplicate imports while a repository is being fetched", async () => {
    vi.mocked(embedChunks).mockImplementation(async (chunks) =>
      chunks.map(() => [0.1, 0.2, 0.3])
    );
    let releaseFetch!: (files: { path: string; content: string }[]) => void;
    vi.mocked(fetchPublicGitHubRepositoryFiles).mockReturnValue(
      new Promise((resolve) => { releaseFetch = resolve; })
    );
    const owner = request.agent(app);
    await register(owner, `duplicate-github-import-${crypto.randomUUID()}@example.com`);
    const project = await owner.post("/api/projects")
      .send({ name: "Duplicate Import", repositoryUrl: "https://github.com/acme/service" })
      .expect(201);
    const projectId = project.body.data.project.id as string;

    await owner.post(`/api/projects/${projectId}/import`).expect(202);
    const duplicate = await owner.post(`/api/projects/${projectId}/import`).expect(409);
    expect(duplicate.body.error.code).toBe("INDEXING_IN_PROGRESS");

    releaseFetch([{ path: "src/index.ts", content: "export const ready = true;" }]);
    await vi.waitFor(async () => {
      expect((await Project.findById(projectId))?.indexingStatus).toBe("ready");
    });
  });

  it("requires a repository URL to import a GitHub project", async () => {
    const owner = request.agent(app);
    await register(owner, `missing-github-url-${crypto.randomUUID()}@example.com`);
    const project = await owner.post("/api/projects").send({ name: "No URL" }).expect(201);

    const result = await owner.post(`/api/projects/${project.body.data.project.id}/import`)
      .expect(400);

    expect(result.body.error.code).toBe("REPOSITORY_URL_REQUIRED");
    expect(fetchPublicGitHubRepositoryFiles).not.toHaveBeenCalled();
  });

  it("indexes source chunks and exposes project status to its owner", async () => {
    vi.mocked(embedChunks).mockImplementation(async (chunks) =>
      chunks.map(() => [0.1, 0.2, 0.3])
    );
    const owner = request.agent(app);
    const registration = await register(owner, "owner@example.com");
    const created = await owner.post("/api/projects").send({ name: "Orders API" }).expect(201);
    const projectId = created.body.data.project.id as string;

    const indexed = await owner.post(`/api/projects/${projectId}/index`).send({
      files: [
        { path: "src/orders.ts", content: 'import { saveOrder } from "./services/orders.service.js";\nexport function createOrder() {\n  return saveOrder();\n}' },
        { path: "src/services/orders.service.ts", content: "export function saveOrder() { return true; }" },
        { path: "README.md", content: "# Orders\n\nOrder processing service." }
      ]
    }).expect(200);

    expect(indexed.body.data).toMatchObject({ filesIndexed: 3, architectureNodes: 3 });
    const chunks = await CodeChunk.find({ projectId }).select("+embedding").lean();
    expect(chunks).toHaveLength(4);
    expect(chunks.every((chunk) => chunk.ownerId === registration.body.data.user.id)).toBe(true);
    expect(chunks.every((chunk) => chunk.embedding.length === 3)).toBe(true);
    expect(chunks.every((chunk) =>
      chunk.fileId && chunk.chunkId && chunk.lineStart > 0 && chunk.lineEnd >= chunk.lineStart
    )).toBe(true);
    expect(await ProjectFile.countDocuments({ projectId, generation: 1 })).toBe(3);
    const architecture = await ProjectArchitecture.findOne({ projectId, generation: 1 }).lean();
    expect(architecture?.nodes).toHaveLength(3);
    expect(architecture?.relationships).toContainEqual({
      id: expect.any(String),
      source: "src/orders.ts",
      target: "src/services/orders.service.ts",
      type: "IMPORTS",
      evidence: "./services/orders.service.js",
      sourceOfInference: "static_import",
      confidence: 1,
      verificationStatus: "statically_confirmed"
    });

    expect(architecture?.nodes).toContainEqual(expect.objectContaining({
      id: "src/services/orders.service.ts",
      category: "service"
    }));

    const project = await owner.get(`/api/projects/${projectId}`).expect(200);
    expect(project.body.data.project.indexingStatus).toBe("ready");
    const structure = await owner.get(`/api/projects/${projectId}/structure`).expect(200);
    expect(structure.body.data.structure).toMatchObject({
      fileCount: 3,
      relationshipCount: 1,
      languages: ["markdown", "typescript"]
    });

    const file = await owner.get(`/api/projects/${projectId}/files/content`)
      .query({ path: "src/orders.ts" }).expect(200);
    expect(file.body.data.file).toMatchObject({
      filePath: "src/orders.ts",
      category: "other",
      lineCount: 4
    });
    const search = await owner.get(`/api/projects/${projectId}/files`)
      .query({ search: "saveOrder" }).expect(200);
    expect(search.body.data.files.map((entry: { filePath: string }) => entry.filePath))
      .toContain("src/orders.ts");
    const metadata = await owner.get(`/api/projects/${projectId}/files/metadata`)
      .query({ path: "src/orders.ts" }).expect(200);
    expect(metadata.body.data.metadata).not.toHaveProperty("content");
    expect(metadata.body.data.metadata.symbols).toContain("createOrder");
    const nodes = await owner.get(`/api/projects/${projectId}/architecture/nodes`).expect(200);
    const relationships = await owner.get(`/api/projects/${projectId}/architecture/relationships`).expect(200);
    expect(nodes.body.data.nodes).toHaveLength(3);
    expect(relationships.body.data.relationships).toHaveLength(1);
  });

  it("serves filtered architecture graphs with package evidence and owner-scoped node details", async () => {
    vi.mocked(embedChunks).mockImplementation(async (chunks) =>
      chunks.map(() => [0.1, 0.2, 0.3])
    );
    const owner = request.agent(app);
    await register(owner, `architecture-${crypto.randomUUID()}@example.com`);
    const projectResponse = await owner.post("/api/projects").send({ name: "Graph Project" }).expect(201);
    const projectId = projectResponse.body.data.project.id as string;
    await owner.post(`/api/projects/${projectId}/index`).send({
      files: [
        {
          path: "package.json",
          content: JSON.stringify({ dependencies: { react: "^18.0.0" }, devDependencies: { vitest: "^2.0.0" } })
        },
        { path: "apps/api/package.json", content: JSON.stringify({ dependencies: { "@nexus/api": "workspace:*" } }) },
        { path: "src/pages/HomePage.tsx", content: 'import { Button } from "../components/Button.js";\nexport const HomePage = () => <Button />;' },
        { path: "src/components/Button.tsx", content: "export const Button = () => null;" },
        { path: "src/pages/HomePage.test.tsx", content: 'import { HomePage } from "./HomePage.js";' }
      ]
    }).expect(200);

    const overview = await owner.get(`/api/projects/${projectId}/architecture/graph`)
      .query({ limit: 20 }).expect(200);
    const graph = overview.body.data.graph;
    expect(graph).toMatchObject({
      projectId,
      generation: 1,
      analysisStatus: "complete",
      totalNodes: 8,
      truncated: false
    });
    expect(graph.nodes.some((node: { id: string }) => node.id === "package:react")).toBe(true);
    expect(graph.edges).toContainEqual(expect.objectContaining({
      source: "apps/api/package.json",
      target: "package:@nexus/api",
      type: "DEPENDS_ON",
      sourceOfInference: "package_manifest",
      evidence: "dependencies.@nexus/api = workspace:*"
    }));
    expect(graph.edges).toContainEqual(expect.objectContaining({
      source: "package.json",
      target: "package:react",
      type: "DEPENDS_ON",
      sourceOfInference: "package_manifest",
      evidence: "dependencies.react = ^18.0.0"
    }));
    expect(graph.edges).toContainEqual(expect.objectContaining({
      source: "src/pages/HomePage.tsx",
      target: "src/components/Button.tsx",
      type: "IMPORTS",
      verificationStatus: "statically_confirmed"
    }));

    const frontend = await owner.get(`/api/projects/${projectId}/architecture/graph`)
      .query({ layer: "frontend", limit: 20 }).expect(200);
    expect(frontend.body.data.graph.nodes.every((node: { category: string }) =>
      ["component", "hook", "page"].includes(node.category)
    )).toBe(true);
    const search = await owner.get(`/api/projects/${projectId}/architecture/graph`)
      .query({ search: "Button", limit: 20 }).expect(200);
    expect(search.body.data.graph.nodes.map((node: { id: string }) => node.id)).toEqual(["src/components/Button.tsx"]);

    const detail = await owner.get(`/api/projects/${projectId}/architecture/node`)
      .query({ nodeId: "src/pages/HomePage.tsx" }).expect(200);
    expect(detail.body.data.node.relationships).toContainEqual(expect.objectContaining({
      type: "IMPORTS",
      direction: "outgoing",
      evidence: "../components/Button.js"
    }));
    const limited = await owner.get(`/api/projects/${projectId}/architecture/graph`)
      .query({ limit: 1 }).expect(200);
    expect(limited.body.data.graph.nodes).toHaveLength(1);
    expect(limited.body.data.graph.truncated).toBe(true);
    await owner.get(`/api/projects/${projectId}/architecture/graph`)
      .query({ layer: "not-a-layer" }).expect(400);
    await owner.get(`/api/projects/${projectId}/architecture/graph`)
      .query({ limit: 301 }).expect(400);
    await owner.get(`/api/projects/${projectId}/architecture/node`)
      .query({ nodeId: "unknown-node" }).expect(404);

    const stranger = request.agent(app);
    await register(stranger, `stranger-${crypto.randomUUID()}@example.com`);
    await stranger.get(`/api/projects/${projectId}/architecture/graph`).expect(404);
    await stranger.get(`/api/projects/${projectId}/architecture/node`)
      .query({ nodeId: "package:react" }).expect(404);
    await ProjectArchitecture.updateOne(
      { projectId, generation: 1 },
      { $push: { nodes: null, relationships: { source: "missing", target: "package:react", type: "IMPORTS" } } }
    );
    const malformed = await owner.get(`/api/projects/${projectId}/architecture/graph`)
      .query({ limit: 20 }).expect(200);
    expect(malformed.body.data.graph.analysisStatus).toBe("partial");
    expect(malformed.body.data.graph.limitations).toContain(
      "Malformed or duplicate architecture records were omitted from this graph response."
    );
    await owner.post(`/api/projects/${projectId}/architecture/refresh`).send({}).expect(200);
  });

  it("reports invalid package metadata as partial without fabricating dependency edges", async () => {
    vi.mocked(embedChunks).mockImplementation(async (chunks) =>
      chunks.map(() => [0.1, 0.2, 0.3])
    );
    const owner = request.agent(app);
    await register(owner, `partial-architecture-${crypto.randomUUID()}@example.com`);
    const projectResponse = await owner.post("/api/projects").send({ name: "Partial Graph" }).expect(201);
    const projectId = projectResponse.body.data.project.id as string;
    await owner.post(`/api/projects/${projectId}/index`).send({
      files: [
        { path: "package.json", content: "{invalid-json" },
        { path: "src/standalone.ts", content: "export const value = true;" }
      ]
    }).expect(200);
    const response = await owner.get(`/api/projects/${projectId}/architecture/graph`).expect(200);
    expect(response.body.data.graph).toMatchObject({
      analysisStatus: "partial",
      totalNodes: 2,
      edges: [],
      limitations: ["package.json is invalid; its package dependency edges were omitted."]
    });
  });

  it("updates only changed files and reuses indexed vectors for unchanged files", async () => {
    vi.mocked(embedChunks).mockImplementation(async (chunks) =>
      chunks.map(() => [0.1, 0.2, 0.3])
    );
    const owner = request.agent(app);
    await register(owner, "incremental@example.com");
    const project = await owner.post("/api/projects").send({ name: "Incremental index" }).expect(201);
    const projectId = project.body.data.project.id as string;
    await owner.post(`/api/projects/${projectId}/index`).send({
      files: [
        { path: "src/changed.ts", content: "export const version = 1;" },
        { path: "src/unchanged.ts", content: "export const reused = true;" },
        { path: "README.md", content: "# remove me" }
      ]
    }).expect(200);
    const unchangedBefore = await CodeChunk.findOne({ projectId, filePath: "src/unchanged.ts" }).lean();
    vi.mocked(embedChunks).mockClear();

    const update = await owner.patch(`/api/projects/${projectId}/index`).send({
      files: [{ path: "src/changed.ts", content: "export const version = 2;" }],
      deletedPaths: ["README.md"]
    }).expect(200);

    expect(update.body.data).toMatchObject({
      filesIndexed: 2,
      changedFilesIndexed: 1,
      unchangedFilesReused: 1,
      chunksEmbedded: 1
    });
    expect(embedChunks).toHaveBeenCalledTimes(1);
    expect(embedChunks.mock.calls[0]?.[0]).toHaveLength(1);
    const unchangedAfter = await CodeChunk.findOne({
      projectId,
      filePath: "src/unchanged.ts",
      generation: 2
    }).lean();
    expect(unchangedAfter?.chunkId).toBe(unchangedBefore?.chunkId);
    expect(unchangedAfter?.embedding).toEqual(unchangedBefore?.embedding);
    expect(await CodeChunk.countDocuments({ projectId, generation: 1 })).toBe(0);
    expect(await ProjectFile.countDocuments({ projectId, generation: 2, filePath: "README.md" })).toBe(0);
  });

  it("deletes only the owned project's vector and file index data", async () => {
    vi.mocked(embedChunks).mockImplementation(async (chunks) =>
      chunks.map(() => [0.1, 0.2, 0.3])
    );
    const owner = request.agent(app);
    await register(owner, "vector-delete@example.com");
    const first = await owner.post("/api/projects").send({ name: "First" }).expect(201);
    const second = await owner.post("/api/projects").send({ name: "Second" }).expect(201);
    const firstId = first.body.data.project.id as string;
    const secondId = second.body.data.project.id as string;
    for (const projectId of [firstId, secondId]) {
      await owner.post(`/api/projects/${projectId}/index`).send({
        files: [{ path: "src/index.ts", content: "export const indexed = true;" }]
      }).expect(200);
    }

    const deleted = await owner.delete(`/api/projects/${firstId}/vectors`).expect(200);
    expect(deleted.body.data.vectorsDeleted).toBeGreaterThan(0);
    expect(await CodeChunk.countDocuments({ projectId: firstId })).toBe(0);
    expect(await ProjectFile.countDocuments({ projectId: firstId })).toBe(0);
    expect(await CodeChunk.countDocuments({ projectId: secondId })).toBeGreaterThan(0);
    expect((await Project.findById(firstId))?.activeGeneration).toBe(0);
  });

  it("runs semantic search with project and metadata scope and returns empty results honestly", async () => {
    vi.mocked(embedChunks).mockImplementation(async (chunks) =>
      chunks.map(() => [0.1, 0.2, 0.3])
    );
    const owner = request.agent(app);
    await register(owner, "search-scope@example.com");
    const project = await owner.post("/api/projects").send({ name: "Scoped search" }).expect(201);
    const projectId = project.body.data.project.id as string;
    await owner.post(`/api/projects/${projectId}/index`).send({
      files: [{ path: "src/search.ts", content: "export const searchable = true;" }]
    }).expect(200);
    vi.mocked(createEmbeddingModel).mockReturnValue({
      embedQuery: vi.fn().mockResolvedValue([0.1, 0.2, 0.3])
    } as never);
    const aggregate = vi.spyOn(CodeChunk, "aggregate").mockReturnValue({
      exec: vi.fn().mockResolvedValue([])
    } as never);

    const response = await owner.post(`/api/projects/${projectId}/search`).send({
      query: "searchable",
      topK: 3,
      filePath: "src/search.ts",
      language: "typescript"
    }).expect(200);
    expect(response.body.data.results).toEqual([]);
    const pipeline = aggregate.mock.calls[0]?.[0];
    expect(pipeline?.[0]?.$vectorSearch).toMatchObject({
      limit: 3,
      filter: {
        $and: [
          { projectId: { $eq: projectId } },
          { ownerId: { $eq: (await User.findOne({ email: "search-scope@example.com" }))?._id.toString() } },
          { generation: { $eq: 1 } },
          { filePath: { $eq: "src/search.ts" } },
          { language: { $eq: "typescript" } }
        ]
      }
    });
    aggregate.mockRestore();
    vi.mocked(createEmbeddingModel).mockReset();
  });

  it("persists project conversations, history, and only retrieved stream sources", async () => {
    const owner = request.agent(app);
    const other = request.agent(app);
    await register(owner, "conversation-owner@example.com");
    await register(other, "conversation-other@example.com");
    const projectResponse = await owner.post("/api/projects").send({ name: "Commerce" }).expect(201);
    const projectId = projectResponse.body.data.project.id as string;
    const created = await owner.post(`/api/projects/${projectId}/conversations`)
      .send({ title: "Orders API" }).expect(201);
    const conversationId = created.body.data.conversation.id as string;
    const sources = [{
      label: "S1",
      filePath: "src/orders.ts",
      language: "typescript",
      symbolContext: "createOrder",
      startLine: 14,
      endLine: 22,
      score: 0.91
    }];
    vi.mocked(streamProjectAnswer).mockImplementation(async (input) => {
      input.onSources(sources);
      input.onToken("Orders are created in src/orders.ts [S1].");
      return {
        requestId: "conversation-request",
        answer: "Orders are created in src/orders.ts [S1].",
        sources,
        limitations: ["Grounded in retrieved chunks."],
        model: "test-chat",
        latencyMs: 21
      };
    });
    const first = await owner.post(`/api/projects/${projectId}/conversations/${conversationId}/messages`)
      .send({ question: "How does the order API work?" })
      .expect(200)
      .expect("Content-Type", /text\/event-stream/);
    expect(first.text).toContain("event: sources");
    expect(first.text).toContain('"startLine":14');
    expect(first.text).toContain("event: token");
    expect(first.text).toContain("event: done");

    const stored = await ProjectMessage.find({ projectId, conversationId }).sort({ createdAt: 1 }).lean();
    expect(stored.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(stored[1]?.sources).toEqual(sources);
    expect(stored[1]?.content).toContain("[S1]");
    expect(streamProjectAnswer).toHaveBeenCalledWith(expect.objectContaining({
      history: [],
      question: "How does the order API work?"
    }));

    await owner.post(`/api/projects/${projectId}/conversations/${conversationId}/messages`)
      .send({ question: "Show me the same flow again." }).expect(200);
    expect(streamProjectAnswer).toHaveBeenLastCalledWith(expect.objectContaining({
      history: [
        { role: "user", content: "How does the order API work?" },
        { role: "assistant", content: "Orders are created in src/orders.ts [S1]." }
      ]
    }));
    const history = await owner.get(`/api/projects/${projectId}/conversations/${conversationId}/messages`)
      .expect(200);
    expect(history.body.data.messages).toHaveLength(4);
    expect(history.body.data.messages[1].sources).toEqual(sources);
    const conversations = await owner.get(`/api/projects/${projectId}/conversations`).expect(200);
    expect(conversations.body.data.conversations[0].title).toBe("Orders API");

    await other.get(`/api/projects/${projectId}/conversations`).expect(404);
    await other.get(`/api/projects/${projectId}/conversations/${conversationId}/messages`).expect(404);
    await other.post(`/api/projects/${projectId}/conversations/${conversationId}/messages`)
      .send({ question: "Can I see this project?" }).expect(404);
  });

  it("does not allow another user to read or chat with an owned project", async () => {
    const owner = request.agent(app);
    const anotherUser = request.agent(app);
    await register(owner, "owner@example.com");
    await register(anotherUser, "another@example.com");
    const project = await owner.post("/api/projects").send({ name: "Private code" }).expect(201);
    const projectId = project.body.data.project.id as string;

    await anotherUser.get(`/api/projects/${projectId}`).expect(404);
    await anotherUser.get(`/api/projects/${projectId}/structure`).expect(404);
    await anotherUser.get(`/api/projects/${projectId}/files`).expect(404);
    await anotherUser.post(`/api/projects/${projectId}/search`)
      .send({ query: "private source" }).expect(404);
    await anotherUser.delete(`/api/projects/${projectId}/vectors`).expect(404);
    const chat = await anotherUser.post(`/api/projects/${projectId}/chat`)
      .send({ question: "How does authentication work?" })
      .expect(404);
    expect(chat.body.error.code).toBe("PROJECT_NOT_FOUND");
  });

  it("validates source files and rejects path traversal before indexing", async () => {
    const owner = request.agent(app);
    await register(owner, "owner@example.com");
    const project = await owner.post("/api/projects").send({ name: "Safe paths" }).expect(201);
    const response = await owner.post(`/api/projects/${project.body.data.project.id}/index`)
      .send({ files: [{ path: "../outside.ts", content: "export const value = 1;" }] })
      .expect(400);
    expect(response.body.error.code).toBe("INVALID_FILE_PATH");
  });

  it("keeps the previous active generation when reindexing fails", async () => {
    vi.mocked(embedChunks).mockImplementation(async (chunks) =>
      chunks.map(() => [0.1, 0.2, 0.3])
    );
    const owner = request.agent(app);
    await register(owner, "reindex@example.com");
    const project = await owner.post("/api/projects").send({ name: "Reindex safety" }).expect(201);
    const projectId = project.body.data.project.id as string;
    await owner.post(`/api/projects/${projectId}/index`).send({
      files: [{ path: "src/first.ts", content: "export function first() {}" }]
    }).expect(200);

    vi.mocked(embedChunks).mockRejectedValueOnce(
      new AppError(503, "Embedding service unavailable", "EMBEDDING_UNAVAILABLE")
    );
    await owner.post(`/api/projects/${projectId}/index`).send({
      files: [{ path: "src/second.ts", content: "export function second() {}" }]
    }).expect(503);

    const savedProject = await Project.findById(projectId);
    expect(savedProject).toMatchObject({ activeGeneration: 1, indexingStatus: "ready" });
    expect(await CodeChunk.countDocuments({ projectId, generation: 1 })).toBe(1);
    expect(await CodeChunk.countDocuments({ projectId, generation: 2 })).toBe(0);
    expect(await ProjectFile.countDocuments({ projectId, generation: 1 })).toBe(1);
    expect(await ProjectFile.countDocuments({ projectId, generation: 2 })).toBe(0);
  });

  it("streams project answers as SSE events", async () => {
    vi.mocked(streamProjectAnswer).mockImplementation(async (input) => {
      const sources = [{
        label: "S1",
        filePath: "src/auth.ts",
        language: "typescript",
        symbolContext: "verifyToken",
        startLine: 3,
        endLine: 8,
        score: 0.9
      }];
      input.onSources(sources);
      input.onToken("JWT validation uses verifyToken [S1].");
      return {
        requestId: "test-request",
        answer: "JWT validation uses verifyToken [S1].",
        sources,
        limitations: ["Grounded in retrieved code."],
        model: "test-chat",
        latencyMs: 18
      };
    });
    const owner = request.agent(app);
    await register(owner, "stream@example.com");
    const project = await owner.post("/api/projects").send({ name: "Streaming" }).expect(201);
    const response = await owner.post(`/api/projects/${project.body.data.project.id}/chat`)
      .send({ question: "How is JWT validation done?" })
      .expect(200)
      .expect("Content-Type", /text\/event-stream/);
    expect(response.text).toContain("event: sources");
    expect(response.text).toContain("event: token");
    expect(response.text).toContain("event: done");
    expect(response.text).toContain("src/auth.ts");
  });

  it("reports Ollama connectivity and failed-model availability without secrets", async () => {
    vi.mocked(aiProvider.checkHealth).mockResolvedValueOnce({
      provider: "ollama",
      connected: true,
      chatModel: { name: "test-chat", available: true },
      embeddingModel: { name: "test-embedding", available: true, capable: true }
    });
    const owner = request.agent(app);
    await register(owner, "health@example.com");
    const healthy = await owner.get("/api/ai/health").expect(200);
    expect(healthy.body.data.ollama).toMatchObject({
      connected: true,
      chatModelAvailable: true,
      embeddingModelAvailable: true
    });
    expect(JSON.stringify(healthy.body)).not.toContain("JWT_SECRET");

    vi.mocked(aiProvider.checkHealth).mockRejectedValueOnce(new Error("Ollama offline"));
    const failed = await owner.get("/api/ai/health").expect(503);
    expect(failed.body.data.ollama.connected).toBe(false);
    expect(JSON.stringify(failed.body)).not.toContain("Ollama offline");
  });

  it("uses the non-production playground to validate chat and embeddings", async () => {
    const invoke = vi.fn().mockResolvedValue({ content: "Local model is ready" });
    const embedQuery = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);
    vi.mocked(aiProvider.createChatModel).mockReturnValue({ invoke } as never);
    vi.mocked(aiProvider.createEmbeddingModel).mockReturnValue({ embedQuery } as never);
    const owner = request.agent(app);
    await register(owner, "playground@example.com");

    const result = await owner.post("/api/ai/playground")
      .send({ prompt: "Say ready" })
      .expect(200);
    expect(result.body.data).toMatchObject({
      provider: "ollama",
      text: "Local model is ready",
      embeddingDimensions: 3
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(embedQuery).toHaveBeenCalledWith("Say ready");
  });

  it("protects project findings by owner and allows the owner to update status", async () => {
    const owner = request.agent(app);
    const anotherUser = request.agent(app);
    const registration = await register(owner, "issues-owner@example.com");
    await register(anotherUser, "issues-other@example.com");
    const projectResponse = await owner.post("/api/projects").send({ name: "Private review" }).expect(201);
    const projectId = projectResponse.body.data.project.id as string;
    await EngineeringIssue.create({
      issueId: "issue-1",
      runId: "run-1",
      ownerId: registration.body.data.user.id,
      projectId,
      agent: "security",
      category: "security",
      severity: "high",
      title: "Authentication configuration is unconditional",
      description: "The configuration cannot disable authentication.",
      reasoningSummary: "The cited assignment is always true, so the guard cannot be disabled.",
      affectedFiles: ["src/auth.ts"],
      evidence: [{
        filePath: "src/auth.ts",
        startLine: 10,
        endLine: 10,
        quote: "export const authEnabled = true;",
        explanation: "This value is unconditionally true."
      }],
      recommendation: "Use a validated configuration value instead.",
      confidence: 0.9
    });

    await anotherUser.get(`/api/projects/${projectId}/issues`).expect(404);
    await anotherUser.patch(`/api/projects/${projectId}/issues/issue-1`).send({ status: "resolved" }).expect(404);
    await request(app).get(`/api/projects/${projectId}/issues`).expect(401);
    const issues = await owner.get(`/api/projects/${projectId}/issues`).expect(200);
    expect(issues.body.data.issues).toHaveLength(1);
    expect(issues.body.data.issues[0]).not.toHaveProperty("ownerId");
    expect(issues.body.data.issues[0]).not.toHaveProperty("projectId");

    const updated = await owner.patch(`/api/projects/${projectId}/issues/issue-1`)
      .send({ status: "resolved" })
      .expect(200);
    expect(updated.body.data.issue.status).toBe("resolved");
  });
});
