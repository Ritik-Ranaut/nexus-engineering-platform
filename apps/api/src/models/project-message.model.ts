import { Schema, model } from "mongoose";

const projectMessageSourceSchema = new Schema({
  label: { type: String, required: true },
  filePath: { type: String, required: true },
  language: { type: String, required: true },
  symbolContext: { type: String, required: true },
  startLine: { type: Number, required: true },
  endLine: { type: Number, required: true },
  score: { type: Number, required: true }
}, { _id: false });

const projectMessageSchema = new Schema(
  {
    ownerId: { type: String, required: true, index: true },
    projectId: { type: String, required: true, index: true },
    conversationId: { type: String, required: true, index: true },
    role: { type: String, enum: ["user", "assistant"], required: true },
    content: { type: String, required: true, maxlength: 20_000 },
    status: { type: String, enum: ["completed", "failed"], required: true },
    sources: { type: [projectMessageSourceSchema], default: [] },
    model: { type: String },
    latencyMs: { type: Number },
    errorCode: { type: String }
  },
  { timestamps: true, versionKey: false, collection: "project_messages" }
);

projectMessageSchema.index({ ownerId: 1, projectId: 1, conversationId: 1, createdAt: 1 });

export const ProjectMessage = model("ProjectMessage", projectMessageSchema);
