import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";
import { pool } from "./db";


const FRONTEND_URL = process.env.THUMBNAILS_FRONTEND_URL || "http://localhost:5173";
const BACKEND_PUBLIC_URL = process.env.THUMBNAILS_BACKEND_URL || `http://localhost:${process.env.PORT || 3000}`;
const THUMBNAILS_DIR = path.join(__dirname, "..", "storage", "thumbnails");
fs.mkdirSync(THUMBNAILS_DIR, { recursive: true });

type Vec3 = [number, number, number];

interface CapturePayload {
  src: string[];
  transforms?: ({ position: Vec3; rotation: Vec3; scale: Vec3 } | null)[];
  dataRotations?: (Vec3 | null)[];
  colors?: (string | null)[];
}
function upAxisFixFor(modelId: string, modelUrl?: string | null): Vec3 {
  if (modelUrl?.toLowerCase().endsWith(".glb")) return [0, 0, 0];
  if (modelId.includes("interiorgs839920-")) return [-90, 0, 0];
  return [180, 0, 0];
}

async function captureOne(browser: import("puppeteer").Browser, payload: CapturePayload): Promise<Buffer | null> {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 512, height: 384 });
    const url = `${FRONTEND_URL}/capture?payload=${encodeURIComponent(JSON.stringify(payload))}`;
    await page.goto(url, { waitUntil: "load" });
    await page.waitForFunction(
      () => document.title === "CAPTURE_READY" || document.title.startsWith("CAPTURE_ERROR"),
      { timeout: 180000 }
    );
    const title = await page.title();
    if (title.startsWith("CAPTURE_ERROR")) {
      // eslint-disable-next-line no-console
      console.error(`  截圖失敗:${title}`);
      return null;
    }
    const dataUrl = await page.$eval("#capture-result", (el) => el.getAttribute("data-image"));
    if (!dataUrl) {
      // eslint-disable-next-line no-console
      console.error("  截圖失敗:CAPTURE_READY 但沒有圖片資料");
      return null;
    }
    const base64 = dataUrl.split(",")[1] ?? "";
    return Buffer.from(base64, "base64");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`  截圖失敗(逾時或例外):${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    await page.close();
  }
}

const args = new Set(process.argv.slice(2));
const runScenes = !args.has("--objects-only");
const runObjects = !args.has("--scenes-only");

async function main() {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      "--no-sandbox",
    ],
  });

  let sceneOk = 0;
  let sceneFail = 0;
  let objectOk = 0;
  let objectFail = 0;

  try {
    const scenes = runScenes ? (await pool.query(`SELECT id FROM library_scenes ORDER BY created_at ASC`)).rows : [];
    for (const scene of scenes) {
      const instances = await pool.query(
        `SELECT soi.pos_x, soi.pos_y, soi.pos_z, soi.rot_x, soi.rot_y, soi.rot_z,
                soi.scale_x, soi.scale_y, soi.scale_z, soi.color,
                lo.id AS model_id, lo.model_url
         FROM scene_object_instances soi
         JOIN library_objects lo ON lo.id = soi.model_id
         WHERE soi.scene_id = $1 AND soi.hidden = false
         ORDER BY soi.created_at ASC`,
        [scene.id]
      );
      if (instances.rows.length === 0) {
        // eslint-disable-next-line no-console
        console.log(`跳過場景 ${scene.id}(沒有任何可見物件)`);
        continue;
      }
      const payload: CapturePayload = {
        src: instances.rows.map((r) => r.model_url),
        transforms: instances.rows.map((r) => ({
          position: [r.pos_x, r.pos_y, r.pos_z],
          rotation: [r.rot_x, r.rot_y, r.rot_z],
          scale: [r.scale_x, r.scale_y, r.scale_z],
        })),
        dataRotations: instances.rows.map((r) => upAxisFixFor(r.model_id, r.model_url)),
        colors: instances.rows.map((r) => r.color),
      };
      // eslint-disable-next-line no-console
      console.log(`場景 ${scene.id}(${instances.rows.length} 個物件)...`);
      const image = await captureOne(browser, payload);
      if (!image) {
        sceneFail++;
        continue;
      }
      const filename = `scene-${scene.id}.jpg`;
      fs.writeFileSync(path.join(THUMBNAILS_DIR, filename), image);
      const url = `${BACKEND_PUBLIC_URL}/storage/thumbnails/${filename}`;
      await pool.query(`UPDATE library_scenes SET thumbnail_url = $2 WHERE id = $1`, [scene.id, url]);
      sceneOk++;
      // eslint-disable-next-line no-console
      console.log(`  完成 -> ${url}`);
    }

    const objects = runObjects
      ? (
          await pool.query(
            `SELECT id, model_url FROM library_objects WHERE model_url IS NOT NULL ORDER BY created_at ASC`
          )
        ).rows
      : [];
    for (const obj of objects) {
      const payload: CapturePayload = {
        src: [obj.model_url],
        dataRotations: [upAxisFixFor(obj.id, obj.model_url)],
      };
      // eslint-disable-next-line no-console
      console.log(`物件 ${obj.id}...`);
      const image = await captureOne(browser, payload);
      if (!image) {
        objectFail++;
        continue;
      }
      const filename = `object-${obj.id}.jpg`;
      fs.writeFileSync(path.join(THUMBNAILS_DIR, filename), image);
      const url = `${BACKEND_PUBLIC_URL}/storage/thumbnails/${filename}`;
      await pool.query(`UPDATE library_objects SET thumbnail_url = $2 WHERE id = $1`, [obj.id, url]);
      objectOk++;
      // eslint-disable-next-line no-console
      console.log(`  完成 -> ${url}`);
    }
  } finally {
    await browser.close();
    await pool.end();
  }

  // eslint-disable-next-line no-console
  console.log(
    `完成。場景:${sceneOk} 成功 / ${sceneFail} 失敗。物件:${objectOk} 成功 / ${objectFail} 失敗。`
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
