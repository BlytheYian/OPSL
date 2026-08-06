import { Router } from "express";
import { pool } from "../db";
import { requireAuth } from "../auth";
import {
  CreateInstanceRequestSchema,
  UpdateInstanceRequestSchema,
  EditCommandRequestSchema,
  CreateVersionRequestSchema,
} from "../schemas";
import { resolveEditCommand } from "../llm/editCommand";
import { findReplacementModel } from "../clip/matchInstances";
import { detectRisks, type RiskMarker } from "../riskDetection";
import { detectSceneFloor, computeFloorBounds } from "../floorDetection";
import { suggestAssetsByRiskType } from "../riskRemediation";
import { detectRoute } from "../routeDetection";

async function withSuggestedAssets<T extends { riskType: RiskMarker["riskType"] }>(
  markers: T[]
): Promise<(T & { suggestedAssets: { id: string; name: string }[] })[]> {
  const suggestionsByType = await suggestAssetsByRiskType(markers.map((m) => m.riskType));
  return markers.map((marker) => ({ ...marker, suggestedAssets: suggestionsByType[marker.riskType] ?? [] }));
}

/**
 * 場景內物件擺放記錄(SceneObjectInstance)的 CRUD,取代前端 stores/sceneObjects.ts
 * 原本的 localStorage 持久化。單一租戶示範資料,不做 OPSL 那種擁有者/分享權限控管——
 * 任何登入使用者都可讀寫任何場景,跟現在 localStorage 版本的行為一致。
 */
export const scenesRouter = Router();

function toInstanceDTO(row: any) {
  return {
    id: row.id,
    sceneId: row.scene_id,
    modelId: row.model_id,
    label: row.label,
    hidden: row.hidden,
    position: [row.pos_x, row.pos_y, row.pos_z],
    rotation: [row.rot_x, row.rot_y, row.rot_z],
    scale: [row.scale_x, row.scale_y, row.scale_z],
    color: row.color,
  };
}

let instanceCounter = 0;
function makeInstanceId() {
  instanceCounter += 1;
  return `inst-${Date.now()}-${instanceCounter}`;
}

scenesRouter.get("/scenes/:sceneId/objects", requireAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT * FROM scene_object_instances WHERE scene_id = $1 ORDER BY created_at ASC`,
    [req.params.sceneId]
  );
  res.json(result.rows.map(toInstanceDTO));
});

scenesRouter.post("/scenes/:sceneId/objects", requireAuth, async (req, res) => {
  const parsed = CreateInstanceRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "請求格式錯誤", detail: parsed.error.flatten() });
  }
  const { modelId, label } = parsed.data;
  const id = makeInstanceId();
  const result = await pool.query(
    `INSERT INTO scene_object_instances (id, scene_id, model_id, label)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [id, req.params.sceneId, modelId, label]
  );
  res.status(201).json(toInstanceDTO(result.rows[0]));
});

scenesRouter.patch("/scenes/:sceneId/objects/:instanceId", requireAuth, async (req, res) => {
  const parsed = UpdateInstanceRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "請求格式錯誤", detail: parsed.error.flatten() });
  }
  const { label, hidden, position, rotation, scale, color } = parsed.data;
  // color 是唯一需要區分「沒送這個欄位」跟「送了但值是 null(清掉染色)」的欄位——其他欄位
  // 用 COALESCE($n, 原值) 就好(沒送就是 null,保留原值),但 color 的 null 本身就是合法的
  // 目標值(復原成原始外觀),不能跟「沒送」共用同一個 SQL NULL 表示,所以另外傳一個
  // colorProvided 布林值,SQL 用 CASE 判斷,而不是 COALESCE。
  const colorProvided = color !== undefined;

  const result = await pool.query(
    `UPDATE scene_object_instances SET
       label = COALESCE($3, label),
       hidden = COALESCE($4, hidden),
       pos_x = COALESCE($5, pos_x), pos_y = COALESCE($6, pos_y), pos_z = COALESCE($7, pos_z),
       rot_x = COALESCE($8, rot_x), rot_y = COALESCE($9, rot_y), rot_z = COALESCE($10, rot_z),
       scale_x = COALESCE($11, scale_x), scale_y = COALESCE($12, scale_y), scale_z = COALESCE($13, scale_z),
       color = CASE WHEN $15 THEN $14 ELSE color END
     WHERE id = $1 AND scene_id = $2
     RETURNING *`,
    [
      req.params.instanceId,
      req.params.sceneId,
      label ?? null,
      hidden ?? null,
      position?.[0] ?? null,
      position?.[1] ?? null,
      position?.[2] ?? null,
      rotation?.[0] ?? null,
      rotation?.[1] ?? null,
      rotation?.[2] ?? null,
      scale?.[0] ?? null,
      scale?.[1] ?? null,
      scale?.[2] ?? null,
      color ?? null,
      colorProvided,
    ]
  );
  if (result.rows.length === 0) {
    return res.status(404).json({ error: "找不到這筆物件記錄" });
  }
  res.json(toInstanceDTO(result.rows[0]));
});

scenesRouter.delete("/scenes/:sceneId/objects/:instanceId", requireAuth, async (req, res) => {
  await pool.query(`DELETE FROM scene_object_instances WHERE id = $1 AND scene_id = $2`, [
    req.params.instanceId,
    req.params.sceneId,
  ]);
  res.status(204).end();
});

/** 自然語言編輯指令——呼叫本機 Ollama(見 llm/editCommand.ts)分兩階段把使用者打的中文句子
 * 解析成「哪個/哪些物件、位置/旋轉/縮放的相對調整量、要不要改顏色」:第一階段是視覺定位(前端
 * 傳來目前畫面截圖 + 每個可見 instance 投影後的螢幕座標,模型看圖找出指令指的是哪個/哪些),
 * 第二階段是純文字語意轉換(指令要做什麼調整)。物件是哪個/哪些不再靠場景資料庫裡的 id/label
 * 文字比對——「紅色的花」「左數第二個」這類靠視覺/空間才分辨得出來的描述,文字清單裡完全編碼
 * 不出這些資訊。position/rotation 用「相對調整量」(delta)、scale 用「倍率」(multiplier)而不是
 * 要模型直接給絕對數值——絕對座標系需要模型對場景的空間感遠超過它實際能力,「往右移一點」這種
 * 指令換算成相對量對一個小模型來說容易得多、也比較不會亂猜。
 *
 * 驗證過後套用到符合的 scene_object_instances 記錄(可能不只一筆,例如「所有椅子」),回傳全部
 * 更新後的 instance(前端可以直接拿去更新畫面,不用另外重新 fetch)。 */
scenesRouter.post("/scenes/:sceneId/edit-commands", requireAuth, async (req, res) => {
  const parsed = EditCommandRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "請求格式錯誤", detail: parsed.error.flatten() });
  }

  let actions;
  try {
    actions = await resolveEditCommand(
      parsed.data.command,
      parsed.data.image,
      parsed.data.instances,
      parsed.data.previousContext ?? null,
      parsed.data.cameraAxes ?? null
    );
  } catch (err) {
    return res.status(422).json({ error: err instanceof Error ? err.message : "指令解析失敗" });
  }

  // 一句話可能被切分成好幾個各自獨立的動作(見 llm/editCommand.ts 的說明,例如「椅子恢復木頭色,
  // 左邊的椅子改成淺藍色」是兩個不同目標各自的改動)——每個動作各自下一次 UPDATE,不能合併成
  // 一次下,不然不同動作的顏色/位置調整會互相覆蓋掉。用 Map 依 id 去重,同一筆記錄如果先後被
  // 兩個動作都改到,只保留最後一次的結果。
  const updatedById = new Map<string, ReturnType<typeof toInstanceDTO>>();
  const removedIds = new Set<string>();
  const added: ReturnType<typeof toInstanceDTO>[] = [];
  const intendedPositions: Record<string, [number, number, number]> = {};
  const reasonings: string[] = [];

  for (const action of actions) {
    if (action.reasoning) reasonings.push(action.reasoning);

    if (action.action === "delete") {
      const result = await pool.query(
        `DELETE FROM scene_object_instances WHERE id = ANY($1) AND scene_id = $2 RETURNING id`,
        [action.instanceIds, req.params.sceneId]
      );
      for (const row of result.rows) {
        updatedById.delete(row.id);
        removedIds.add(row.id);
      }
      continue;
    }

    if (action.action === "place") {
      if (!action.placementQuery) continue;
      const newModel = await findReplacementModel(action.placementQuery);
      if (!newModel) {
        return res.status(422).json({ error: `找不到符合「${action.placementQuery}」的物件` });
      }

      let targetX = 0, targetY = 0, targetZ = 0;
      if (action.instanceIds.length > 0) {
        const refInstance = parsed.data.instances.find((i) => i.id === action.instanceIds[0]);
        if (refInstance?.worldPos) {
          [targetX, targetY, targetZ] = refInstance.worldPos;
        }
      }

      const offset = action.positionDelta ?? [0.5, 0, 0];
      targetX += offset[0];
      targetY += offset[1];
      targetZ += offset[2];

      const newId = makeInstanceId();
      const insertResult = await pool.query(
        `INSERT INTO scene_object_instances (id, scene_id, model_id, label, pos_x, pos_y, pos_z)
         VALUES ($1, $2, $3, $4, 0, 0, 0) RETURNING *`,
        [newId, req.params.sceneId, newModel.id, newModel.name]
      );
      added.push(toInstanceDTO(insertResult.rows[0]));
      intendedPositions[newId] = [targetX, targetY, targetZ];
      continue;
    }

    if (action.action === "replace") {
      const replacement = action.replacementQuery ? await findReplacementModel(action.replacementQuery) : null;
      if (!replacement) {
        return res.status(422).json({ error: "找不到符合描述的替代模型" });
      }
      const targetsResult = await pool.query(
        `SELECT * FROM scene_object_instances WHERE id = ANY($1) AND scene_id = $2`,
        [action.instanceIds, req.params.sceneId]
      );
      for (const row of targetsResult.rows) {
        await pool.query(`DELETE FROM scene_object_instances WHERE id = $1`, [row.id]);
        updatedById.delete(row.id);
        removedIds.add(row.id);

        const refInstance = parsed.data.instances.find((i) => i.id === row.id);
        const newId = makeInstanceId();
        const insertResult = await pool.query(
          `INSERT INTO scene_object_instances (id, scene_id, model_id, label, pos_x, pos_y, pos_z, color)
           VALUES ($1, $2, $3, $4, 0, 0, 0, $5) RETURNING *`,
          [newId, req.params.sceneId, replacement.id, replacement.name, row.color]
        );
        added.push(toInstanceDTO(insertResult.rows[0]));
        if (refInstance?.worldPos) intendedPositions[newId] = refInstance.worldPos;
      }
      continue;
    }

    const result = await pool.query(
      // COALESCE($n, 0)/COALESCE($n, 1) 的字面 0/1 不能寫成裸數字——Postgres 從查詢文字推斷參數
      // 型別時,會拿 COALESCE 裡另一個分支(裸的整數字面量)去統一型別,把 $n 定成 INTEGER,
      // 之後綁進去的浮點數(例如 0.3)就會因為型別對不上被拒絕。寫成 0::numeric/1::numeric
      // 明確標型別,參數就會正確被推斷成 NUMERIC。
      // WHERE id = ANY($1) 一次套用到所有符合的 id(可能只有一筆,也可能是「所有椅子」那種
      // 好幾筆),不用在應用層迴圈一筆一筆下 UPDATE。
      //
      // CASE WHEN reset* THEN <初始值> ELSE <原本疊加/相乘邏輯> END——「恢復原狀」沒辦法用
      // COALESCE 表達(見 schemas.ts LLMEditDeltaSchema 的說明,delta 是null 只代表「沒有要求
      // 調整」,不是「調整到 0」),resetPosition/resetRotation/resetScale 為 true 時直接設回
      // 新增時的初始值(位置原點、不旋轉、原始大小),不管 delta 欄位有沒有值都不理會。color
      // 同理,resetColor 為 true 時明確設回 NULL(清掉染色),不是 COALESCE 保留原值。action 是
      // "hide" 時 hidden 直接設 true,其餘情況(adjust)保留原值不動。
      `UPDATE scene_object_instances SET
         pos_x = CASE WHEN $13 THEN 0::numeric ELSE pos_x + COALESCE($3, 0::numeric) END,
         pos_y = CASE WHEN $13 THEN 0::numeric ELSE pos_y + COALESCE($4, 0::numeric) END,
         pos_z = CASE WHEN $13 THEN 0::numeric ELSE pos_z + COALESCE($5, 0::numeric) END,
         rot_x = CASE WHEN $14 THEN 0::numeric ELSE rot_x + COALESCE($6, 0::numeric) END,
         rot_y = CASE WHEN $14 THEN 0::numeric ELSE rot_y + COALESCE($7, 0::numeric) END,
         rot_z = CASE WHEN $14 THEN 0::numeric ELSE rot_z + COALESCE($8, 0::numeric) END,
         scale_x = CASE WHEN $15 THEN 1::numeric ELSE scale_x * COALESCE($9, 1::numeric) END,
         scale_y = CASE WHEN $15 THEN 1::numeric ELSE scale_y * COALESCE($10, 1::numeric) END,
         scale_z = CASE WHEN $15 THEN 1::numeric ELSE scale_z * COALESCE($11, 1::numeric) END,
         color = CASE WHEN $16 THEN NULL ELSE COALESCE($12, color) END,
         hidden = CASE WHEN $17 THEN true ELSE hidden END
       WHERE id = ANY($1) AND scene_id = $2
       RETURNING *`,
      [
        action.instanceIds,
        req.params.sceneId,
        action.positionDelta?.[0] ?? null,
        action.positionDelta?.[1] ?? null,
        action.positionDelta?.[2] ?? null,
        action.rotationDelta?.[0] ?? null,
        action.rotationDelta?.[1] ?? null,
        action.rotationDelta?.[2] ?? null,
        action.scaleMultiplier?.[0] ?? null,
        action.scaleMultiplier?.[1] ?? null,
        action.scaleMultiplier?.[2] ?? null,
        action.color ?? null,
        action.resetPosition,
        action.resetRotation,
        action.resetScale,
        action.resetColor,
        action.action === "hide",
      ]
    );
    for (const row of result.rows) updatedById.set(row.id, toInstanceDTO(row));
  }

  if (updatedById.size === 0 && removedIds.size === 0 && added.length === 0) {
    return res.status(404).json({ error: "找不到符合的物件記錄" });
  }
  res.json({
    instances: [...updatedById.values()],
    removedIds: [...removedIds],
    added,
    intendedPositions,
    reasoning: reasonings.join(" ") || null,
  });
});


scenesRouter.post("/scenes/:sceneId/risk-check", requireAuth, async (req, res) => {
  const markers = await detectRisks(req.params.sceneId);
  res.json(await withSuggestedAssets(markers));
});

scenesRouter.get("/scenes/:sceneId/floor-detection", requireAuth, async (req, res) => {
  const result = await detectSceneFloor(req.params.sceneId);
  if (!result?.mainFloor) return res.json({ bounds: null });
  res.json({ bounds: computeFloorBounds(result.mainFloor) });
});

scenesRouter.post("/scenes/:sceneId/route-detection", requireAuth, async (req, res) => {
  const result = await detectRoute(req.params.sceneId);
  res.json(result ?? null);
});

scenesRouter.delete("/scenes/:sceneId/versions/:versionId", requireAuth, async (req, res) => {
  await pool.query(
    `DELETE FROM scene_versions WHERE id = $1 AND scene_id = $2 AND source_commands = '[]'::jsonb`,
    [req.params.versionId, req.params.sceneId]
  );
  res.status(204).end();
});

scenesRouter.post("/scenes/:sceneId/versions", requireAuth, async (req, res) => {
  await pool.query(
    `DELETE FROM scene_versions
     WHERE scene_id = $1
       AND id = (SELECT id FROM scene_versions WHERE scene_id = $1 ORDER BY version_number DESC LIMIT 1)
       AND source_commands = '[]'::jsonb`,
    [req.params.sceneId]
  );

  const instancesResult = await pool.query(
    `SELECT * FROM scene_object_instances WHERE scene_id = $1 ORDER BY created_at ASC`,
    [req.params.sceneId]
  );
  const nextResult = await pool.query(
    `SELECT COALESCE(MAX(version_number), 0) + 1 AS next FROM scene_versions WHERE scene_id = $1`,
    [req.params.sceneId]
  );
  const versionNumber = nextResult.rows[0].next;
  const result = await pool.query(
    `INSERT INTO scene_versions (scene_id, version_number, created_by, snapshot, source_commands)
     VALUES ($1, $2, $3, $4, '[]'::jsonb)
     RETURNING id, version_number, created_at, source_commands, reverted_from_version_id`,
    [req.params.sceneId, versionNumber, req.userId, JSON.stringify(instancesResult.rows)]
  );
  const newVersionId = result.rows[0].id;

  const riskMarkers = await detectRisks(req.params.sceneId);
  for (const marker of riskMarkers) {
    await pool.query(
      `INSERT INTO risk_markers
         (scene_version_id, risk_type, bbox_min_x, bbox_min_y, bbox_min_z, bbox_max_x, bbox_max_y, bbox_max_z)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        newVersionId,
        marker.riskType,
        marker.bboxMin[0],
        marker.bboxMin[1],
        marker.bboxMin[2],
        marker.bboxMax[0],
        marker.bboxMax[1],
        marker.bboxMax[2],
      ]
    );
  }

  res.status(201).json(toVersionDTO(result.rows[0]));
});

scenesRouter.get("/scenes/:sceneId/versions/:versionId/risks", requireAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT rm.id, rm.risk_type, rm.bbox_min_x, rm.bbox_min_y, rm.bbox_min_z, rm.bbox_max_x, rm.bbox_max_y, rm.bbox_max_z
     FROM risk_markers rm
     JOIN scene_versions sv ON sv.id = rm.scene_version_id
     WHERE rm.scene_version_id = $1 AND sv.scene_id = $2`,
    [req.params.versionId, req.params.sceneId]
  );
  const markers = result.rows.map((row) => ({
    id: row.id,
    riskType: row.risk_type as RiskMarker["riskType"],
    bboxMin: [Number(row.bbox_min_x), Number(row.bbox_min_y), Number(row.bbox_min_z)] as [number, number, number],
    bboxMax: [Number(row.bbox_max_x), Number(row.bbox_max_y), Number(row.bbox_max_z)] as [number, number, number],
  }));
  res.json(await withSuggestedAssets(markers));
});

function toVersionDTO(row: any) {
  return {
    id: row.id,
    versionNumber: row.version_number,
    createdAt: row.created_at,
    sourceCommands: row.source_commands,
    revertedFromVersionId: row.reverted_from_version_id,
  };
}

scenesRouter.patch("/scenes/:sceneId/versions/:versionId/commands", requireAuth, async (req, res) => {
  const { sourceCommands } = req.body;
  if (!Array.isArray(sourceCommands)) return res.status(400).json({ error: "格式錯誤" });
  await pool.query(
    `UPDATE scene_versions SET source_commands = $1 WHERE id = $2 AND scene_id = $3`,
    [JSON.stringify(sourceCommands), req.params.versionId, req.params.sceneId]
  );
  res.status(204).end();
});

scenesRouter.get("/scenes/:sceneId/versions", requireAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT id, version_number, created_at, source_commands, reverted_from_version_id FROM scene_versions
     WHERE scene_id = $1 ORDER BY version_number DESC`,
    [req.params.sceneId]
  );
  res.json(result.rows.map(toVersionDTO));
});

scenesRouter.get("/scenes/:sceneId/versions/:versionId/instances", requireAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT snapshot FROM scene_versions WHERE id = $1 AND scene_id = $2`,
    [req.params.versionId, req.params.sceneId]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: "找不到這個版本" });
  const rows = result.rows[0].snapshot as any[];
  res.json(rows.map(toInstanceDTO));
});

scenesRouter.post("/scenes/:sceneId/versions/:versionId/restore", requireAuth, async (req, res) => {
  const versionResult = await pool.query(
    `SELECT snapshot FROM scene_versions WHERE id = $1 AND scene_id = $2`,
    [req.params.versionId, req.params.sceneId]
  );
  if (versionResult.rows.length === 0) {
    return res.status(404).json({ error: "找不到這個版本" });
  }
  const snapshot = versionResult.rows[0].snapshot as any[];

  const client = await pool.connect();
  let newVersionRow: any;
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM scene_object_instances WHERE scene_id = $1`, [req.params.sceneId]);
    for (const row of snapshot) {
      await client.query(
        `INSERT INTO scene_object_instances
           (id, scene_id, model_id, label, hidden, pos_x, pos_y, pos_z, rot_x, rot_y, rot_z, scale_x, scale_y, scale_z, color)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          row.id,
          req.params.sceneId,
          row.model_id,
          row.label,
          row.hidden,
          row.pos_x,
          row.pos_y,
          row.pos_z,
          row.rot_x,
          row.rot_y,
          row.rot_z,
          row.scale_x,
          row.scale_y,
          row.scale_z,
          row.color,
        ]
      );
    }

    const nextResult = await client.query(
      `SELECT COALESCE(MAX(version_number), 0) + 1 AS next FROM scene_versions WHERE scene_id = $1`,
      [req.params.sceneId]
    );
    const versionInsert = await client.query(
      `INSERT INTO scene_versions
         (scene_id, version_number, created_by, snapshot, source_commands, reverted_from_version_id, reverted_by)
       VALUES ($1, $2, $3, $4, '[]'::jsonb, $5, $6)
       RETURNING id, version_number, created_at, source_commands, reverted_from_version_id`,
      [
        req.params.sceneId,
        nextResult.rows[0].next,
        req.userId,
        JSON.stringify(snapshot),
        req.params.versionId,
        req.userId,
      ]
    );
    newVersionRow = versionInsert.rows[0];
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  const result = await pool.query(
    `SELECT * FROM scene_object_instances WHERE scene_id = $1 ORDER BY created_at ASC`,
    [req.params.sceneId]
  );
  res.json({ instances: result.rows.map(toInstanceDTO), newVersion: toVersionDTO(newVersionRow) });
});

scenesRouter.post("/scenes/:sceneId/build", requireAuth, async (_req, res) => {
  res.status(501).json({ error: "尚未實作", note: "上傳素材建場景,對應之後的訓練場景流程" });
});

scenesRouter.get("/scenes/:sceneId/build/:jobId", requireAuth, async (_req, res) => {
  res.status(501).json({ error: "尚未實作", note: "建場任務狀態輪詢" });
});

scenesRouter.get("/scenes/:sceneId/care-giver-ideas", requireAuth, async (_req, res) => {
  res.status(501).json({ error: "尚未實作", note: "構想管理" });
});

scenesRouter.post("/scenes/:sceneId/care-giver-ideas", requireAuth, async (_req, res) => {
  res.status(501).json({ error: "尚未實作", note: "構想管理" });
});

scenesRouter.post("/care-giver-ideas/:id/feasibility", requireAuth, async (_req, res) => {
  res.status(501).json({ error: "尚未實作", note: "可行性評估" });
});
