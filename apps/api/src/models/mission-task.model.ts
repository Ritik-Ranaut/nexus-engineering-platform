import { Schema, model } from "mongoose";

const missionTaskSchema = new Schema(
  {
    missionId: { type: Schema.Types.ObjectId, ref: "Mission", required: true },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
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
    dependencies: { type: [String], default: [] }
  },
  { timestamps: true, versionKey: false, collection: "mission_tasks" }
);

missionTaskSchema.index({ missionId: 1, taskId: 1 }, { unique: true });
missionTaskSchema.index({ userId: 1, projectId: 1, missionId: 1, createdAt: 1 });

export const MissionTask = model("MissionTask", missionTaskSchema);
