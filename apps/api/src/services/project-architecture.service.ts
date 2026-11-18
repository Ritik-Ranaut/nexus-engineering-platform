import path from "node:path";
import { createHash } from "node:crypto";
import ts from "typescript";
import { languageForPath } from "./code-chunker.service.js";
import type { SafeRepositoryFile } from "../utils/repository-input.js";

export const architectureCategories = [
  "route",
  "page",
  "controller",
  "service",
  "model",
  "component",
  "hook",
  "utility",
  "configuration",
  "test",
  "other"
] as const;

export type ArchitectureCategory = typeof architectureCategories[number];

export interface ProjectFileAnalysis {
  filePath: string;
  language: string;
  category: ArchitectureCategory;
  lineCount: number;
  sizeBytes: number;
  contentHash: string;
  imports: string[];
  symbols: string[];
}

export interface ArchitectureNode extends ProjectFileAnalysis {
  id: string;
  label: string;
  type: ArchitectureCategory;
}

export interface ArchitectureRelationship {
  id: string;
  source: string;
  target: string;
  type: "IMPORTS";
  evidence: string;
  sourceOfInference: "static_import";
  confidence: 1;
  verificationStatus: "statically_confirmed";
}

const categoryPatterns: [ArchitectureCategory, RegExp[]][] = [
  ["test", [/(^|\/)__tests__(\/|$)/, /(^|\/)tests?(\/|$)/, /\.(test|spec)\.[^.]+$/]],
  ["route", [/(^|\/)routes?(\/|$)/, /\.(route|routes)\.[^.]+$/]],
  ["page", [/(^|\/)pages?(\/|$)/, /\.(page|pages)\.[^.]+$/]],
  ["controller", [/(^|\/)controllers?(\/|$)/, /\.controller\.[^.]+$/]],
  ["service", [/(^|\/)services?(\/|$)/, /\.service\.[^.]+$/]],
  ["model", [/(^|\/)models?(\/|$)/, /\.model\.[^.]+$/]],
  ["component", [/(^|\/)components?(\/|$)/, /\.(component|components)\.[^.]+$/]],
  ["hook", [/(^|\/)hooks?(\/|$)/, /(^|\/)use[A-Z][^/]*\.[^.]+$/]],
  ["utility", [/(^|\/)utils?(\/|$)/, /(^|\/)lib(\/|$)/]],
  ["configuration", [/(^|\/)config(uration)?(\/|$)/, /(^|\/)(vite|webpack|jest|vitest|eslint|prettier)\.config\./, /(^|\/)(package|tsconfig|settings)\.[^/]+$/]]
];

const classifyFile = (filePath: string): ArchitectureCategory => {
  const normalized = filePath.toLowerCase();
  return categoryPatterns.find(([, patterns]) =>
    patterns.some((pattern) => pattern.test(normalized))
  )?.[0] ?? "other";
};

const extractImports = (source: string, filePath: string): string[] => {
  const imports = new Set<string>();
  const extension = path.posix.extname(filePath).toLowerCase();
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(extension)) {
    const scriptKind = extension === ".tsx" ? ts.ScriptKind.TSX
      : extension === ".jsx" ? ts.ScriptKind.JSX
        : [".js", ".mjs", ".cjs"].includes(extension) ? ts.ScriptKind.JS
          : ts.ScriptKind.TS;
    const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind);
    const addModuleSpecifier = (node: ts.Expression | undefined) => {
      if (node && ts.isStringLiteralLike(node)) imports.add(node.text);
    };
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        addModuleSpecifier(node.moduleSpecifier);
      } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
        const [argument] = node.arguments;
        if (
          node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require")
        ) addModuleSpecifier(argument);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return [...imports].sort();
  }
  const patterns = [
    /\b(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /^\s*(?:from\s+([.\w]+)\s+import|import\s+([.\w]+))/gm
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const imported = match[1] ?? match[2];
      if (imported) imports.add(imported);
    }
  }
  return [...imports].sort();
};

const extractSymbols = (source: string): string[] => {
  const symbols = new Set<string>();
  const patterns = [
    /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g,
    /^\s*def\s+([A-Za-z_]\w*)\s*\(/gm
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) symbols.add(match[1]);
    }
  }
  return [...symbols].sort();
};

export const analyzeProjectFiles = (files: SafeRepositoryFile[]) => {
  const analyzed = files.map((file): ProjectFileAnalysis => ({
    filePath: file.path,
    language: languageForPath(file.path),
    category: classifyFile(file.path),
    lineCount: file.content.length === 0 ? 0 : file.content.split(/\r\n|\r|\n/).length,
    sizeBytes: Buffer.byteLength(file.content, "utf8"),
    contentHash: createHash("sha256").update(file.content).digest("hex"),
    imports: extractImports(file.content, file.path),
    symbols: extractSymbols(file.content)
  }));
  const byPath = new Map(analyzed.map((file) => [file.filePath, file]));
  const nodes: ArchitectureNode[] = analyzed.map((file) => ({
    ...file,
    id: file.filePath,
    label: path.posix.basename(file.filePath),
    type: file.category
  }));
  const relationships: ArchitectureRelationship[] = [];

  for (const file of files) {
    for (const specifier of extractImports(file.content, file.path)) {
      if (!specifier.startsWith(".")) continue;
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), specifier));
      const sourceExtensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py", ".vue"];
      const knownExtension = path.posix.extname(base);
      const extensionlessBase = knownExtension ? base.slice(0, -knownExtension.length) : base;
      const candidates = [
        base,
        ...sourceExtensions.map((extension) => `${extensionlessBase}${extension}`),
        ...[".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".py"].map((extension) => `${base}/index${extension}`)
      ];
      const target = candidates.find((candidate) => byPath.has(candidate));
      if (target) {
        const id = createHash("sha256")
          .update(`${file.path}:IMPORTS:${target}:${specifier}`)
          .digest("hex");
        relationships.push({
          id,
          source: file.path,
          target,
          type: "IMPORTS",
          evidence: specifier,
          sourceOfInference: "static_import",
          confidence: 1,
          verificationStatus: "statically_confirmed"
        });
      }
    }
  }

  const summary = Object.fromEntries(architectureCategories.map((category) => [
    category,
    analyzed.filter((file) => file.category === category).length
  ]));
  return { files: analyzed, nodes, relationships, summary };
};
