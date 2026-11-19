import { z } from "zod";
import { AppError } from "../utils/app-error.js";
import {
  isIndexableRepositoryPath,
  normalizeRepositoryPath,
  type RepositoryFileInput
} from "../utils/repository-input.js";

const maximumFiles = 1_000;
const maximumFileBytes = 1_000_000;
const maximumRepositoryBytes = 20_000_000;
const maximumTreeResponseBytes = 20_000_000;
const requestTimeoutMs = 20_000;
const downloadConcurrency = 8;

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

export const parsePublicGitHubRepositoryUrl = (repositoryUrl: string) => {
  let url: URL;
  try {
    url = new URL(repositoryUrl);
  } catch {
    throw new AppError(400, "Enter a valid public GitHub repository URL", "INVALID_GITHUB_URL");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.port ||
    url.username ||
    url.password
  ) {
    throw new AppError(400, "Only public repositories hosted at https://github.com are supported", "UNSUPPORTED_REPOSITORY_HOST");
  }

  let segments: string[];
  try {
    segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    throw new AppError(400, "The GitHub repository URL contains invalid path encoding", "INVALID_GITHUB_URL");
  }
  if (segments.length === 0) {
    throw new AppError(400, "Enter a GitHub URL in the form https://github.com/owner/repository", "INVALID_GITHUB_URL");
  }
  const [owner, rawRepository] = segments;
  const repository = rawRepository?.replace(/\.git$/i, "");
  const validName = (value: string | undefined) =>
    Boolean(value && value !== "." && value !== ".." && /^[A-Za-z0-9_.-]+$/.test(value));
  if (!validName(owner) || !validName(repository)) {
    throw new AppError(400, "Enter a GitHub URL in the form https://github.com/owner/repository", "INVALID_GITHUB_URL");
  }

  let branch: string | undefined;
  if (segments.length === 2) {
    branch = undefined;
  } else if (segments.length >= 4 && segments[2] === "tree") {
    branch = segments.slice(3).map(decodeURIComponent).join("/");
    if (!branch || branch.split("/").some((part) => !validName(part))) {
      throw new AppError(400, "Enter a valid GitHub branch URL", "INVALID_GITHUB_URL");
    }
  } else {
    throw new AppError(400, "Use a repository URL or a GitHub branch URL, not a file or subfolder URL", "INVALID_GITHUB_URL");
  }
  return { owner, repository, branch };
};

const githubGet = async (url: URL, description: string) => {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "NEXUS-project-import"
      },
      redirect: "error",
      signal: AbortSignal.timeout(requestTimeoutMs)
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new AppError(504, `Timed out while ${description}`, "GITHUB_IMPORT_TIMEOUT");
    }
    throw new AppError(502, `Could not reach GitHub while ${description}`, "GITHUB_UNAVAILABLE");
  }
  if (response.status === 404) {
    throw new AppError(404, "The repository or branch was not found or is private. Only public GitHub repositories can be imported.", "GITHUB_REPOSITORY_NOT_FOUND");
  }
  if (response.status === 403 || response.status === 429) {
    throw new AppError(429, "GitHub rate-limited this import. Please wait and try again.", "GITHUB_RATE_LIMITED");
  }
  if (!response.ok) {
    throw new AppError(502, `GitHub could not provide the ${description}`, "GITHUB_IMPORT_FAILED");
  }
  return response;
};

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
  declaredSize: number
): Promise<RepositoryFileInput> => {
  const url = new URL(
    `/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/${commitSha}/${encodedPath(filePath)}`,
    "https://raw.githubusercontent.com"
  );
  const response = await githubGet(url, `downloading ${filePath}`);
  const bytes = await readBoundedBytes(response, maximumFileBytes, `Source file ${filePath}`);
  if (bytes.byteLength !== declaredSize) {
    throw new AppError(502, `GitHub returned an incomplete source file: ${filePath}`, "INVALID_GITHUB_RESPONSE");
  }
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

export const fetchPublicGitHubRepositoryFiles = async (
  repositoryUrl: string,
  onProgress?: (stage: "validating" | "discovering" | "indexing") => void
): Promise<RepositoryFileInput[]> => {
  onProgress?.("validating");
  const { owner, repository, branch } = parsePublicGitHubRepositoryUrl(repositoryUrl);
  onProgress?.("discovering");
  const repositoryApiUrl = new URL(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`,
    "https://api.github.com"
  );
  const repositoryResponse = await githubGet(repositoryApiUrl, "loading repository details");
  const repositoryDetails = await readJson(
    repositoryResponse,
    repositorySchema,
    1_000_000,
    "repository details"
  );
  const selectedBranch = branch ?? repositoryDetails.default_branch;
  const branchUrl = new URL(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/branches/${encodeURIComponent(selectedBranch)}`,
    "https://api.github.com"
  );
  const branchResponse = await githubGet(branchUrl, "loading the repository branch");
  const branchDetails = await readJson(branchResponse, branchSchema, 1_000_000, "branch details");
  const treeUrl = new URL(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/git/trees/${branchDetails.commit.commit.tree.sha}?recursive=1`,
    "https://api.github.com"
  );
  const treeResponse = await githubGet(treeUrl, "loading the repository file tree");
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
    .filter((entry) => isIndexableRepositoryPath(entry.path));

  if (sourceFiles.length === 0) {
    throw new AppError(400, "No supported source or documentation files were found in this repository", "NO_INDEXABLE_FILES");
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
    const batch = sizedSourceFiles.slice(offset, offset + downloadConcurrency);
    files.push(...await Promise.all(batch.map((file) =>
      downloadFile(owner, repository, branchDetails.commit.sha, file.path, file.size)
    )));
  }
  return files;
};
