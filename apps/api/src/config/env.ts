import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  MONGODB_URI: z.string().min(1),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_EXPIRES_IN_SECONDS: z.coerce.number().int().positive().max(86_400).default(900),
  WEB_ORIGIN: z.string().url().default("http://localhost:5173"),
  AI_PROVIDER: z.enum(["ollama"]).default("ollama"),
  OLLAMA_BASE_URL: z.string().url().refine((value) =>
    /^https?:\/\//i.test(value),
    "OLLAMA_BASE_URL must use HTTP or HTTPS"
  ),
  OLLAMA_CHAT_MODEL: z.string().trim().min(1),
  OLLAMA_EMBEDDING_MODEL: z.string().trim().min(1),
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().max(300_000).default(60_000),
  AI_CHAT_RETRIES: z.coerce.number().int().min(0).max(5).default(1),
  AI_EMBEDDING_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  AI_VECTOR_DIMENSIONS: z.coerce.number().int().positive().default(768),
  AI_VECTOR_INDEX_NAME: z.string().min(1).default("nexus_code_chunks"),
  AI_RETRIEVAL_TOP_K: z.coerce.number().int().min(1).max(20).default(5),
  AGENT_ANALYSIS_TIMEOUT_MS: z.coerce.number().int().positive().max(600_000).default(240_000)
});

export const parseEnvironment = (source: NodeJS.ProcessEnv) => envSchema.parse({
  ...source,
  OLLAMA_CHAT_MODEL: source.LLM_MODEL ?? source.OLLAMA_CHAT_MODEL,
  OLLAMA_EMBEDDING_MODEL: source.EMBEDDING_MODEL ?? source.OLLAMA_EMBEDDING_MODEL
});

export const env = parseEnvironment(process.env);
