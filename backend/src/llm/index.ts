import type { LLMProvider } from "./provider";
import { OllamaProvider } from "./ollamaProvider";
import { AnthropicProvider } from "./anthropicProvider";

export type { LLMProvider } from "./provider";

let cached: LLMProvider | null = null;

export function getLLMProvider(): LLMProvider {
  if (cached) return cached;
  const kind = process.env.LLM_PROVIDER || "ollama";
  switch (kind) {
    case "ollama":
      cached = new OllamaProvider();
      break;
    case "claude":
      cached = new AnthropicProvider();
      break;
    default:
      throw new Error(`未知的 LLM_PROVIDER: ${kind}`);
  }
  return cached;
}
