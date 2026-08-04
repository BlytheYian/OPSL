import type { LLMCompleteOptions, LLMProvider } from "./provider";

export class OllamaProvider implements LLMProvider {
  constructor(
    private readonly baseUrl = process.env.OLLAMA_URL || "http://localhost:11434",
    private readonly model = process.env.OLLAMA_MODEL || "gemma4:E4B"
  ) {}

  async complete(systemPrompt: string, userPrompt: string, options?: LLMCompleteOptions): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: userPrompt,
            ...(options?.images ? { images: options.images } : {}),
          },
        ],
        format: options?.jsonSchema ?? "json",
        stream: false,
        options: { temperature: 0.2 },
      }),
    });
    if (!res.ok) {
      throw new Error(`Ollama 回應失敗(${res.status})——確認 Ollama 服務有在跑、模型已經 pull 過`);
    }
    const data = (await res.json()) as { message?: { content?: string } };
    const content = data.message?.content;
    if (!content) throw new Error("Ollama 回應沒有內容");
    return content;
  }
}
