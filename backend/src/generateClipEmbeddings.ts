import fs from "fs";
import path from "path";
import { AutoProcessor, CLIPVisionModelWithProjection, RawImage } from "@huggingface/transformers";
import { pool } from "./db";


const MODEL = "Xenova/clip-vit-base-patch32";
const THUMBNAILS_DIR = path.join(__dirname, "..", "storage", "thumbnails");

async function main() {
  // eslint-disable-next-line no-console
  console.log("載入 CLIP 圖片模型...");
  const processor = await AutoProcessor.from_pretrained(MODEL);
  const visionModel = await CLIPVisionModelWithProjection.from_pretrained(MODEL, { dtype: "fp32" });

  const objects = await pool.query(`SELECT id FROM library_objects WHERE model_url IS NOT NULL ORDER BY created_at ASC`);

  let ok = 0;
  let skipped = 0;
  for (const obj of objects.rows) {
    const thumbPath = path.join(THUMBNAILS_DIR, `object-${obj.id}.jpg`);
    if (!fs.existsSync(thumbPath)) {
      // eslint-disable-next-line no-console
      console.log(`跳過 ${obj.id}(找不到離線縮圖,先跑 npm run thumbnails:generate)`);
      skipped++;
      continue;
    }
    try {
      const image = await RawImage.read(thumbPath);
      const inputs = await processor(image);
      const { image_embeds } = await visionModel(inputs);
      const embedding = Array.from(image_embeds.data as Float32Array);
      await pool.query(`UPDATE library_objects SET clip_embedding = $2 WHERE id = $1`, [obj.id, embedding]);
      ok++;
      // eslint-disable-next-line no-console
      console.log(`完成 ${obj.id}`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`  失敗 ${obj.id}:`, err instanceof Error ? err.message : String(err));
      skipped++;
    }
  }

  // eslint-disable-next-line no-console
  console.log(`完成。${ok} 成功 / ${skipped} 跳過。`);
  await pool.end();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
