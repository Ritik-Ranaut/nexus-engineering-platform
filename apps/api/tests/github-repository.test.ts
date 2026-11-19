import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchPublicGitHubRepositoryFiles,
  parsePublicGitHubRepositoryUrl
} from "../src/services/github-repository.service.js";

const commitSha = "a".repeat(40);
const treeSha = "b".repeat(40);
type TestFile = { path: string; content: string; mode?: string };

const mockGitHub = (files: TestFile[], options: { truncated?: boolean } = {}) => {
  const contentByPath = new Map(files.map((file) => [file.path, file.content]));
  const tree = files.map((file) => ({
    path: file.path,
    type: "blob",
    mode: file.mode ?? "100644",
    size: Buffer.byteLength(file.content, "utf8")
  }));
  const requests: URL[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo) => {
    const url = input instanceof URL
      ? input
      : new URL(typeof input === "string" ? input : input.url);
    requests.push(url);

    if (url.hostname === "api.github.com" && url.pathname === "/repos/acme/service") {
      return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
    }
    if (url.hostname === "api.github.com" && url.pathname === "/repos/acme/service/branches/main") {
      return new Response(JSON.stringify({
        commit: {
          sha: commitSha,
          commit: { tree: { sha: treeSha } }
        }
      }), { status: 200 });
    }
    if (
      url.hostname === "api.github.com" &&
      url.pathname === `/repos/acme/service/git/trees/${treeSha}` &&
      url.searchParams.get("recursive") === "1"
    ) {
      return new Response(JSON.stringify({ truncated: options.truncated ?? false, tree }), { status: 200 });
    }
    if (url.hostname === "raw.githubusercontent.com") {
      const prefix = `/acme/service/${commitSha}/`;
      const path = decodeURIComponent(url.pathname.slice(prefix.length));
      const content = contentByPath.get(path);
      if (content !== undefined) return new Response(content, { status: 200 });
    }
    return new Response(null, { status: 404 });
  }));
  return requests;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("public GitHub repository import", () => {
  it("normalizes .git URLs and preserves slash-containing branch names", () => {
    expect(parsePublicGitHubRepositoryUrl("https://github.com/acme/service.git")).toEqual({
      owner: "acme",
      repository: "service",
      branch: undefined
    });
    expect(parsePublicGitHubRepositoryUrl("https://github.com/acme/service/tree/feature/import-v2")).toEqual({
      owner: "acme",
      repository: "service",
      branch: "feature/import-v2"
    });
  });

  it("recursively downloads supported files while excluding secrets, generated files, and unsupported assets", async () => {
    const requests = mockGitHub([
      { path: "README.md", content: "# Service" },
      { path: "apps/api/src/main.ts", content: "export const main = true;" },
      { path: ".env", content: "TOKEN=not-indexed" },
      { path: "apps/api/node_modules/pkg/index.ts", content: "export const generated = true;" },
      { path: "assets/logo.png", content: "not-indexed" },
      { path: "apps/api/src/shortcut.ts", content: "target.ts", mode: "120000" }
    ]);

    const files = await fetchPublicGitHubRepositoryFiles("https://github.com/acme/service");

    expect(files).toEqual([
      { path: "README.md", content: "# Service" },
      { path: "apps/api/src/main.ts", content: "export const main = true;" }
    ]);
    expect(requests.some((url) => url.hostname === "raw.githubusercontent.com" && url.pathname.endsWith("/.env"))).toBe(false);
    expect(requests.some((url) => url.hostname === "raw.githubusercontent.com" && url.pathname.includes("node_modules"))).toBe(false);
  });

  it("imports a complete supported source set beyond the local upload caps", async () => {
    const files = Array.from({ length: 101 }, (_, index) => ({
      path: `packages/service/src/file-${index}.ts`,
      content: "x".repeat(50_000)
    }));
    mockGitHub(files);

    const imported = await fetchPublicGitHubRepositoryFiles("https://github.com/acme/service/tree/main");

    expect(imported).toHaveLength(101);
    expect(imported.reduce((total, file) => total + Buffer.byteLength(file.content), 0)).toBeGreaterThan(4_000_000);
  });

  it("rejects unsupported hosts before making outbound requests", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPublicGitHubRepositoryFiles("https://github.com.example/acme/service"))
      .rejects.toMatchObject({ code: "UNSUPPORTED_REPOSITORY_HOST" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects incomplete GitHub trees instead of indexing a partial repository", async () => {
    mockGitHub([{ path: "src/main.ts", content: "export const main = true;" }], { truncated: true });

    await expect(fetchPublicGitHubRepositoryFiles("https://github.com/acme/service"))
      .rejects.toMatchObject({ code: "GITHUB_TREE_TRUNCATED" });
  });
});
