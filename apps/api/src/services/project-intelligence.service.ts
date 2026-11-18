import { ProjectArchitecture } from "../models/project-architecture.model.js";
import { ProjectFile } from "../models/project-file.model.js";
import { analyzeProjectFiles } from "./project-architecture.service.js";
import { AppError } from "../utils/app-error.js";
import { normalizeRepositoryPath } from "../utils/repository-input.js";
import { getOwnedProject } from "./project.service.js";

const activeFilter = (projectId: string, ownerId: string, generation: number) => ({
  projectId,
  ownerId,
  generation
});

export const listProjectFiles = async (projectId: string, ownerId: string, search?: string) => {
  const project = await getOwnedProject(projectId, ownerId);
  const filter: Record<string, unknown> = activeFilter(projectId, ownerId, project.activeGeneration);
  if (search?.trim()) {
    const escaped = search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const expression = new RegExp(escaped, "i");
    filter.$or = [
      { filePath: expression },
      { content: expression },
      { category: expression },
      { language: expression },
      { symbols: expression }
    ];
  }
  const files = await ProjectFile.find(filter)
    .select("filePath language category lineCount sizeBytes contentHash imports symbols")
    .sort({ filePath: 1 })
    .lean();
  return files.map(({ _id, filePath, language, category, lineCount, sizeBytes, contentHash, imports, symbols }) => ({
    id: String(_id),
    filePath,
    language,
    category,
    lineCount,
    sizeBytes,
    contentHash,
    imports,
    symbols
  }));
};

export const getProjectFile = async (projectId: string, ownerId: string, inputPath: string) => {
  const project = await getOwnedProject(projectId, ownerId);
  const filePath = normalizeRepositoryPath(inputPath);
  const file = await ProjectFile.findOne(activeFilter(projectId, ownerId, project.activeGeneration))
    .where({ filePath })
    .lean();
  if (!file) throw new AppError(404, "Project file not found", "PROJECT_FILE_NOT_FOUND");
  return {
    id: String(file._id),
    filePath: file.filePath,
    content: file.content,
    language: file.language,
    category: file.category,
    lineCount: file.lineCount,
    sizeBytes: file.sizeBytes,
    contentHash: file.contentHash,
    imports: file.imports,
    symbols: file.symbols
  };
};

export const getProjectFileMetadata = async (projectId: string, ownerId: string, inputPath: string) => {
  const project = await getOwnedProject(projectId, ownerId);
  const filePath = normalizeRepositoryPath(inputPath);
  const file = await ProjectFile.findOne(activeFilter(projectId, ownerId, project.activeGeneration))
    .where({ filePath })
    .select("filePath language category lineCount sizeBytes contentHash imports symbols")
    .lean();
  if (!file) throw new AppError(404, "Project file not found", "PROJECT_FILE_NOT_FOUND");
  return {
    id: String(file._id),
    filePath: file.filePath,
    language: file.language,
    category: file.category,
    lineCount: file.lineCount,
    sizeBytes: file.sizeBytes,
    contentHash: file.contentHash,
    imports: file.imports,
    symbols: file.symbols
  };
};

export const getProjectArchitecture = async (projectId: string, ownerId: string) => {
  const project = await getOwnedProject(projectId, ownerId);
  return ProjectArchitecture.findOne(activeFilter(projectId, ownerId, project.activeGeneration)).lean();
};

export interface ArchitectureGraphFilters {
  search?: string;
  layer?: string;
  relationshipType?: string;
  limit: number;
  offset: number;
  neighborhood?: string;
}

interface GraphNode {
  id: string;
  projectId: string;
  name: string;
  type: string;
  filePath?: string;
  language: string;
  description: string;
  analysisSource: string;
  confidence: number;
  verificationStatus: string;
  category: string;
  imports: unknown[];
  symbols: unknown[];
}

interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  evidence: string;
  sourceOfInference: string;
  confidence: number;
  verificationStatus: string;
}

const frontendCategories = new Set(["component", "hook", "page"]);
const backendCategories = new Set(["route", "controller", "service", "model"]);

const graphForProject = async (projectId: string, ownerId: string) => {
  const project = await getOwnedProject(projectId, ownerId);
  const architecture = await ProjectArchitecture.findOne(
    activeFilter(projectId, ownerId, project.activeGeneration)
  ).lean();
  if (!architecture) {
    return {
      project,
      nodes: [],
      edges: [],
      totalNodes: 0,
      invalidGraphData: false,
      invalidPackageManifests: []
    };
  }
  const nodes: GraphNode[] = [];
  let invalidGraphData = false;
  const nodeIds = new Set<string>();
  const supportedCategories = new Set([
    "route", "page", "controller", "service", "model", "component",
    "hook", "utility", "configuration", "test", "other"
  ]);
  for (const rawNode of architecture.nodes) {
    if (typeof rawNode !== "object" || rawNode === null || Array.isArray(rawNode)) {
      invalidGraphData = true;
      continue;
    }
    const node = rawNode as Record<string, unknown>;
    const filePath = typeof node.filePath === "string"
      ? node.filePath
      : typeof node.id === "string" ? node.id : "";
    const id = typeof node.id === "string" ? node.id : filePath;
    if (!id || nodeIds.has(id)) {
      invalidGraphData = true;
      continue;
    }
    nodeIds.add(id);
    const category = typeof node.category === "string" && supportedCategories.has(node.category)
      ? node.category
      : "other";
    if (category === "other" && node.category !== "other") invalidGraphData = true;
    nodes.push({
      id,
      projectId,
      name: typeof node.label === "string" ? node.label : filePath.split("/").at(-1) ?? filePath,
      type: category,
      filePath,
      language: typeof node.language === "string" ? node.language : "unknown",
      description: `${category.replaceAll("_", " ")} file · ${Array.isArray(node.symbols) ? node.symbols.length : 0} detected symbols`,
      analysisSource: "static_file_analysis",
      confidence: 1,
      verificationStatus: "statically_classified",
      category,
      imports: Array.isArray(node.imports) ? node.imports.filter((entry): entry is string => typeof entry === "string") : [],
      symbols: Array.isArray(node.symbols) ? node.symbols.filter((entry): entry is string => typeof entry === "string") : []
    });
  }
  const edges: GraphEdge[] = [];
  const edgeIds = new Set<string>();
  for (const rawRelationship of architecture.relationships) {
    if (typeof rawRelationship !== "object" || rawRelationship === null || Array.isArray(rawRelationship)) {
      invalidGraphData = true;
      continue;
    }
    const relationship = rawRelationship as Record<string, unknown>;
    if (
      typeof relationship.source !== "string" ||
      typeof relationship.target !== "string" ||
      !nodeIds.has(relationship.source) ||
      !nodeIds.has(relationship.target)
    ) {
      invalidGraphData = true;
      continue;
    }
    const id = typeof relationship.id === "string"
      ? relationship.id
      : `${relationship.source}:${relationship.target}`;
    if (edgeIds.has(id)) {
      invalidGraphData = true;
      continue;
    }
    edgeIds.add(id);
    edges.push({
      id,
      source: relationship.source,
      target: relationship.target,
      type: "IMPORTS",
      evidence: typeof relationship.evidence === "string" ? relationship.evidence : "",
      sourceOfInference: "static_import",
      confidence: 1,
      verificationStatus: "statically_confirmed"
    });
  }

  const invalidPackageManifests: string[] = [];
  const manifests = await ProjectFile.find({
    ...activeFilter(projectId, ownerId, project.activeGeneration),
    filePath: /(^|\/)package\.json$/
  }).select("filePath content").sort({ filePath: 1 }).lean();
  for (const manifest of manifests) {
    try {
      const parsed: unknown = JSON.parse(manifest.content);
      if (typeof parsed === "object" && parsed !== null) {
        const dependencyGroups = [
          ["dependencies", "runtime"],
          ["devDependencies", "development"],
          ["peerDependencies", "peer"]
        ] as const;
        for (const [field, dependencyType] of dependencyGroups) {
          const value = (parsed as Record<string, unknown>)[field];
          if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
          for (const [name, version] of Object.entries(value)) {
            if (
              typeof version !== "string" ||
              name.length > 256 ||
              version.length > 256 ||
              !/^[\w@./+*-]+$/.test(name)
            ) continue;
            const id = `package:${name}`;
            if (!nodes.some((node) => node.id === id)) {
              nodes.push({
                id,
                projectId,
                name,
                type: "package",
                language: "package",
                description: `${dependencyType} dependency · ${version}`,
                analysisSource: "package_manifest",
                confidence: 1,
                verificationStatus: "manifest_declared",
                category: "package",
                imports: [],
                symbols: []
              });
            }
            edges.push({
              id: `${manifest.filePath}:DEPENDS_ON:${name}:${dependencyType}`,
              source: manifest.filePath,
              target: id,
              type: "DEPENDS_ON",
              evidence: `${field}.${name} = ${version}`,
              sourceOfInference: "package_manifest",
              confidence: 1,
              verificationStatus: "manifest_declared"
            });
          }
        }
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      invalidPackageManifests.push(manifest.filePath);
    }
  }
  return { project, nodes, edges, totalNodes: nodes.length, invalidPackageManifests, invalidGraphData };
};

export const getArchitectureGraph = async (
  projectId: string,
  ownerId: string,
  filters: ArchitectureGraphFilters
) => {
  const graph = await graphForProject(projectId, ownerId);
  const term = filters.search?.trim().toLocaleLowerCase();
  const matching = graph.nodes.filter((node) => {
    if (!filters.neighborhood && filters.layer === "frontend" && !frontendCategories.has(node.category)) return false;
    if (!filters.neighborhood && filters.layer === "backend" && !backendCategories.has(node.category)) return false;
    if (!filters.neighborhood && filters.layer === "data" && node.category !== "model" && node.category !== "package" &&
        !(node.category === "configuration" && node.filePath?.endsWith("package.json"))) return false;
    if (!filters.neighborhood && filters.layer === "tests" && node.category !== "test") return false;
    if (!filters.neighborhood && filters.layer === "configuration" && node.category !== "configuration") return false;
    if (term && !`${node.name} ${node.filePath ?? ""} ${node.type} ${node.symbols.join(" ")}`
      .toLocaleLowerCase().includes(term)) return false;
    return true;
  });
  const neighborhood = filters.neighborhood
    ? new Set([
      filters.neighborhood,
      ...graph.edges.flatMap((edge) => edge.source === filters.neighborhood
        ? [edge.target]
        : edge.target === filters.neighborhood ? [edge.source] : [])
    ])
    : null;
  const filtered = matching.filter((node) => !neighborhood || neighborhood.has(node.id));
  const total = filtered.length;
  const pageNodes = filtered.slice(filters.offset, filters.offset + filters.limit);
  const nodeIds = new Set(pageNodes.map((node) => node.id));
  const edges = graph.edges.filter((edge) =>
    (!filters.relationshipType || edge.type === filters.relationshipType) &&
    nodeIds.has(edge.source) && nodeIds.has(edge.target)
  );
  return {
    projectId,
    generation: graph.project.activeGeneration,
    nodes: pageNodes,
    edges,
    totalNodes: total,
    totalEdges: edges.length,
    limit: filters.limit,
    offset: filters.offset,
    truncated: filters.offset + pageNodes.length < total,
    analysisStatus: graph.project.indexingStatus === "ready" &&
        graph.invalidPackageManifests.length === 0 && !graph.invalidGraphData
      ? "complete"
      : "partial",
    limitations: [
      ...(graph.invalidPackageManifests.map((filePath) =>
        `${filePath} is invalid; its package dependency edges were omitted.`
      )),
      ...(graph.invalidGraphData ? ["Malformed or duplicate architecture records were omitted from this graph response."] : [])
    ]
  };
};

export const getArchitectureNode = async (
  projectId: string,
  ownerId: string,
  nodeId: string
) => {
  const graph = await graphForProject(projectId, ownerId);
  const node = graph.nodes.find((entry) => entry.id === nodeId);
  if (!node) throw new AppError(404, "Architecture node not found", "ARCHITECTURE_NODE_NOT_FOUND");
  const edges = graph.edges.filter((edge) => edge.source === nodeId || edge.target === nodeId);
  return {
    ...node,
    relationships: edges.map((edge) => ({
      ...edge,
      direction: edge.source === nodeId ? "outgoing" : "incoming",
      connectedNode: graph.nodes.find((entry) => entry.id === (edge.source === nodeId ? edge.target : edge.source))
    }))
  };
};

export const refreshProjectArchitecture = async (projectId: string, ownerId: string) => {
  const project = await getOwnedProject(projectId, ownerId);
  if (project.activeGeneration < 1) {
    throw new AppError(409, "Index project files before refreshing architecture.", "PROJECT_NOT_INDEXED");
  }
  const files = await ProjectFile.find(activeFilter(projectId, ownerId, project.activeGeneration))
    .select("filePath content")
    .sort({ filePath: 1 })
    .lean();
  const analysis = analyzeProjectFiles(files.map((file) => ({ path: file.filePath, content: file.content })));
  await ProjectArchitecture.findOneAndUpdate(
    activeFilter(projectId, ownerId, project.activeGeneration),
    {
      $set: {
        nodes: analysis.nodes,
        relationships: analysis.relationships,
        summary: analysis.summary
      }
    },
    { new: true, upsert: true, runValidators: true }
  ).lean();
  return { generation: project.activeGeneration, nodeCount: analysis.nodes.length, edgeCount: analysis.relationships.length };
};

export const getProjectStructure = async (projectId: string, ownerId: string) => {
  const project = await getOwnedProject(projectId, ownerId);
  const files = await ProjectFile.find(activeFilter(projectId, ownerId, project.activeGeneration))
    .select("filePath language category")
    .sort({ filePath: 1 })
    .lean();
  const architecture = await ProjectArchitecture.findOne(
    activeFilter(projectId, ownerId, project.activeGeneration)
  ).select("relationships").lean();

  interface TreeDirectory { type: "directory"; name: string; children: Record<string, TreeEntry> }
  interface TreeFile { type: "file"; name: string; path: string; language: string; category: string }
  type TreeEntry = TreeDirectory | TreeFile;
  const root: TreeDirectory = { type: "directory", name: "", children: {} };
  for (const file of files) {
    const parts = file.filePath.split("/");
    let current = root;
    for (const part of parts.slice(0, -1)) {
      const existing = current.children[part];
      if (!existing) {
        current.children[part] = { type: "directory", name: part, children: {} };
      }
      const entry = current.children[part];
      if (entry?.type === "directory") current = entry;
    }
    const name = parts.at(-1) ?? file.filePath;
    current.children[name] = {
      type: "file",
      name,
      path: file.filePath,
      language: file.language,
      category: file.category
    };
  }
  const languages = [...new Set(files.map((file) => file.language))].sort();
  const categories = [...new Set(files.map((file) => file.category))].sort();
  return {
    tree: root,
    fileCount: files.length,
    languages,
    categories,
    relationshipCount: architecture?.relationships.length ?? 0
  };
};
