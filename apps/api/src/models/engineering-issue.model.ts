import { Schema, model } from "mongoose";

const evidenceSchema = new Schema({
  filePath: { type: String, required: true },
  startLine: { type: Number, required: true },
  endLine: { type: Number, required: true },
  quote: { type: String, required: true },
  explanation: { type: String, required: true }
}, { _id: false });

const engineeringIssueSchema = new Schema(
  {
    issueId: { type: String, required: true },
    runId: { type: String, required: true },
    ownerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    agent: {
      type: String,
      enum: ["code_quality", "security", "performance", "testing", "documentation"],
      required: true
    },
    category: {
      type: String,
      enum: ["code_quality", "security", "performance", "testing", "documentation"],
      required: true
    },
    severity: {
      type: String,
      enum: ["critical", "high", "medium", "low", "suggestion"],
      required: true
    },
    title: { type: String, required: true },
    description: { type: String, required: true },
    reasoningSummary: { type: String, required: true },
    affectedFiles: { type: [String], required: true },
    evidence: { type: [evidenceSchema], required: true },
    recommendation: { type: String, required: true },
    confidence: { type: Number, min: 0, max: 1, required: true },
    status: {
      type: String,
      enum: ["open", "accepted", "dismissed", "resolved"],
      default: "open",
      required: true
    }
  },
  { timestamps: true, versionKey: false }
);

engineeringIssueSchema.index({ ownerId: 1, projectId: 1, createdAt: -1 });
engineeringIssueSchema.index({ ownerId: 1, projectId: 1, runId: 1, issueId: 1 }, { unique: true });

export const EngineeringIssue = model("EngineeringIssue", engineeringIssueSchema);
