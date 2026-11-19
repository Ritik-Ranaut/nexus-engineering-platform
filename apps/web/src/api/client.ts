export interface User {
  id: string;
  name: string;
  email: string;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  name: string;
  repositoryUrl?: string;
  indexingStatus: "empty" | "pending" | "validating" | "discovering" | "cloning" | "indexing" | "analyzing" | "ready" | "failed" | "cancelled";
  indexingError?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface ProjectSource {
  label: string;
  filePath: string;
  language: string;
  symbolContext: string;
  startLine: number;
  endLine: number;
  score: number;
}

export interface ProjectConversation {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
}

export interface ProjectMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "completed" | "failed";
  sources: ProjectSource[];
  model?: string;
  latencyMs?: number;
  createdAt: string;
}

export interface ProjectFileMetadata {
  id: string;
  filePath: string;
  language: string;
  category: string;
  lineCount: number;
  sizeBytes: number;
  contentHash: string;
  imports: string[];
  symbols: string[];
}

export interface ProjectFile extends ProjectFileMetadata {
  content: string;
}

export interface ProjectTreeFile {
  type: "file";
  name: string;
  path: string;
  language: string;
  category: string;
}

export interface ProjectTreeDirectory {
  type: "directory";
  name: string;
  children: Record<string, ProjectTreeEntry>;
}

export type ProjectTreeEntry = ProjectTreeFile | ProjectTreeDirectory;

export interface ArchitectureNode extends ProjectFileMetadata {
  id: string;
  label: string;
}

export interface ArchitectureRelationship {
  source: string;
  target: string;
  id?: string;
  type: "imports" | "IMPORTS" | "DEPENDS_ON";
  evidence?: string;
  sourceOfInference?: string;
  confidence?: number;
  verificationStatus?: string;
}

export interface ArchitectureGraphNode {
  id: string;
  projectId: string;
  name: string;
  type: string;
  filePath?: string;
  language: string;
  description?: string;
  analysisSource: string;
  confidence: number;
  verificationStatus: string;
  category: string;
  imports: string[];
  symbols: string[];
}

export interface ArchitectureGraphEdge {
  id: string;
  source: string;
  target: string;
  type: "IMPORTS" | "DEPENDS_ON";
  evidence: string;
  sourceOfInference: string;
  confidence: number;
  verificationStatus: string;
}

export interface ArchitectureGraph {
  projectId: string;
  generation: number;
  nodes: ArchitectureGraphNode[];
  edges: ArchitectureGraphEdge[];
  totalNodes: number;
  totalEdges: number;
  limit: number;
  offset: number;
  truncated: boolean;
  analysisStatus: "complete" | "partial";
  limitations?: string[];
}

export type EngineeringAgent =
  | "code_quality"
  | "security"
  | "performance"
  | "testing"
  | "documentation";
export type IssueSeverity = "critical" | "high" | "medium" | "low" | "suggestion";
export type IssueStatus = "open" | "accepted" | "dismissed" | "resolved";

export interface EngineeringIssue {
  issueId: string;
  runId: string;
  agent: EngineeringAgent;
  category: EngineeringAgent;
  severity: IssueSeverity;
  title: string;
  description: string;
  reasoningSummary: string;
  affectedFiles: string[];
  evidence: {
    filePath: string;
    startLine: number;
    endLine: number;
    quote: string;
    explanation: string;
  }[];
  recommendation: string;
  confidence: number;
  status: IssueStatus;
  createdAt: string;
}

export interface EngineeringRun {
  runId: string;
  status: "completed" | "partial" | "failed";
  selectedAgents: EngineeringAgent[];
  failures: { agent: string; code: string; message: string }[];
  issueCount: number;
  report: {
    summary: string;
    issueCount: number;
    severityCounts: Partial<Record<IssueSeverity, number>>;
  };
  durationMs: number;
  model: string;
  createdAt: string;
}

export type MissionStatus =
  | "CREATED"
  | "PLANNING"
  | "RUNNING"
  | "WAITING_FOR_APPROVAL"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export interface Mission {
  id: string;
  projectId: string;
  goal: string;
  status: MissionStatus;
  plan?: { summary?: string; rationale?: string };
  tasks: {
    taskId: string;
    agent: EngineeringAgent;
    description: string;
    status: "pending" | "running" | "completed" | "failed" | "cancelled";
    result?: string;
    dependencies: string[];
  }[];
  findings: EngineeringIssue[];
  report?: {
    summary: string;
    issueCount: number;
    severityCounts: Partial<Record<IssueSeverity, number>>;
  } | null;
  actions: {
    actionId: string;
    issueId: string;
    description: string;
    status: "pending" | "approved" | "rejected";
    decidedAt?: string;
  }[];
  progress: {
    percent: number;
    currentStep: string;
    events: {
      eventId: string;
      message: string;
      status: "info" | "completed" | "running" | "failed";
      createdAt: string;
    }[];
  };
  errors: { code: string; message: string; createdAt: string }[];
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MissionProgressEvent {
  missionId: string;
  status: MissionStatus;
  message: string;
  progress: number;
  taskId?: string;
  agent?: string;
  eventStatus: "info" | "completed" | "running" | "failed";
  createdAt: string;
}

export type EngineeringReportType =
  | "project_health"
  | "security_audit"
  | "code_quality"
  | "performance_analysis"
  | "testing_coverage"
  | "documentation"
  | "mission";

export interface EngineeringReportFinding extends EngineeringIssue {
  verification: "confirmed" | "unverified";
  source?: "issue" | "mission";
}

export interface EngineeringReport {
  reportId: string;
  projectId: string;
  userId: string;
  missionId?: string;
  reportType: EngineeringReportType;
  title: string;
  summary: string;
  status: "complete" | "partial";
  findingRefs: { findingId: string; runId: string; source: "issue" | "mission" }[];
  unverifiedFindingRefs: { findingId: string; runId: string; source: "issue" | "mission" }[];
  findings?: EngineeringReportFinding[];
  severityCounts: Partial<Record<IssueSeverity, number>>;
  categoryCounts: Partial<Record<EngineeringAgent, number>>;
  sections: { category: EngineeringAgent; summary: string; findingIds: string[] }[];
  affectedFiles: { filePath: string; findingIds: string[] }[];
  recommendations: {
    findingId: string;
    title: string;
    action: string;
    category: EngineeringAgent;
    severity: IssueSeverity;
    affectedFiles: string[];
  }[];
  limitations: string[];
  healthScore: {
    status: "calculated" | "insufficient_data";
    value: number | null;
    formula: string;
    rationale: string;
  };
  generation: {
    sourceFingerprint: string;
    sourceRunIds: string[];
    indexedGeneration: number;
    model?: string;
    narrativeStatus: "generated" | "fallback";
    generatedAt: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface EngineeringReportPage {
  reports: EngineeringReport[];
  page: number;
  pageSize: number;
  total: number;
}

export type FixProposalStatus =
  | "GENERATING"
  | "GENERATED"
  | "AWAITING_APPROVAL"
  | "VALIDATION_FAILED"
  | "APPROVED"
  | "REJECTED"
  | "APPLIED"
  | "VERIFICATION_FAILED";

export interface FixProposalFileChange {
  filePath: string;
  language: string;
  originalContent: string;
  proposedContent: string;
  originalHash: string;
  proposedHash: string;
  patch: string;
}

export interface FixProposal {
  proposalId: string;
  findingKey: string;
  projectId: string;
  userId: string;
  findingId: string;
  runId: string;
  missionId?: string;
  finding: {
    title: string;
    category: EngineeringAgent;
    severity: IssueSeverity;
    description: string;
    recommendation: string;
    evidence: EngineeringIssue["evidence"];
  };
  originalFinding?: EngineeringIssue | null;
  targetGeneration: number;
  targetRevision: string;
  changes: FixProposalFileChange[];
  rootCause?: string;
  explanation?: string;
  sideEffects: string[];
  assumptions: string[];
  status: FixProposalStatus;
  validationStatus: "PENDING" | "VALID" | "STALE" | "FAILED";
  validationMessage?: string;
  approvalStatus: "PENDING" | "APPROVED" | "REJECTED";
  decision?: {
    status?: "APPROVED" | "REJECTED";
    userId?: string;
    decidedAt?: string;
    rejectionReason?: string;
  };
  applicationResult?: {
    status: "NOT_SUPPORTED" | "STARTED" | "SUCCEEDED" | "FAILED" | "PARTIAL";
    attemptedBy?: string;
    attemptedAt?: string;
    message?: string;
    filesApplied: string[];
    filesNotApplied: string[];
    rollbackStatus: "NOT_AVAILABLE" | "NOT_REQUESTED" | "SUCCEEDED" | "FAILED";
  };
  auditTrail?: {
    action: string;
    userId: string;
    createdAt: string;
    message?: string;
  }[];
  model?: string;
  failureCode?: string;
  generatedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface VerificationCheck {
  checkId: "test" | "lint" | "build";
  commandIdentifier: "project-test" | "project-lint" | "project-build";
  status: "PASSED" | "FAILED" | "SKIPPED" | "TIMED_OUT" | "CANCELLED";
  exitCode?: number;
  sanitizedOutputSummary: string;
  durationMs: number;
  failureReason?: string;
}

export interface VerificationRun {
  verificationId: string;
  projectId: string;
  userId: string;
  fixProposalId: string;
  missionId?: string;
  repositoryRevision: string;
  expectedRevision: string;
  checks: VerificationCheck[];
  status: "PENDING" | "RUNNING" | "PASSED" | "FAILED" | "PARTIAL" | "CANCELLED" | "TIMED_OUT";
  failureReason?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs: number;
  createdAt: string;
  updatedAt: string;
}

export interface FixProposalListItem extends Omit<FixProposal, "changes" | "finding" | "originalFinding"> {
  finding: Pick<FixProposal["finding"], "title" | "category" | "severity">;
  changes: Pick<FixProposalFileChange, "filePath" | "language" | "originalHash" | "proposedHash">[];
}

export interface AIHealth {
  ollama: {
    connected: boolean;
    chatModelAvailable: boolean;
    embeddingModelAvailable: boolean;
  };
  models?: {
    chat: string;
    embedding: string;
  };
}

interface ApiResponse<T> {
  data: T;
}

interface ApiErrorResponse {
  error?: {
    code?: string;
    message?: string;
    details?: { path: string; message: string }[];
  };
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly details?: { path: string; message: string }[]
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: "include",
      headers: { "Content-Type": "application/json", ...init?.headers }
    });
  } catch {
    if (init?.signal?.aborted) {
      throw new ApiError("The request was cancelled", 0, "REQUEST_CANCELLED");
    }
    throw new ApiError("Unable to reach NEXUS. Check your connection and try again.", 0);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as ApiErrorResponse | null;
    throw new ApiError(
      body?.error?.message ?? "The request could not be completed",
      response.status,
      body?.error?.code,
      body?.error?.details
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
};

export const authApi = {
  async register(input: { name: string; email: string; password: string }): Promise<User> {
    const result = await request<ApiResponse<{ user: User }>>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify(input)
    });
    return result.data.user;
  },
  async login(input: { email: string; password: string }): Promise<User> {
    const result = await request<ApiResponse<{ user: User }>>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(input)
    });
    return result.data.user;
  },
  async me(): Promise<User> {
    const result = await request<ApiResponse<{ user: User }>>("/api/auth/me");
    return result.data.user;
  },
  logout(): Promise<void> {
    return request<void>("/api/auth/logout", { method: "POST" });
  }
};

export const projectApi = {
  async list(): Promise<Project[]> {
    const result = await request<ApiResponse<{ projects: Project[] }>>("/api/projects");
    return result.data.projects;
  },
  async get(projectId: string): Promise<Project> {
    const result = await request<ApiResponse<{ project: Project }>>(
      `/api/projects/${encodeURIComponent(projectId)}`
    );
    return result.data.project;
  },
  async create(input: { name: string; repositoryUrl?: string }): Promise<Project> {
    const result = await request<ApiResponse<{ project: Project }>>("/api/projects", {
      method: "POST",
      body: JSON.stringify(input)
    });
    return result.data.project;
  },
  async index(projectId: string, files: { path: string; content: string }[]) {
    return request<ApiResponse<{
      filesIndexed: number;
      chunksIndexed: number;
      architectureNodes: number;
      architectureRelationships: number;
    }>>(
      `/api/projects/${encodeURIComponent(projectId)}/index`,
      { method: "POST", body: JSON.stringify({ files }) }
    );
  },
  async importRepository(projectId: string) {
    return request<ApiResponse<{ status: "indexing" }>>(
      `/api/projects/${encodeURIComponent(projectId)}/import`,
      { method: "POST" }
    );
  },
  async structure(projectId: string): Promise<{
    tree: ProjectTreeDirectory;
    fileCount: number;
    languages: string[];
    categories: string[];
    relationshipCount: number;
  }> {
    const result = await request<ApiResponse<{ structure: {
      tree: ProjectTreeDirectory;
      fileCount: number;
      languages: string[];
      categories: string[];
      relationshipCount: number;
    } }>>(`/api/projects/${encodeURIComponent(projectId)}/structure`);
    return result.data.structure;
  },
  async files(projectId: string, search = ""): Promise<ProjectFileMetadata[]> {
    const query = search ? `?search=${encodeURIComponent(search)}` : "";
    const result = await request<ApiResponse<{ files: ProjectFileMetadata[] }>>(
      `/api/projects/${encodeURIComponent(projectId)}/files${query}`
    );
    return result.data.files;
  },
  async file(projectId: string, filePath: string): Promise<ProjectFile> {
    const query = new URLSearchParams({ path: filePath });
    const result = await request<ApiResponse<{ file: ProjectFile }>>(
      `/api/projects/${encodeURIComponent(projectId)}/files/content?${query}`
    );
    return result.data.file;
  },
  async fileMetadata(projectId: string, filePath: string): Promise<ProjectFileMetadata> {
    const query = new URLSearchParams({ path: filePath });
    const result = await request<ApiResponse<{ metadata: ProjectFileMetadata }>>(
      `/api/projects/${encodeURIComponent(projectId)}/files/metadata?${query}`
    );
    return result.data.metadata;
  },
  async architectureNodes(projectId: string): Promise<ArchitectureNode[]> {
    const result = await request<ApiResponse<{ nodes: ArchitectureNode[] }>>(
      `/api/projects/${encodeURIComponent(projectId)}/architecture/nodes`
    );
    return result.data.nodes;
  },
  async architectureRelationships(projectId: string): Promise<ArchitectureRelationship[]> {
    const result = await request<ApiResponse<{ relationships: ArchitectureRelationship[] }>>(
      `/api/projects/${encodeURIComponent(projectId)}/architecture/relationships`
    );
    return result.data.relationships;
  },
  async architectureGraph(
    projectId: string,
    filters: {
      search?: string;
      layer?: "all" | "frontend" | "backend" | "data" | "tests" | "configuration";
      relationshipType?: "IMPORTS" | "DEPENDS_ON";
      limit?: number;
      offset?: number;
      neighborhood?: string;
    } = {}
  ): Promise<ArchitectureGraph> {
    const query = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => {
      if (value !== undefined && value !== "") query.set(key, String(value));
    });
    const result = await request<ApiResponse<{ graph: ArchitectureGraph }>>(
      `/api/projects/${encodeURIComponent(projectId)}/architecture/graph?${query}`
    );
    return result.data.graph;
  },
  async architectureNode(projectId: string, nodeId: string): Promise<ArchitectureGraphNode & {
    relationships: (ArchitectureGraphEdge & {
      direction: "incoming" | "outgoing";
      connectedNode?: ArchitectureGraphNode;
    })[];
  }> {
    const query = new URLSearchParams({ nodeId });
    const result = await request<ApiResponse<{ node: ArchitectureGraphNode & {
      relationships: (ArchitectureGraphEdge & {
        direction: "incoming" | "outgoing";
        connectedNode?: ArchitectureGraphNode;
      })[];
    } }>>(`/api/projects/${encodeURIComponent(projectId)}/architecture/node?${query}`);
    return result.data.node;
  },
  async refreshArchitecture(projectId: string): Promise<{
    generation: number;
    nodeCount: number;
    edgeCount: number;
  }> {
    const result = await request<ApiResponse<{
      generation: number;
      nodeCount: number;
      edgeCount: number;
    }>>(`/api/projects/${encodeURIComponent(projectId)}/architecture/refresh`, {
      method: "POST",
      body: JSON.stringify({})
    });
    return result.data;
  }
};

export const projectConversationApi = {
  async list(projectId: string): Promise<ProjectConversation[]> {
    const result = await request<ApiResponse<{ conversations: ProjectConversation[] }>>(
      `/api/projects/${encodeURIComponent(projectId)}/conversations`
    );
    return result.data.conversations;
  },
  async create(projectId: string, title?: string): Promise<ProjectConversation> {
    const result = await request<ApiResponse<{ conversation: ProjectConversation }>>(
      `/api/projects/${encodeURIComponent(projectId)}/conversations`,
      { method: "POST", body: JSON.stringify(title ? { title } : {}) }
    );
    return result.data.conversation;
  },
  async messages(projectId: string, conversationId: string): Promise<ProjectMessage[]> {
    const result = await request<ApiResponse<{ messages: ProjectMessage[] }>>(
      `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/messages`
    );
    return result.data.messages;
  }
};

export const engineeringApi = {
  async listIssues(projectId: string): Promise<EngineeringIssue[]> {
    const result = await request<ApiResponse<{ issues: EngineeringIssue[] }>>(
      `/api/projects/${encodeURIComponent(projectId)}/issues`
    );
    return result.data.issues;
  },
  async listRuns(projectId: string): Promise<EngineeringRun[]> {
    const result = await request<ApiResponse<{ runs: EngineeringRun[] }>>(
      `/api/projects/${encodeURIComponent(projectId)}/analysis/runs`
    );
    return result.data.runs;
  },
  async run(projectId: string, goal: string, signal?: AbortSignal): Promise<{
    run: EngineeringRun & {
      activities: { agent: string; status: string; summary: string }[];
      summaries: Record<string, string>;
    };
    issues: EngineeringIssue[];
  }> {
    const result = await request<ApiResponse<{
      run: EngineeringRun & {
        activities: { agent: string; status: string; summary: string }[];
        summaries: Record<string, string>;
      };
      issues: EngineeringIssue[];
    }>>(`/api/projects/${encodeURIComponent(projectId)}/analysis`, {
      method: "POST",
      signal,
      body: JSON.stringify({ goal })
    });
    return result.data;
  },
  async updateIssue(projectId: string, issueId: string, status: IssueStatus): Promise<EngineeringIssue> {
    const result = await request<ApiResponse<{ issue: EngineeringIssue }>>(
      `/api/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(issueId)}`,
      { method: "PATCH", body: JSON.stringify({ status }) }
    );
    return result.data.issue;
  }
};

export const missionApi = {
  async list(projectId: string): Promise<Mission[]> {
    const result = await request<ApiResponse<{ missions: Mission[] }>>(
      `/api/projects/${encodeURIComponent(projectId)}/missions`
    );
    return result.data.missions;
  },
  async get(missionId: string): Promise<Mission> {
    const result = await request<ApiResponse<{ mission: Mission }>>(
      `/api/missions/${encodeURIComponent(missionId)}`
    );
    return result.data.mission;
  },
  async create(projectId: string, goal: string): Promise<Mission> {
    const result = await request<ApiResponse<{ mission: Mission }>>(
      `/api/projects/${encodeURIComponent(projectId)}/missions`,
      { method: "POST", body: JSON.stringify({ goal }) }
    );
    return result.data.mission;
  },
  async cancel(missionId: string): Promise<Mission> {
    const result = await request<ApiResponse<{ mission: Mission }>>(
      `/api/missions/${encodeURIComponent(missionId)}/cancel`,
      { method: "POST" }
    );
    return result.data.mission;
  },
  async decide(
    missionId: string,
    actionId: string,
    decision: "approved" | "rejected"
  ): Promise<Mission> {
    const result = await request<ApiResponse<{ mission: Mission }>>(
      `/api/missions/${encodeURIComponent(missionId)}/actions/${encodeURIComponent(actionId)}/decision`,
      { method: "POST", body: JSON.stringify({ decision }) }
    );
    return result.data.mission;
  }
};

export const engineeringReportApi = {
  async list(
    projectId: string,
    filter: { page?: number; pageSize?: number; reportType?: EngineeringReportType; missionId?: string } = {}
  ): Promise<EngineeringReportPage> {
    const query = new URLSearchParams();
    if (filter.page) query.set("page", String(filter.page));
    if (filter.pageSize) query.set("pageSize", String(filter.pageSize));
    if (filter.reportType) query.set("reportType", filter.reportType);
    if (filter.missionId) query.set("missionId", filter.missionId);
    const suffix = query.size > 0 ? `?${query}` : "";
    const result = await request<ApiResponse<EngineeringReportPage>>(
      `/api/projects/${encodeURIComponent(projectId)}/reports${suffix}`
    );
    return result.data;
  },
  async get(projectId: string, reportId: string): Promise<EngineeringReport> {
    const result = await request<ApiResponse<{ report: EngineeringReport }>>(
      `/api/projects/${encodeURIComponent(projectId)}/reports/${encodeURIComponent(reportId)}`
    );
    return result.data.report;
  },
  async generate(projectId: string, reportType: EngineeringReportType): Promise<EngineeringReport> {
    const result = await request<ApiResponse<{ report: EngineeringReport }>>(
      `/api/projects/${encodeURIComponent(projectId)}/reports`,
      { method: "POST", body: JSON.stringify({ reportType }) }
    );
    return result.data.report;
  },
  async generateMission(projectId: string, missionId: string): Promise<EngineeringReport> {
    const result = await request<ApiResponse<{ report: EngineeringReport }>>(
      `/api/projects/${encodeURIComponent(projectId)}/missions/${encodeURIComponent(missionId)}/report`,
      { method: "POST", body: JSON.stringify({}) }
    );
    return result.data.report;
  },
  async getMission(projectId: string, missionId: string): Promise<EngineeringReport> {
    const result = await request<ApiResponse<{ report: EngineeringReport }>>(
      `/api/projects/${encodeURIComponent(projectId)}/missions/${encodeURIComponent(missionId)}/report`
    );
    return result.data.report;
  },
  async remove(projectId: string, reportId: string): Promise<void> {
    await request<void>(
      `/api/projects/${encodeURIComponent(projectId)}/reports/${encodeURIComponent(reportId)}`,
      { method: "DELETE" }
    );
  }
};

export const fixProposalApi = {
  async list(projectId: string): Promise<{ proposals: FixProposalListItem[]; page: number; pageSize: number; total: number }> {
    const result = await request<ApiResponse<{
      proposals: FixProposalListItem[];
      page: number;
      pageSize: number;
      total: number;
    }>>(`/api/projects/${encodeURIComponent(projectId)}/fix-proposals?pageSize=50`);
    return result.data;
  },
  async get(projectId: string, proposalId: string): Promise<FixProposal> {
    const result = await request<ApiResponse<{ proposal: FixProposal }>>(
      `/api/projects/${encodeURIComponent(projectId)}/fix-proposals/${encodeURIComponent(proposalId)}`
    );
    return result.data.proposal;
  },
  async generate(projectId: string, input: { findingId: string; runId: string; missionId?: string }): Promise<FixProposal> {
    const result = await request<ApiResponse<{ proposal: FixProposal }>>(
      `/api/projects/${encodeURIComponent(projectId)}/fix-proposals`,
      { method: "POST", body: JSON.stringify(input) }
    );
    return result.data.proposal;
  },
  async diff(projectId: string, proposalId: string): Promise<{
    proposalId: string;
    status: FixProposalStatus;
    validationStatus: FixProposal["validationStatus"];
    targetGeneration: number;
    files: Pick<FixProposalFileChange, "filePath" | "originalContent" | "proposedContent" | "patch" | "originalHash" | "proposedHash">[];
  }> {
    const result = await request<ApiResponse<{
      proposalId: string;
      status: FixProposalStatus;
      validationStatus: FixProposal["validationStatus"];
      targetGeneration: number;
      files: Pick<FixProposalFileChange, "filePath" | "originalContent" | "proposedContent" | "patch" | "originalHash" | "proposedHash">[];
    }>>(
      `/api/projects/${encodeURIComponent(projectId)}/fix-proposals/${encodeURIComponent(proposalId)}/diff`
    );
    return result.data;
  },
  async validate(projectId: string, proposalId: string): Promise<FixProposal> {
    const result = await request<ApiResponse<{ proposal: FixProposal }>>(
      `/api/projects/${encodeURIComponent(projectId)}/fix-proposals/${encodeURIComponent(proposalId)}/validate`,
      { method: "POST", body: JSON.stringify({}) }
    );
    return result.data.proposal;
  },
  async decide(
    projectId: string,
    proposalId: string,
    decision: "approved" | "rejected",
    rejectionReason?: string
  ): Promise<FixProposal> {
    const result = await request<ApiResponse<{ proposal: FixProposal }>>(
      `/api/projects/${encodeURIComponent(projectId)}/fix-proposals/${encodeURIComponent(proposalId)}/decision`,
      { method: "POST", body: JSON.stringify({ decision, ...(rejectionReason ? { rejectionReason } : {}) }) }
    );
    return result.data.proposal;
  },
  async reviewed(projectId: string, proposalId: string): Promise<FixProposal> {
    const result = await request<ApiResponse<{ proposal: FixProposal }>>(
      `/api/projects/${encodeURIComponent(projectId)}/fix-proposals/${encodeURIComponent(proposalId)}/reviewed`,
      { method: "POST", body: JSON.stringify({}) }
    );
    return result.data.proposal;
  },
  async apply(projectId: string, proposalId: string): Promise<FixProposal> {
    const result = await request<ApiResponse<{ proposal: FixProposal }>>(
      `/api/projects/${encodeURIComponent(projectId)}/fix-proposals/${encodeURIComponent(proposalId)}/apply`,
      { method: "POST", body: JSON.stringify({}) }
    );
    return result.data.proposal;
  },
  async listVerifications(projectId: string, proposalId: string): Promise<VerificationRun[]> {
    const result = await request<ApiResponse<{ runs: VerificationRun[] }>>(
      `/api/projects/${encodeURIComponent(projectId)}/fix-proposals/${encodeURIComponent(proposalId)}/verifications`
    );
    return result.data.runs;
  },
  async startVerification(projectId: string, proposalId: string): Promise<VerificationRun> {
    const result = await request<ApiResponse<{ run: VerificationRun }>>(
      `/api/projects/${encodeURIComponent(projectId)}/fix-proposals/${encodeURIComponent(proposalId)}/verifications`,
      { method: "POST", body: JSON.stringify({}) }
    );
    return result.data.run;
  },
  async cancelVerification(projectId: string, verificationId: string): Promise<VerificationRun> {
    const result = await request<ApiResponse<{ run: VerificationRun }>>(
      `/api/projects/${encodeURIComponent(projectId)}/verifications/${encodeURIComponent(verificationId)}/cancel`,
      { method: "POST", body: JSON.stringify({}) }
    );
    return result.data.run;
  }
};

export const aiApi = {
  async health(): Promise<AIHealth> {
    let response: Response;
    try {
      response = await fetch("/api/ai/health", { credentials: "include" });
    } catch {
      throw new ApiError("Unable to reach the NEXUS API", 0);
    }
    const body = await response.json().catch(() => null) as ApiResponse<AIHealth> | null;
    if (!body?.data) {
      throw new ApiError("AI service status could not be read", response.status);
    }
    return body.data;
  }
};

interface ChatDoneEvent {
  requestId: string;
  conversationId?: string;
  messageId?: string;
  answer: string;
  sources: ProjectSource[];
  limitations: string[];
  model: string;
  latencyMs: number;
  tokenUsage?: { input: number; output: number };
}

export interface ProjectChatCallbacks {
  onSources: (sources: ProjectSource[]) => void;
  onToken: (text: string) => void;
  onDone: (result: ChatDoneEvent) => void;
  onError: (error: { code: string; message: string }) => void;
}

export const streamProjectChat = async (
  projectId: string,
  question: string,
  callbacks: ProjectChatCallbacks,
  signal: AbortSignal
): Promise<void> => {
  await streamChatRequest(
    `/api/projects/${encodeURIComponent(projectId)}/chat`,
    { question },
    callbacks,
    signal
  );
};

export const streamConversationMessage = async (
  projectId: string,
  conversationId: string,
  question: string,
  callbacks: ProjectChatCallbacks,
  signal: AbortSignal
): Promise<void> => {
  await streamChatRequest(
    `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/messages`,
    { question },
    callbacks,
    signal
  );
};

const streamChatRequest = async (
  path: string,
  body: { question: string },
  callbacks: ProjectChatCallbacks,
  signal: AbortSignal
): Promise<void> => {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal
    });
  } catch {
    throw new ApiError("Unable to reach NEXUS. Check your connection and try again.", 0);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as ApiErrorResponse | null;
    throw new ApiError(body?.error?.message ?? "The chat request failed", response.status, body?.error?.code);
  }
  if (!response.body) throw new ApiError("The chat stream is unavailable", response.status);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const dispatch = (frame: string) => {
    let event = "message";
    const data: string[] = [];
    for (const rawLine of frame.split("\n")) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0) return;
    const payload: unknown = JSON.parse(data.join("\n"));
    if (event === "sources" && isSourcePayload(payload)) callbacks.onSources(payload.sources);
    if (event === "token" && isTextPayload(payload)) callbacks.onToken(payload.text);
    if (event === "done" && isDonePayload(payload)) callbacks.onDone(payload);
    if (event === "error" && isErrorPayload(payload)) callbacks.onError(payload);
  };
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      dispatch(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
    }
    if (done) break;
  }
  if (buffer.trim()) dispatch(buffer);
};

const isSourcePayload = (value: unknown): value is { sources: ProjectSource[] } =>
  typeof value === "object" && value !== null && "sources" in value && Array.isArray(value.sources);

const isTextPayload = (value: unknown): value is { text: string } =>
  typeof value === "object" && value !== null && "text" in value && typeof value.text === "string";

const isDonePayload = (value: unknown): value is ChatDoneEvent =>
  typeof value === "object" && value !== null &&
  "answer" in value && typeof value.answer === "string" &&
  "sources" in value && Array.isArray(value.sources);

const isErrorPayload = (value: unknown): value is { code: string; message: string } =>
  typeof value === "object" && value !== null &&
  "code" in value && typeof value.code === "string" &&
  "message" in value && typeof value.message === "string";
