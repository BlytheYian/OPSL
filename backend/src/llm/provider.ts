
export interface LLMCompleteOptions {
  jsonSchema?: object;
  images?: string[];
}

export interface LLMProvider {
  complete(systemPrompt: string, userPrompt: string, options?: LLMCompleteOptions): Promise<string>;
}
