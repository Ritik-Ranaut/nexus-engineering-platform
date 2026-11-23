import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { env } from "../config/env.js";
import { AppError } from "../utils/app-error.js";
import {
  isIndexableRepositoryPath,
  normalizeRepositoryPath,
  type RepositoryFileInput
} from "../utils/repository-input.js";

const execFile = promisify(execFileCallback);
const maximumFiles = 1_000;
const maximumFileBytes = 1_000_000;
const maximumRepositoryBytes = 20_000_000;
const gitProbeTimeoutMs = 8_000;
const gitCloneTimeoutMs = 180_000;
const skippedDirectoryNames = new Set(["node_modules", "vendor", ".git", "dist", "build", "coverage"]);

export interface GitHubCloneRequest {
  owner: string;
  repository: string;
  cloneUrl: string;
  branch?: string;
  subdirectory?: string;
  signal?: AbortSignal;
  onProgress?: (stage: "validating" | "cloning" | "discovering") => void;
}

const sanitizeGitMessage = (value: string) =>
  value
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/x-access-token:[^@\s]+/gi, "x-access-token:[REDACTED]")
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, "[REDACTED]");

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) {
    throw new AppError(409, "Repository import was cancelled", "IMPORT_CANCELLED");
  }
};

const gitEnvironment = (): NodeJS.ProcessEnv => {
  const processEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "echo",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null"
  };
  if (env.GITHUB_TOKEN) {
    processEnv.GIT_CONFIG_COUNT = "1";
    processEnv.GIT_CONFIG_KEY_0 = "http.extraHeader";
    processEnv.GIT_CONFIG_VALUE_0 = `Authorization: Bearer ${env.GITHUB_TOKEN}`;
  }
  return processEnv;
};

const classifyGitFailure = (error: unknown): AppError => {
  if (error instanceof AppError) return error;
  const code = typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "";
  if (code === "ABORT_ERR" || code === "ERR_ABORTED") {
    return new AppError(409, "Repository import was cancelled", "IMPORT_CANCELLED");
  }
  if (code === "ENOENT") {
    return new AppError(503, "Git is not installed on the NEXUS API host", "GIT_NOT_INSTALLED");
  }
  if (code === "ETIMEDOUT") {
    return new AppError(504, "Timed out while cloning the GitHub repository", "GITHUB_IMPORT_TIMEOUT");
  }
  const stderr = typeof error === "object" && error !== null && "stderr" in error
    ? sanitizeGitMessage(String(error.stderr))
    : "";
  const output = stderr.toLowerCase();
  if (output.includes("authentication failed") || output.includes("could not read username")) {
    return new AppError(
      404,
      "The repository was not found or is private. Public repositories can be imported without a token; private repositories require GITHUB_TOKEN on the API.",
      "GITHUB_REPOSITORY_NOT_FOUND"
    );
  }
  if (output.includes("not found") || output.includes("repository not found")) {
    return new AppError(
      404,
      "The repository or branch was not found or is private. Only public GitHub repositories can be imported without a token.",
      "GITHUB_REPOSITORY_NOT_FOUND"
    );
  }
  if (output.includes("remote branch") && output.includes("not found")) {
    return new AppError(404, "The requested GitHub branch was not found", "GITHUB_BRANCH_NOT_FOUND");
  }
  return new AppError(502, "Git could not clone this GitHub repository", "GITHUB_CLONE_FAILED");
};

export const runGit = async (
  args: string[],
  options: { cwd?: string; signal?: AbortSignal; timeout?: number } = {}
) => {
  throwIfAborted(options.signal);
  try {
    return await execFile("git", args, {
      cwd: options.cwd,
      timeout: options.timeout ?? gitCloneTimeoutMs,
      signal: options.signal,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 8_000_000,
      env: gitEnvironment()
    });
  } catch (error) {
    throw classifyGitFailure(error);
  }
};

export const isGitAvailable = async (): Promise<boolean> => {
  try {
    await runGit(["--version"], { timeout: gitProbeTimeoutMs });
    return true;
  } catch {
    return false;
  }
};

const gitSafetyPrefix = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "protocol.file.allow=never",
  "-c", "protocol.ext.allow=never"
];

export const listRemoteHeads = async (
  cloneUrl: string,
  signal?: AbortSignal
): Promise<{ defaultBranch?: string; branches: string[] }> => {
  const { stdout } = await runGit(
    [...gitSafetyPrefix, "ls-remote", "--heads", "--symref", "--", cloneUrl],
    { signal, timeout: 30_000 }
  );
  const branches: string[] = [];
  let defaultBranch: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    const symref = line.match(/^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/);
    if (symref?.[1]) {
      defaultBranch = symref[1];
      continue;
    }
    const head = line.match(/^[a-f0-9]+\s+refs\/heads\/(.+)$/i);
    if (head?.[1]) branches.push(head[1]);
  }
  return { defaultBranch, branches };
};

export const resolveBranchAndSubdirectory = (
  treePath: string | undefined,
  branches: string[],
  defaultBranch?: string
): { branch: string; subdirectory?: string } => {
  if (!treePath) {
    const branch = defaultBranch ?? branches.find((name) => name === "main" || name === "master") ?? branches[0];
    if (!branch) {
      throw new AppError(400, "The GitHub repository has no branches to import", "GITHUB_REPOSITORY_EMPTY");
    }
    return { branch };
  }
  const matching = branches
    .filter((branch) => treePath === branch || treePath.startsWith(`${branch}/`))
    .sort((left, right) => right.length - left.length);
  const branch = matching[0];
  if (!branch) {
    throw new AppError(404, "The requested GitHub branch was not found", "GITHUB_BRANCH_NOT_FOUND");
  }
  const subdirectory = treePath.slice(branch.length).replace(/^\//, "") || undefined;
  return { branch, subdirectory };
};

const assertInsideBase = async (baseDir: string, targetDir: string) => {
  const [base, target] = await Promise.all([realpath(baseDir), realpath(targetDir)]);
  const relative = path.relative(base, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new AppError(500, "Repository checkout left the import sandbox", "GITHUB_CLONE_FAILED");
  }
};

export const readIndexableFilesFromDirectory = async (
  rootDir: string,
  subdirectory?: string
): Promise<RepositoryFileInput[]> => {
  const root = await realpath(rootDir);
  const scopedRoot = subdirectory
    ? await realpath(path.join(root, ...subdirectory.split("/")))
    : root;
  const scopedRelative = path.relative(root, scopedRoot);
  if (subdirectory && (scopedRelative.startsWith("..") || path.isAbsolute(scopedRelative))) {
    throw new AppError(400, "The requested repository subdirectory is invalid", "INVALID_REPOSITORY_SUBDIRECTORY");
  }

  const files: RepositoryFileInput[] = [];
  let totalBytes = 0;

  const walk = async (directory: string, relativeDir: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (skippedDirectoryNames.has(entry.name.toLowerCase())) continue;
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(fullPath, relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      let normalized: string;
      try {
        normalized = normalizeRepositoryPath(relativePath);
      } catch {
        continue;
      }
      if (!isIndexableRepositoryPath(normalized)) continue;
      const fileStat = await stat(fullPath);
      if (fileStat.size > maximumFileBytes) {
        throw new AppError(413, `Source file ${normalized} exceeds the 1 MB per-file import limit`, "GITHUB_IMPORT_FILE_TOO_LARGE");
      }
      totalBytes += fileStat.size;
      if (totalBytes > maximumRepositoryBytes) {
        throw new AppError(413, "The repository exceeds the 20 MB source import limit", "GITHUB_IMPORT_SIZE_LIMIT");
      }
      if (files.length >= maximumFiles) {
        throw new AppError(413, `The repository contains more than ${maximumFiles} indexable files`, "GITHUB_IMPORT_FILE_LIMIT");
      }
      const bytes = await readFile(fullPath);
      if (bytes.includes(0)) {
        throw new AppError(422, `The source file is binary and cannot be indexed: ${normalized}`, "UNSUPPORTED_REPOSITORY_FILE");
      }
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new AppError(422, `The source file is not valid UTF-8 text: ${normalized}`, "UNSUPPORTED_REPOSITORY_FILE");
      }
      files.push({ path: normalized, content });
    }
  };

  try {
    await walk(scopedRoot, subdirectory ?? "");
  } catch (error) {
    const nodeCode = typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
    if (nodeCode === "ENOENT" && subdirectory) {
      throw new AppError(404, "The requested repository subdirectory was not found", "GITHUB_SUBDIRECTORY_NOT_FOUND");
    }
    throw error;
  }

  if (files.length === 0) {
    throw new AppError(400, "No supported source or documentation files were found in this repository", "NO_INDEXABLE_FILES");
  }
  return files;
};

export const clonePublicGitHubRepositoryFiles = async (
  request: GitHubCloneRequest
): Promise<RepositoryFileInput[]> => {
  request.onProgress?.("validating");
  throwIfAborted(request.signal);
  const { defaultBranch, branches } = await listRemoteHeads(request.cloneUrl, request.signal);
  const resolved = resolveBranchAndSubdirectory(
    request.branch,
    branches,
    defaultBranch
  );
  const subdirectory = request.subdirectory ?? resolved.subdirectory;
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "nexus-import-"));
  const checkoutDir = path.join(workspaceRoot, "checkout");
  request.onProgress?.("cloning");
  try {
    await runGit(
      [
        ...gitSafetyPrefix,
        "clone",
        "--depth", "1",
        "--single-branch",
        "--no-tags",
        "--branch", resolved.branch,
        "--",
        request.cloneUrl,
        checkoutDir
      ],
      { signal: request.signal, timeout: gitCloneTimeoutMs }
    );
    await assertInsideBase(tmpdir(), checkoutDir);
    request.onProgress?.("discovering");
    return await readIndexableFilesFromDirectory(checkoutDir, subdirectory);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true }).catch((error: unknown) => {
      console.error("Could not remove GitHub import workspace", {
        errorType: error instanceof Error ? error.name : "UnknownError"
      });
    });
  }
};
