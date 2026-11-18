import { Schema, model } from "mongoose";

const missionTaskSchema = new Schema({
  taskId: { type: String, required: true },
  agent: {
    type: String,
    enum: ["code_quality", "security", "performance", "testing", "documentation"],
    required: true
  },
  description: { type: String, required: true, maxlength: 500 },
  status: {
    type: String,
    enum: ["pending", "running", "completed", "failed", "cancelled"],
    required: true,
    default: "pending"
  },
  result: { type: String, maxlength: 1_000 },
  dependencies: [{ type: String }]
}, { _id: false });

const missionActionSchema = new Schema({
  actionId: { type: String, required: true },
  issueId: { type: String, required: true },
  description: { type: String, required: true, maxlength: 1_500 },
  status: {
    type: String,
    enum: ["pending", "approved", "rejected"],
    required: true,
    default: "pending"
  },
  decidedAt: Date
}, { _id: false });

const missionFindingSchema = new Schema({
  issueId: { type: String, required: true },
  runId: { type: String, required: true },
  agent: { type: String, required: true },
  category: { type: String, required: true },
  severity: { type: String, required: true },
  title: { type: String, required: true },
  description: { type: String, required: true },
  reasoningSummary: { type: String, required: true },
  affectedFiles: [{ type: String }],
  evidence: [{
    filePath: { type: String, required: true },
    startLine: { type: Number, required: true },
    endLine: { type: Number, required: true },
    quote: { type: String, required: true },
    explanation: { type: String, required: true }
  }],
  recommendation: { type: String, required: true },
  confidence: { type: Number, required: true },
  status: { type: String, required: true },
  createdAt: { type: String, required: true }
}, { _id: false });

const missionSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    goal: { type: String, required: true, maxlength: 1_000 },
    status: {
      type: String,
      enum: [
        "CREATED",
        "PLANNING",
        "RUNNING",
        "WAITING_FOR_APPROVAL",
        "COMPLETED",
        "FAILED",
        "CANCELLED"
      ],
      required: true,
      default: "CREATED"
    },
    plan: {
      summary: { type: String, maxlength: 1_000 },
      rationale: { type: String, maxlength: 1_000 }
    },
    tasks: { type: [missionTaskSchema], default: [] },
    findings: { type: [missionFindingSchema], default: [] },
    report: { type: Schema.Types.Mixed, default: null },
    actions: { type: [missionActionSchema], default: [] },
    progress: {
      percent: { type: Number, min: 0, max: 100, default: 0 },
      currentStep: { type: String, maxlength: 300, default: "Mission created" },
      events: [{
        eventId: { type: String, required: true },
        message: { type: String, required: true, maxlength: 500 },
        status: { type: String, enum: ["info", "completed", "running", "failed"], required: true },
        createdAt: { type: Date, required: true }
      }]
    },
    errors: [{
      code: { type: String, required: true },
      message: { type: String, required: true },
      createdAt: { type: Date, required: true }
    }],
    startedAt: Date,
    completedAt: Date
  },
  { timestamps: true, versionKey: false }
);

missionSchema.index({ userId: 1, projectId: 1, createdAt: -1 });
missionSchema.index({ status: 1, updatedAt: 1 });

export const Mission = model("Mission", missionSchema);
