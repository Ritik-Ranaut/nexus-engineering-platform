import { Schema, model } from "mongoose";

const projectArchitectureSchema = new Schema(
  {
    ownerId: { type: String, required: true },
    projectId: { type: String, required: true },
    generation: { type: Number, required: true },
    nodes: { type: [Schema.Types.Mixed], required: true, default: [] },
    relationships: { type: [Schema.Types.Mixed], required: true, default: [] },
    summary: { type: Schema.Types.Mixed, required: true, default: {} }
  },
  { timestamps: true, versionKey: false, collection: "project_architectures" }
);

projectArchitectureSchema.index(
  { ownerId: 1, projectId: 1, generation: 1 },
  { unique: true }
);

export const ProjectArchitecture = model("ProjectArchitecture", projectArchitectureSchema);
