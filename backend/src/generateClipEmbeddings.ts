import fs from "fs";
import path from "path";
import { pool } from "./db";
import { embedImageFile } from "./clip/imageEmbed";

const THUMBNAILS_DIR = path.join(__dirname, "..", "storage", "thumbnails");

async function main() {
  const objects = await pool.query(`SELECT id FROM library_objects WHERE model_url IS NOT NULL ORDER BY created_at ASC`);

  let ok = 0;
  let skipped = 0;
  for (const obj of objects.rows) {
    const thumbPath = path.join(THUMBNAILS_DIR, `object-${obj.id}.jpg`);
    if (!fs.existsSync(thumbPath)) {
      console.log(`跳過 ${obj.id}(找不到縮圖)`);
      skipped++;
      continue;
    }
    try {
      const embedding = await embedImageFile(thumbPath);
      await pool.query(`UPDATE library_objects SET clip_embedding = $2 WHERE id = $1`, [obj.id, embedding]);
      ok++;
      console.log(`完成 ${obj.id}`);
    } catch (err) {
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
