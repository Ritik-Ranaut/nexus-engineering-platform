const githubPathPattern = /^https:\/\/(?:www\.)?github\.com\/[^/]+\/[^/]+/i;

export const normalizeGitHubRepositoryUrlInput = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^git@github\.com:/i.test(trimmed)) {
    return `https://github.com/${trimmed.replace(/^git@github\.com:/i, "").replace(/\.git$/i, "")}`;
  }
  if (/^http:\/\/(?:www\.)?github\.com\//i.test(trimmed)) {
    return `https://${trimmed.replace(/^http:\/\/(?:www\.)?/i, "")}`;
  }
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^(www\.)?github\.com\//i.test(trimmed)) return `https://${trimmed}`;
  if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(trimmed)) return `https://github.com/${trimmed}`;
  return trimmed;
};

export const githubRepositoryUrlError = (value: string): string | null => {
  const normalized = normalizeGitHubRepositoryUrlInput(value);
  if (!normalized) return "Enter a public GitHub repository URL.";
  try {
    const url = new URL(normalized);
    if (!githubPathPattern.test(url.href) && !githubPathPattern.test(`https://github.com${url.pathname}`)) {
      return "Use a github.com repository URL such as https://github.com/owner/repository.";
    }
    if (url.hostname.replace(/^www\./i, "").toLowerCase() !== "github.com") {
      return "Only github.com repository URLs can be imported.";
    }
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length < 2) {
      return "Enter a GitHub URL in the form https://github.com/owner/repository.";
    }
    if (segments[2] && !["tree"].includes(segments[2]) && segments[2] !== undefined) {
      if (["blob", "commit", "pulls", "issues"].includes(segments[2])) {
        return "Use a repository or branch URL, not a file URL.";
      }
    }
  } catch {
    return "Enter a valid public GitHub repository URL.";
  }
  return null;
};
