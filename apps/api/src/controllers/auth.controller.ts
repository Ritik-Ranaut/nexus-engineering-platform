import type { RequestHandler } from "express";
import { env } from "../config/env.js";
import { authService } from "../services/auth.service.js";
import { loginSchema, registrationSchema } from "../validators/auth.validators.js";
import { asyncHandler } from "../utils/async-handler.js";

const cookieOptions = () => ({
  httpOnly: true,
  secure: env.NODE_ENV === "production",
  sameSite: "strict" as const,
  maxAge: env.JWT_EXPIRES_IN_SECONDS * 1000,
  path: "/"
});

export const register: RequestHandler = asyncHandler(async (request, response) => {
  const input = registrationSchema.parse(request.body);
  const result = await authService.register(input);
  response.cookie("nexus_token", result.token, cookieOptions());
  response.status(201).json({ data: { user: result.user } });
});

export const login: RequestHandler = asyncHandler(async (request, response) => {
  const input = loginSchema.parse(request.body);
  const result = await authService.login(input);
  response.cookie("nexus_token", result.token, cookieOptions());
  response.status(200).json({ data: { user: result.user } });
});

export const getProfile: RequestHandler = asyncHandler(async (request, response) => {
  const user = await authService.getProfile(request.user!.id);
  response.status(200).json({ data: { user } });
});

export const logout: RequestHandler = asyncHandler(async (request, response) => {
  await authService.revokeSessions(request.user!.id);
  response.clearCookie("nexus_token", {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/"
  });
  response.status(204).end();
});
