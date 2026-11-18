import { Schema, model } from "mongoose";

const analysisRunSchema = new Schema(
  {
    runId: { type: String, required: true, unique: true },
    ownerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    goal: { type: String, required: true, maxlength: 1_000 },
    status: { type: String, enum: ["completed", "partial", "failed"], required: true },
    selectedAgents: [{ type: String, required: true }],
    summaries: { type: Schema.Types.Mixed, required: true, default: {} },
    report: { type: Schema.Types.Mixed, required: true, default: {} },
    activities: [{
      agent: { type: String, required: true },
      status: { type: String, enum: ["started", "completed", "failed"], required: true },
      summary: { type: String, required: true }
    }],
    failures: [{
      agent: { type: String, required: true },
      code: { type: String, required: true },
      message: { type: String, required: true }
    }],
    issueCount: { type: Number, required: true, default: 0 },
    durationMs: { type: Number, required: true },
    model: { type: String, required: true }
  },
  { timestamps: true, versionKey: false }
);

analysisRunSchema.index({ ownerId: 1, projectId: 1, createdAt: -1 });

export const AnalysisRun = model("AnalysisRun", analysisRunSchema);
