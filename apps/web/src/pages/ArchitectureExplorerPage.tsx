import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ApiError,
  projectApi,
  type ArchitectureGraph,
  type ArchitectureGraphNode,
  type Project
} from "../api/client";

type Layer = "all" | "frontend" | "backend" | "data" | "tests" | "configuration";
type RelationshipType = "all" | "IMPORTS" | "DEPENDS_ON";

const layers: { id: Layer; label: string }[] = [
  { id: "all", label: "Overview" },
  { id: "frontend", label: "Frontend" },
  { id: "backend", label: "Backend" },
  { id: "data", label: "Data & packages" },
  { id: "tests", label: "Tests" },
  { id: "configuration", label: "Configuration" }
];

const categoryColumns: Record<string, number> = {
  component: 0,
  hook: 0,
  page: 0,
  route: 1,
  controller: 2,
  utility: 2,
  other: 2,
  service: 3,
  model: 4,
  test: 5,
  configuration: 5,
  package: 5
};
const columnTitles = ["UI", "Routes", "Handlers", "Services", "Models", "Tests · config · packages"];

const describeType = (type: string) => type.replaceAll("_", " ");

function nodePosition(node: ArchitectureGraphNode, index: number, rowsByColumn: number[]) {
  const column = categoryColumns[node.category] ?? 2;
  const row = rowsByColumn[column] ?? 0;
  rowsByColumn[column] = row + 1;
  return { x: 45 + column * 205, y: 82 + row * 84, column, index };
}

export function ArchitectureExplorerPage() {
  const { projectId = "" } = useParams();
  const [project, setProject] = useState<Project | null>(null);
  const [graph, setGraph] = useState<ArchitectureGraph | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<Awaited<ReturnType<typeof projectApi.architectureNode>> | null>(null);
  const [layer, setLayer] = useState<Layer>("all");
  const [relationshipType, setRelationshipType] = useState<RelationshipType>("all");
  const [neighborhood, setNeighborhood] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 220);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([
      projectApi.get(projectId),
      projectApi.architectureGraph(projectId, {
        search: query || undefined,
        layer,
        relationshipType: relationshipType === "all" ? undefined : relationshipType,
        limit: 200,
        neighborhood: neighborhood ?? undefined
      })
    ]).then(([currentProject, currentGraph]) => {
      if (!active) return;
      setProject(currentProject);
      setGraph(currentGraph);
      setError(null);
      if (selectedNodeId && !currentGraph.nodes.some((node) => node.id === selectedNodeId)) {
        setSelectedNodeId(null);
        setSelectedNode(null);
      }
    }).catch((loadError: unknown) => {
      if (!active) return;
      setError(loadError instanceof ApiError
        ? loadError.message
        : loadError instanceof Error ? loadError.message : "Could not load architecture graph");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [projectId, query, layer, relationshipType, neighborhood]);

  useEffect(() => {
    if (!selectedNodeId) {
      setSelectedNode(null);
      return;
    }
    let active = true;
    projectApi.architectureNode(projectId, selectedNodeId).then((node) => {
      if (active) setSelectedNode(node);
    }).catch((nodeError: unknown) => {
      if (active) setError(nodeError instanceof Error ? nodeError.message : "Could not load architecture node");
    });
    return () => { active = false; };
  }, [projectId, selectedNodeId]);

  const positions = useMemo(() => {
    if (!graph) return new Map<string, { x: number; y: number; column: number; index: number }>();
    const rowsByColumn = Array.from({ length: columnTitles.length }, () => 0);
    const ordered = [...graph.nodes].sort((a, b) =>
      (categoryColumns[a.category] ?? 2) - (categoryColumns[b.category] ?? 2) ||
      a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
    );
    return new Map(ordered.map((node, index) => [node.id, nodePosition(node, index, rowsByColumn)]));
  }, [graph]);

  const graphDimensions = useMemo(() => {
    const maxY = Math.max(570, ...[...positions.values()].map((position) => position.y + 110));
    return { width: Math.max(1_260, columnTitles.length * 205 + 40), height: maxY };
  }, [positions]);

  const refresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      await projectApi.refreshArchitecture(projectId);
      const currentGraph = await projectApi.architectureGraph(projectId, {
        search: query || undefined,
        layer,
        relationshipType: relationshipType === "all" ? undefined : relationshipType,
        limit: 200,
        neighborhood: neighborhood ?? undefined
      });
      setGraph(currentGraph);
    } catch (refreshError: unknown) {
      setError(refreshError instanceof Error ? refreshError.message : "Could not refresh architecture analysis");
    } finally {
      setRefreshing(false);
    }
  };

  const loadNextPage = async () => {
    if (!graph || loading || !graph.truncated) return;
    setLoading(true);
    setError(null);
    try {
      const next = await projectApi.architectureGraph(projectId, {
        search: query || undefined,
        layer,
        relationshipType: relationshipType === "all" ? undefined : relationshipType,
        limit: 200,
        offset: graph.offset + graph.nodes.length,
        neighborhood: neighborhood ?? undefined
      });
      setGraph((current) => {
        if (!current) return next;
        const nodesById = new Map(current.nodes.map((node) => [node.id, node]));
        next.nodes.forEach((node) => nodesById.set(node.id, node));
        const edgesById = new Map(current.edges.map((edge) => [edge.id, edge]));
        next.edges.forEach((edge) => edgesById.set(edge.id, edge));
        return {
          ...next,
          nodes: [...nodesById.values()],
          edges: [...edgesById.values()],
          offset: current.offset,
          totalEdges: edgesById.size
        };
      });
    } catch (pageError: unknown) {
      setError(pageError instanceof Error ? pageError.message : "Could not load the next graph page");
    } finally {
      setLoading(false);
    }
  };

  const openFileUrl = (filePath: string) =>
    `/projects/${projectId}/explorer?${new URLSearchParams({ file: filePath })}`;

  const edges = graph?.edges ?? [];
  const nodes = graph?.nodes ?? [];
  const connectedCount = selectedNode?.relationships.length ?? 0;

  return (
    <main className="architecture-shell">
      <header className="workspace-header explorer-header">
        <Link className="brand" to="/workspace"><span className="brand-mark">N</span><span>NEXUS<span className="brand-period">.</span></span></Link>
        <div className="explorer-project-title"><span className="project-header-dot" />{project?.name ?? "Architecture Explorer"}</div>
        <nav className="issues-nav">
          <Link className="back-link" to={`/projects/${projectId}/explorer`}>Code <span>⌘</span></Link>
          <Link className="back-link" to={`/projects/${projectId}/chat`}>Chat <span>→</span></Link>
          <Link className="back-link" to={`/projects/${projectId}/issues`}>Findings <span>!</span></Link>
          <Link className="back-link" to={`/projects/${projectId}/reports`}>Reports <span>▤</span></Link>
        </nav>
      </header>
      <section className="architecture-content">
        <div className="workspace-eyebrow"><span className="status-dot" /> CODEBASE INTELLIGENCE · STATIC RELATIONSHIPS</div>
        <div className="architecture-title-row">
          <div>
            <h1>Architecture <span>explorer.</span></h1>
            <p>Explore indexed files and relationships with traceable static evidence. Uncertain connections are left out.</p>
          </div>
          <button type="button" className="architecture-refresh" disabled={refreshing} onClick={() => void refresh()}>
            {refreshing ? "Refreshing…" : "Refresh analysis"}
          </button>
        </div>
        <div className="architecture-toolbar">
          <label className="architecture-search">
            <span>⌕</span>
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search files, symbols, and packages" aria-label="Search architecture" />
          </label>
          <label className="architecture-edge-filter">
            <span>RELATIONSHIP</span>
            <select value={relationshipType} onChange={(event) => setRelationshipType(event.target.value as RelationshipType)}>
              <option value="all">All detected</option>
              <option value="IMPORTS">Imports</option>
              <option value="DEPENDS_ON">Package dependencies</option>
            </select>
          </label>
          <div className="architecture-zoom">
            <button type="button" onClick={() => setZoom((value) => Math.max(.55, value - .15))} aria-label="Zoom out">−</button>
            <span>{Math.round(zoom * 100)}%</span>
            <button type="button" onClick={() => setZoom((value) => Math.min(1.6, value + .15))} aria-label="Zoom in">+</button>
          </div>
        </div>
        <div className="architecture-view-tabs" role="tablist" aria-label="Architecture layer">
          {layers.map((item) => (
            <button
              type="button"
              role="tab"
              aria-selected={layer === item.id}
              key={item.id}
              className={layer === item.id ? "architecture-view-active" : ""}
              onClick={() => { setLayer(item.id); setSelectedNodeId(null); setNeighborhood(null); }}
            >{item.label}</button>
          ))}
          <span>{graph?.totalNodes ?? 0} nodes · {graph?.totalEdges ?? 0} visible links{neighborhood ? " · one-hop focus" : ""}</span>
        </div>
        {neighborhood && selectedNode && (
          <div className="architecture-focus-note" role="status">
            Focused on {selectedNode.name} and its direct connections.
            <button type="button" onClick={() => setNeighborhood(null)}>Clear focus</button>
          </div>
        )}
        {error && <div className="form-alert" role="alert">{error}</div>}
        {loading ? (
          <div className="project-empty"><span className="loading-orbit" /><span>Loading indexed architecture…</span></div>
        ) : project?.indexingStatus !== "ready" ? (
          <div className="issues-empty"><span className="empty-mark">⌘</span><h2>Architecture is not ready</h2><p>Index project files before exploring static relationships.</p></div>
        ) : !graph || graph.totalNodes === 0 ? (
          <div className="issues-empty"><span className="empty-mark">⌘</span><h2>No architecture elements match</h2><p>Try a different layer or search term, or refresh the static analysis.</p></div>
        ) : (
          <>
            <div className="architecture-confidence-note">
              <strong>{graph.analysisStatus === "complete" ? "STATIC ANALYSIS" : "PARTIAL ANALYSIS"}</strong>
              <span>Links represent confirmed import statements or manifest declarations, not inferred call behavior. Package declarations are read from indexed package.json metadata.</span>
              <span>Generation {graph.generation} · showing {nodes.length} of {graph.totalNodes} nodes</span>
            </div>
            {graph.limitations?.map((limitation) => (
              <div className="architecture-truncated" key={limitation} role="status">{limitation}</div>
            ))}
            {graph.truncated && (
              <div className="architecture-truncated" role="status">
                Rendering the graph in bounded batches to keep large repositories responsive.
                <button type="button" disabled={loading} onClick={() => void loadNextPage()}>Load next 200 nodes</button>
              </div>
            )}
            <div className="architecture-workspace">
              <div className="architecture-canvas-scroll" aria-label="Interactive architecture graph">
                <svg
                  className="architecture-canvas"
                  width={graphDimensions.width * zoom}
                  height={graphDimensions.height * zoom}
                  viewBox={`0 0 ${graphDimensions.width} ${graphDimensions.height}`}
                  role="img"
                  aria-label="Architecture relationship graph"
                >
                  <defs>
                    <marker id="architecture-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                      <path d="M0,0 L8,4 L0,8 z" fill="#627247" />
                    </marker>
                  </defs>
                  <g>
                    {columnTitles.map((title, index) => (
                      <g key={title}>
                        <text x={45 + index * 205} y={35} className="architecture-column-title">{title}</text>
                        <line x1={35 + index * 205} y1={48} x2={35 + index * 205} y2={graphDimensions.height - 18} className="architecture-column-line" />
                      </g>
                    ))}
                    {edges.map((edge) => {
                      const source = positions.get(edge.source);
                      const target = positions.get(edge.target);
                      if (!source || !target) return null;
                      const x1 = source.x + 168;
                      const y1 = source.y + 24;
                      const x2 = target.x;
                      const y2 = target.y + 24;
                      const bend = Math.max(35, Math.abs(x2 - x1) * .42);
                      const path = `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
                      return (
                        <g key={edge.id}>
                          <path d={path} className="architecture-edge" markerEnd="url(#architecture-arrow)" />
                          {edge.evidence && <title>{edge.type}: {edge.evidence}</title>}
                        </g>
                      );
                    })}
                    {nodes.map((node) => {
                      const position = positions.get(node.id);
                      if (!position) return null;
                      const selected = node.id === selectedNodeId;
                      return (
                        <g
                          key={node.id}
                          className={`architecture-node architecture-node-${node.category}${selected ? " architecture-node-selected" : ""}`}
                          transform={`translate(${position.x} ${position.y})`}
                          role="button"
                          tabIndex={0}
                          aria-label={`${node.name}, ${node.type}`}
                          onClick={() => setSelectedNodeId(node.id)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") setSelectedNodeId(node.id);
                          }}
                        >
                          <rect width="168" height="50" rx="5" />
                          <text x="10" y="20" className="architecture-node-name">{node.name.length > 23 ? `${node.name.slice(0, 20)}…` : node.name}</text>
                          <text x="10" y="37" className="architecture-node-type">{describeType(node.type).toUpperCase()}</text>
                          <title>{node.filePath ?? node.name} · {node.verificationStatus}</title>
                        </g>
                      );
                    })}
                  </g>
                </svg>
              </div>
              <aside className="architecture-inspector">
                {!selectedNode ? (
                  <div className="architecture-inspector-empty"><span>⌖</span><strong>Select a node</strong><p>Choose an element to inspect its evidence and connected components.</p></div>
                ) : (
                  <>
                    <span className="card-overline">ARCHITECTURE ELEMENT · {selectedNode.verificationStatus}</span>
                    <h2>{selectedNode.name}</h2>
                    <span className="architecture-type-pill">{describeType(selectedNode.type)}</span>
                    <p>{selectedNode.description ?? "No additional description is available."}</p>
                    {selectedNode.filePath && <Link className="architecture-source-link" to={openFileUrl(selectedNode.filePath)}>{selectedNode.filePath} <span>Open source →</span></Link>}
                    <dl className="architecture-node-meta">
                      <div><dt>Language</dt><dd>{selectedNode.language}</dd></div>
                      <div><dt>Analysis</dt><dd>{selectedNode.analysisSource}</dd></div>
                      <div><dt>Confidence</dt><dd>{Math.round(selectedNode.confidence * 100)}% · {selectedNode.verificationStatus}</dd></div>
                      <div><dt>Connected</dt><dd>{connectedCount} confirmed relationships</dd></div>
                    </dl>
                    <div className="architecture-connections">
                      <strong>Relationship evidence</strong>
                      <button type="button" onClick={() => setNeighborhood(selectedNode.id)}>
                        <span>EXPLORE</span>
                        <strong>Show direct neighborhood</strong>
                        <small>Limit graph to this node and its one-hop connections</small>
                      </button>
                      {selectedNode.relationships.length === 0 ? <p>No indexed relationships connect to this element.</p> : selectedNode.relationships.map((relationship) => {
                        const related = relationship.connectedNode;
                        if (!related) return null;
                        return (
                          <button key={relationship.id} type="button" onClick={() => setSelectedNodeId(related.id)}>
                            <span>{relationship.direction === "outgoing" ? "→" : "←"} {relationship.type.replaceAll("_", " ")}</span>
                            <strong>{related.name}</strong>
                            <small>{relationship.evidence || "Static relationship"} · {relationship.verificationStatus}</small>
                          </button>
                        );
                      })}
                    </div>
                    <div className="architecture-inspector-links">
                      <Link to={`/projects/${projectId}/chat?${new URLSearchParams({
                        question: `Explain ${selectedNode.name}${selectedNode.filePath ? ` in ${selectedNode.filePath}` : ""}, using the project's source files.`
                      })}`}>Ask about this component →</Link>
                      <Link to={`/projects/${projectId}/issues`}>Engineering findings →</Link>
                      <Link to={`/projects/${projectId}/reports`}>Project reports →</Link>
                    </div>
                  </>
                )}
              </aside>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
