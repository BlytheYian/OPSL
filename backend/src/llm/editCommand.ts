import { getLLMProvider } from "./index";
import { VisionMatchSchema, LLMEditDeltaSchema, SplitCommandSchema, type ResolvedEditAction } from "../schemas";
import { identifyInstancesClip } from "../clip/matchInstances";

export interface VisibleInstance {
  id: string;
  label: string;
  /** 0~1000 正規化螢幕座標(前端依目前相機投影算出來的),跟下面 box_2d 用同一套座標系,
   * 兩邊才能直接比對距離。 */
  x: number;
  y: number;
  /** 對應 library_objects.id——CLIP 語意比對階段(../clip/matchInstances.ts)用這個查離線算好的
   * CLIP embedding。舊的視覺模型路徑(identifyInstances)不用這個欄位。 */
  modelId: string;
  /** 這個 instance 目前的染色(執行期設的),null 代表還是原始顏色。CLIP 語意比對階段用這個
   * 決定顏色要不要交給 CLIP 判斷,還是直接跟這個欄位比對——見 matchInstances.ts 開頭的說明。
   * 舊的視覺模型路徑不用這個欄位。 */
  color: string | null;
  /** 跟目前鏡頭的距離(世界座標單位)——「離我近的」「前面的」這類距離描述用,CLIP 語意比對
   * 階段的最終選取才會用到,舊的視覺模型路徑不用這個欄位。 */
  distance: number;
}

type Vec3 = [number, number, number];

/** 目前鏡頭的右/上/前單位向量(世界座標系,前端 GSplatViewer.vue getCameraAxes() 算出來的)。 */
export interface CameraAxes {
  right: Vec3;
  up: Vec3;
  forward: Vec3;
}

/** 把「鏡頭相對」位移([往右, 往上, 往螢幕裡面])換算成世界座標位移——語意轉換階段是純文字、
 * 看不到畫面,只能用鏡頭相對的方式表達方向(見 DELTA_SYSTEM_PROMPT 的說明),真正要寫進資料庫
 * 的是世界座標,這段純幾何運算(座標基底變換)自己算,不該讓模型猜世界座標軸怎麼對應。沒有
 * cameraAxes 可用(理論上前端一定會傳,防禦性地退回原樣,當作已經是世界座標)。 */
function cameraRelativeToWorld(delta: Vec3, axes: CameraAxes | null): Vec3 {
  if (!axes) return delta;
  const [dRight, dUp, dForward] = delta;
  const [rx, ry, rz] = axes.right;
  const [ux, uy, uz] = axes.up;
  const [fx, fy, fz] = axes.forward;
  return [
    dRight * rx + dUp * ux + dForward * fx,
    dRight * ry + dUp * uy + dForward * fy,
    dRight * rz + dUp * uz + dForward * fz,
  ];
}


const BATCH_KEYWORD_RE = /所有|全部|每一|每個|每張|每扇|每面|通通|全都|統統/;

const SPLIT_SYSTEM_PROMPT = `使用者會用中文下一句編輯指令,句子裡可能包含一個,也可能包含好幾個
各自獨立的「目標+動作」組合(例如「椅子恢復木頭色,左邊的椅子改成淺藍色」其實是兩個不同目標
各自的改動,不是同一個動作)。你要判斷這句話裡有幾個獨立的編輯動作,拆成一個陣列。

重要:拆出來的每一句(text 欄位)都要是完整、獨立能理解的一句話——原句如果用「然後」「而」「,」
省略掉後半句的目標(例如「…,然後改成紅色」),拆的時候要把省略掉的目標補回去,不能留下代名詞
或空缺讓後面的步驟猜不到指的是誰。

例外:如果整句(或其中一個子句)講的是「它」「這個」「那個」「繼續」「還是改成…好了」這類
**指前一次操作對象、但完全沒有描述那個物件實際是什麼**的說法,不要嘗試瞎猜或編造一個描述——
這種情況把 referencesPrevious 設成 true,text 照原句的這一段填(不用勉強補目標)。

回傳一個 JSON 物件:
{"commands": [{"text": "...", "referencesPrevious": true 或 false}, ...]}
只有一個動作的句子,commands 就只有一個元素。`;

const VISION_SYSTEM_PROMPT = `你在看一張 3D 場景編輯器目前畫面的截圖。使用者會用中文下一句編輯指令
(例如「把沙發往右移一點」、「牆角的椅子改成藍色」、「紅色的花改成藍色」、「所有椅子的坐墊改成
黃色」),你只需要判斷指令裡提到的是畫面中的哪個/哪些物件,不用理會指令要做什麼調整(移動/縮放/
改色那些之後由別的步驟處理)。

回傳一個 JSON **陣列**,每個元素是 {"box_2d": [y_min, x_min, y_max, x_max], "label": "你認為那是
什麼"},box_2d 座標正規化到 0~1000(不管圖片實際解析度)。

- 指令指的是「一個特定物件」時(例如「牆角的椅子」「紅色的花」),陣列只回傳最符合的那一個。
- 指令指的是「一整類、所有符合的」物件時(例如「所有椅子」「每一扇窗戶」),把畫面中每一個符合的
  都各自回傳一個元素。
- 指令是「把 A 換成 B」「A 換一個 B 好了」這種替換說法(例如「把單人沙發換成雙人沙發」)時,要找
  的是畫面裡現有的 A(單人沙發),不是 B(雙人沙發)——B 是使用者想換成的新描述,畫面裡通常根本
  沒有這個東西,不要因為指令提到 B 就去找長得像 B 的物件。
- 找不到符合指令描述的物件,回傳空陣列 []。`;

const ACTION_SYSTEM_PROMPT = `你是一個 3D 場景編輯助手,做純文字的結構化資料轉換——使用者會用中文
下一句編輯指令,要編輯哪個物件已經由另一個步驟決定好了,你只需要判斷這句指令屬於哪一種動作、
並把它換算成具體的數值調整。

回傳一個 JSON **物件**(不是陣列),欄位都要有,不需要的填 null 或 false:
{
  "action": "adjust" 或 "hide" 或 "delete" 或 "replace",
  "positionDelta": [dx, dy, dz] 或 null,
  "rotationDelta": [drx, dry, drz] 或 null,
  "scaleMultiplier": [sx, sy, sz] 或 null,
  "color": "#rrggbb" 或 null,
  "resetPosition": true 或 false,
  "resetRotation": true 或 false,
  "resetScale": true 或 false,
  "resetColor": true 或 false,
  "replacementQuery": "..." 或 null,
  "reasoning": "一句話說明你做了什麼調整"
}

先判斷 action(四選一,只能選一個):
- "adjust":移動/旋轉/縮放/改色/恢復原狀——物件本身不變,只是調整它的位置、朝向、大小或顏色。
  這是預設情況,大部分指令都是這一種。
- "hide":使用者說「清空」「先移開」「暫時拿掉」「藏起來」「擋住不要看到」這類語氣——物件其實
  還在場景裡,只是暫時不想讓它出現、擋到視角或動線判斷,不是真的要永久拿掉它。
- "delete":使用者說「刪除」「移除」「拆掉」「丟掉」「不要了」這類明確、永久性的語氣——真的要
  把這個物件從場景裡拿掉。
- "replace":使用者說「把 A 換成 B」「A 換一個 B 好了」「這個我想換成別的」這類明確表示「拿掉
  原本這個,改放一個不同東西」的語氣——不是調整原本這個物件,是要用另一個物件取代它。

action 是 "adjust" 時,positionDelta/rotationDelta/scaleMultiplier/color/reset* 欄位照下面規則
填;action 是其他三種時,這幾個欄位全部填 null/false。action 是 "replace" 時,replacementQuery
填「要換成什麼」的中文描述(例如「把單人沙發換成雙人沙發」→ replacementQuery 填 "雙人沙發";
「這張椅子我想換一張比較現代風格的」→ replacementQuery 填 "現代風格的椅子"),其他情況填 null。

- positionDelta 是相對移動量(不是新的絕對座標),**用「鏡頭相對」座標,不是世界座標**:
  [往右移多少, 往上移多少, 往螢幕裡面(遠離鏡頭)移多少]——正值分別代表「使用者螢幕上看到的
  右邊」「上面」「往畫面深處/遠離鏡頭」,跟世界座標軸沒有直接關係(由後端另外換算)。單位跟場景
  座標一致,一般物件家具尺度大約是 0.1~1 之間的量級;「往右移一點」大約是 [0.3, 0, 0]、
  「往前靠近一點/往使用者這邊移」大約是 [0, 0, -0.3],「移多一點」用大一點的數值。
- rotationDelta 是相對旋轉角度,單位是度,「轉一下」大約 15~45 度。
- scaleMultiplier 是縮放倍率(不是新的絕對大小),1 代表不變,「放大一點」大約 [1.15,1.15,1.15],
  「縮小一點」大約 [0.85,0.85,0.85]。
- color 是使用者想要的目標顏色,轉換成 #rrggbb 十六進位色碼(例如「藍色」約 #3366cc、「紅色」約
  #cc3333、「黃色」約 #e0c030、「木頭色/原木色」約 #a97c50),沒有要求改色就是 null。
- resetPosition/resetRotation/resetScale/resetColor:使用者明確要求「恢復原狀/復原/回到一開始
  的樣子」時,把對應的欄位設成 true(位置恢復原點、旋轉恢復不轉、縮放恢復原始大小、顏色恢復
  原本沒染色的樣子)——這四個各自獨立,使用者可能只要求恢復其中一項(例如「顏色改回來就好,
  位置不用動」只設 resetColor)。設成 true 的欄位,對應的 positionDelta/rotationDelta/
  scaleMultiplier/color 就填 null(兩者互斥,不用同時給)。單純「沒有要求調整」跟「明確要求
  恢復原狀」是不一樣的,不要把兩者都當成 null/false 處理不出來就隨便選一個。`;

/** 有些模型偶爾還是會在 JSON 前後夾雜 ```json 圍欄或多餘文字,即使已經用 JSON Schema 強制文法
 * 理論上該擋住這種情況——防禦性清理,不差這幾行。 */
function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return match ? match[1] : trimmed;
}

const SPLIT_JSON_SCHEMA = {
  type: "object",
  properties: {
    commands: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          referencesPrevious: { type: "boolean" },
        },
        required: ["text", "referencesPrevious"],
      },
    },
  },
  required: ["commands"],
};

const VISION_JSON_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      box_2d: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 },
      label: { type: ["string", "null"] },
    },
    required: ["box_2d"],
  },
};

const ACTION_JSON_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["adjust", "hide", "delete", "replace"] },
    positionDelta: { type: ["array", "null"], items: { type: "number" }, minItems: 3, maxItems: 3 },
    rotationDelta: { type: ["array", "null"], items: { type: "number" }, minItems: 3, maxItems: 3 },
    scaleMultiplier: { type: ["array", "null"], items: { type: "number" }, minItems: 3, maxItems: 3 },
    color: { type: ["string", "null"] },
    resetPosition: { type: "boolean" },
    resetRotation: { type: "boolean" },
    resetScale: { type: "boolean" },
    resetColor: { type: "boolean" },
    replacementQuery: { type: ["string", "null"] },
    reasoning: { type: ["string", "null"] },
  },
  required: [
    "action",
    "positionDelta",
    "rotationDelta",
    "scaleMultiplier",
    "color",
    "resetPosition",
    "resetRotation",
    "resetScale",
    "resetColor",
    "replacementQuery",
    "reasoning",
  ],
};

interface SplitItem {
  text: string;
  referencesPrevious: boolean;
}

async function splitCommands(command: string): Promise<SplitItem[]> {
  const provider = getLLMProvider();
  const userPrompt = `使用者指令:「${command}」\n\n請回傳符合說明格式的 JSON。`;
  const raw = await provider.complete(SPLIT_SYSTEM_PROMPT, userPrompt, { jsonSchema: SPLIT_JSON_SCHEMA });

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch {
    // eslint-disable-next-line no-console
    console.error("[edit-command] 切分階段回傳的不是合法 JSON:", raw);
    throw new Error("模型回傳的不是合法 JSON,無法解析指令");
  }

  const result = SplitCommandSchema.safeParse(parsed);
  if (!result.success) {
    // eslint-disable-next-line no-console
    console.error("[edit-command] 切分階段回傳的格式不符預期:", raw, result.error.flatten());
    throw new Error("模型回傳的格式不符預期,無法解析指令");
  }
  return result.data.commands;
}
const REFERENCE_CHECK_SYSTEM_PROMPT = `你在檢查一句中文編輯指令的其中一段,判斷它有沒有「描述目標
物件本身」。

任何指出物件是什麼種類的名詞都算描述,不管有沒有再加顏色/材質/位置這些額外修飾——「椅子」
「花」「桌子」「花瓶」這種**單獨一個名詞**本身就已經是描述了,不需要额外的顏色或位置才算數。

只有完全沒有提到任何物件種類、純粹用代稱指前一次操作對象的說法,才算「沒有描述」——例如
「它」「這個」「那個」「繼續」「還是改成…好了」「一樣」「同一個」。判斷方式:把這句話拿掉
所有動作/顏色/數值之後,還剩不剩下一個具體的物件種類名詞?剩下就算有描述,只剩代名詞或完全
沒有名詞才算沒有描述。

注意:即使句子裡提到「剛剛」「之前」「上一個」這類時間詞,只要同時也提到了物件種類,就算
「有描述」——時間詞只是額外資訊,不能取代真正的物件種類名詞。

回傳一個 JSON 物件:{"hasDescription": true 或 false}`;

const REFERENCE_CHECK_JSON_SCHEMA = {
  type: "object",
  properties: {
    hasDescription: { type: "boolean" },
  },
  required: ["hasDescription"],
};

async function hasIndependentDescription(text: string): Promise<boolean> {
  const provider = getLLMProvider();
  const userPrompt = `子句:「${text}」\n\n請回傳符合說明格式的 JSON。`;
  const raw = await provider.complete(REFERENCE_CHECK_SYSTEM_PROMPT, userPrompt, {
    jsonSchema: REFERENCE_CHECK_JSON_SCHEMA,
  });
  const parsed = JSON.parse(stripCodeFence(raw)) as { hasDescription: boolean };
  return !!parsed.hasDescription;
}

interface MatchedInstance {
  id: string;
  label: string;
}

export interface PreviousEditContext {
  command: string;
  instances: MatchedInstance[];
}

async function identifyInstances(
  command: string,
  imageBase64: string,
  visible: VisibleInstance[]
): Promise<MatchedInstance[]> {
  const provider = getLLMProvider();
  const userPrompt = `使用者指令:「${command}」\n\n請找出這張截圖裡,使用者指令指的是哪個/哪些物件,回傳符合說明格式的 JSON 陣列。`;
  const raw = await provider.complete(VISION_SYSTEM_PROMPT, userPrompt, {
    jsonSchema: VISION_JSON_SCHEMA,
    images: [imageBase64],
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch {
    // eslint-disable-next-line no-console
    console.error("[edit-command] 視覺定位階段回傳的不是合法 JSON:", raw);
    throw new Error("視覺定位模型回傳的不是合法 JSON,無法解析指令");
  }

  const result = VisionMatchSchema.safeParse(parsed);
  if (!result.success) {
    // eslint-disable-next-line no-console
    console.error("[edit-command] 視覺定位階段回傳的格式不符預期:", raw, result.error.flatten());
    throw new Error("視覺定位模型回傳的格式不符預期,無法解析指令");
  }
  if (result.data.length === 0) {
    throw new Error("在目前畫面上找不到指令描述的物件——確認物件在畫面可見範圍內");
  }

  const matched = new Map<string, MatchedInstance>();
  for (const box of result.data) {
    const [yMin, xMin, yMax, xMax] = box.box_2d;
    const cx = (xMin + xMax) / 2;
    const cy = (yMin + yMax) / 2;
    let nearest: VisibleInstance | null = null;
    let nearestDist = Infinity;
    for (const inst of visible) {
      const dist = (inst.x - cx) ** 2 + (inst.y - cy) ** 2;
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = inst;
      }
    }
    if (nearest) matched.set(nearest.id, { id: nearest.id, label: nearest.label });
  }
  if (matched.size === 0) {
    throw new Error("視覺定位結果對不到場景裡任何一個目前可見的物件");
  }

  if (BATCH_KEYWORD_RE.test(command) || matched.size === 1) {
    return [...matched.values()];
  }

  let best: MatchedInstance | null = null;
  let bestDist = Infinity;
  for (const inst of visible) {
    if (!matched.has(inst.id)) continue;
    const dist = (inst.x - 500) ** 2 + (inst.y - 500) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = { id: inst.id, label: inst.label };
    }
  }
  return best ? [best] : [...matched.values()];
}

interface ActionResult {
  action: "adjust" | "hide" | "delete" | "replace";
  positionDelta: [number, number, number] | null;
  rotationDelta: [number, number, number] | null;
  scaleMultiplier: [number, number, number] | null;
  color: string | null;
  resetPosition: boolean;
  resetRotation: boolean;
  resetScale: boolean;
  resetColor: boolean;
  replacementQuery: string | null;
  reasoning: string | null;
}

async function extractAction(command: string): Promise<ActionResult> {
  const provider = getLLMProvider();
  const userPrompt = `使用者指令:「${command}」\n\n請回傳符合說明格式的 JSON。`;
  const raw = await provider.complete(ACTION_SYSTEM_PROMPT, userPrompt, { jsonSchema: ACTION_JSON_SCHEMA });

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch {
    // eslint-disable-next-line no-console
    console.error("[edit-command] 語意轉換階段回傳的不是合法 JSON:", raw);
    throw new Error("模型回傳的不是合法 JSON,無法解析指令");
  }

  const result = LLMEditDeltaSchema.safeParse(parsed);
  if (!result.success) {
    // eslint-disable-next-line no-console
    console.error("[edit-command] 語意轉換階段回傳的格式不符預期:", raw, result.error.flatten());
    throw new Error("模型回傳的格式不符預期,無法解析指令");
  }

  return {
    action: result.data.action ?? "adjust",
    positionDelta: result.data.positionDelta ?? null,
    rotationDelta: result.data.rotationDelta ?? null,
    scaleMultiplier: result.data.scaleMultiplier ?? null,
    color: result.data.color ?? null,
    resetPosition: result.data.resetPosition ?? false,
    resetRotation: result.data.resetRotation ?? false,
    resetScale: result.data.resetScale ?? false,
    resetColor: result.data.resetColor ?? false,
    replacementQuery: result.data.replacementQuery ?? null,
    reasoning: result.data.reasoning ?? null,
  };
}

const MAX_ATTEMPTS = 3;
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function resolveOneCommand(
  item: SplitItem,
  imageBase64: string,
  visible: VisibleInstance[],
  previousContext: PreviousEditContext | null,
  cameraAxes: CameraAxes | null
): Promise<ResolvedEditAction> {
  let reusePrevious = item.referencesPrevious && !!previousContext?.instances.length;
  if (reusePrevious) {
    // 覆核切分階段的判斷,見 hasIndependentDescription 宣告處的說明——只有覆核也同意「真的沒有
    // 描述物件本身」才真正沿用歷史,不然強制重新跑一次比對。
    const hasDescription = await withRetry(() => hasIndependentDescription(item.text));
    if (hasDescription) reusePrevious = false;
  }
  const useClipMatcher = process.env.EDIT_COMMAND_MATCHER === "clip";

  const [matchedInstances, action] = await Promise.all([
    reusePrevious
      ? Promise.resolve(previousContext!.instances)
      : withRetry(() =>
          useClipMatcher
            ? identifyInstancesClip(item.text, visible, previousContext)
            : identifyInstances(item.text, imageBase64, visible)
        ),
    withRetry(() => extractAction(item.text)),
  ]);

  const matchedNote = reusePrevious
    ? `沿用上一輪的物件(${matchedInstances.map((m) => m.label).join("、")})。`
    : matchedInstances.length > 1
      ? `找到 ${matchedInstances.length} 個符合的物件(${matchedInstances.map((m) => m.label).join("、")})。`
      : "";

  return {
    instanceIds: matchedInstances.map((m) => m.id),
    action: action.action,
    positionDelta:
      action.action === "adjust" && action.positionDelta
        ? cameraRelativeToWorld(action.positionDelta, cameraAxes)
        : null,
    rotationDelta: action.action === "adjust" ? action.rotationDelta : null,
    scaleMultiplier: action.action === "adjust" ? action.scaleMultiplier : null,
    color: action.action === "adjust" ? action.color : null,
    resetPosition: action.action === "adjust" && action.resetPosition,
    resetRotation: action.action === "adjust" && action.resetRotation,
    resetScale: action.action === "adjust" && action.resetScale,
    resetColor: action.action === "adjust" && action.resetColor,
    replacementQuery: action.action === "replace" ? action.replacementQuery : null,
    reasoning: matchedNote + (action.reasoning ?? ""),
  };
}

export async function resolveEditCommand(
  command: string,
  imageBase64: string,
  visible: VisibleInstance[],
  previousContext: PreviousEditContext | null,
  cameraAxes: CameraAxes | null
): Promise<ResolvedEditAction[]> {
  const subCommands = await withRetry(() => splitCommands(command));
  return Promise.all(
    subCommands.map((item) => resolveOneCommand(item, imageBase64, visible, previousContext, cameraAxes))
  );
}
