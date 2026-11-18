import type { RequestHandler } from "express";
import { User } from "../models/user.model.js";
import { verifyToken } from "../services/auth.service.js";
import { AppError } from "../utils/app-error.js";
import { asyncHandler } from "../utils/async-handler.js";

export const requireAuth: RequestHandler = asyncHandler(async (request, _response, next) => {
  const token = request.cookies?.nexus_token;
  if (typeof token !== "string" || token.length === 0) {
    throw new AppError(401, "Authentication required", "AUTHENTICATION_REQUIRED");
  }

  const claims = verifyToken(token);
  const user = await User.findById(claims.userId).select("+tokenVersion");
  if (!user || user.tokenVersion !== claims.tokenVersion) {
    throw new AppError(401, "Authentication session is invalid", "INVALID_SESSION");
  }
  request.user = { id: String(user._id), name: user.name, email: user.email };
  next();
});
