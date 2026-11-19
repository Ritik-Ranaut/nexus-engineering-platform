import { AppError } from "./app-error.js";

const supportedExtensions = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".go", ".h", ".hpp", ".html",
  ".java", ".js", ".jsx", ".md", ".mdx", ".php", ".py", ".rb", ".rs",
  ".ini", ".json", ".properties", ".rst", ".scss", ".sh", ".sql", ".swift",
  ".toml", ".ts", ".tsx", ".txt", ".vue", ".xml", ".yaml", ".yml"
]);

const sensitiveFileNames = new Set([
  ".env", ".env.local", ".env.production", "id_rsa", "id_ed25519",
  "credentials", "secrets.json"
]);

export interface RepositoryFileInput {
  path: string;
  content: string;
}

export interface SafeRepositoryFile {
  path: string;
  content: string;
}

export const normalizeRepositoryPath = (filePath: string): string => {
  const normalized = filePath.replace(/\\/g, "/");
  if (
    normalized.startsWith("/") ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.split("/").some((part) => part === ".." || part === "." || part.length === 0) ||
    normalized.includes("\0")
  ) {
    throw new AppError(400, "Repository paths must be relative and cannot traverse directories", "INVALID_FILE_PATH");
  }
  return normalized;
};

const shouldIndex = (filePath: string): boolean => {
  const lowerPath = filePath.toLowerCase();
  const baseName = lowerPath.split("/").at(-1) ?? lowerPath;
  if (
    sensitiveFileNames.has(baseName) ||
    baseName.startsWith(".env.") ||
    /\.(pem|p12|pfx|key|crt|cer)$/i.test(baseName) ||
    /(^|\/)(node_modules|vendor|\.git|dist|build|coverage)\//.test(lowerPath)
  ) return false;
  const dot = baseName.lastIndexOf(".");
  return supportedExtensions.has(baseName.slice(dot)) ||
    ["dockerfile", "makefile", "cmakelists.txt"].includes(baseName);
};

export const isIndexableRepositoryPath = (filePath: string) =>
  shouldIndex(normalizeRepositoryPath(filePath));

const quotedCredentialPattern =
  /\b(api[_-]?key|access[_-]?token|client[_-]?secret|private[_-]?key|credential|authorization|token|password|passwd|secret)\b(\s*[:=]\s*)(["'`])([^"'`\r\n]{6,})\3/gi;
const unquotedCredentialPattern =
  /\b(api[_-]?key|access[_-]?token|client[_-]?secret|private[_-]?key|credential|authorization|token|password|passwd|secret)\b(\s*[:=]\s*)([A-Za-z0-9/+=._-]{8,})\b/gi;
const secretPatterns: RegExp[] = [
  /\b(AKIA[0-9A-Z]{16})\b/g,
  /\b(gh[pousr]_[A-Za-z0-9_]{20,})\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g
];

export const redactSecrets = (content: string): string => secretPatterns.reduce(
  (safeContent, pattern) => safeContent.replace(
    pattern,
    (match) => match.startsWith("Bearer ") ? "Bearer [REDACTED]" : "[REDACTED]"
  ),
  content
    .replace(
      quotedCredentialPattern,
      (_match, label: string, separator: string, quote: string) =>
        `${label}${separator}${quote}[REDACTED]${quote}`
    )
    .replace(
      unquotedCredentialPattern,
      (_match, label: string, separator: string) => `${label}${separator}[REDACTED]`
    )
);

export const prepareRepositoryFiles = (files: RepositoryFileInput[]): SafeRepositoryFile[] => {
  const seenPaths = new Set<string>();
  const safeFiles: SafeRepositoryFile[] = [];
  for (const file of files) {
    const path = normalizeRepositoryPath(file.path);
    if (seenPaths.has(path)) {
      throw new AppError(400, `Duplicate repository path: ${path}`, "DUPLICATE_FILE_PATH");
    }
    seenPaths.add(path);
    if (!shouldIndex(path)) continue;
    safeFiles.push({ path, content: redactSecrets(file.content) });
  }
  if (safeFiles.length === 0) {
    throw new AppError(400, "No supported source or documentation files were provided", "NO_INDEXABLE_FILES");
  }
  return safeFiles;
};
