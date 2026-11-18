import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/ai-provider.js", () => ({
  aiProvider: {
    name: "test-provider",
    createChatModel: vi.fn(),
    createEmbeddingModel: vi.fn(),
    checkHealth: vi.fn()
  }
}));

import { aiProvider } from "../src/services/ai-provider.js";
import { embedText, generateText, invokeWithRetry } from "../src/services/ai.service.js";

describe("reusable AI service", () => {
  afterEach(() => vi.clearAllMocks());

  it("generates text with the configured provider and retries transient failures", async () => {
    const invoke = vi.fn()
      .mockRejectedValueOnce(new Error("temporary model failure"))
      .mockResolvedValueOnce({ content: "Local model response" });
    vi.mocked(aiProvider.createChatModel).mockReturnValue({ invoke } as never);

    await expect(generateText("Explain this source")).resolves.toBe("Local model response");
    expect(aiProvider.createChatModel).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("generates validated embeddings through the configured provider", async () => {
    const embedQuery = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);
    vi.mocked(aiProvider.createEmbeddingModel).mockReturnValue({ embedQuery } as never);
    await expect(embedText("embedding input")).resolves.toEqual([0.1, 0.2, 0.3]);
    expect(embedQuery).toHaveBeenCalledWith("embedding input");
  });

  it("maps exhausted model failures to a service-unavailable error", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(invokeWithRetry(
      () => Promise.reject(new Error("model offline")),
      undefined,
      0
    )).rejects.toMatchObject({ statusCode: 503, code: "AI_GENERATION_FAILED" });
    warning.mockRestore();
  });

  it("maps provider timeouts to a gateway timeout error", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const timeout = new DOMException("The operation timed out", "TimeoutError");
    await expect(invokeWithRetry(
      () => Promise.reject(timeout),
      undefined,
      0
    )).rejects.toMatchObject({ statusCode: 504, code: "AI_TIMEOUT" });
    warning.mockRestore();
  });

  it("retries a stream only when the provider fails before emitting content", async () => {
    const stream = vi.fn()
      .mockRejectedValueOnce(new Error("temporary stream failure"))
      .mockResolvedValueOnce((async function* () {
        yield { content: "ready" };
      })());
    vi.mocked(aiProvider.createChatModel).mockReturnValue({ stream } as never);
    const { streamChat } = await import("../src/services/ai.service.js");
    const content: string[] = [];
    for await (const chunk of streamChat([])) content.push(String(chunk.content));
    expect(content).toEqual(["ready"]);
    expect(stream).toHaveBeenCalledTimes(2);
  });
});
