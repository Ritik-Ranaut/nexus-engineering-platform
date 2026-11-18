import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  ApiError,
  projectApi,
  type ArchitectureNode,
  type ArchitectureRelationship,
  type Project,
  type ProjectFile,
  type ProjectFileMetadata,
  type ProjectTreeDirectory,
  type ProjectTreeEntry
} from "../api/client";

function TreeEntry({
  entry,
  selectedPath,
  onSelect
}: {
  entry: ProjectTreeEntry;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  if (entry.type === "file") {
    return (
      <button
        className={`explorer-file${selectedPath === entry.path ? " explorer-file-selected" : ""}`}
        type="button"
        onClick={() => onSelect(entry.path)}
        title={`${entry.path} · ${entry.category}`}
      >
        <span className="explorer-file-icon">{entry.name.split(".").at(-1)?.slice(0, 3) ?? "file"}</span>
        <span>{entry.name}</span>
      </button>
    );
  }
  return (
    <details className="explorer-directory" open>
      <summary><span>▾</span> {entry.name}</summary>
      <div className="explorer-children">
        {Object.values(entry.children).map((child) => (
          <TreeEntry key={child.type === "file" ? child.path : child.name} entry={child} selectedPath={selectedPath} onSelect={onSelect} />
        ))}
      </div>
    </details>
  );
}

const formatBytes = (size: number) => size < 1024
  ? `${size} B`
  : `${(size / 1024).toFixed(1)} KB`;

export function CodeExplorerPage() {
  const { projectId = "" } = useParams();
  const [searchParams] = useSearchParams();
  const requestedFile = searchParams.get("file");
  const requestedLine = Number(searchParams.get("line"));
  const [project, setProject] = useState<Project | null>(null);
  const [files, setFiles] = useState<ProjectFileMetadata[]>([]);
  const [tree, setTree] = useState<ProjectTreeDirectory | null>(null);
  const [searchResults, setSearchResults] = useState<ProjectFileMetadata[]>([]);
  const [nodes, setNodes] = useState<ArchitectureNode[]>([]);
  const [relationships, setRelationships] = useState<ArchitectureRelationship[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(requestedFile);
  const [selectedFile, setSelectedFile] = useState<ProjectFile | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([
      projectApi.get(projectId),
      projectApi.structure(projectId),
      projectApi.files(projectId),
      projectApi.architectureNodes(projectId),
      projectApi.architectureRelationships(projectId)
    ]).then(([currentProject, structure, projectFiles, architectureNodes, architectureRelationships]) => {
      if (!active) return;
      setProject(currentProject);
      setTree(structure.tree);
      setFiles(projectFiles);
      setNodes(architectureNodes);
      setRelationships(architectureRelationships);
      setError(null);
    }).catch((loadError: unknown) => {
      if (active) setError(loadError instanceof ApiError
        ? loadError.message
        : loadError instanceof Error ? loadError.message : "Could not load project structure");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [projectId]);

  useEffect(() => {
    const term = search.trim();
    if (!term) {
      setSearchResults([]);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      projectApi.files(projectId, term).then((matches) => {
        if (active) {
          setSearchResults(matches);
          setError(null);
        }
      }).catch((searchError: unknown) => {
        if (active) setError(searchError instanceof Error ? searchError.message : "Could not search project files");
      });
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [projectId, search]);

  useEffect(() => {
    setSelectedPath(requestedFile);
  }, [requestedFile]);

  useEffect(() => {
    if (!selectedPath) {
      setSelectedFile(null);
      return;
    }
    let active = true;
    projectApi.file(projectId, selectedPath).then((file) => {
      if (active) {
        setSelectedFile(file);
        setError(null);
      }
    }).catch((fileError: unknown) => {
      if (active) setError(fileError instanceof Error ? fileError.message : "Could not load this file");
    });
    return () => { active = false; };
  }, [projectId, selectedPath]);

  useEffect(() => {
    if (!selectedFile || !Number.isInteger(requestedLine) || requestedLine < 1) return;
    document.getElementById(`source-line-${requestedLine}`)?.scrollIntoView({ block: "center" });
  }, [requestedLine, selectedFile]);

  const visibleFiles = search.trim() ? searchResults : files;
  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of nodes) counts.set(node.category, (counts.get(node.category) ?? 0) + 1);
    return [...counts.entries()].sort((left, right) => left[0].localeCompare(right[0]));
  }, [nodes]);

  const openFile = (filePath: string) => setSelectedPath(filePath);
  const formatCategory = (category: string) => category.replaceAll("_", " ");

  return (
    <main className="explorer-shell">
      <header className="workspace-header explorer-header">
        <Link className="brand" to="/workspace"><span className="brand-mark">N</span><span>NEXUS<span className="brand-period">.</span></span></Link>
        <div className="explorer-project-title"><span className="project-header-dot" />{project?.name ?? "Code Explorer"}</div>
        <nav className="issues-nav">
          <Link className="back-link" to={`/projects/${projectId}/architecture`}>Architecture <span>⌘</span></Link>
          <Link className="back-link" to={`/projects/${projectId}/chat`}>Project chat <span>→</span></Link>
          <Link className="back-link" to="/workspace">Workspace <span>↗</span></Link>
        </nav>
      </header>
      <section className="explorer-content">
        <div className="workspace-eyebrow"><span className="status-dot" /> CODEBASE INTELLIGENCE · STRUCTURAL INDEX</div>
        <div className="explorer-heading">
          <div><h1>Code <span>explorer.</span></h1><p>Browse indexed source and inspect its statically detected architecture. No AI analysis is involved.</p></div>
          <div className="explorer-stat"><strong>{files.length}</strong><span>indexed files</span></div>
          <div className="explorer-stat"><strong>{relationships.length}</strong><span>import links</span></div>
        </div>
        {error && <div className="form-alert" role="alert">{error}</div>}
        {loading ? (
          <div className="project-empty"><span className="loading-orbit" /><span>Loading indexed project…</span></div>
        ) : project?.indexingStatus !== "ready" ? (
          <div className="issues-empty"><span className="empty-mark">⌘</span><h2>Project files are not ready</h2><p>Index this project before opening its code explorer.</p></div>
        ) : (
          <>
            <section className="architecture-panel">
              <div className="architecture-panel-heading"><div><span className="card-overline">ARCHITECTURE MAP</span><h2>Project layers</h2></div><span>{nodes.length} nodes · {relationships.length} relationships</span></div>
              <div className="architecture-categories">
                {categoryCounts.map(([category, count]) => (
                  <div className="architecture-category" key={category}><span>{formatCategory(category)}</span><strong>{count}</strong></div>
                ))}
              </div>
              {relationships.length > 0 ? (
                <div className="relationship-list">
                  {relationships.slice(0, 8).map((relationship) => (
                    <button className="relationship-row" type="button" key={`${relationship.source}-${relationship.target}`} onClick={() => openFile(relationship.source)}>
                      <span>{relationship.source}</span><i>imports</i><span>{relationship.target}</span>
                    </button>
                  ))}
                  {relationships.length > 8 && <span className="relationship-more">+ {relationships.length - 8} more import relationships</span>}
                </div>
              ) : <p className="architecture-empty">No relative import relationships were detected in the indexed files.</p>}
            </section>
            <section className="code-explorer-layout">
              <aside className="file-browser">
                <div className="file-browser-heading"><div><span className="card-overline">SOURCE FILES</span><strong>{visibleFiles.length} / {files.length}</strong></div></div>
                <label className="explorer-search">
                  <span aria-hidden="true">⌕</span>
                  <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search files, layers, symbols…" aria-label="Search project files" />
                </label>
                {tree && (
                  <div className="file-tree">
                    {Object.values(tree.children).map((entry) => (
                      <TreeEntry key={entry.type === "file" ? entry.path : entry.name} entry={entry} selectedPath={selectedPath} onSelect={openFile} />
                    ))}
                  </div>
                )}
                {search && <div className="search-results">
                  {visibleFiles.map((file) => (
                    <button type="button" key={file.id} onClick={() => openFile(file.filePath)}>
                      <span>{file.filePath}</span><small>{file.category}</small>
                    </button>
                  ))}
                  {visibleFiles.length === 0 && <span>No matching indexed files.</span>}
                </div>}
              </aside>
              <section className="code-view">
                {selectedFile ? (
                  <>
                    <header className="code-view-header"><div><span>{selectedFile.filePath}</span><small>{selectedFile.language}</small></div><span>{selectedFile.lineCount} lines</span></header>
                    <div className="code-view-body">
                      <pre aria-label={`Source code for ${selectedFile.filePath}`}><code>{selectedFile.content.split(/\r\n|\r|\n/).map((line, index) => (
                        <span className={`code-line${index + 1 === requestedLine ? " code-line-highlight" : ""}`} id={`source-line-${index + 1}`} key={index}><i>{index + 1}</i><span>{line || " "}</span></span>
                      ))}</code></pre>
                    </div>
                    <div className="file-metadata">
                      <div><span>Layer</span><strong>{formatCategory(selectedFile.category)}</strong></div>
                      <div><span>Size</span><strong>{formatBytes(selectedFile.sizeBytes)}</strong></div>
                      <div><span>SHA-256</span><code>{selectedFile.contentHash.slice(0, 16)}…</code></div>
                      <div><span>Imports</span><strong>{selectedFile.imports.length}</strong></div>
                      <div><span>Detected symbols</span><strong>{selectedFile.symbols.length ? selectedFile.symbols.join(", ") : "None"}</strong></div>
                    </div>
                  </>
                ) : (
                  <div className="code-view-empty"><span>⌘</span><strong>Select a file to inspect its source</strong><small>Indexed file contents are secret-redacted before storage.</small></div>
                )}
              </section>
            </section>
          </>
        )}
      </section>
    </main>
  );
}
