import type { LLMProvider } from "./provider";
import { OllamaProvider } from "./ollamaProvider";

export type { LLMProvider } from "./provider";

let cached: LLMProvider | null = null;

export function getLLMProvider(): LLMProvider {
  if (cached) return cached;
  const kind = process.env.LLM_PROVIDER || "ollama";
  switch (kind) {
    case "ollama":
      cached = new OllamaProvider();
      break;
    default:
      throw new Error(`未知的 LLM_PROVIDER: ${kind}`);
  }
  return cached;
}
