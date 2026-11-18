import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { chat } from "../controllers/project-chat.controller.js";
import {
  create as createConversation,
  list as listConversations,
  messages as conversationMessages,
  sendMessage as sendConversationMessage
} from "../controllers/project-conversation.controller.js";
import {
  create,
  deleteVectors,
  get,
  index,
  list,
  updateIndex
} from "../controllers/project.controller.js";
import { search } from "../controllers/project-search.controller.js";
import { rateLimit } from "express-rate-limit";
import { env } from "../config/env.js";
import {
  listIssues,
  listRuns,
  runAnalysis,
  updateIssue
} from "../controllers/engineering-analysis.controller.js";
import { createMission, listMissions } from "../controllers/mission.controller.js";
import {
  architectureNodes,
  architectureGraph,
  architectureNode,
  architectureRelationships,
  file,
  fileMetadata,
  files,
  structure,
  refreshArchitecture
} from "../controllers/project-intelligence.controller.js";
import {
  generate as generateReport,
  generateMissionReport,
  get as getReport,
  list as listReports,
  missionReport,
  remove as deleteReport
} from "../controllers/engineering-report.controller.js";
import {
  apply as applyFixProposal,
  decide as decideFixProposal,
  diff as getFixProposalDiff,
  generate as generateFixProposal,
  get as getFixProposal,
  list as listFixProposals,
  validate as validateFixProposal,
  reviewed as recordFixProposalReview
} from "../controllers/fix-proposal.controller.js";
import {
  cancel as cancelVerification,
  get as getVerification,
  list as listVerifications,
  start as startVerification
} from "../controllers/verification.controller.js";

const router = Router();
const chatRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Too many AI requests" } }
});
const indexingRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: () => env.NODE_ENV === "test",
  message: { error: { code: "RATE_LIMITED", message: "Too many project indexing requests" } }
});
const analysisRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Too many engineering analysis requests" } }
});
const missionRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Too many mission requests" } }
});
const reportRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Too many report generation requests" } }
});
const fixProposalRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: () => env.NODE_ENV === "test",
  message: { error: { code: "RATE_LIMITED", message: "Too many fix proposal requests" } }
});
const verificationRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: () => env.NODE_ENV === "test",
  message: { error: { code: "RATE_LIMITED", message: "Too many verification requests" } }
});

router.use(requireAuth);
router.post("/", create);
router.get("/", list);
router.get("/:projectId", get);
router.post("/:projectId/index", indexingRateLimit, index);
router.patch("/:projectId/index", indexingRateLimit, updateIndex);
router.delete("/:projectId/vectors", deleteVectors);
router.post("/:projectId/search", search);
router.get("/:projectId/structure", structure);
router.get("/:projectId/files", files);
router.get("/:projectId/files/content", file);
router.get("/:projectId/files/metadata", fileMetadata);
router.get("/:projectId/architecture/nodes", architectureNodes);
router.get("/:projectId/architecture/relationships", architectureRelationships);
router.get("/:projectId/architecture/graph", architectureGraph);
router.get("/:projectId/architecture/node", architectureNode);
router.post("/:projectId/architecture/refresh", refreshArchitecture);
router.post("/:projectId/chat", chatRateLimit, chat);
router.get("/:projectId/conversations", listConversations);
router.post("/:projectId/conversations", createConversation);
router.get("/:projectId/conversations/:conversationId/messages", conversationMessages);
router.post("/:projectId/conversations/:conversationId/messages", chatRateLimit, sendConversationMessage);
router.post("/:projectId/analysis", analysisRateLimit, runAnalysis);
router.get("/:projectId/analysis/runs", listRuns);
router.get("/:projectId/issues", listIssues);
router.patch("/:projectId/issues/:issueId", updateIssue);
router.post("/:projectId/missions", missionRateLimit, createMission);
router.get("/:projectId/missions", listMissions);
router.post("/:projectId/reports", reportRateLimit, generateReport);
router.get("/:projectId/reports", listReports);
router.get("/:projectId/reports/:reportId", getReport);
router.delete("/:projectId/reports/:reportId", deleteReport);
router.post("/:projectId/missions/:missionId/report", reportRateLimit, generateMissionReport);
router.get("/:projectId/missions/:missionId/report", missionReport);
router.post("/:projectId/fix-proposals", fixProposalRateLimit, generateFixProposal);
router.get("/:projectId/fix-proposals", listFixProposals);
router.get("/:projectId/fix-proposals/:proposalId/diff", getFixProposalDiff);
router.post("/:projectId/fix-proposals/:proposalId/validate", validateFixProposal);
router.post("/:projectId/fix-proposals/:proposalId/decision", decideFixProposal);
router.post("/:projectId/fix-proposals/:proposalId/reviewed", recordFixProposalReview);
router.post("/:projectId/fix-proposals/:proposalId/apply", applyFixProposal);
router.post("/:projectId/fix-proposals/:proposalId/verifications", verificationRateLimit, startVerification);
router.get("/:projectId/fix-proposals/:proposalId/verifications", listVerifications);
router.get("/:projectId/verifications/:verificationId", getVerification);
router.post("/:projectId/verifications/:verificationId/cancel", cancelVerification);
router.get("/:projectId/fix-proposals/:proposalId", getFixProposal);

export default router;
