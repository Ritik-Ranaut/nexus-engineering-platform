import { Schema, model } from "mongoose";
import { reportTypes } from "../validators/report.validators.js";

const findingReferenceSchema = new Schema({
  findingId: { type: String, required: true },
  runId: { type: String, required: true },
  source: { type: String, enum: ["issue", "mission"], required: true }
}, { _id: false });

const affectedFileSchema = new Schema({
  filePath: { type: String, required: true },
  findingIds: { type: [String], required: true, default: [] }
}, { _id: false });

const reportSectionSchema = new Schema({
  category: { type: String, required: true },
  summary: { type: String, required: true },
  findingIds: { type: [String], required: true, default: [] }
}, { _id: false });

const recommendationSchema = new Schema({
  findingId: { type: String, required: true },
  title: { type: String, required: true },
  action: { type: String, required: true },
  category: { type: String, required: true },
  severity: { type: String, required: true },
  affectedFiles: { type: [String], required: true, default: [] }
}, { _id: false });

const reportSchema = new Schema(
  {
    reportId: { type: String, required: true, unique: true },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    missionId: { type: Schema.Types.ObjectId, ref: "Mission" },
    reportType: { type: String, enum: reportTypes, required: true },
    title: { type: String, required: true, maxlength: 180 },
    summary: { type: String, required: true, maxlength: 2_000 },
    status: { type: String, enum: ["complete", "partial"], required: true },
    findingRefs: { type: [findingReferenceSchema], required: true, default: [] },
    unverifiedFindingRefs: { type: [findingReferenceSchema], required: true, default: [] },
    severityCounts: { type: Schema.Types.Mixed, required: true, default: {} },
    categoryCounts: { type: Schema.Types.Mixed, required: true, default: {} },
    sections: { type: [reportSectionSchema], required: true, default: [] },
    affectedFiles: { type: [affectedFileSchema], required: true, default: [] },
    recommendations: { type: [recommendationSchema], required: true, default: [] },
    limitations: { type: [String], required: true, default: [] },
    healthScore: {
      status: { type: String, enum: ["calculated", "insufficient_data"], required: true },
      value: { type: Number, min: 0, max: 100, default: null },
      formula: { type: String, required: true },
      rationale: { type: String, required: true }
    },
    generation: {
      sourceFingerprint: { type: String, required: true },
      sourceRunIds: { type: [String], required: true, default: [] },
      indexedGeneration: { type: Number, required: true },
      model: { type: String },
      narrativeStatus: { type: String, enum: ["generated", "fallback"], required: true },
      generatedAt: { type: Date, required: true }
    }
  },
  { timestamps: true, versionKey: false, collection: "engineering_reports" }
);

reportSchema.index(
  { userId: 1, projectId: 1, reportType: 1, missionId: 1, "generation.sourceFingerprint": 1 },
  { unique: true }
);
reportSchema.index({ userId: 1, projectId: 1, createdAt: -1 });
reportSchema.index({ userId: 1, projectId: 1, missionId: 1, createdAt: -1 });

export const EngineeringReport = model("EngineeringReport", reportSchema);
