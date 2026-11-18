import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import jwt from "jsonwebtoken";
import request from "supertest";
import { createApp } from "../src/app.js";
import { env } from "../src/config/env.js";
import { User } from "../src/models/user.model.js";

const app = createApp();
let database: MongoMemoryServer;

beforeAll(async () => {
  database = await MongoMemoryServer.create();
  await mongoose.connect(database.getUri());
});

afterEach(async () => {
  await User.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await database.stop();
});

describe("authentication API", () => {
  it("registers a user, hashes their password, and returns no credential fields", async () => {
    const response = await request(app).post("/api/auth/register").send({
      name: "Ada Lovelace",
      email: "Ada@Example.com",
      password: "correct-horse-battery"
    });

    expect(response.status).toBe(201);
    expect(response.body.data.user.email).toBe("ada@example.com");
    expect(response.body.data.user).not.toHaveProperty("passwordHash");
    expect(response.body.data.user).not.toHaveProperty("password");
    expect(response.body).not.toHaveProperty("token");
    expect(response.headers["set-cookie"][0]).toContain("HttpOnly");

    const stored = await User.findOne({ email: "ada@example.com" }).select("+passwordHash");
    expect(stored?.passwordHash).not.toBe("correct-horse-battery");
  });

  it("rejects duplicate email addresses", async () => {
    const input = {
      name: "Ada Lovelace",
      email: "ada@example.com",
      password: "correct-horse-battery"
    };
    await request(app).post("/api/auth/register").send(input).expect(201);
    const response = await request(app).post("/api/auth/register").send(input).expect(409);
    expect(response.body.error.code).toBe("EMAIL_IN_USE");
  });

  it("validates registration input", async () => {
    const response = await request(app).post("/api/auth/register").send({
      name: "A",
      email: "not-an-email",
      password: "short"
    }).expect(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects invalid credentials", async () => {
    const response = await request(app).post("/api/auth/login").send({
      email: "missing@example.com",
      password: "wrong-password"
    }).expect(401);
    expect(response.body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it("logs in with valid credentials and establishes an HTTP-only session cookie", async () => {
    const credentials = {
      name: "Ada Lovelace",
      email: "ada@example.com",
      password: "correct-horse-battery"
    };
    await request(app).post("/api/auth/register").send(credentials).expect(201);
    const response = await request(app).post("/api/auth/login").send({
      email: "ADA@example.com",
      password: credentials.password
    }).expect(200);
    expect(response.body.data.user.email).toBe(credentials.email);
    expect(response.headers["set-cookie"][0]).toContain("HttpOnly");
    expect(response.body.data.user).not.toHaveProperty("passwordHash");
  });

  it("requires a token for protected profile routes", async () => {
    const response = await request(app).get("/api/auth/me").expect(401);
    expect(response.body.error.code).toBe("AUTHENTICATION_REQUIRED");
  });

  it("rejects invalid and expired tokens", async () => {
    const invalid = await request(app).get("/api/auth/me")
      .set("Cookie", "nexus_token=not-a-jwt").expect(401);
    expect(invalid.body.error.code).toBe("INVALID_TOKEN");
    const registered = await request(app).post("/api/auth/register").send({
      name: "Ada Lovelace",
      email: "ada@example.com",
      password: "correct-horse-battery"
    }).expect(201);
    const token = jwt.sign({ ver: 0 }, env.JWT_SECRET, {
      subject: registered.body.data.user.id,
      expiresIn: -1,
      issuer: "nexus-api",
      audience: "nexus-web"
    });
    const response = await request(app).get("/api/auth/me")
      .set("Cookie", `nexus_token=${token}`)
      .expect(401);
    expect(response.body.error.code).toBe("TOKEN_EXPIRED");
  });

  it("returns the profile for a valid session and revokes it on logout", async () => {
    const agent = request.agent(app);
    const registration = await agent.post("/api/auth/register").send({
      name: "Ada Lovelace",
      email: "ada@example.com",
      password: "correct-horse-battery"
    }).expect(201);

    const profile = await agent.get("/api/auth/me").expect(200);
    expect(profile.body.data.user.id).toBe(registration.body.data.user.id);
    expect(profile.body.data.user).not.toHaveProperty("passwordHash");

    await agent.post("/api/auth/logout").expect(204);
    await agent.get("/api/auth/me").expect(401);
  });
});
