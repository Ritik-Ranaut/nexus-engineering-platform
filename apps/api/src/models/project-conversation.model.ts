import { Schema, model } from "mongoose";

const projectConversationSchema = new Schema(
  {
    ownerId: { type: String, required: true, index: true },
    projectId: { type: String, required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    lastMessageAt: { type: Date, required: true, default: Date.now }
  },
  { timestamps: true, versionKey: false, collection: "project_conversations" }
);

projectConversationSchema.index({ ownerId: 1, projectId: 1, lastMessageAt: -1 });

export const ProjectConversation = model("ProjectConversation", projectConversationSchema);
