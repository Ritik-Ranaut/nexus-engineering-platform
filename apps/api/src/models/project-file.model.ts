import { Schema, model } from "mongoose";

const projectFileSchema = new Schema(
  {
    ownerId: { type: String, required: true },
    projectId: { type: String, required: true },
    generation: { type: Number, required: true },
    fileId: { type: String, required: true },
    filePath: { type: String, required: true },
    content: { type: String, required: true },
    language: { type: String, required: true },
    category: { type: String, required: true },
    lineCount: { type: Number, required: true },
    sizeBytes: { type: Number, required: true },
    contentHash: { type: String, required: true },
    imports: { type: [String], required: true, default: [] },
    symbols: { type: [String], required: true, default: [] }
  },
  { timestamps: true, versionKey: false, collection: "project_files" }
);

projectFileSchema.index(
  { ownerId: 1, projectId: 1, generation: 1, fileId: 1 },
  { unique: true }
);

export const ProjectFile = model("ProjectFile", projectFileSchema);
