import Anthropic from "@anthropic-ai/sdk";
import type { LLMCompleteOptions, LLMProvider } from "./provider";

/** Claude API(Anthropic)。clip/matchInstances.ts 的 selectFinalInstances() 固定用這個(不受
 * LLM_PROVIDER 影響)——那一步要在候選清單裡做多步驟數值比較+關係推理(誰最近、誰最左、先分組
 * 再挑方向這類),實測本機小模型(gemma4:E4B)在沒有思維鏈的情況下數值推理不夠可靠,換一顆規模
 * 大很多的模型直接解決可靠度問題。其餘階段(切分/代稱覆核/CLIP 描述詞翻譯/語意轉換)預設走
 * 免費的本機 Ollama,設定 LLM_PROVIDER=claude 可以整批換成這個 provider。
 *
 * 用 tool use(強制呼叫單一工具、工具的 input_schema 就是我們要的 JSON Schema)取代
 * Ollama 那種「format 傳 JSON Schema 走文法約束解碼」的做法——這是 Claude API 對應的標準
 * 結構化輸出手法,保證回傳的 tool_use.input 符合我們要的形狀。 */
export class AnthropicProvider implements LLMProvider {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("缺少 ANTHROPIC_API_KEY 環境變數,無法呼叫 Claude API");
    this.client = new Anthropic({ apiKey });
    this.model = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
  }

  async complete(systemPrompt: string, userPrompt: string, options?: LLMCompleteOptions): Promise<string> {
    const content: Anthropic.Messages.ContentBlockParam[] = [];
    // 圖片(base64,不含 data URL 前綴)——跟 Ollama 那邊同一種輸入格式,目前只有視覺定位階段
    // (舊的 identifyInstances,不是 CLIP 這條路徑)會傳,這裡先支援起來,以防之後也想切過來。
    if (options?.images) {
      for (const image of options.images) {
        content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } });
      }
    }
    content.push({ type: "text", text: userPrompt });

    if (options?.jsonSchema) {
      const toolName = "respond";
      const rawSchema = options.jsonSchema as Record<string, unknown>;
      // Claude 的 tool input_schema 硬性要求頂層 type 必須是 "object"(工具呼叫本來就是「具名參數」
      // 的概念),但我們有些 schema(例如 VISION_JSON_SCHEMA)頂層是 array——Ollama 的文法約束
      // 解碼不管這個限制,直接把 array schema 當 format 傳就能用,Claude 這邊會回 400。頂層是
      // array 時包一層 {items: [...]},呼叫方拿到的 JSON 字串解開後跟原本 schema 形狀一致。
      const isArraySchema = rawSchema.type === "array";
      const inputSchema = isArraySchema
        ? { type: "object", properties: { items: rawSchema }, required: ["items"] }
        : rawSchema;

      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: "user", content }],
        tools: [
          {
            name: toolName,
            description: "回傳符合指定格式的結構化回應",
            input_schema: inputSchema as Anthropic.Messages.Tool.InputSchema,
          },
        ],
        tool_choice: { type: "tool", name: toolName },
      });
      const toolUse = response.content.find((block) => block.type === "tool_use");
      if (!toolUse || toolUse.type !== "tool_use") {
        throw new Error("Claude 沒有回傳預期的工具呼叫結果");
      }
      const output = isArraySchema ? (toolUse.input as { items: unknown }).items : toolUse.input;
      return JSON.stringify(output);
    }

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content }],
    });
    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text") throw new Error("Claude 沒有回傳文字內容");
    return textBlock.text;
  }
}
