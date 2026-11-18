import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { User } from "../models/user.model.js";
import { AppError } from "../utils/app-error.js";

const SALT_ROUNDS = 12;

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
  updatedAt: Date;
}

const toPublicUser = (user: {
  _id: unknown;
  name: string;
  email: string;
  createdAt: Date;
  updatedAt: Date;
}): PublicUser => ({
  id: String(user._id),
  name: user.name,
  email: user.email,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt
});

const createToken = (userId: string, tokenVersion: number): string =>
  jwt.sign({ ver: tokenVersion }, env.JWT_SECRET, {
    subject: userId,
    expiresIn: env.JWT_EXPIRES_IN_SECONDS,
    issuer: "nexus-api",
    audience: "nexus-web"
  });

export const authService = {
  async register(input: { name: string; email: string; password: string }) {
    const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);
    try {
      const user = await User.create({
        name: input.name,
        email: input.email,
        passwordHash
      });
      return {
        user: toPublicUser(user),
        token: createToken(String(user._id), user.tokenVersion)
      };
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === 11000) {
        throw new AppError(409, "An account with this email already exists", "EMAIL_IN_USE");
      }
      throw error;
    }
  },

  async login(input: { email: string; password: string }) {
    const user = await User.findOne({ email: input.email }).select("+passwordHash +tokenVersion");
    const passwordMatches = user
      ? await bcrypt.compare(input.password, user.passwordHash)
      : await bcrypt.compare(
          input.password,
          "$2a$12$BvAqD7ULvaw4oJ4DJDqlFe4rd5YZtQuVtYU6wXZZbY9EM81hC4Tkq"
        );
    if (!user || !passwordMatches) {
      throw new AppError(401, "Email or password is incorrect", "INVALID_CREDENTIALS");
    }
    return {
      user: toPublicUser(user),
      token: createToken(String(user._id), user.tokenVersion)
    };
  },

  async getProfile(userId: string): Promise<PublicUser> {
    const user = await User.findById(userId);
    if (!user) {
      throw new AppError(401, "Authentication is no longer valid", "INVALID_SESSION");
    }
    return toPublicUser(user);
  },

  async revokeSessions(userId: string): Promise<void> {
    const result = await User.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } });
    if (result.matchedCount !== 1) {
      throw new AppError(401, "Authentication is no longer valid", "INVALID_SESSION");
    }
  }
};

export const verifyToken = (token: string): { userId: string; tokenVersion: number } => {
  let payload: string | jwt.JwtPayload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET, {
      issuer: "nexus-api",
      audience: "nexus-web"
    });
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new AppError(401, "Authentication token has expired", "TOKEN_EXPIRED");
    }
    if (error instanceof jwt.JsonWebTokenError) {
      throw new AppError(401, "Invalid authentication token", "INVALID_TOKEN");
    }
    throw error;
  }
  if (
    typeof payload === "string" ||
    typeof payload.sub !== "string" ||
    typeof payload.ver !== "number"
  ) {
    throw new AppError(401, "Invalid authentication token", "INVALID_TOKEN");
  }
  return { userId: payload.sub, tokenVersion: payload.ver };
};
