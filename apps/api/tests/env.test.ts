import { describe, expect, it } from "vitest";
import { parseEnvironment } from "../src/config/env.js";

describe("AI environment configuration", () => {
  const validEnvironment = {
    NODE_ENV: "test",
    MONGODB_URI: "mongodb://127.0.0.1:27017/nexus",
    JWT_SECRET: "test-secret-for-nexus-auth-at-least-32-characters",
    OLLAMA_BASE_URL: "http://127.0.0.1:11434",
    LLM_MODEL: "config-chat-model",
    EMBEDDING_MODEL: "config-embedding-model"
  };

  it("accepts generic model variable names and maps them to configured models", () => {
    const parsed = parseEnvironment(validEnvironment);
    expect(parsed).toMatchObject({
      AI_PROVIDER: "ollama",
      OLLAMA_CHAT_MODEL: "config-chat-model",
      OLLAMA_EMBEDDING_MODEL: "config-embedding-model"
    });
  });

  it("rejects invalid URLs and missing model configuration", () => {
    expect(() => parseEnvironment({
      ...validEnvironment,
      OLLAMA_BASE_URL: "file:///tmp/ollama"
    })).toThrow();
    expect(() => parseEnvironment({
      ...validEnvironment,
      LLM_MODEL: undefined
    })).toThrow();
    expect(() => parseEnvironment({
      ...validEnvironment,
      AI_PROVIDER: "other"
    })).toThrow();
  });

  it("prefers generic model names over legacy Ollama-specific variables", () => {
    const parsed = parseEnvironment({
      ...validEnvironment,
      OLLAMA_CHAT_MODEL: "legacy-chat",
      OLLAMA_EMBEDDING_MODEL: "legacy-embedding"
    });
    expect(parsed.OLLAMA_CHAT_MODEL).toBe("config-chat-model");
    expect(parsed.OLLAMA_EMBEDDING_MODEL).toBe("config-embedding-model");
  });
});
