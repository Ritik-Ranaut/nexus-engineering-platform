import { z } from "zod";
import { env } from "../config/env.js";
import { AppError } from "../utils/app-error.js";
import {
  isIndexableRepositoryPath,
  normalizeRepositoryPath,
  type RepositoryFileInput
} from "../utils/repository-input.js";
import {
  clonePublicGitHubRepositoryFiles,
  isGitAvailable
} from "./github-clone.service.js";

const maximumFiles = 1_000;
const maximumFileBytes = 1_000_000;
const maximumRepositoryBytes = 20_000_000;
const maximumTreeResponseBytes = 20_000_000;
const requestTimeoutMs = 20_000;
const downloadConcurrency = 8;
const allowedGitHubHosts = new Set([
  "github.com",
  "www.github.com",
  "api.github.com",
  "raw.githubusercontent.com",
  "objects.githubusercontent.com",
  "codeload.github.com"
]);

const repositorySchema = z.object({
  default_branch: z.string().min(1).max(255)
});

const branchSchema = z.object({
  commit: z.object({
    sha: z.string().regex(/^[a-f0-9]{40}$/i),
    commit: z.object({
      tree: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/i) })
    })
  })
});

const treeSchema = z.object({
  truncated: z.boolean(),
  tree: z.array(z.object({
    path: z.string().min(1).max(2_048),
    type: z.string(),
    mode: z.string().optional(),
    size: z.number().int().nonnegative().optional()
  }))
});

export interface ParsedGitHubRepository {
  owner: string;
  repository: string;
  cloneUrl: string;
  branch?: string;
}

export const parsePublicGitHubRepositoryUrl = (repositoryUrl: string): ParsedGitHubRepository => {
  let url: URL;
  try {
    url = new URL(repositoryUrl.trim());
  } catch {
    throw new AppError(400, "Enter a valid public GitHub repository URL", "INVALID_GITHUB_URL");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    (hostname !== "github.com" && hostname !== "www.github.com") ||
    (url.port && url.port !== "443" && url.port !== "80") ||
    url.username ||
    url.password
  ) {
    throw new AppError(400, "Only public repositories hosted at https://github.com are supported", "UNSUPPORTED_REPOSITORY_HOST");
  }

  let segments: string[];
  try {
    segments = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  } catch {
    throw new AppError(400, "The GitHub repository URL contains invalid path encoding", "INVALID_GITHUB_URL");
  }
  if (segments.length < 2) {
    throw new AppError(400, "Enter a GitHub URL in the form https://github.com/owner/repository", "INVALID_GITHUB_URL");
  }
  const [owner, rawRepository, ...rest] = segments;
  const repository = rawRepository.replace(/\.git$/i, "");
  const validName = (value: string | undefined) =>
    Boolean(value && value !== "." && value !== ".." && /^[A-Za-z0-9_.-]+$/.test(value));
  if (!validName(owner) || !validName(repository)) {
    throw new AppError(400, "Enter a GitHub URL in the form https://github.com/owner/repository", "INVALID_GITHUB_URL");
  }

  let branch: string | undefined;
  if (rest.length === 0 || (rest.length === 1 && rest[0].toLowerCase() === "tree")) {
    branch = undefined;
  } else if (rest[0] === "tree") {
    branch = rest.slice(1).join("/");
    if (!branch || branch.split("/").some((part) => !validName(part))) {
      throw new AppError(400, "Enter a valid GitHub branch or subdirectory URL", "INVALID_GITHUB_URL");
    }
  } else if (["blob", "raw", "commit", "commits", "pull", "pulls", "issues", "wiki", "actions", "releases", "tags"].includes(rest[0])) {
    throw new AppError(400, "Use a repository URL or a GitHub branch/subdirectory URL, not a file or extra GitHub page URL", "INVALID_GITHUB_URL");
  } else {
    throw new AppError(400, "Use a repository URL or a GitHub branch URL, not a file or subfolder URL", "INVALID_GITHUB_URL");
  }
  return {
    owner,
    repository,
    cloneUrl: `https://github.com/${owner}/${repository}.git`,
    branch
  };
};

export const canonicalGitHubRepositoryUrl = (repositoryUrl: string): string => {
  const parsed = parsePublicGitHubRepositoryUrl(repositoryUrl);
  return parsed.branch
    ? `https://github.com/${parsed.owner}/${parsed.repository}/tree/${parsed.branch}`
    : `https://github.com/${parsed.owner}/${parsed.repository}`;
};

const githubHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "NEXUS-project-import"
  };
  if (env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  }
  return headers;
};

const assertSafeGitHubUrl = (url: URL) => {
  if (
    url.protocol !== "https:" ||
    !allowedGitHubHosts.has(url.hostname.toLowerCase()) ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  ) {
    throw new AppError(400, "GitHub redirected to an unsupported host", "UNSUPPORTED_REPOSITORY_HOST");
  }
};

const githubGetWithUrl = async (
  url: URL,
  description: string,
  signal?: AbortSignal,
  options: { allowNotFound?: boolean } = {}
) : Promise<{ response: Response; effectiveUrl: URL }> => {
  let current = url;
  for (let redirectCount = 0; redirectCount < 5; redirectCount += 1) {
    assertSafeGitHubUrl(current);
    let response: Response;
    try {
      const timeout = AbortSignal.timeout(requestTimeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      response = await fetch(current, {
        headers: githubHeaders(),
        redirect: "manual",
        signal: combined
      });
    } catch (error) {
      if (signal?.aborted) {
        throw new AppError(409, "Repository import was cancelled", "IMPORT_CANCELLED");
      }
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new AppError(504, `Timed out while ${description}`, "GITHUB_IMPORT_TIMEOUT");
      }
      throw new AppError(502, `Could not reach GitHub while ${description}`, "GITHUB_UNAVAILABLE");
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) {
        throw new AppError(502, `GitHub redirected without a location while ${description}`, "GITHUB_IMPORT_FAILED");
      }
      current = new URL(location, current);
      continue;
    }
    if (response.status === 404) {
      if (options.allowNotFound) return { response, effectiveUrl: current };
      throw new AppError(404, "The repository or branch was not found or is private. Only public GitHub repositories can be imported without a token.", "GITHUB_REPOSITORY_NOT_FOUND");
    }
    if (response.status === 401) {
      throw new AppError(404, "The repository or branch was not found or is private. Only public GitHub repositories can be imported without a token.", "GITHUB_REPOSITORY_NOT_FOUND");
    }
    if (response.status === 403 || response.status === 429) {
      throw new AppError(429, "GitHub rate-limited this import. Please wait and try again.", "GITHUB_RATE_LIMITED");
    }
    if (!response.ok) {
      throw new AppError(502, `GitHub could not provide the ${description}`, "GITHUB_IMPORT_FAILED");
    }
    return { response, effectiveUrl: current };
  }
  throw new AppError(502, `GitHub issued too many redirects while ${description}`, "GITHUB_IMPORT_FAILED");
};

const githubGet = async (
  url: URL,
  description: string,
  signal?: AbortSignal,
  options: { allowNotFound?: boolean } = {}
) => (await githubGetWithUrl(url, description, signal, options)).response;

const readBoundedBytes = async (
  response: Response,
  maximumBytes: number,
  description: string
): Promise<Uint8Array> => {
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > maximumBytes) {
    throw new AppError(413, `${description} exceeds the import size limit`, "GITHUB_IMPORT_SIZE_LIMIT");
  }
  if (!response.body) {
    throw new AppError(502, `GitHub returned an empty ${description}`, "INVALID_GITHUB_RESPONSE");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        void reader.cancel();
        throw new AppError(413, `${description} exceeds the import size limit`, "GITHUB_IMPORT_SIZE_LIMIT");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
};

const readJson = async <T>(
  response: Response,
  schema: z.ZodType<T>,
  maximumBytes: number,
  description: string
): Promise<T> => {
  const bytes = await readBoundedBytes(response, maximumBytes, description);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new AppError(502, `GitHub returned invalid data for the ${description}`, "INVALID_GITHUB_RESPONSE");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(502, `GitHub returned an incomplete ${description}`, "INVALID_GITHUB_RESPONSE");
  }
  return parsed.data;
};

const encodedPath = (filePath: string) =>
  filePath.split("/").map((part) => encodeURIComponent(part)).join("/");

const downloadFile = async (
  owner: string,
  repository: string,
  commitSha: string,
  filePath: string,
  signal?: AbortSignal
): Promise<RepositoryFileInput> => {
  const url = new URL(
    `/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/${commitSha}/${encodedPath(filePath)}`,
    "https://raw.githubusercontent.com"
  );
  const response = await githubGet(url, `downloading ${filePath}`, signal);
  const bytes = await readBoundedBytes(response, maximumFileBytes, `Source file ${filePath}`);
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new AppError(422, `The source file is not valid UTF-8 text: ${filePath}`, "UNSUPPORTED_REPOSITORY_FILE");
  }
  if (content.includes("\0")) {
    throw new AppError(422, `The source file is binary and cannot be indexed: ${filePath}`, "UNSUPPORTED_REPOSITORY_FILE");
  }
  return { path: filePath, content };
};

const resolveBranchViaApi = async (
  owner: string,
  repository: string,
  treePath: string | undefined,
  defaultBranch: string,
  signal?: AbortSignal
) => {
  if (!treePath) return { branch: defaultBranch, subdirectory: undefined as string | undefined };
  const segments = treePath.split("/");
  for (let length = segments.length; length >= 1; length -= 1) {
    const candidate = segments.slice(0, length).join("/");
    const branchUrl = new URL(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/branches/${encodeURIComponent(candidate)}`,
      "https://api.github.com"
    );
    const response = await githubGet(branchUrl, "loading the repository branch", signal, { allowNotFound: true });
    if (response.status === 404) continue;
    const branchDetails = await readJson(response, branchSchema, 1_000_000, "branch details");
    const subdirectory = segments.slice(length).join("/") || undefined;
    return { branch: candidate, subdirectory, branchDetails };
  }
  throw new AppError(404, "The requested GitHub branch was not found", "GITHUB_BRANCH_NOT_FOUND");
};

export const fetchGitHubRepositoryFilesViaApi = async (
  repositoryUrl: string,
  onProgress?: (stage: "validating" | "discovering" | "indexing") => void,
  signal?: AbortSignal
): Promise<RepositoryFileInput[]> => {
  onProgress?.("validating");
  const parsedRepository = parsePublicGitHubRepositoryUrl(repositoryUrl);
  let { owner, repository } = parsedRepository;
  const { branch } = parsedRepository;
  onProgress?.("discovering");
  const repositoryApiUrl = new URL(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`,
    "https://api.github.com"
  );
  const repositoryResult = await githubGetWithUrl(repositoryApiUrl, "loading repository details", signal);
  const repositoryResponse = repositoryResult.response;
  const redirectedRepository = /^\/repos\/([^/]+)\/([^/]+)\/?$/.exec(
    repositoryResult.effectiveUrl.pathname
  );
  if (redirectedRepository) {
    owner = decodeURIComponent(redirectedRepository[1]);
    repository = decodeURIComponent(redirectedRepository[2]).replace(/\.git$/i, "");
  }
  const repositoryDetails = await readJson(
    repositoryResponse,
    repositorySchema,
    1_000_000,
    "repository details"
  );
  const resolved = await resolveBranchViaApi(
    owner,
    repository,
    branch,
    repositoryDetails.default_branch,
    signal
  );
  const branchDetails = resolved.branchDetails ?? await readJson(
    await githubGet(
      new URL(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/branches/${encodeURIComponent(resolved.branch)}`,
        "https://api.github.com"
      ),
      "loading the repository branch",
      signal
    ),
    branchSchema,
    1_000_000,
    "branch details"
  );
  const treeUrl = new URL(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/git/trees/${branchDetails.commit.commit.tree.sha}?recursive=1`,
    "https://api.github.com"
  );
  const treeResponse = await githubGet(treeUrl, "loading the repository file tree", signal);
  const tree = await readJson(treeResponse, treeSchema, maximumTreeResponseBytes, "repository file tree");
  if (tree.truncated) {
    throw new AppError(413, "GitHub truncated this repository's file tree, so it cannot be imported completely.", "GITHUB_TREE_TRUNCATED");
  }

  const sourceFiles = tree.tree
    .filter((entry) => entry.type === "blob" && entry.mode !== "120000")
    .map((entry) => ({
      path: normalizeRepositoryPath(entry.path),
      size: entry.size
    }))
    .filter((entry) => isIndexableRepositoryPath(entry.path))
    .filter((entry) => !resolved.subdirectory || entry.path === resolved.subdirectory || entry.path.startsWith(`${resolved.subdirectory}/`));

  if (sourceFiles.length === 0) {
    throw new AppError(
      resolved.subdirectory ? 404 : 400,
      resolved.subdirectory
        ? "The requested repository subdirectory was not found or has no supported source files"
        : "No supported source or documentation files were found in this repository",
      resolved.subdirectory ? "GITHUB_SUBDIRECTORY_NOT_FOUND" : "NO_INDEXABLE_FILES"
    );
  }
  if (sourceFiles.length > maximumFiles) {
    throw new AppError(413, `The repository contains more than ${maximumFiles} indexable files`, "GITHUB_IMPORT_FILE_LIMIT");
  }

  const sizedSourceFiles = sourceFiles.map((file) => {
    if (file.size === undefined) {
      throw new AppError(502, `GitHub did not provide the size for ${file.path}`, "INVALID_GITHUB_RESPONSE");
    }
    if (file.size > maximumFileBytes) {
      throw new AppError(413, `Source file ${file.path} exceeds the 1 MB per-file import limit`, "GITHUB_IMPORT_FILE_TOO_LARGE");
    }
    return { ...file, size: file.size };
  });
  let estimatedBytes = 0;
  for (const file of sizedSourceFiles) {
    estimatedBytes += file.size;
    if (estimatedBytes > maximumRepositoryBytes) {
      throw new AppError(413, "The repository exceeds the 20 MB source import limit", "GITHUB_IMPORT_SIZE_LIMIT");
    }
  }

  const files: RepositoryFileInput[] = [];
  for (let offset = 0; offset < sizedSourceFiles.length; offset += downloadConcurrency) {
    if (signal?.aborted) {
      throw new AppError(409, "Repository import was cancelled", "IMPORT_CANCELLED");
    }
    const batch = sizedSourceFiles.slice(offset, offset + downloadConcurrency);
    files.push(...await Promise.all(batch.map((file) =>
      downloadFile(owner, repository, branchDetails.commit.sha, file.path, signal)
    )));
  }
  return files;
};

export const fetchPublicGitHubRepositoryFiles = async (
  repositoryUrl: string,
  onProgress?: (stage: "validating" | "cloning" | "discovering" | "indexing") => void,
  signal?: AbortSignal
): Promise<RepositoryFileInput[]> => {
  parsePublicGitHubRepositoryUrl(repositoryUrl);
  const strategy = env.GITHUB_IMPORT_STRATEGY;
  const useGit = strategy === "git" || strategy === "git_then_api";
  if (useGit && await isGitAvailable()) {
    const parsed = parsePublicGitHubRepositoryUrl(repositoryUrl);
    try {
      return await clonePublicGitHubRepositoryFiles({
        owner: parsed.owner,
        repository: parsed.repository,
        cloneUrl: parsed.cloneUrl,
        branch: parsed.branch,
        signal,
        onProgress
      });
    } catch (error) {
      if (strategy === "git" ||
        (error instanceof AppError && ["IMPORT_CANCELLED", "GITHUB_BRANCH_NOT_FOUND"].includes(error.code))) {
        throw error;
      }
    }
  } else if (strategy === "git") {
    throw new AppError(503, "Git is not installed on the NEXUS API host", "GIT_NOT_INSTALLED");
  }
  return fetchGitHubRepositoryFilesViaApi(repositoryUrl, onProgress, signal);
};
