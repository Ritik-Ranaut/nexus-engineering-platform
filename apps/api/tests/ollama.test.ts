import { afterEach, describe, expect, it, vi } from "vitest";
import { checkOllamaHealth } from "../src/services/ollama.service.js";

describe("Ollama model availability", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("distinguishes an installed chat model from an embedding-capable model", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        models: [{ name: "test-chat-model:latest" }, { name: "test-embedding-model:latest" }]
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        capabilities: ["embedding"]
      }), { status: 200 })));

    await expect(checkOllamaHealth()).resolves.toEqual({
      provider: "ollama",
      connected: true,
      chatModel: { name: "test-chat-model", available: true },
      embeddingModel: { name: "test-embedding-model", available: true, capable: true }
    });
  });

  it("does not mistake an installed chat-only model for an embedding model", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        models: [{ name: "test-chat-model:latest" }]
      }), { status: 200 })));

    await expect(checkOllamaHealth()).resolves.toEqual({
      provider: "ollama",
      connected: true,
      chatModel: { name: "test-chat-model", available: true },
      embeddingModel: { name: "test-embedding-model", available: false, capable: false }
    });
  });

  it("reports embedding models that are installed but lack embedding capability", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        models: [{ name: "test-chat-model:latest" }, { name: "test-embedding-model:latest" }]
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        capabilities: ["completion"]
      }), { status: 200 })));

    await expect(checkOllamaHealth()).resolves.toMatchObject({
      connected: true,
      embeddingModel: { available: true, capable: false }
    });
  });

  it("surfaces connectivity failure to the caller", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(checkOllamaHealth()).rejects.toThrow("offline");
  });
});
