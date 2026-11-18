import { Schema, model } from "mongoose";

const verificationCheckSchema = new Schema({
  checkId: {
    type: String,
    enum: ["test", "lint", "build"],
    required: true
  },
  commandIdentifier: {
    type: String,
    enum: ["project-test", "project-lint", "project-build"],
    required: true
  },
  status: {
    type: String,
    enum: ["PASSED", "FAILED", "SKIPPED", "TIMED_OUT", "CANCELLED"],
    required: true
  },
  exitCode: { type: Number },
  sanitizedOutputSummary: { type: String, maxlength: 2_000, default: "" },
  durationMs: { type: Number, min: 0, required: true, default: 0 },
  failureReason: { type: String, maxlength: 500 }
}, { _id: false });

const verificationRunSchema = new Schema(
  {
    verificationId: { type: String, required: true, unique: true },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    fixProposalId: { type: String, required: true },
    missionId: { type: Schema.Types.ObjectId, ref: "Mission" },
    repositoryRevision: { type: String, default: "unavailable" },
    expectedRevision: { type: String, required: true },
    checks: { type: [verificationCheckSchema], default: [] },
    status: {
      type: String,
      enum: ["PENDING", "RUNNING", "PASSED", "FAILED", "PARTIAL", "CANCELLED", "TIMED_OUT"],
      required: true
    },
    failureReason: { type: String, maxlength: 1_000 },
    startedAt: Date,
    completedAt: Date,
    durationMs: { type: Number, min: 0, default: 0, required: true }
  },
  { timestamps: true, versionKey: false, collection: "verification_runs" }
);

verificationRunSchema.index({ projectId: 1, userId: 1, fixProposalId: 1, createdAt: -1 });
verificationRunSchema.index({ projectId: 1, userId: 1, status: 1 });

export const VerificationRun = model("VerificationRun", verificationRunSchema);
