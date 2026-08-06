import path from "path";
import { pool } from "./db";
import { hashPassword } from "./auth";

const BACKEND_ORIGIN = process.env.BACKEND_ORIGIN || "http://localhost:3000";
const DEMO_USERNAME = "demo";
const DEMO_PASSWORD = "demo1234";
const PLACEHOLDER_THUMBNAIL = "/hero-living-room.jpg";

const OPSL_ASSETS: { id: string; name: string; description: string; file: string }[] = [
  { id: "opsl-ast-001", name: "直式扶手", description: "OPSL 輔具資產：直式扶手(AST-001)。", file: "AST-001.glb" },
  { id: "opsl-ast-003", name: "短式扶手", description: "OPSL 輔具資產：短式扶手(AST-003)。", file: "AST-003.glb" },
  { id: "opsl-ast-004", name: "防滑地墊", description: "OPSL 輔具資產：防滑地墊(AST-004)。", file: "AST-004.glb" },
  { id: "opsl-ast-005", name: "防滑貼條", description: "OPSL 輔具資產：防滑貼條(AST-005)。", file: "AST-005.glb" },
  { id: "opsl-ast-006", name: "門檻斜坡道", description: "OPSL 輔具資產：門檻斜坡道(AST-006)。", file: "AST-006.glb" },
  { id: "opsl-ast-007", name: "淋浴垂直扶手", description: "OPSL 輔具資產：淋浴垂直扶手(AST-007)。", file: "AST-007.glb" },
  { id: "opsl-ast-008", name: "U型浴缸扶手", description: "OPSL 輔具資產：U型浴缸扶手(AST-008)。", file: "AST-008.glb" },
  { id: "opsl-ast-009", name: "摺疊式扶手", description: "OPSL 輔具資產：摺疊式扶手(AST-009)。", file: "AST-009.glb" },
  { id: "opsl-ast-010", name: "圓點防滑貼片", description: "OPSL 輔具資產：圓點防滑貼片(AST-010)。", file: "AST-010.glb" },
  { id: "opsl-ast-011", name: "樓梯止滑條", description: "OPSL 輔具資產：樓梯止滑條(AST-011)。", file: "AST-011.glb" },
  { id: "opsl-ast-012", name: "固定式門檻導角條", description: "OPSL 輔具資產：固定式門檻導角條(AST-012)。", file: "AST-012.glb" },
  { id: "opsl-ast-013", name: "可攜式斜坡板", description: "OPSL 輔具資產：可攜式斜坡板(AST-013)。", file: "AST-013.glb" },
  { id: "opsl-ast-014", name: "感應式走道夜燈", description: "OPSL 輔具資產：感應式走道夜燈(AST-014)。", file: "AST-014.glb" },
  { id: "opsl-ast-015", name: "樓梯感應燈條", description: "OPSL 輔具資產：樓梯感應燈條(AST-015)。", file: "AST-015.glb" },
  { id: "opsl-ast-016", name: "浴室防潮感應燈", description: "OPSL 輔具資產：浴室防潮感應燈(AST-016)。", file: "AST-016.glb" },
  { id: "opsl-ast-017", name: "桌角防撞護角", description: "OPSL 輔具資產：桌角防撞護角(AST-017)。", file: "AST-017.glb" },
  { id: "opsl-ast-018", name: "家具邊緣防撞條", description: "OPSL 輔具資產：家具邊緣防撞條(AST-018)。", file: "AST-018.glb" },
  { id: "opsl-ast-019", name: "淋浴椅／沐浴椅", description: "OPSL 輔具資產：淋浴椅／沐浴椅(AST-019)。", file: "AST-019.glb" },
  { id: "opsl-ast-020", name: "馬桶增高座", description: "OPSL 輔具資產：馬桶增高座(AST-020)。", file: "AST-020.glb" },
  { id: "opsl-ast-021", name: "馬桶扶手架", description: "OPSL 輔具資產：馬桶扶手架(AST-021)。", file: "AST-021.glb" },
  { id: "opsl-ast-022", name: "家具防傾倒固定帶", description: "OPSL 輔具資產：家具防傾倒固定帶(AST-022)。", file: "AST-022.glb" },
  { id: "opsl-ast-023", name: "緊急求助鈴", description: "OPSL 輔具資產：緊急求助鈴(AST-023)。", file: "AST-023.glb" },
  { id: "opsl-ast-024", name: "標準手動輪椅", description: "OPSL 輔具資產：標準手動輪椅(AST-024)。", file: "AST-024.glb" },
  { id: "opsl-ast-025", name: "四腳助行器", description: "OPSL 輔具資產：四腳助行器(AST-025)。", file: "AST-025.glb" },
  { id: "opsl-ast-026", name: "帶輪助步車", description: "OPSL 輔具資產：帶輪助步車(AST-026)。", file: "AST-026.glb" },
  { id: "opsl-ast-027", name: "床邊護欄", description: "OPSL 輔具資產：床邊護欄(AST-027)。", file: "AST-027.glb" },
  { id: "opsl-ast-028", name: "床邊起身扶手（移位桿）", description: "OPSL 輔具資產：床邊起身扶手／移位桿(AST-028)。", file: "AST-028.glb" },
  { id: "opsl-ast-029", name: "瓦斯／CO警報器", description: "OPSL 輔具資產：瓦斯／CO警報器(AST-029)。", file: "AST-029.glb" },
  { id: "opsl-ast-030", name: "移位滑墊／移位板", description: "OPSL 輔具資產：移位滑墊／移位板(AST-030)。", file: "AST-030.glb" },
];

async function ensureDemoUser(): Promise<number> {
  const existing = await pool.query(`SELECT id FROM users WHERE username = $1`, [DEMO_USERNAME]);
  if (existing.rows.length > 0) return existing.rows[0].id;
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const result = await pool.query(
    `INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id`,
    [DEMO_USERNAME, passwordHash]
  );
  return result.rows[0].id;
}

async function main() {
  const demoUserId = await ensureDemoUser();
  let upserted = 0;

  for (const asset of OPSL_ASSETS) {
    const modelUrl = `${BACKEND_ORIGIN}/storage/models/opsl-assets-glb/${asset.file}`;
    await pool.query(
      `INSERT INTO library_objects (id, name, thumbnail_url, description, model_url, owner_user_id, asset_kind)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         model_url = EXCLUDED.model_url,
         description = EXCLUDED.description`,
      [asset.id, asset.name, PLACEHOLDER_THUMBNAIL, asset.description, modelUrl, demoUserId, "mesh"]
    );
    upserted++;
  }

  console.log(`upserted ${upserted} OPSL assets`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
