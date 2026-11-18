# NEXUS

NEXUS is an engineering intelligence platform with project-scoped code intelligence, local LLM/RAG, specialist analysis, missions, and evidence-backed engineering reports. Project setup uses safe source-file ingestion and does not clone repositories or access backend filesystem paths.

## Architecture

- `apps/web`: React, Vite, TypeScript, React Router, Zustand. Project setup, streamed project chat, and retrieved source display live in pages/components; API access is in the client module.
- `apps/api`: Express and TypeScript, separated into routes, controllers, services, Mongoose models, validators, and middleware.
- MongoDB stores users, projects, chunk embeddings, AI request metadata, analysis runs, and evidence-backed findings.
- LangChain's `@langchain/ollama` adapter provides the shared configurable Ollama chat and embedding models. Project investigations use `@langchain/langgraph` with a bounded explicit workflow.
- Chat streams over Server-Sent Events (SSE); mission progress is delivered over authenticated Socket.IO rooms.

## Local development

1. Install Node.js 20+ and MongoDB.
2. Copy `apps/api/.env.example` to `apps/api/.env`.
3. Configure `JWT_SECRET`, `OLLAMA_BASE_URL`, `LLM_MODEL`, `EMBEDDING_MODEL`, and `AI_VECTOR_DIMENSIONS`. The model values in the example are placeholders. `OLLAMA_CHAT_MODEL` and `OLLAMA_EMBEDDING_MODEL` remain supported as legacy aliases.
4. Install dependencies from the repository root with `npm install`.
5. Create the MongoDB Atlas Vector Search index described in `apps/api/src/config/vector-search-index.json` on the `code_chunks` collection. Set the index name to `AI_VECTOR_INDEX_NAME` and set `numDimensions` to the same value as `AI_VECTOR_DIMENSIONS`. The index needs vector field `embedding` with cosine similarity and filter fields `projectId`, `ownerId`, `generation`, `fileId`, `filePath`, and `language`.
6. Make the configured chat and embedding models available in Ollama (for example, with `ollama pull <configured-model>`).
7. Start the API with `npm run dev --workspace @nexus/api`.
8. Start the frontend in another terminal with `npm run dev --workspace @nexus/web`.

The Vite development server proxies `/api` requests to `http://localhost:4000`. `AI_PROVIDER` currently supports `ollama`; `AI_REQUEST_TIMEOUT_MS`, `AI_CHAT_RETRIES`, and `AI_EMBEDDING_RETRIES` configure request reliability. Production deployments must configure `WEB_ORIGIN`, MongoDB Atlas, Ollama connectivity, and a high-entropy JWT secret through the environment; never put API secrets in frontend variables.

The local model provider is isolated behind the `AIProvider` interface. It initializes LangChain's Ollama chat and embedding adapters from environment configuration, reports Ollama/model availability through `GET /api/ai/health`, and enforces request timeouts. Authenticated `POST /api/ai/playground` is enabled only outside production to validate text generation and embedding dimensions without persisting the prompt or vector.

## Authentication

- `POST /api/auth/register` creates a user and starts a session.
- `POST /api/auth/login` starts a session.
- `GET /api/auth/me` returns the authenticated profile.
- `POST /api/auth/logout` revokes all current sessions for the user and clears the browser cookie.

JWTs are held in an HTTP-only, same-site cookie; the frontend does not receive or persist the token. Passwords are hashed with bcrypt. Registration requires a password of at least 12 characters.

## Code intelligence

- `POST /api/projects` creates a project owned by the authenticated user.
- `GET /api/projects` lists only the authenticated user's projects.
- `GET /api/projects/:projectId` returns a project only to its owner.
- `POST /api/projects/:projectId/index` accepts up to 100 relative-path source/documentation files, with a 4 MB combined content limit. It rejects traversal paths and excludes credential, generated, and unsupported files.
- `POST /api/projects/:projectId/chat` streams `sources`, `token`, `done`, and `error` SSE events. Retrieval is filtered by owner, project, and active index generation.
- `GET /api/ai/health` reports Ollama connectivity and configured model availability to authenticated users.

Chunk records preserve file path, language, symbol context, line range, index generation, source hash, and vector embedding. Reindexing stages a new generation and activates it only after embedding and storage complete. AI telemetry records model names, duration, request status, token usage when provided, and retrieved source metadata; it does not persist prompts, model output, or credentials.

The UI currently uploads selected files or a browser-selected project folder; it does not clone Git repositories or walk backend filesystem paths. Chat responses show retrieved source references and an explicit grounding limitation. This is retrieval-grounded assistance, not a verification claim.

### Structural codebase map

The Code Explorer displays the indexed file tree, secret-redacted source, file metadata, detected project layers, and relative import relationships. Classification and import resolution are deterministic source inspection; this structural map does not invoke an AI model.

- `GET /api/projects/:projectId/structure` returns the file tree and language/layer counts.
- `GET /api/projects/:projectId/files?search=...` lists file metadata and searches paths, symbols, and indexed source contents.
- `GET /api/projects/:projectId/files/content?path=...` returns a file's redacted source and metadata; `GET /api/projects/:projectId/files/metadata?path=...` returns metadata only.
- `GET /api/projects/:projectId/architecture/nodes` and `/api/projects/:projectId/architecture/relationships` return the detected architecture graph.

File records and graph snapshots are stored in MongoDB per owner, project, and index generation. Reindexing activates file and graph metadata together with vector chunks, preserving the previous active generation if indexing fails.

## Project RAG

The code-aware chunker preserves symbol context and source line ranges. Each vector record stores owner/project/generation scope, stable `fileId` and `chunkId`, file path, language, `lineStart`/`lineEnd`, source content, and embedding. Vector retrieval always applies project, owner, and active-generation filters; optional file ID, path, and language filters are applied inside MongoDB Atlas Vector Search. Results are returned only from stored chunks, and no-match retrieval returns an empty list.

- `POST /api/projects/:projectId/index` indexes a complete project snapshot.
- `PATCH /api/projects/:projectId/index` accepts changed files and/or `deletedPaths`. Unchanged file chunks and embeddings are copied to the new generation without re-embedding.
- `DELETE /api/projects/:projectId/vectors` deletes only the authenticated owner's vectors and index metadata for that project and resets its indexing status.
- `POST /api/projects/:projectId/search` performs semantic search with `query`, optional bounded `topK` (1-100), and optional `fileId`, `filePath`, or `language` metadata filters. It returns actual stored source chunks, not generated answers.

Indexing activates chunk, file, and architecture metadata as one generation; a failed update leaves the prior active generation available.

## Project-aware AI chat

The project assistant retrieves active-generation chunks through the Phase 6 retriever before generating each answer. Conversations and messages are stored with owner and project scope; each assistant message retains its retrieved source paths and line ranges. The response stream exposes `sources`, sanitized `token` output, `done`, and safe `error` events. If retrieval is empty, the assistant does not invoke the chat model and returns an explicit no-evidence response. Generated answers without a valid citation to a retrieved chunk are replaced with a source-backed limitation; unverified file and line references are removed before any text is streamed or persisted.

- `GET /api/projects/:projectId/conversations` lists the authenticated user's project conversations.
- `POST /api/projects/:projectId/conversations` creates a project-scoped conversation.
- `GET /api/projects/:projectId/conversations/:conversationId/messages` returns its bounded message history and source references.
- `POST /api/projects/:projectId/conversations/:conversationId/messages` persists the user message, retrieves project context, and streams a grounded assistant response. Recent completed turns are included as conversation context; they do not replace retrieved code evidence.

The workspace project list opens the project-aware assistant. Its conversation rail, source references, error states, and history are scoped to the currently selected project.

## Engineering analysis

The analysis workflow reuses the configured `createChatModel()` abstraction and project retriever; specialists do not create separate model clients or embedding integrations. The LangGraph state tracks the request scope, project context, selected specialists, findings, failures, activity summaries, and execution position.

The LangGraph workflow uses explicit state and follows `START -> context -> planner/agent selection -> bounded specialist loop -> aggregate -> reviewer -> prioritize -> final report -> END`. The planner selects from five specialists: Code Quality (correctness and maintainability), Security (auth, authorization, injection, and secrets), Performance (evidenced bottlenecks), Testing (test reliability and coverage gaps), and Documentation (setup/API/architecture gaps). Specialists execute sequentially, with a five-agent ceiling and at most three tool rounds of four calls per specialist. Findings are deterministically checked and deduplicated before reviewer evaluation, then sorted by severity, confidence, and title. The final report records a safe summary and severity totals. Planner failures select the bounded specialist set; individual specialist and reviewer failures are recorded without suppressing other results. `AGENT_ANALYSIS_TIMEOUT_MS` controls the overall deadline, and request/mission cancellation aborts the graph and active model/tool calls.

Mission execution persists safe workflow activity to MongoDB and streams it to the authenticated owner over the existing Socket.IO `mission:progress` event. Activities describe stage and tool progress (for example, loading context, searching indexed code, reviewer completion, and finding counts); model rationale and private reasoning are not sent as progress. Completed reports, task outcomes, findings, and safe failure summaries are persisted with the mission.

Each specialist implements the shared structured agent interface and has a narrow responsibility, structured input/output, and distinct tool allowlist. Read-only tools are `searchCode`, `readFile`, `findReferences`, `inspectProject`, `retrieveContext`, and `searchMemory`; code/project tools are scoped to the authenticated owner, requested project, and active index generation, while memory search is scoped to completed conversation messages for that owner and project. No shell execution or arbitrary filesystem access is available. Repository text is passed as untrusted data and cannot override system instructions. A Reviewer Agent checks candidate quality and support; deterministic validation additionally rejects findings unless quoted evidence and line ranges match retrieved project chunks, then removes duplicates. Reviewer failures are logged and surfaced in run activity; only findings that pass deterministic evidence checks are retained. Only concise user-facing summaries are exposed, not chain-of-thought.

- `POST /api/projects/:projectId/analysis` runs a project-scoped investigation and returns the run, activity summary, failures, and findings.
- `GET /api/projects/:projectId/analysis/runs` lists recent runs.
- `GET /api/projects/:projectId/issues` lists findings; `PATCH /api/projects/:projectId/issues/:issueId` updates finding status.

Analysis runs and issue records include owner and project references. All endpoints require authentication and verify project ownership. Findings include category, severity, concise problem and reasoning summaries, exact source evidence, recommendation, confidence, and status. The Issues page groups findings by critical/high/medium/low/suggestion and shows evidence, affected files, and status controls.

## AI engineering missions

- `POST /api/projects/:projectId/missions` creates an asynchronous mission and returns `202`.
- `GET /api/projects/:projectId/missions` lists recent project missions; `GET /api/missions/:missionId` returns a mission to its owner.
- `POST /api/missions/:missionId/cancel` cancels a created, planning, running, or approval-waiting mission.
- `POST /api/missions/:missionId/actions/:actionId/decision` records an explicit `approved` or `rejected` decision for one recommendation.

Missions persist their lifecycle status, plan, ordered dependency-linked task documents, progress timeline, findings, final report, recommendation decisions, and safe error summaries. Each task is stored independently in `mission_tasks` with owner/project/mission scope and mirrored into the mission response for display. The mission planner chooses relevant specialists using the shared Ollama model service; if planning fails, NEXUS records a safe fallback warning and proceeds with the bounded five-agent plan. Investigation reuses the Phase 9 LangGraph workflow and project-scoped retrieval. The Mission Center offers common engineering goal prompts, plan and per-agent task monitoring, prioritized findings, final severity totals, cancellation, and human recommendation decisions. It subscribes to authenticated Socket.IO progress events and polls mission state as a recovery path.

Mission lifecycle states are `CREATED`, `PLANNING`, `RUNNING`, `WAITING_FOR_APPROVAL`, `COMPLETED`, `FAILED`, and `CANCELLED`. Recommendations are not executable operations: approving or rejecting only records the human decision, and NEXUS does not modify source code, run shell commands, or deploy. Socket handshakes validate the HTTP-only JWT cookie and current user token version; subscriptions are authorized against mission ownership. On API restart, in-flight missions are marked `FAILED` with a retry instruction rather than left stuck.

## AI engineering reports

Reports are persisted in the `engineering_reports` collection and reference existing project findings or mission findings rather than copying the full source records. Generation is idempotent for a fixed report type, mission/run set, indexed generation, and finding state. All report operations require authentication and verify both project ownership and user scope; report and mission findings are reloaded only inside that scope.

- `POST /api/projects/:projectId/reports` generates a report. Supported `reportType` values: `project_health`, `security_audit`, `code_quality`, `performance_analysis`, `testing_coverage`, and `documentation`.
- `GET /api/projects/:projectId/reports` lists reports with bounded `page`, `pageSize`, `reportType`, and `missionId` filters.
- `GET /api/projects/:projectId/reports/:reportId` returns a report and its referenced findings.
- `DELETE /api/projects/:projectId/reports/:reportId` deletes only the selected report.
- `POST`/`GET /api/projects/:projectId/missions/:missionId/report` generate or retrieve the latest mission-specific report. Reports require a finished mission.

Finding counts, category totals, priorities, and score values are computed deterministically. Each finding is checked against the exact file and quoted line range in the project's active indexed generation. Findings with stale, missing, dismissed, or malformed evidence are labeled **unverified**, excluded from confirmed totals and scoring, and shown separately for review. Incomplete runs, invalid finding data, stale source, and failed narrative generation are listed as limitations and produce a partial report. The optional Ollama narrative uses only confirmed finding summaries; a deterministic fallback is used if model output is unavailable or invalid.

The project health score is a transparent heuristic, not an objective quality metric: `100 - sum(category weight × min(100, Σ severity points))`, rounded to the nearest integer. Weights are security 30%, code quality 25%, performance 20%, testing 15%, and documentation 10%. Severity points are critical 40, high 25, medium 12, low 4, and suggestion 1. A score is calculated only after a completed investigation for all five categories; otherwise the UI displays **Insufficient data**. This score reflects only evidence-validated findings from the selected latest runs, does not measure unreported risks, and must not be interpreted as a security certification or general quality guarantee. Evidence validation confirms quoted text and line ranges against indexed source; it does not independently prove that an issue's interpretation or severity is correct.

The Reports page shows executive summaries, deterministic severity and category counts, confirmed and unverified findings, evidence line ranges, file links into Code Explorer, recommendations, limitations, and previous reports. It supports Markdown and JSON downloads; PDF export is intentionally omitted. Mission Center links to the associated mission report.

## AI fix proposals

Fix proposals are stored separately in `fix_proposals`; they link to an existing issue or mission finding, its run, active project generation, source hashes, and the original evidence. Generation reuses the configured LangChain/Ollama text service and project-scoped vector retriever. The model returns a strict JSON proposal with full proposed contents only for existing finding-affected files. The API constructs a unified diff with the `diff` library; it never trusts or applies an LLM-supplied patch string.

- `POST /api/projects/:projectId/fix-proposals` accepts `findingId`, `runId`, and optional `missionId`.
- `GET /api/projects/:projectId/fix-proposals` lists scoped proposal metadata with pagination/status/finding filters.
- `GET /api/projects/:projectId/fix-proposals/:proposalId` retrieves a proposal and its original finding.
- `GET /api/projects/:projectId/fix-proposals/:proposalId/diff` retrieves proposed source and unified diff.
- `POST /api/projects/:projectId/fix-proposals/:proposalId/validate` rechecks source generation, hashes, path policy, diff integrity, and patch size.
- `POST /api/projects/:projectId/fix-proposals/:proposalId/reviewed` records an authenticated review event.
- `POST /api/projects/:projectId/fix-proposals/:proposalId/decision` records an atomic `approved` or `rejected` human decision, including the deciding user, timestamp, and optional rejection reason.
- `POST /api/projects/:projectId/fix-proposals/:proposalId/apply` is deliberately blocked with `REPOSITORY_WRITE_UNAVAILABLE`; it records the attempt and changes no files.

The generator is limited to a small set of code file extensions and at most three existing affected files; each source/proposed file and the total patch have bounded sizes. It rejects absolute/traversal paths, sensitive names/extensions, paths outside the finding's affected files, creations/deletions, duplicates, conflict markers, credential-like output, invalid source evidence, hash mismatches, and patches that fail a diff round trip. A partial unique index serializes concurrent generation for the same finding. Each proposal records generation and content hashes; a changed active generation invalidates validation and approval, and the old patch is never refreshed over newer source. Request disconnect aborts in-flight model generation where supported.

Statuses are `GENERATING`, `AWAITING_APPROVAL`, `VALIDATION_FAILED`, `APPROVED`, `REJECTED`, `APPLIED`, and `VERIFICATION_FAILED`. Approval is only available for a currently valid proposal awaiting review; stale proposals cannot be approved, and conditional database updates prevent duplicate/racing decisions. Approval and application are separate. The application endpoint is an explicit refusal, `APPLIED` is not reachable, rollback is unavailable, and no indexed source record is mutated. Decision and review events are stored in the proposal audit trail. Validation does not execute tests; responses explicitly say tests were not run. The Fix Proposals UI presents original and proposed source, finding evidence, root cause, explanation, assumptions, side effects, additions/deletions, source hashes, stale warnings, audit history, and review controls. Apply remains disabled because there is no writable checkout. It uses a text diff viewer rather than Monaco because Monaco is not an existing dependency.

NEXUS currently indexes uploaded, secret-redacted project snapshots and does not keep a Git checkout or filesystem path. Proposals therefore target the active indexed generation, not a Git commit. Safe application, rollback, partial-write recovery, and filesystem/symlink race validation cannot be implemented against this storage model; no simulation is presented as a real apply. Symlinks cannot be traversed by the current workflow because it never accesses or writes a filesystem. Any future writable-repository integration must independently provide path/symlink protections, concurrency checks, atomic writes or recovery, and rollback before enabling application.

## Automated verification (Phase 14)

`verification_runs` stores project/user-scoped verification attempts linked to a fix proposal. Checks use fixed identifiers (`project-test`, `project-lint`, and `project-build`); request bodies reject arbitrary command input. Each check records its status, optional exit code, bounded sanitized output summary, duration, and failure reason. Verification status is separate from the fix proposal's approval/application status.

- `POST /api/projects/:projectId/fix-proposals/:proposalId/verifications` requests verification.
- `GET /api/projects/:projectId/fix-proposals/:proposalId/verifications` lists up to 50 attempts.
- `GET /api/projects/:projectId/verifications/:verificationId` retrieves an owner-scoped attempt.
- `POST /api/projects/:projectId/verifications/:verificationId/cancel` cancels a pending/running record.

Verification requires both an `APPLIED` proposal and a successful application record containing an actual repository revision. NEXUS currently has no writable repository, sandbox/container executor, or background job worker. Accordingly, no project test, lint, build, dependency install, or other repository script runs on the NEXUS host. When called for an appropriately applied proposal, the API records all three checks as `SKIPPED` and returns `PARTIAL`; a proposal that is merely generated or approved is rejected without creating a run. The indexed target revision is retained separately from the actual application revision. No check can be considered passed from submission or model output.

The deterministic status classifier considers a verification `PASSED` only if all required test/lint/build checks have actual zero exit codes; failed non-zero exits yield `FAILED`, incomplete checks yield `PARTIAL`, and explicit cancellation or timeout take precedence. Output sanitization removes terminal control sequences, redacts credential-like values, and caps summaries at 2,000 characters. Authenticated Socket.IO subscriptions use owner-scoped verification IDs and emit status-only events. Cancellation transitions only pending/running records; there is no subprocess to clean up until an isolated runner exists.

The Verification panel distinguishes generated, approved, applied, and verification states, shows prior attempts and per-check results, and keeps verification disabled unless the proposal has actually been applied successfully. With current infrastructure this panel explains the sandbox limitation and displays no fabricated test results. AI failure diagnosis is not invoked without real, sandbox-produced failure output.

## Interactive architecture explorer (Phase 15)

The explorer reuses each project's active `project_architectures` generation. File nodes have stable generation-independent IDs equal to normalized indexed paths; node details include project, name/type, path when applicable, language, category, detected symbols/imports, static-analysis source, confidence, and verification status. Package nodes use `package:<name>` IDs and come from parsed `package.json` dependency groups. Edges have deterministic IDs, endpoints, type, evidence, inference source, confidence, and verification status:

- `IMPORTS` edges are emitted only when a relative import/export/require specifier resolves to a file in the same indexed project. The import specifier is retained as evidence and marked statically confirmed.
- `DEPENDS_ON` edges are emitted only for dependency declarations actually present in `package.json`; evidence records the manifest field, package name, and version.

No call, render, route-to-controller, or model-use edge is guessed based on file names. Such relationships remain unknown unless supported by the current static import/manifest analysis. The graph presently covers the JavaScript/TypeScript ecosystem's indexed local imports and npm manifests; it does not parse every supported language or resolve dynamic/runtime behavior.

- `GET /api/projects/:projectId/architecture/graph` returns a project-scoped graph with optional `search`, `layer`, `relationshipType`, `limit` (1–300), `offset`, and one-hop `neighborhood` filters. The default node page is bounded; pagination metadata includes total nodes and truncation.
- `GET /api/projects/:projectId/architecture/node?nodeId=...` returns node details and its incoming/outgoing evidence-bearing relationships.
- `POST /api/projects/:projectId/architecture/refresh` reruns the deterministic analyzer against the active indexed generation; it does not reindex source or call an LLM.

All graph requests verify project ownership and use the active project generation. The Architecture Explorer provides overview/frontend/backend/data/tests/configuration views, search, relationship filtering, bounded SVG rendering with zoom/scroll, node inspection, evidence and confidence status, and links to Code Explorer, project chat, issues, and reports. The renderer is custom SVG because React Flow is not installed; it renders at most 300 nodes per request (the UI requests 200) and includes edges only when both endpoint nodes are in the returned page. Invalid package JSON omits package edges and marks the graph partial. The graph does not persist separate package/node records and is not an authoritative runtime call graph.

## Validation

- `npm test` runs backend authentication, project isolation/indexing, code chunking, embedding retry, chat streaming, fixture-based RAG metrics, and engineering-agent workflow/tool tests.
- `npm run build` type-checks/builds the API and frontend.
