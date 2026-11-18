export interface CodeChunk {
  filePath: string;
  language: string;
  symbolContext: string;
  startLine: number;
  endLine: number;
  content: string;
}

interface SymbolDeclaration {
  name: string;
  kind: "class" | "function" | "module";
}

const languageByExtension: Record<string, string> = {
  c: "c", cc: "cpp", cpp: "cpp", cs: "csharp", css: "css", go: "go",
  h: "c", hpp: "cpp", html: "html", ini: "ini", java: "java", js: "javascript",
  jsx: "javascript", md: "markdown", mdx: "markdown", php: "php",
  py: "python", rb: "ruby", rs: "rust", rst: "restructuredtext",
  json: "json", properties: "properties", scss: "scss", sh: "shell", sql: "sql",
  swift: "swift", toml: "toml", ts: "typescript",
  tsx: "typescript", txt: "text", vue: "vue", xml: "xml", yaml: "yaml", yml: "yaml"
};

const findDeclaration = (line: string, insideClass: boolean): SymbolDeclaration | null => {
  const patterns: Array<[RegExp, SymbolDeclaration["kind"]]> = [
    [/\b(?:class|interface|struct|enum|trait|record)\s+([A-Za-z_$][\w$]*)/, "class"],
    [/\b(?:function|def|fn|func)\s+([A-Za-z_$][\w$]*)/, "function"],
    [/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/, "function"]
  ];
  for (const [pattern, kind] of patterns) {
    const match = line.match(pattern);
    if (match?.[1]) return { name: match[1], kind };
  }
  if (insideClass) {
    const match = line.match(/^\s*(?:(?:public|private|protected|static|async|override|final|abstract)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\s*\{/);
    if (match?.[1] && !["if", "for", "while", "switch", "catch", "return"].includes(match[1])) {
      return { name: match[1], kind: "function" };
    }
  }
  return null;
};

export const languageForPath = (filePath: string): string => {
  const extension = filePath.split(".").at(-1)?.toLowerCase() ?? "";
  return languageByExtension[extension] ?? "text";
};

const splitOversizedBlock = (
  lines: string[],
  firstLine: number,
  filePath: string,
  language: string,
  symbolContext: string
): CodeChunk[] => {
  const result: CodeChunk[] = [];
  let pending: string[] = [];
  let startLine = firstLine;
  let characters = 0;
  const lastBlankLine = () => {
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      if (pending[index]?.trim() === "") return index;
    }
    return -1;
  };
  const flush = () => {
    while (pending.at(-1)?.trim() === "") pending.pop();
    if (pending.length > 0) {
      result.push({
        filePath,
        language,
        symbolContext,
        startLine,
        endLine: startLine + pending.length - 1,
        content: pending.join("\n")
      });
    }
    pending = [];
    characters = 0;
  };
  lines.forEach((line, offset) => {
    if (pending.length >= 100 || characters + line.length > 8_000) {
      const lastBlank = lastBlankLine();
      if (lastBlank > 0 && lastBlank >= pending.length - 12) {
        const carry = pending.splice(lastBlank + 1);
        flush();
        pending = carry;
        startLine = firstLine + offset - carry.length;
        characters = carry.reduce((sum, item) => sum + item.length, 0);
      } else {
        flush();
        startLine = firstLine + offset;
      }
    }
    pending.push(line);
    characters += line.length;
  });
  flush();
  return result;
};

export const chunkSourceFile = (filePath: string, source: string): CodeChunk[] => {
  const language = languageForPath(filePath);
  const lines = source.split(/\r?\n/);
  const chunks: CodeChunk[] = [];
  let block: string[] = [];
  let blockStart = 1;
  let currentContext = "module scope";
  let blockContext = currentContext;
  let classContext: string | null = null;
  let classBraceDepth: number | null = null;
  let classIndent = 0;
  let braceDepth = 0;
  let blockCharacters = 0;
  const flush = () => {
    chunks.push(...splitOversizedBlock(block, blockStart, filePath, language, blockContext));
    block = [];
    blockCharacters = 0;
  };

  lines.forEach((line, index) => {
    const indentation = line.length - line.trimStart().length;
    if (
      classContext &&
      language === "python" &&
      line.trim() &&
      indentation <= classIndent &&
      !/^\s*class\b/.test(line)
    ) {
      classContext = null;
      classBraceDepth = null;
      currentContext = "module scope";
    }
    const declaration = findDeclaration(line, classContext !== null);
    if (declaration && block.length > 0) flush();
    if (declaration) {
      if (declaration.kind === "class") {
        classContext = declaration.name;
        classIndent = indentation;
        currentContext = declaration.name;
      } else if (declaration.kind === "function") {
        currentContext = classContext
          ? `${classContext}.${declaration.name}`
          : declaration.name;
      }
    }
    if (block.length === 0) {
      blockStart = index + 1;
      blockContext = currentContext;
    }
    block.push(line);
    blockCharacters += line.length;
    if (block.length >= 100 || blockCharacters > 8_000) flush();

    braceDepth += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
    if (declaration?.kind === "class" && braceDepth > 0) classBraceDepth = braceDepth;
    if (classBraceDepth !== null && braceDepth < classBraceDepth) {
      classContext = null;
      classBraceDepth = null;
      currentContext = "module scope";
    }
  });
  if (block.length > 0) flush();
  return chunks.filter((chunk) => chunk.content.trim().length > 0);
};
