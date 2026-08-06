import fs from "fs";
import path from "path";
import { pool } from "./db";
import { hashPassword } from "./auth";



const REPO_ROOT = path.resolve(__dirname, "..", "..");
const THUMBNAIL_URL = "/hero-living-room.jpg";
const BACKEND_ORIGIN = process.env.BACKEND_ORIGIN || "http://localhost:3000";

const DEMO_USERNAME = "demo";
const DEMO_PASSWORD = "demo1234";

async function ensureDemoUser(): Promise<number> {
  const existing = await pool.query(`SELECT id FROM users WHERE username = $1`, [DEMO_USERNAME]);
  if (existing.rows.length > 0) return existing.rows[0].id;
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const result = await pool.query(`INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id`, [
    DEMO_USERNAME,
    passwordHash,
  ]);
  return result.rows[0].id;
}

interface SceneSeed {
  id: string;
  name: string;
  description: string;
}

interface ObjectSeed {
  id: string;
  name: string;
  description: string;
  modelUrl: string;
  originSceneId: string;
}

const SCENES: SceneSeed[] = [
  {
    id: "scene-interiorgs839920",
    name: "InteriorGS 839920",
    description:
      "InteriorGS 資料集場景 0001_839920(非商業研究/教育用途,不可重新散布,見 InteriorGS License)。927,067 顆高斯,SuperSplat 壓縮格式,物件用官方 ground-truth 3D 包圍盒直接裁切,不經過分類器推論。",
  },
];

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function interiorgsObjects(): ObjectSeed[] {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "interiorgs_839920", "manifest.json"), "utf-8")
  ) as { insId: string; label: string; gaussianCount: number; file: string }[];

  const background: ObjectSeed = {
    id: "interiorgs839920-background",
    name: "背景",
    description: "InteriorGS 場景 0001_839920 的背景層(扣掉全部已標註物件後剩下的高斯),尚未補洞。",
    modelUrl: `${BACKEND_ORIGIN}/storage/models/interiorgs839920-objects/background.ply`,
    originSceneId: "scene-interiorgs839920",
  };

  const objects = manifest.map(({ insId, label, gaussianCount, file }) => ({
    id: `interiorgs839920-${insId}`,
    name: `${label} ${insId}`,
    description: `InteriorGS 場景 0001_839920 的標註物件(ground truth 3D 包圍盒裁切,label=${label},${fmt(gaussianCount)} 顆高斯)。`,
    modelUrl: `${BACKEND_ORIGIN}/storage/models/interiorgs839920-objects/${file}`,
    originSceneId: "scene-interiorgs839920",
  }));

  return [background, ...objects];
}

let instanceCounter = 0;
function makeInstanceId() {
  instanceCounter += 1;
  return `inst-seed-${instanceCounter}`;
}

async function main() {
  const objects = interiorgsObjects();
  const demoUserId = await ensureDemoUser();

  await pool.query("BEGIN");
  try {
    await pool.query("TRUNCATE scene_object_instances, library_objects, library_scenes CASCADE");

    for (const scene of SCENES) {
      await pool.query(
        `INSERT INTO library_scenes (id, name, thumbnail_url, description, owner_user_id) VALUES ($1, $2, $3, $4, $5)`,
        [scene.id, scene.name, THUMBNAIL_URL, scene.description, demoUserId]
      );
    }

    for (const obj of objects) {
      await pool.query(
        `INSERT INTO library_objects (id, name, thumbnail_url, description, model_url, origin_scene_id, owner_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [obj.id, obj.name, THUMBNAIL_URL, obj.description, obj.modelUrl, obj.originSceneId, demoUserId]
      );
    }

    for (const obj of objects) {
      await pool.query(
        `INSERT INTO scene_object_instances (id, scene_id, model_id, label) VALUES ($1, $2, $3, $4)`,
        [makeInstanceId(), obj.originSceneId, obj.id, obj.name]
      );
    }

    await pool.query("COMMIT");
    // eslint-disable-next-line no-console
    console.log(`seeded ${SCENES.length} scenes, ${objects.length} objects, ${objects.length} instances`);
  } catch (err) {
    await pool.query("ROLLBACK");
    throw err;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
