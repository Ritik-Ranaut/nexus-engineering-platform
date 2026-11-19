import { Schema, model } from "mongoose";

const projectSchema = new Schema(
  {
    ownerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 120
    },
    repositoryUrl: {
      type: String,
      trim: true,
      maxlength: 2048
    },
    indexingStatus: {
      type: String,
      enum: ["empty", "pending", "validating", "discovering", "cloning", "indexing", "analyzing", "ready", "failed", "cancelled"],
      default: "empty",
      required: true
    },
    indexingError: { type: String, maxlength: 500 },
    generationCounter: { type: Number, default: 0, required: true },
    activeGeneration: { type: Number, default: 0, required: true }
  },
  { timestamps: true, versionKey: false }
);

projectSchema.index({ ownerId: 1, createdAt: -1 });

export const Project = model("Project", projectSchema);
