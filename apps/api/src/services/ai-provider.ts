import { env } from "../config/env.js";
import { AppError } from "../utils/app-error.js";
import { OllamaProvider } from "./ollama-provider.js";
import type { AIProvider } from "./ai-provider.types.js";

const providers: Record<string, () => AIProvider> = {
  ollama: () => new OllamaProvider()
};

const createProvider = (): AIProvider => {
  const providerFactory = providers[env.AI_PROVIDER];
  if (!providerFactory) {
    throw new AppError(500, "The configured AI provider is not supported", "AI_PROVIDER_UNAVAILABLE");
  }
  return providerFactory();
};

export const aiProvider = createProvider();
