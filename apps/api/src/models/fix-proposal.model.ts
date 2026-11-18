import { Schema, model } from "mongoose";

const fileChangeSchema = new Schema({
  filePath: { type: String, required: true },
  language: { type: String, required: true },
  originalContent: { type: String, required: true },
  proposedContent: { type: String, required: true },
  originalHash: { type: String, required: true },
  proposedHash: { type: String, required: true },
  patch: { type: String, required: true }
}, { _id: false });

const evidenceReferenceSchema = new Schema({
  filePath: { type: String, required: true },
  startLine: { type: Number, required: true },
  endLine: { type: Number, required: true },
  quote: { type: String, required: true }
}, { _id: false });

const fixProposalSchema = new Schema(
  {
    proposalId: { type: String, required: true, unique: true },
    findingKey: { type: String, required: true },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    findingId: { type: String, required: true },
    runId: { type: String, required: true },
    missionId: { type: Schema.Types.ObjectId, ref: "Mission" },
    finding: {
      title: { type: String, required: true },
      category: { type: String, required: true },
      severity: { type: String, required: true },
      description: { type: String, required: true },
      recommendation: { type: String, required: true },
      evidence: { type: [evidenceReferenceSchema], required: true, default: [] }
    },
    targetGeneration: { type: Number, required: true },
    targetRevision: { type: String, required: true },
    changes: { type: [fileChangeSchema], required: true, default: [] },
    rootCause: { type: String, maxlength: 1_500 },
    explanation: { type: String, maxlength: 2_500 },
    sideEffects: { type: [String], default: [] },
    assumptions: { type: [String], default: [] },
    status: {
      type: String,
      enum: [
        "GENERATING",
        "GENERATED",
        "AWAITING_APPROVAL",
        "VALIDATION_FAILED",
        "APPROVED",
        "REJECTED",
        "APPLIED",
        "VERIFICATION_FAILED"
      ],
      required: true
    },
    validationStatus: {
      type: String,
      enum: ["PENDING", "VALID", "STALE", "FAILED"],
      required: true
    },
    validationMessage: { type: String, maxlength: 1_000 },
    approvalStatus: {
      type: String,
      enum: ["PENDING", "APPROVED", "REJECTED"],
      default: "PENDING",
      required: true
    },
    decision: {
      status: { type: String, enum: ["APPROVED", "REJECTED"] },
      userId: { type: Schema.Types.ObjectId, ref: "User" },
      decidedAt: Date,
      rejectionReason: { type: String, maxlength: 1_000 }
    },
    applicationResult: {
      status: {
        type: String,
        enum: ["NOT_SUPPORTED", "STARTED", "SUCCEEDED", "FAILED", "PARTIAL"],
        default: "NOT_SUPPORTED",
        required: true
      },
      attemptedBy: { type: Schema.Types.ObjectId, ref: "User" },
      attemptedAt: Date,
      message: { type: String, maxlength: 1_000 },
      repositoryRevision: { type: String, maxlength: 256 },
      filesApplied: { type: [String], default: [] },
      filesNotApplied: { type: [String], default: [] },
      rollbackStatus: {
        type: String,
        enum: ["NOT_AVAILABLE", "NOT_REQUESTED", "SUCCEEDED", "FAILED"],
        default: "NOT_AVAILABLE"
      }
    },
    auditTrail: [{
      action: {
        type: String,
        enum: [
          "GENERATED",
          "REVIEWED",
          "APPROVED",
          "REJECTED",
          "APPLICATION_UNAVAILABLE",
          "APPLICATION_STARTED",
          "APPLICATION_SUCCEEDED",
          "APPLICATION_FAILED",
          "ROLLBACK_REQUESTED",
          "ROLLBACK_SUCCEEDED",
          "ROLLBACK_FAILED"
        ],
        required: true
      },
      userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
      createdAt: { type: Date, required: true },
      message: { type: String, maxlength: 500 }
    }],
    model: { type: String },
    failureCode: { type: String },
    generatedAt: Date
  },
  { timestamps: true, versionKey: false, collection: "fix_proposals" }
);

fixProposalSchema.index(
  { projectId: 1, userId: 1, findingKey: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "GENERATING" }
  }
);
fixProposalSchema.index({ projectId: 1, userId: 1, createdAt: -1 });
fixProposalSchema.index({ projectId: 1, userId: 1, findingId: 1, runId: 1 });

export const FixProposal = model("FixProposal", fixProposalSchema);
