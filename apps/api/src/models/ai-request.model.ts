import { Schema, model } from "mongoose";

const aiRequestSchema = new Schema(
  {
    requestId: { type: String, required: true, unique: true },
    ownerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    model: { type: String, required: true },
    embeddingModel: { type: String, required: true },
    latencyMs: { type: Number, required: true },
    status: { type: String, enum: ["success", "failed"], required: true },
    errorCode: { type: String },
    retrievedChunks: [{
      chunkId: { type: String, required: true },
      filePath: { type: String, required: true },
      startLine: { type: Number, required: true },
      endLine: { type: Number, required: true },
      score: { type: Number, required: true }
    }],
    tokenUsage: {
      input: { type: Number },
      output: { type: Number }
    }
  },
  { timestamps: true, versionKey: false }
);

aiRequestSchema.index({ ownerId: 1, projectId: 1, createdAt: -1 });

export const AIRequest = model("AIRequest", aiRequestSchema);
