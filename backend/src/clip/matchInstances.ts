import { AutoTokenizer, CLIPTextModelWithProjection } from "@huggingface/transformers";
import { pool } from "../db";
import { getLLMProvider } from "../llm/index";
import { AnthropicProvider } from "../llm/anthropicProvider";
import type { LLMProvider } from "../llm/provider";
import type { VisibleInstance, PreviousEditContext } from "../llm/editCommand";



const CLIP_MODEL = "Xenova/clip-vit-base-patch32";

let tokenizerPromise: ReturnType<typeof AutoTokenizer.from_pretrained> | null = null;
let textModelPromise: ReturnType<typeof CLIPTextModelWithProjection.from_pretrained> | null = null;


async function getClipTextModel() {
  if (!tokenizerPromise) tokenizerPromise = AutoTokenizer.from_pretrained(CLIP_MODEL);
  if (!textModelPromise) textModelPromise = CLIPTextModelWithProjection.from_pretrained(CLIP_MODEL, { dtype: "fp32" });
  const [tokenizer, textModel] = await Promise.all([tokenizerPromise, textModelPromise]);
  return { tokenizer, textModel };
}

async function embedText(text: string): Promise<number[]> {
  const { tokenizer, textModel } = await getClipTextModel();
  const inputs = tokenizer([text], { padding: true, truncation: true });
  const { text_embeds } = await textModel(inputs);
  return Array.from(text_embeds.data as Float32Array);
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const COLOR_NAME_TO_HEX: Record<string, string> = {
  red: "#cc3333",
  blue: "#3366cc",
  yellow: "#e0c030",
  brown: "#a97c50",
  wood: "#a97c50",
  green: "#3a8c4a",
  white: "#f2f2f2",
  black: "#222222",
  gray: "#888888",
  grey: "#888888",
  orange: "#e08030",
  purple: "#8855aa",
  pink: "#e0a0b0",
};

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  return [parseInt(clean.slice(0, 2), 16), parseInt(clean.slice(2, 4), 16), parseInt(clean.slice(4, 6), 16)];
}

function colorSimilarity(hexA: string, hexB: string): number {
  const [r1, g1, b1] = hexToRgb(hexA);
  const [r2, g2, b2] = hexToRgb(hexB);
  const dist = Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
  const maxDist = Math.sqrt(255 ** 2 * 3);
  return 1 - dist / maxDist;
}

const DESCRIPTOR_SYSTEM_PROMPT = `你在幫忙把中文的物件描述轉換成搜尋用的英文詞,給 CLIP 圖文比對用。

- typeQuery:物件的類型/形狀,翻成幾個簡短的英文單字,不要包含顏色(例如「紅色的花瓶」→
  "vase"、「有靠背的椅子」→ "chair with backrest")。如果句子是「A 的左邊/旁邊那個 B」這種
  結構(A 是另一個參考物件,B 才是真正要選的目標),只翻譯 B 的類型,不要翻 A(例如「剛剛改的
  椅子左邊的桌子」→ "table",不是 "chair")。如果句子是「把 A 換成 B」「A 換一個 B 好了」這種
  替換結構(A 是場景裡現有、要被換掉的物件,B 是使用者想換成的新描述,場景裡通常根本沒有 B 這個
  東西),要在畫面裡找的是 A,只翻譯 A 的類型,不要翻 B(例如「把桌上的花換成盤子」→ "flower",
  不是 "plate";「把單人沙發換成雙人沙發」→ "sofa",不是 "double sofa")。如果句子描述的完全
  不是外觀/類型(例如「所有改變顏色的物件」這種在講修改歷史狀態的描述),填一個通用詞 "object"
  即可。
- colorName:使用者描述裡如果有提到「目標物件」**目前/現在**的顏色(不是想改成的目標顏色,也
  不是參考物件的顏色),翻成一個英文顏色單字(red/blue/yellow/brown/green/white/black/gray/
  orange/purple/pink 這幾個裡面選最接近的一個)。這個欄位是用來從場景裡「認出」是哪個物件的,
  不是要改成的新顏色。指令若是「把 A 從 X 色改成 Y 色」「A 現在是 X 色,想改成 Y 色」這種同時
  描述目前顏色+目標顏色的句型,X 才是這裡要填的(現在的顏色,用來認物件),不要填 Y(想改成的
  目標顏色,那是給調整動作用的,跟這裡無關)——例如「把椅子從黑色改成白色」填 "black",不是
  "white"。沒有提到目前顏色就是 null。

回傳一個 JSON 物件:{"typeQuery": "...", "colorName": "..." 或 null}`;

const DESCRIPTOR_JSON_SCHEMA = {
  type: "object",
  properties: {
    typeQuery: { type: "string" },
    colorName: { type: ["string", "null"] },
  },
  required: ["typeQuery", "colorName"],
};

interface Descriptor {
  typeQuery: string;
  colorName: string | null;
}

function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return match ? match[1] : trimmed;
}

export async function extractDescriptor(command: string): Promise<Descriptor> {
  const provider = getLLMProvider();
  const userPrompt = `使用者描述:「${command}」\n\n請回傳符合說明格式的 JSON。`;
  const raw = await provider.complete(DESCRIPTOR_SYSTEM_PROMPT, userPrompt, { jsonSchema: DESCRIPTOR_JSON_SCHEMA });
  const parsed = JSON.parse(stripCodeFence(raw)) as Partial<Descriptor>;
  return { typeQuery: parsed.typeQuery ?? "object", colorName: parsed.colorName ?? null };
}

export async function findReplacementModel(query: string): Promise<{ id: string; name: string } | null> {
  const descriptor = await extractDescriptor(query);
  const searchText = descriptor.colorName ? `${descriptor.colorName} ${descriptor.typeQuery}` : descriptor.typeQuery;
  const queryEmbed = await embedText(searchText);

  const rows = await pool.query(`SELECT id, name, clip_embedding FROM library_objects WHERE clip_embedding IS NOT NULL`);
  let best: { id: string; name: string; score: number } | null = null;
  for (const row of rows.rows) {
    const score = cosineSimilarity(queryEmbed, row.clip_embedding);
    if (!best || score > best.score) best = { id: row.id, name: row.name, score };
  }
  return best ? { id: best.id, name: best.name } : null;
}

interface ScoredCandidate {
  id: string;
  label: string;
  x: number;
  y: number;
  distance: number;
  color: string | null;
  score: number;
}

async function scoreCandidates(visible: VisibleInstance[], descriptor: Descriptor): Promise<ScoredCandidate[]> {
  const typeOnlyEmbed = await embedText(descriptor.typeQuery);
  const withColorEmbed = descriptor.colorName
    ? await embedText(`${descriptor.colorName} ${descriptor.typeQuery}`)
    : typeOnlyEmbed;

  const modelIds = [...new Set(visible.map((v) => v.modelId))];
  const embeddingRows = await pool.query(
    `SELECT id, clip_embedding FROM library_objects WHERE id = ANY($1) AND clip_embedding IS NOT NULL`,
    [modelIds]
  );
  const embeddingByModelId = new Map<string, number[]>(embeddingRows.rows.map((r) => [r.id, r.clip_embedding]));

  return visible
    .map((inst) => {
      const modelEmbed = embeddingByModelId.get(inst.modelId);
      if (!modelEmbed) return null; 

      const hasRuntimeColor = !!inst.color;
      const clipScore = cosineSimilarity(hasRuntimeColor ? typeOnlyEmbed : withColorEmbed, modelEmbed);

      let score = clipScore;
      if (hasRuntimeColor && descriptor.colorName && inst.color) {
        const targetHex = COLOR_NAME_TO_HEX[descriptor.colorName];
        if (targetHex) {
          const colorSim = colorSimilarity(inst.color, targetHex);
          score = clipScore * 0.9 + colorSim * 0.1;
        }
      }

      return { id: inst.id, label: inst.label, x: inst.x, y: inst.y, distance: inst.distance, color: inst.color, score };
    })
    .filter((v): v is ScoredCandidate => v !== null)
    .sort((a, b) => b.score - a.score);
}

const FINAL_SELECT_SYSTEM_PROMPT = `你在查一份資料庫紀錄,不是在看照片辨識物件——下面會給你一份
JSON 陣列,每個元素是場景裡一個「目前看得到的物件副本」的紀錄(id/物件類型/螢幕座標/有沒有被
染色/CLIP 相似度分數),以及使用者用中文下的一句指令。你要判斷指令指的是哪個/哪些紀錄,回傳
它們的 id。

每筆紀錄的欄位:
- id:紀錄的識別碼,回傳時要用這個。
- label:這個物件的類型(例如 "chair"、"wine")。
- x:螢幕上的水平位置,0 是最左、1000 是最右(不是世界座標,是使用者當下看到的畫面位置)。
- y:螢幕上的垂直位置,0 是最上、1000 是最下。
- distance:跟使用者(鏡頭)的距離(世界座標單位,數字越小代表離使用者越近/越前面)。
- distanceRank:這筆紀錄依 distance 排序,在**全部候選裡**排第幾近(1 = 全部候選裡離使用者
  最近的那一筆)。判斷「離我近/最近/前面的」時,**直接比這個排名數字**,不要自己去比較原始
  distance 數值大小——候選常常有幾十筆,自己心算容易比錯,這個欄位已經幫你排好名次了。
- xRankFromLeft:這筆紀錄依 x 排序,在**全部候選裡**排第幾左(1 = 全部候選裡螢幕上最左邊的
  那一筆)。判斷「左邊/最左/左數第 N 個」時,同樣直接比這個排名數字,不要自己比較原始 x 座標。
- hasCustomColor:這個物件有沒有被之前的指令染過色(true/false)。
- customColorHex:如果被染過色,目前是什麼顏色(十六進位色碼);沒被染色就是 null。
- clipScore:這個物件的類型/外觀跟使用者描述的相似度分數——這批分數天生落在很窄的範圍
  (實際大約 0.15~0.30 之間,不是想像中 0~1 那種大範圍量表),0.23 這種數字在這個範圍裡已經算
  相對高分,不要因為數字看起來「不到 0.5」就以為沒有合適的候選、乾脆整批放棄。只是參考訊號,
  不是絕對標準,分數接近的候選都可能是對的,不要只看分數排序的第一名就決定,還要結合座標/
  染色狀態/指令的實際語意判斷。清單裡通常會有一個相對最符合的候選,除非指令描述的東西
  (例如某個特定顏色/材質)在清單裡全部候選都完全對不上,否則不要回傳空陣列。

判斷規則:
- **預設只選一筆**——只有指令裡真的出現「所有/全部/每一/都/通通」這類全稱語氣字眼,才回傳
  所有符合類型(+顏色)描述的紀錄的 id。指令裡沒有這類字眼,就算候選清單裡同一種類型有好幾筆
  紀錄,也只回傳語意上最符合的**一筆**——不要因為候選有好幾筆長得像,就自己腦補成使用者要選
  全部。例如候選清單裡有三筆 chair,指令只是「椅子」(沒有「都」「所有」),要回傳的是這三筆
  裡最符合的一筆,不是三筆全部。
- 提到「左邊/右邊」(使用者看到的左右,不是物件朝向):在符合類型的候選裡,挑 xRankFromLeft
  最小(最左)或最大(最右)的那一筆。「左數第 N 個」:在符合類型的候選裡,依 xRankFromLeft
  由小到大排序,挑第 N 個。
- 提到「離我近的/最近的」「前面的」:在符合類型的候選裡,挑 distanceRank 最小的那一筆。提到
  「靠近我這側中間的」這類複合描述:同時考慮 distanceRank 小、x 接近 500 兩個條件,挑綜合起來
  最符合的那一筆。
- 提到「那排/那一群/那幾個」+ 距離描述(例如「離我近那排椅子」):不是字面上唯一一個最近的,
  是指距離(distance)明顯聚在一起、比其他同類型候選近很多的一小群——先在符合類型的候選裡,
  依 distance 由小到大排序,找出數值上明顯聚在一起的那一群(例如前面幾筆彼此 distance 相差不到
  1,但比再下一筆小很多),當作「那一排」,再依其他描述(例如「左數第一把」)在這群裡面繼續
  篩選。
- 描述的是「哪些物件被改過顏色」這種狀態(不是外觀類型):忽略 clipScore/typeQuery,直接找
  hasCustomColor 為 true 的紀錄。
- 句子是「A 的左邊/旁邊那個 B」這種結構:A 是參考物件,先用「上一輪操作對象」(如果有提供)或
  候選清單裡描述符合 A 的紀錄定位出 A 的座標,再從符合 B 描述的候選裡,依 A 的座標挑方向正確、
  離 A 最近的那一筆當作答案——最終要回傳的是 B,不是 A。
- 句子是「把 A 換成 B」「A 換一個 B 好了」這種替換結構:要選的是符合 A 描述的紀錄(場景裡現有、
  要被換掉的東西),不是 B——B 是使用者想換成的新描述,候選清單裡通常根本沒有這個東西,不要因為
  指令裡出現 B 這個詞,就去找長得像 B 的紀錄。
- 找不到任何符合的紀錄:回傳空陣列。

回傳一個 JSON 物件:{"selectedIds": ["...", ...]}`;

const FINAL_SELECT_JSON_SCHEMA = {
  type: "object",
  properties: {
    selectedIds: { type: "array", items: { type: "string" } },
  },
  required: ["selectedIds"],
};

interface MatchedInstance {
  id: string;
  label: string;
}

let finalSelectProvider: LLMProvider | null = null;
function getFinalSelectProvider(): LLMProvider {
  if (!finalSelectProvider) finalSelectProvider = new AnthropicProvider();
  return finalSelectProvider;
}

async function selectFinalInstances(
  command: string,
  candidates: ScoredCandidate[],
  previousContext: PreviousEditContext | null
): Promise<MatchedInstance[]> {
  const byDistance = [...candidates].sort((a, b) => a.distance - b.distance);
  const distanceRank = new Map(byDistance.map((c, i) => [c.id, i + 1]));
  const byX = [...candidates].sort((a, b) => a.x - b.x);
  const xRank = new Map(byX.map((c, i) => [c.id, i + 1]));

  const records = candidates.map((c) => ({
    id: c.id,
    label: c.label,
    x: Math.round(c.x),
    y: Math.round(c.y),
    distance: Number(c.distance.toFixed(2)),
    distanceRank: distanceRank.get(c.id),
    xRankFromLeft: xRank.get(c.id), 
    hasCustomColor: c.color !== null,
    customColorHex: c.color,
    clipScore: Number(c.score.toFixed(3)),
  }));
  // eslint-disable-next-line no-console
  console.log("[clip match] pool=" + JSON.stringify(records));

  const previousNote = previousContext?.instances.length
    ? `\n\n上一輪操作對象(如果指令用「剛剛」「之前」這類說法指這個,就是它):${JSON.stringify(
        previousContext.instances
      )}`
    : "";

  const userPrompt =
    `資料紀錄:${JSON.stringify(records)}\n\n使用者指令:「${command}」${previousNote}` +
    `\n\n請回傳符合說明格式的 JSON。`;

  const provider = getFinalSelectProvider();
  const raw = await provider.complete(FINAL_SELECT_SYSTEM_PROMPT, userPrompt, {
    jsonSchema: FINAL_SELECT_JSON_SCHEMA,
  });
  const parsed = JSON.parse(stripCodeFence(raw)) as { selectedIds?: string[] };
  const selectedIds = new Set(parsed.selectedIds ?? []);
  return candidates.filter((c) => selectedIds.has(c.id)).map((c) => ({ id: c.id, label: c.label }));
}

export async function identifyInstancesClip(
  command: string,
  visible: VisibleInstance[],
  previousContext: PreviousEditContext | null
): Promise<MatchedInstance[]> {
  if (visible.length === 0) throw new Error("目前畫面上看不到任何物件");

  console.log(
    "[clip match] command=" + JSON.stringify(command) + " visible=" +
      JSON.stringify(
        visible.map((v) => ({
          id: v.id,
          label: v.label,
          x: Math.round(v.x),
          y: Math.round(v.y),
          distance: Number(v.distance.toFixed(2)),
          color: v.color,
        }))
      )
  );

  const descriptor = await extractDescriptor(command);
  // eslint-disable-next-line no-console
  console.log("[clip match] descriptor=" + JSON.stringify(descriptor));

  const scored = await scoreCandidates(visible, descriptor);
  if (scored.length === 0) throw new Error("目前可見的物件都還沒有可比對的 CLIP embedding");

  // eslint-disable-next-line no-console
  console.log("[clip match] scores=" + scored.map((s) => `${s.label}=${s.score.toFixed(4)}`).join(", "));

  const SCORE_MARGIN = 0.08;
  const MAX_POOL_SIZE = 60;
  const topScore = scored[0].score;
  const byMargin = scored.filter((s) => topScore - s.score <= SCORE_MARGIN).slice(0, MAX_POOL_SIZE);
  const marginIds = new Set(byMargin.map((s) => s.id));
  // 濾掉。
  const recoloredExtras = scored.filter((s) => s.color !== null && !marginIds.has(s.id));
  const pool = [...byMargin, ...recoloredExtras];

  const matched = await selectFinalInstances(command, pool, previousContext);
  // eslint-disable-next-line no-console
  console.log("[clip match] selected=" + JSON.stringify(matched));

  if (matched.length === 0) throw new Error("在目前畫面上找不到指令描述的物件——確認物件在畫面可見範圍內");
  return matched;
}
