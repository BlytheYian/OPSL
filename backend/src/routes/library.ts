import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { pool } from "../db";
import { requireAuth } from "../auth";
import { embedImageFile } from "../clip/imageEmbed";

/**
 * 模型庫瀏覽——取代前端 stores/library.ts 原本硬編的 allScenes/allObjects 陣列。
 * 回傳形狀對齊前端 LibraryItem(id/name/thumbnail/createdAt/status/description/modelUrl),
 * 欄位名稱從 snake_case 轉成前端期待的 camelCase 在這裡做,前端不用再各自轉換。
 *
 * 「我的模型庫」vs「線上資產庫」(2026-08-02 新增):library_scenes/library_objects 現在都有
 * owner_user_id——不設或別人擁有的項目一樣查得到,但只在 ?scope=all(線上資產庫)才回傳,
 * 預設(或 ?scope=mine)只回傳自己擁有的。「加入我的模型庫」不是搬移,是複製一份新記錄,
 * owner_user_id 設成自己,不影響原本擁有者(POST .../copy)。
 *
 * 線上資產庫不分場景/模型元件(2026-08-02,同日修正):資產庫是給使用者上傳的獨立資產用的
 * (家具、扶手這類實際單品),不是拿 InteriorGS 這種從場景切出來的分類器/包圍盒物件(那些是
 * 「示範場景裡剛好長這樣」,不是通用可重複使用的獨立資產)。判斷依據是 origin_scene_id 有沒有
 * 值——有值代表是從某個場景切出來的,只在該場景的模型列表/我的模型庫看得到,不會出現在資產庫;
 * 使用者上傳的物件 origin_scene_id 天生是 NULL,自然符合資產庫資格,不用額外欄位。場景本身
 * (library_scenes)完全不在資產庫瀏覽範圍內,前端也拿掉了這個分頁下的場景/模型元件分類切換。
 */
export const libraryRouter = Router();

const PLACEHOLDER_THUMBNAIL = "/hero-living-room.jpg";

function toSceneDTO(row: any) {
  return {
    id: row.id,
    name: row.name,
    thumbnail: row.thumbnail_url,
    description: row.description,
    status: row.status,
    createdAt: row.created_at,
  };
}
function toObjectDTO(row: any) {
  return {
    id: row.id,
    name: row.name,
    thumbnail: row.thumbnail_url,
    description: row.description,
    status: row.status,
    createdAt: row.created_at,
    modelUrl: row.model_url,
    assetKind: row.asset_kind,
  };
}

// 縮圖真的截圖存起來——見 backend/src/generateThumbnails.ts,那是一次性/可重複執行的批次腳本
// (不是掛在正式網站上的功能),用 Puppeteer 開 frontend/src/views/ThumbnailCapturePage.vue,
// 把場景/物件實際載入渲染一次、對著世界座標包圍盒置中截圖,再直接寫進這兩支路由的檔案/資料庫,
// 取代原本每個項目都共用同一張佔位圖的狀態。存在 backend 自己的 storage/ 目錄(不是前端
// public/),由 app.ts 的 express.static('/storage', ...) 直接served,DB 只存完整 URL。
const THUMBNAILS_DIR = path.join(__dirname, "..", "..", "storage", "thumbnails");
fs.mkdirSync(THUMBNAILS_DIR, { recursive: true });
const MODELS_DIR = path.join(__dirname, "..", "..", "storage", "models");
fs.mkdirSync(MODELS_DIR, { recursive: true });

function makeThumbnailUpload(prefix: string) {
  return multer({
    storage: multer.diskStorage({
      destination: THUMBNAILS_DIR,
      filename: (req, _file, cb) => cb(null, `${prefix}-${req.params.id}.jpg`),
    }),
    limits: { fileSize: 10 * 1024 * 1024 },
  });
}
const uploadSceneThumbnail = makeThumbnailUpload("scene");
const uploadObjectThumbnail = makeThumbnailUpload("object");

// 使用者上傳模型元件用——接受 .ply(gsplat,我們的 3D 檢視器直接看得懂)跟 .glb(一般網格,
// PlayCanvas 引擎內建 gltf/glb 解析器,GSplatViewer.vue 另外走一條網格渲染路徑)。obj/fbx 沒有
// 現成的瀏覽器端解析器/引擎內建支援(obj 要自己寫 parser,fbx 業界通常離線轉檔),UploadModal.vue
// 那邊選這兩種格式維持「只選檔不真上傳」的 placeholder 狀態,不接這支路由。
const UPLOADABLE_EXTENSIONS: Record<string, "gsplat" | "mesh"> = { ".ply": "gsplat", ".glb": "mesh" };

const uploadModelFile = multer({
  storage: multer.diskStorage({
    destination: MODELS_DIR,
    filename: (req, file, cb) => cb(null, `${req.userId}-${Date.now()}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!(path.extname(file.originalname).toLowerCase() in UPLOADABLE_EXTENSIONS)) {
      cb(new Error("只支援 .ply 或 .glb 格式"));
      return;
    }
    cb(null, true);
  },
});

function absoluteUrl(req: import("express").Request, relPath: string): string {
  return `${req.protocol}://${req.get("host")}${relPath}`;
}

/** multer(底層是 busboy)解析 multipart 表單的檔名時,把 Content-Disposition 標頭裡的
 * filename 參數當成 latin1 位元組解讀——但瀏覽器端組表單時檔名本身是用 UTF-8 編碼寫進那個
 * 位元組序列的,兩邊對不上,中文檔名(例如「AST-001_直式扶手.glb」這種真實資產檔名)因此變亂碼。
 * 這是 multer/busboy 行之有年、大家都在踩的已知行為,標準解法就是把拿到的字串重新用 latin1
 * 解回原始位元組,再照正確的 utf8 重新解讀一次。只套用在檔名上——multipart 表單「欄位值」
 * (例如 req.body.name)走的是 body 內容而非標頭參數解析,不會有這個問題,對它套用同一招
 * 反而會把原本正確的字串弄壞。 */
function fixMulterFilename(originalname: string): string {
  return Buffer.from(originalname, "latin1").toString("utf8");
}

/** 場景編輯頁面左側「模型列表」要用:這個場景可以加入哪些模型,是看它的「尋根」來源場景
 * (copied_from_scene_id,永遠指向最初來源,不會疊出一條複製鏈)決定,不是看它自己這個
 * (可能是複製出來的全新)id——不然「加入我的模型庫」複製出來的場景,因為原本那 466 個物件的
 * origin_scene_id 都還指向舊的場景 id,左側模型列表會是空的。 */
async function resolveOriginSceneId(sceneId: string): Promise<string> {
  const result = await pool.query(`SELECT copied_from_scene_id FROM library_scenes WHERE id = $1`, [sceneId]);
  return result.rows[0]?.copied_from_scene_id ?? sceneId;
}

libraryRouter.get("/library/scenes", requireAuth, async (req, res) => {
  const scope = req.query.scope === "all" ? "all" : "mine";
  const result = await pool.query(
    scope === "mine"
      ? `SELECT id, name, thumbnail_url, description, status, created_at
         FROM library_scenes WHERE owner_user_id = $1 ORDER BY created_at ASC`
      : `SELECT id, name, thumbnail_url, description, status, created_at
         FROM library_scenes ORDER BY created_at ASC`,
    scope === "mine" ? [req.userId] : []
  );
  res.json(result.rows.map(toSceneDTO));
});

/** 預覽彈窗點標題改名。WHERE owner_user_id = req.userId 同時做到「找不到」跟「不是你的」
 * 兩種情況都回 404,不用另外查一次擁有者是不是自己,也不會洩漏這筆記錄屬於別人這件事。 */
libraryRouter.patch("/library/scenes/:id", requireAuth, async (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!name) return res.status(400).json({ error: "名稱不能空白" });
  const result = await pool.query(
    `UPDATE library_scenes SET name = $3 WHERE id = $1 AND owner_user_id = $2 RETURNING *`,
    [req.params.id, req.userId, name]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: "找不到這個場景,或你不是擁有者" });
  res.json(toSceneDTO(result.rows[0]));
});

libraryRouter.get("/library/objects", requireAuth, async (req, res) => {
  const sceneIdParam = typeof req.query.sceneId === "string" ? req.query.sceneId : undefined;
  // sceneId 是給場景編輯頁面用的(這個場景可以加入哪些模型),跟「我的模型庫/線上資產庫」的
  // 擁有者篩選是兩件不相干的事——不管模型是誰擁有的,只要是這個場景(或它的來源場景)切出來的
  // 就該出現在列表裡,不套用 scope 篩選。
  if (sceneIdParam) {
    const effectiveSceneId = await resolveOriginSceneId(sceneIdParam);
    const result = await pool.query(
      `SELECT id, name, thumbnail_url, description, model_url, status, asset_kind, created_at
       FROM library_objects WHERE origin_scene_id = $1 ORDER BY created_at ASC`,
      [effectiveSceneId]
    );
    return res.json(result.rows.map(toObjectDTO));
  }

  const scope = req.query.scope === "all" ? "all" : "mine";
  const result = await pool.query(
    scope === "mine"
      ? `SELECT id, name, thumbnail_url, description, model_url, status, asset_kind, created_at
         FROM library_objects WHERE owner_user_id = $1 ORDER BY created_at ASC`
      : // 線上資產庫:只列獨立資產(origin_scene_id 是 NULL,不是從某個場景切出來的),
        // 見檔案開頭的說明,不分擁有者但也不含場景切出來的物件。
        `SELECT id, name, thumbnail_url, description, model_url, status, asset_kind, created_at
         FROM library_objects WHERE origin_scene_id IS NULL ORDER BY created_at ASC`,
    scope === "mine" ? [req.userId] : []
  );
  res.json(result.rows.map(toObjectDTO));
});

libraryRouter.patch("/library/objects/:id", requireAuth, async (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!name) return res.status(400).json({ error: "名稱不能空白" });
  const result = await pool.query(
    `UPDATE library_objects SET name = $3 WHERE id = $1 AND owner_user_id = $2 RETURNING *`,
    [req.params.id, req.userId, name]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: "找不到這個物件,或你不是擁有者" });
  res.json(toObjectDTO(result.rows[0]));
});

/** 「線上資產庫」按「加入我的模型庫」:複製一份新場景記錄(新 id,owner_user_id 設成自己),
 * 並把來源場景目前的物件擺放記錄(scene_object_instances)也複製一份過去,不然剛加入的場景
 * 在編輯頁面打開會是空的、看起來像壞掉。 */
libraryRouter.post("/library/scenes/:id/copy", requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sceneResult = await client.query(`SELECT * FROM library_scenes WHERE id = $1`, [req.params.id]);
    if (sceneResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "找不到這個場景" });
    }
    const original = sceneResult.rows[0];
    const newId = `copy-${Date.now()}-${original.id}`;
    const rootSceneId = original.copied_from_scene_id ?? original.id;

    await client.query(
      `INSERT INTO library_scenes (id, name, thumbnail_url, description, owner_user_id, copied_from_scene_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [newId, original.name, original.thumbnail_url, original.description, req.userId, rootSceneId]
    );

    const instancesResult = await client.query(`SELECT * FROM scene_object_instances WHERE scene_id = $1`, [
      req.params.id,
    ]);
    let counter = 0;
    for (const inst of instancesResult.rows) {
      counter += 1;
      await client.query(
        `INSERT INTO scene_object_instances
           (id, scene_id, model_id, label, hidden, pos_x, pos_y, pos_z, rot_x, rot_y, rot_z, scale_x, scale_y, scale_z)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          `${newId}-inst-${counter}`,
          newId,
          inst.model_id,
          inst.label,
          inst.hidden,
          inst.pos_x,
          inst.pos_y,
          inst.pos_z,
          inst.rot_x,
          inst.rot_y,
          inst.rot_z,
          inst.scale_x,
          inst.scale_y,
          inst.scale_z,
        ]
      );
    }

    await client.query("COMMIT");
    res.status(201).json(
      toSceneDTO({ ...original, id: newId, created_at: new Date() })
    );
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

/** 「線上資產庫」按「加入我的模型庫」(單一模型元件版):複製一份新物件記錄,owner_user_id
 * 設成自己。實際的 .ply 檔案不用複製,新記錄的 model_url 直接指向同一個檔案就好。 */
libraryRouter.post("/library/objects/:id/copy", requireAuth, async (req, res) => {
  const original = await pool.query(`SELECT * FROM library_objects WHERE id = $1`, [req.params.id]);
  if (original.rows.length === 0) return res.status(404).json({ error: "找不到這個物件" });
  const o = original.rows[0];
  // id 刻意保留原本的 id 當後綴(不是隨機/純序號)——upAxisFixFor()(前端 stores/library.ts)
  // 靠 id 裡有沒有出現 'interiorgs839920-' 這個字樣判斷資料來源該用哪個座標轉正角度,複製出來的
  // 新記錄如果換成完全無關的新 id,這個判斷就會失效,複製過去的 InteriorGS 物件會轉向錯誤。
  const newId = `copy-${Date.now()}-${o.id}`;
  // clip_embedding 也要一起複製——複製版跟原始版共用同一個 model_url/thumbnail_url,
  // embedding 是對縮圖算出來的,理論上完全一樣,不用重跑 CLIP 批次腳本。漏複製這個欄位的話,
  // scoreCandidates()(clip/matchInstances.ts)查詢時 WHERE clip_embedding IS NOT NULL
  // 會直接把複製出來的這份濾掉,語意編輯指令永遠找不到它(2026-08-04 實測到的真實案例)。
  await pool.query(
    `INSERT INTO library_objects
       (id, name, thumbnail_url, description, model_url, origin_scene_id, owner_user_id, asset_kind, clip_embedding)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [newId, o.name, o.thumbnail_url, o.description, o.model_url, o.origin_scene_id, req.userId, o.asset_kind, o.clip_embedding]
  );
  res.status(201).json(toObjectDTO({ ...o, id: newId, created_at: new Date() }));
});

/** 真的上傳一個模型元件(.ply)——建立一筆新的 library_objects 記錄,owner_user_id 設成上傳者,
 * 立刻出現在自己的「我的模型庫」。場景包裝格式(.usdz/.gltf)沒有這支路由,見上面 uploadModelFile
 * 的說明。
 *
 * 不用 uploadModelFile.single(...) 直接當 route middleware——multer 的 fileFilter/檔案大小超過
 * limit 這些錯誤預設會被 express-async-errors 接住、掉進 app.ts 最後那個「系統內部錯誤」的通用
 * 500 handler,前端只看得到一句沒意義的「系統內部錯誤」,看不到 fileFilter 真正丟出來的
 * 「只支援 .ply 格式」這句話。改成手動呼叫、自己接 callback 的錯誤,才能回一個乾淨的 400
 * 加上真正的錯誤訊息。 */
libraryRouter.post("/library/objects", requireAuth, (req, res) => {
  uploadModelFile.single("model")(req, res, async (err: unknown) => {
    if (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "上傳失敗" });
      return;
    }
    try {
      if (!req.file) {
        res.status(400).json({ error: "缺少模型檔案(.ply 或 .glb)" });
        return;
      }
      const originalname = fixMulterFilename(req.file.originalname);
      const ext = path.extname(originalname).toLowerCase();
      const assetKind = UPLOADABLE_EXTENSIONS[ext] ?? "gsplat";
      const name = (typeof req.body?.name === "string" && req.body.name.trim()) || originalname.replace(/\.(ply|glb)$/i, "");
      const modelUrl = absoluteUrl(req, `/storage/models/${req.file.filename}`);
      const newId = `object-${req.userId}-${Date.now()}`;
      await pool.query(
        `INSERT INTO library_objects (id, name, thumbnail_url, description, model_url, owner_user_id, asset_kind)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [newId, name, PLACEHOLDER_THUMBNAIL, "使用者上傳的模型元件。", modelUrl, req.userId, assetKind]
      );
      res.status(201).json(
        toObjectDTO({
          id: newId,
          name,
          thumbnail_url: PLACEHOLDER_THUMBNAIL,
          description: "使用者上傳的模型元件。",
          status: "ready",
          created_at: new Date(),
          model_url: modelUrl,
          asset_kind: assetKind,
        })
      );
    } catch (innerErr) {
      res.status(500).json({
        error: "系統內部錯誤",
        detail: innerErr instanceof Error ? innerErr.message : String(innerErr),
      });
    }
  });
});

libraryRouter.post(
  "/library/scenes/:id/thumbnail",
  requireAuth,
  uploadSceneThumbnail.single("thumbnail"),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "缺少縮圖檔案" });
    const url = absoluteUrl(req, `/storage/thumbnails/${req.file.filename}`);
    const result = await pool.query(`UPDATE library_scenes SET thumbnail_url = $2 WHERE id = $1 RETURNING id`, [
      req.params.id,
      url,
    ]);
    if (result.rowCount === 0) return res.status(404).json({ error: "找不到這個場景" });
    res.json({ thumbnailUrl: url });
  }
);

libraryRouter.post(
  "/library/objects/:id/thumbnail",
  requireAuth,
  uploadObjectThumbnail.single("thumbnail"),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "缺少縮圖檔案" });
    const url = absoluteUrl(req, `/storage/thumbnails/${req.file.filename}`);
    const result = await pool.query(`UPDATE library_objects SET thumbnail_url = $2 WHERE id = $1 RETURNING id`, [
      req.params.id,
      url,
    ]);
    if (result.rowCount === 0) return res.status(404).json({ error: "找不到這個物件" });

    const filePath = req.file.path;
    const objectId = req.params.id;
    embedImageFile(filePath)
      .then((embedding) => pool.query(`UPDATE library_objects SET clip_embedding = $2 WHERE id = $1`, [objectId, embedding]))
      .catch((err) => console.error(`[clip] ${objectId} embedding 失敗:`, err instanceof Error ? err.message : err));

    res.json({ thumbnailUrl: url });
  }
);
