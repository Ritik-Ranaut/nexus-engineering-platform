import { describe, expect, it } from "vitest";
import {
  buildVectorSearchPipeline
} from "../src/services/vector-retriever.service.js";
import { chunkSourceFile } from "../src/services/code-chunker.service.js";
import { analyzeProjectFiles } from "../src/services/project-architecture.service.js";
import {
  normalizeRepositoryPath,
  prepareRepositoryFiles,
  redactSecrets
} from "../src/utils/repository-input.js";

describe("code-aware chunking", () => {
  it("preserves file language, declaration context, and line ranges", () => {
    const source = [
      "export class AuthService {",
      "  async login(email: string) {",
      "    return verify(email);",
      "  }",
      "}",
      "",
      "export function verifyToken(token: string) {",
      "  return token.length > 0;",
      "}"
    ].join("\n");

    const chunks = chunkSourceFile("src/auth.ts", source);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toMatchObject({
      filePath: "src/auth.ts",
      language: "typescript",
      symbolContext: "AuthService",
      startLine: 1,
      endLine: 1
    });
    expect(chunks[1]).toMatchObject({
      symbolContext: "AuthService.login",
      startLine: 2,
      endLine: 5
    });
    expect(chunks[2]).toMatchObject({
      symbolContext: "verifyToken",
      startLine: 7,
      endLine: 9
    });
  });

  it("splits oversized source without losing lines", () => {
    const source = Array.from({ length: 225 }, (_, index) => `const value${index} = ${index};`).join("\n");
    const chunks = chunkSourceFile("src/large.ts", source);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0]?.startLine).toBe(1);
    expect(chunks.at(-1)?.endLine).toBe(225);
    expect(chunks.every((chunk) => chunk.endLine - chunk.startLine < 100)).toBe(true);
  });
});

describe("static architecture analysis", () => {
  it("uses TypeScript syntax nodes for imports and emits evidence-backed unique edges", () => {
    const architecture = analyzeProjectFiles([
      {
        path: "src/pages/HomePage.tsx",
        content: [
          'import { Button } from "../components/Button.js";',
          'import type { ButtonProps } from "../components/Button.js";',
          'const sample = "import { Fake } from \\"./Missing.js\\"";',
          '// import { AlsoFake } from "./MissingToo.js";'
        ].join("\n")
      },
      { path: "src/components/Button.tsx", content: "export const Button = () => null;" },
      { path: "src/pages/HomePage.test.tsx", content: "export {};" },
      { path: "apps/api/src/routes/project.routes.ts", content: "export {};" }
    ]);

    expect(architecture.nodes.find((node) => node.filePath === "src/pages/HomePage.tsx"))
      .toMatchObject({ type: "page", category: "page" });
    expect(architecture.nodes.find((node) => node.filePath === "src/pages/HomePage.test.tsx"))
      .toMatchObject({ type: "test", category: "test" });
    expect(architecture.nodes.find((node) => node.filePath === "apps/api/src/routes/project.routes.ts"))
      .toMatchObject({ type: "route", category: "route" });
    expect(architecture.relationships).toHaveLength(1);
    expect(architecture.relationships[0]).toMatchObject({
      source: "src/pages/HomePage.tsx",
      target: "src/components/Button.tsx",
      type: "IMPORTS",
      evidence: "../components/Button.js",
      sourceOfInference: "static_import",
      confidence: 1,
      verificationStatus: "statically_confirmed"
    });
  });
});

describe("repository source safety", () => {
  it("rejects traversal and absolute paths", () => {
    expect(() => normalizeRepositoryPath("../../outside.ts")).toThrow();
    expect(() => normalizeRepositoryPath("C:\\private\\secret.ts")).toThrow();
  });

  it("omits secret files and redacts common inline credentials", () => {
    const files = prepareRepositoryFiles([
      { path: ".env", content: "TOKEN=real-secret-value" },
      {
        path: "src/client.ts",
        content: 'const api_key = "private-api-key-value";\nexport const ping = true;'
      }
    ]);
    expect(files).toHaveLength(1);
    expect(files[0]?.content).not.toContain("private-api-key-value");
    expect(files[0]?.content).toContain("[REDACTED]");
    const redacted = redactSecrets([
      "token: unquoted-access-token-value",
      "Authorization: Bearer abc.def.ghi"
    ].join("\n"));
    expect(redacted).not.toContain("unquoted-access-token-value");
    expect(redacted).not.toContain("abc.def.ghi");
  });
});

describe("MongoDB vector-search scope", () => {
  it("filters by owner, project, and active index generation", () => {
    const [stage] = buildVectorSearchPipeline([0.1, 0.2, 0.3], "project-a", "owner-a", 7, 4);
    const projection = buildVectorSearchPipeline([0.1, 0.2, 0.3], "project-a", "owner-a", 7, 4)[1];
    expect(stage?.$vectorSearch).toMatchObject({
      path: "embedding",
      limit: 4,
      filter: {
        $and: [
          { projectId: { $eq: "project-a" } },
          { ownerId: { $eq: "owner-a" } },
          { generation: { $eq: 7 } }
        ]
      }
    });
    expect(projection?.$project).toMatchObject({
      filePath: 1,
      content: 1,
      score: { $meta: "vectorSearchScore" }
    });
    expect(projection?.$project).not.toHaveProperty("embedding");
  });

  it("applies project isolation with optional metadata filters and a bounded top-K", () => {
    const firstProject = buildVectorSearchPipeline(
      [0.1, 0.2, 0.3],
      "project-a",
      "owner-a",
      7,
      6,
      { fileId: "file-a", filePath: "src/auth.ts", language: "typescript" }
    )[0]?.$vectorSearch;
    const otherProject = buildVectorSearchPipeline(
      [0.1, 0.2, 0.3],
      "project-b",
      "owner-a",
      2,
      3
    )[0]?.$vectorSearch;
    expect(firstProject).toMatchObject({
      limit: 6,
      filter: {
        $and: [
          { projectId: { $eq: "project-a" } },
          { ownerId: { $eq: "owner-a" } },
          { generation: { $eq: 7 } },
          { fileId: { $eq: "file-a" } },
          { filePath: { $eq: "src/auth.ts" } },
          { language: { $eq: "typescript" } }
        ]
      }
    });
    expect(otherProject?.filter.$and[0]).toEqual({ projectId: { $eq: "project-b" } });
  });
});
