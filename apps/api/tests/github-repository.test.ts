import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchPublicGitHubRepositoryFiles,
  parsePublicGitHubRepositoryUrl
} from "../src/services/github-repository.service.js";
import {
  readIndexableFilesFromDirectory,
  resolveBranchAndSubdirectory
} from "../src/services/github-clone.service.js";

const commitSha = "a".repeat(40);
const treeSha = "b".repeat(40);
type TestFile = { path: string; content: string; mode?: string };

const mockGitHub = (files: TestFile[], options: { truncated?: boolean; redirects?: boolean } = {}) => {
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

    if (options.redirects && url.hostname === "api.github.com" && url.pathname === "/repos/acme/renamed") {
      return new Response(null, {
        status: 301,
        headers: { location: "https://api.github.com/repos/acme/service" }
      });
    }
    if (url.hostname === "api.github.com" && url.pathname === "/repos/acme/service") {
      return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
    }
    if (url.hostname === "api.github.com" && url.pathname === "/repos/acme/service/branches/main/src") {
      return new Response(null, { status: 404 });
    }
    if (url.hostname === "api.github.com" && url.pathname === "/repos/acme/service/branches/main") {
      return new Response(JSON.stringify({
        commit: {
          sha: commitSha,
          commit: { tree: { sha: treeSha } }
        }
      }), { status: 200 });
    }
    if (url.hostname === "api.github.com" && url.pathname === "/repos/acme/service/branches/feature/import-v2") {
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
      const pathName = decodeURIComponent(url.pathname.slice(prefix.length));
      const content = contentByPath.get(pathName);
      if (content !== undefined) {
        return new Response(content, {
          status: 200,
          headers: { "content-length": String(Buffer.byteLength(content) + 1) }
        });
      }
    }
    return new Response(null, { status: 404 });
  }));
  return requests;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("public GitHub repository import", () => {
  it("normalizes .git URLs, www hosts, SSH URLs, bare domains, and preserves slash-containing branch names", () => {
    expect(parsePublicGitHubRepositoryUrl("https://github.com/acme/service.git")).toEqual({
      owner: "acme",
      repository: "service",
      cloneUrl: "https://github.com/acme/service.git",
      branch: undefined
    });
    expect(parsePublicGitHubRepositoryUrl("git@github.com:acme/service.git")).toEqual({
      owner: "acme",
      repository: "service",
      cloneUrl: "https://github.com/acme/service.git",
      branch: undefined
    });
    expect(parsePublicGitHubRepositoryUrl("github.com/acme/service")).toEqual({
      owner: "acme",
      repository: "service",
      cloneUrl: "https://github.com/acme/service.git",
      branch: undefined
    });
    expect(parsePublicGitHubRepositoryUrl("https://github.com/acme/service/")).toEqual({
      owner: "acme",
      repository: "service",
      cloneUrl: "https://github.com/acme/service.git",
      branch: undefined
    });
    expect(parsePublicGitHubRepositoryUrl("https://www.github.com/acme/service/tree/feature/import-v2")).toEqual({
      owner: "acme",
      repository: "service",
      cloneUrl: "https://github.com/acme/service.git",
      branch: "feature/import-v2"
    });
    expect(parsePublicGitHubRepositoryUrl("https://github.com/acme/service/tree/main/packages/api")).toMatchObject({
      owner: "acme",
      repository: "service",
      branch: "main/packages/api"
    });
  });

  it("rejects file, gist, and spoofed host URLs", () => {
    expect(() => parsePublicGitHubRepositoryUrl("https://github.com/acme/service/blob/main/src/index.ts"))
      .toThrow(/file or extra GitHub page/);
    expect(() => parsePublicGitHubRepositoryUrl("https://github.com.example/acme/service"))
      .toThrow(/https:\/\/github.com/);
    expect(() => parsePublicGitHubRepositoryUrl("https://user:pass@github.com/acme/service"))
      .toThrow(/https:\/\/github.com/);
  });

  it("resolves subdirectory URLs against the longest matching branch", () => {
    expect(resolveBranchAndSubdirectory("main/packages/api", ["main", "develop"], "main")).toEqual({
      branch: "main",
      subdirectory: "packages/api"
    });
    expect(resolveBranchAndSubdirectory("feature/import-v2", ["main", "feature/import-v2"], "main")).toEqual({
      branch: "feature/import-v2",
      subdirectory: undefined
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

  it("imports a subdirectory without treating it as the branch name", async () => {
    mockGitHub([
      { path: "README.md", content: "# Root" },
      { path: "src/app.ts", content: "export const app = true;" }
    ]);

    const files = await fetchPublicGitHubRepositoryFiles("https://github.com/acme/service/tree/main/src");

    expect(files).toEqual([{ path: "src/app.ts", content: "export const app = true;" }]);
  });

  it("follows GitHub repository rename redirects on allowlisted hosts", async () => {
    mockGitHub([{ path: "README.md", content: "# Service" }], { redirects: true });
    const files = await fetchPublicGitHubRepositoryFiles("https://github.com/acme/renamed");
    expect(files).toEqual([{ path: "README.md", content: "# Service" }]);
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

describe("cloned repository file discovery", () => {
  it("indexes supported files while skipping generated directories and secrets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nexus-clone-fixture-"));
    try {
      await mkdir(path.join(root, "src"), { recursive: true });
      await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
      await mkdir(path.join(root, ".next", "cache"), { recursive: true });
      await mkdir(path.join(root, "__pycache__"), { recursive: true });
      await writeFile(path.join(root, "src", "index.ts"), "export const ready = true;\n");
      await writeFile(path.join(root, "README"), "# Title\nDocumentation\n");
      await writeFile(path.join(root, "LICENSE"), "MIT License\n");
      await writeFile(path.join(root, ".env"), "SECRET=1\n");
      await writeFile(path.join(root, "node_modules", "pkg", "index.ts"), "export const ignored = true;\n");
      await writeFile(path.join(root, ".next", "cache", "build.js"), "export const cached = true;\n");
      await writeFile(path.join(root, "__pycache__", "module.pyc"), "ignored\n");
      const files = await readIndexableFilesFromDirectory(root);
      expect(files).toEqual([
        { path: "LICENSE", content: "MIT License\n" },
        { path: "README", content: "# Title\nDocumentation\n" },
        { path: "src/index.ts", content: "export const ready = true;\n" }
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
