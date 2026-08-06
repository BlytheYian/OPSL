import { pool } from "./db";
import type { RiskType } from "./riskDetection";

// 對齊 OPSL riskRemediation.ts 的風險類型→建議輔具對照表,但改用關鍵字比對(ILIKE)而不是
// OPSL 原本的精確名稱比對(WHERE name = ANY(...))——OPSL 的輔具庫用的是通用名稱(「斜坡道」
// 「防滑墊」「感應夜燈」「防撞角護套」),我們匯入的 OPSL 輔具資產(opsl-ast-*)名稱更具體
// (「門檻斜坡道」「感應式走道夜燈」等),精確比對會全部落空,用關鍵字才能真的比對到既有資料。
const REMEDIATION_KEYWORDS: Record<RiskType, string[]> = {
  門檻: ["斜坡", "防滑"],
  地面高低差: ["斜坡"],
  走道障礙: ["燈"],
  家具邊角: ["防撞"],
};

export interface AssetSuggestion {
  id: string;
  name: string;
}

export async function suggestAssetsByRiskType(riskTypes: RiskType[]): Promise<Record<string, AssetSuggestion[]>> {
  const uniqueTypes = Array.from(new Set(riskTypes));
  const suggestionsByType: Record<string, AssetSuggestion[]> = {};

  for (const riskType of uniqueTypes) {
    const keywords = REMEDIATION_KEYWORDS[riskType] ?? [];
    if (keywords.length === 0) {
      suggestionsByType[riskType] = [];
      continue;
    }
    const pattern = keywords.map((k) => `%${k}%`);
    const result = await pool.query<AssetSuggestion>(
      `SELECT id, name FROM library_objects WHERE category = '輔具' AND name LIKE ANY($1) ORDER BY id`,
      [pattern]
    );
    suggestionsByType[riskType] = result.rows;
  }

  return suggestionsByType;
}
