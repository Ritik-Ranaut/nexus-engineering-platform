import { Schema, model } from "mongoose";

const codeChunkSchema = new Schema(
  {
    ownerId: { type: String, required: true },
    projectId: { type: String, required: true },
    generation: { type: Number, required: true },
    fileId: { type: String, required: true },
    filePath: { type: String, required: true },
    chunkId: { type: String, required: true },
    language: { type: String, required: true },
    symbolContext: { type: String, required: true },
    lineStart: { type: Number, required: true },
    lineEnd: { type: Number, required: true },
    startLine: { type: Number, required: true },
    endLine: { type: Number, required: true },
    content: { type: String, required: true },
    embedding: { type: [Number], required: true, select: false },
    metadata: {
      type: Schema.Types.Mixed,
      required: true,
      default: {}
    }
  },
  { timestamps: true, versionKey: false, collection: "code_chunks" }
);

codeChunkSchema.index({ ownerId: 1, projectId: 1, generation: 1 });
codeChunkSchema.index({ projectId: 1, filePath: 1, generation: 1 });
codeChunkSchema.index({ ownerId: 1, projectId: 1, generation: 1, fileId: 1 });
codeChunkSchema.index({ ownerId: 1, projectId: 1, generation: 1, chunkId: 1 }, { unique: true });

export const CodeChunk = model("CodeChunk", codeChunkSchema);
