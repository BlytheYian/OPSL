// ===== 舊版:自訂家具邊角/雜物兩類規則(先註解停用,改用下方對齊 OPSL 原始 4 類型的版本) =====
// import { pool } from "./db";
//
// const RISK_BBOX_HALF = 0.15;
//
// export type RiskType = "家具邊角" | "雜物" | "地面高低差";
//
// export interface RiskMarker {
//   riskType: RiskType;
//   bboxMin: [number, number, number];
//   bboxMax: [number, number, number];
// }
//
// async function detectFurnitureAndClutterRisks(sceneId: string): Promise<RiskMarker[]> {
//   const result = await pool.query(
//     `SELECT si.pos_x, si.pos_y, si.pos_z, lo.category, lo.baked_centroid_x, lo.baked_centroid_y, lo.baked_centroid_z
//      FROM scene_object_instances si
//      JOIN library_objects lo ON lo.id = si.model_id
//      WHERE si.scene_id = $1 AND si.hidden = false AND lo.category IN ('家具', '雜物')`,
//     [sceneId]
//   );
//   return result.rows.map((row) => {
//     const baseX = row.baked_centroid_x !== null ? Number(row.baked_centroid_x) : 0;
//     const baseY = row.baked_centroid_y !== null ? Number(row.baked_centroid_y) : 0;
//     const baseZ = row.baked_centroid_z !== null ? Number(row.baked_centroid_z) : 0;
//     const x = baseX + Number(row.pos_x);
//     const y = baseY + Number(row.pos_y);
//     const z = baseZ + Number(row.pos_z);
//     return {
//       riskType: row.category === "家具" ? "家具邊角" : "雜物",
//       bboxMin: [x - RISK_BBOX_HALF, y, z - RISK_BBOX_HALF],
//       bboxMax: [x + RISK_BBOX_HALF, y + RISK_BBOX_HALF * 2, z + RISK_BBOX_HALF],
//     };
//   });
// }
//
// export async function detectRisks(sceneId: string): Promise<RiskMarker[]> {
//   return detectFurnitureAndClutterRisks(sceneId);
// }
// ===== 舊版結束 =====

import fs from "fs";
import path from "path";
import { pool } from "./db";

const RISK_BBOX_HALF = 0.15;

export type RiskType = "門檻" | "家具邊角" | "地面高低差" | "走道障礙";

export interface RiskMarker {
  riskType: RiskType;
  bboxMin: [number, number, number];
  bboxMax: [number, number, number];
}

// 走道障礙判斷用:雜物離所有「同一區域(Y 相近,避免跨樓層/跨區誤判)」家具的 XZ 距離都超過這個
// 半徑,就視為坐落在開放地板空間、可能擋住無障礙動線。OPSL 原本是靠場景 JSON 裡人工標記的
// region=='走道' 欄位,我們沒有這個資料,改用「離家具多遠」這個幾何代理指標。
const WALKWAY_FURNITURE_RADIUS = 0.6;
const WALKWAY_ZONE_Y_TOLERANCE = 1.0;

interface PositionedRow {
  x: number;
  y: number;
  z: number;
  category: string | null;
}

function resolvePosition(row: {
  pos_x: unknown;
  pos_y: unknown;
  pos_z: unknown;
  baked_centroid_x: unknown;
  baked_centroid_y: unknown;
  baked_centroid_z: unknown;
}): { x: number; y: number; z: number } {
  const baseX = row.baked_centroid_x !== null ? Number(row.baked_centroid_x) : 0;
  const baseY = row.baked_centroid_y !== null ? Number(row.baked_centroid_y) : 0;
  const baseZ = row.baked_centroid_z !== null ? Number(row.baked_centroid_z) : 0;
  return {
    x: baseX + Number(row.pos_x),
    y: baseY + Number(row.pos_y),
    z: baseZ + Number(row.pos_z),
  };
}

function isInOpenFloorSpace(pos: { x: number; y: number; z: number }, furniture: PositionedRow[]): boolean {
  for (const f of furniture) {
    if (Math.abs(pos.y - f.y) > WALKWAY_ZONE_Y_TOLERANCE) continue;
    const dx = pos.x - f.x;
    const dz = pos.z - f.z;
    if (Math.sqrt(dx * dx + dz * dz) < WALKWAY_FURNITURE_RADIUS) return false;
  }
  return true;
}

// 「離家具很遠」不代表真的站在地板上——也可能是坐落在完全沒有地板掃描資料的空區(場景邊界外、
// 掃描破洞),或其實是擺在某個高台/層架上,只是那個高台本身沒被判定成「家具」而已。這裡直接讀
// 場景自己的原始高斯點雲(background.ply)動態算出每個 XZ 位置「當地」的地板高度,而不是猜測或
// 沿用之前那組被證實不可靠的全域地板基準——物件真的貼著它所在位置的地板,才算數。
const FLOOR_GRID_CELL = 0.5;
const FLOOR_GRID_SEARCH_RADIUS_CELLS = 1;
const FLOOR_HEIGHT_ABOVE_FLOOR_MIN = -0.3;
const FLOOR_HEIGHT_ABOVE_FLOOR_MAX = 2.5;

interface FloorGrid {
  cellSize: number;
  cells: Map<string, number[]>;
}

function floorCellKey(x: number, z: number, cellSize: number): string {
  return `${Math.floor(x / cellSize)},${Math.floor(z / cellSize)}`;
}

function parsePlyPoints(filePath: string): Float32Array {
  const buf = fs.readFileSync(filePath);
  const headerEndMarker = Buffer.from("end_header\n");
  const headerEndIndex = buf.indexOf(headerEndMarker);
  const headerEnd = headerEndIndex + headerEndMarker.length;
  const header = buf.toString("ascii", 0, headerEnd);

  let vertexCount = 0;
  const properties: string[] = [];
  for (const line of header.split("\n")) {
    const vertexMatch = line.match(/^element vertex (\d+)/);
    if (vertexMatch) vertexCount = Number(vertexMatch[1]);
    const propMatch = line.match(/^property \S+ (\S+)/);
    if (propMatch) properties.push(propMatch[1]);
  }
  const stride = properties.length * 4;
  const xOffset = properties.indexOf("x") * 4;
  const yOffset = properties.indexOf("y") * 4;
  const zOffset = properties.indexOf("z") * 4;

  const points = new Float32Array(vertexCount * 3);
  let offset = headerEnd;
  for (let i = 0; i < vertexCount; i++) {
    points[i * 3] = buf.readFloatLE(offset + xOffset);
    points[i * 3 + 1] = buf.readFloatLE(offset + yOffset);
    points[i * 3 + 2] = buf.readFloatLE(offset + zOffset);
    offset += stride;
  }
  return points;
}

function buildFloorGrid(points: Float32Array): FloorGrid {
  const cells = new Map<string, number[]>();
  for (let i = 0; i < points.length / 3; i++) {
    const x = points[i * 3];
    const y = points[i * 3 + 1];
    const z = points[i * 3 + 2];
    const key = floorCellKey(x, z, FLOOR_GRID_CELL);
    let bucket = cells.get(key);
    if (!bucket) {
      bucket = [];
      cells.set(key, bucket);
    }
    bucket.push(y);
  }
  return { cellSize: FLOOR_GRID_CELL, cells };
}

function localFloorY(grid: FloorGrid, x: number, z: number): number | null {
  const cx = Math.floor(x / grid.cellSize);
  const cz = Math.floor(z / grid.cellSize);
  const ys: number[] = [];
  for (let dx = -FLOOR_GRID_SEARCH_RADIUS_CELLS; dx <= FLOOR_GRID_SEARCH_RADIUS_CELLS; dx++) {
    for (let dz = -FLOOR_GRID_SEARCH_RADIUS_CELLS; dz <= FLOOR_GRID_SEARCH_RADIUS_CELLS; dz++) {
      const bucket = grid.cells.get(`${cx + dx},${cz + dz}`);
      if (bucket) ys.push(...bucket);
    }
  }
  if (ys.length === 0) return null;
  ys.sort((a, b) => a - b);
  return ys[Math.floor(ys.length * 0.05)];
}

function resolveModelFilePath(modelUrl: string): string | null {
  const storageMatch = modelUrl.match(/\/storage\/(.+)$/);
  if (storageMatch) return path.join(__dirname, "..", "storage", storageMatch[1]);
  return null;
}

async function loadFloorGrid(sceneId: string): Promise<FloorGrid | null> {
  const result = await pool.query<{ model_url: string }>(
    `SELECT lo.model_url FROM scene_object_instances si
     JOIN library_objects lo ON lo.id = si.model_id
     WHERE si.scene_id = $1 AND lo.name = '背景' LIMIT 1`,
    [sceneId]
  );
  if (result.rows.length === 0) return null;
  const filePath = resolveModelFilePath(result.rows[0].model_url);
  if (!filePath || !fs.existsSync(filePath)) return null;
  return buildFloorGrid(parsePlyPoints(filePath));
}

function isNearLocalFloor(pos: { x: number; y: number; z: number }, floorGrid: FloorGrid | null): boolean {
  if (!floorGrid) return true; // 沒有地板掃描資料可查時,退回只靠家具距離判斷,不擋掉整個功能
  const floorY = localFloorY(floorGrid, pos.x, pos.z);
  if (floorY === null) return false; // 這個 XZ 位置附近完全沒有地板點雲資料,不是真的開放地板
  const heightAboveFloor = pos.y - floorY;
  return heightAboveFloor >= FLOOR_HEIGHT_ABOVE_FLOOR_MIN && heightAboveFloor <= FLOOR_HEIGHT_ABOVE_FLOOR_MAX;
}


// 對齊 OPSL scene_engine.py detect_risks() 的原始判斷邏輯(category==門檻/地面高低差 直接對應、
// category==雜物 且 region==走道 對應走道障礙)。我們目前 category 只 backfill 過「家具」「雜物」
// 「輔具」三種(沒有門檻/地面高低差來源資料),所以門檻/地面高低差這兩條件實務上不會被觸發——這
// 是資料落差,邏輯本身跟 OPSL 一致。走道障礙則用 isInOpenFloorSpace()(離家具多遠)+
// isNearLocalFloor()(當地是否真的貼著地板)這兩個幾何代理指標取代 OPSL 的 region 欄位。
export async function detectRisks(sceneId: string): Promise<RiskMarker[]> {
  const result = await pool.query(
    `SELECT si.pos_x, si.pos_y, si.pos_z, lo.category, lo.baked_centroid_x, lo.baked_centroid_y, lo.baked_centroid_z
     FROM scene_object_instances si
     JOIN library_objects lo ON lo.id = si.model_id
     WHERE si.scene_id = $1 AND si.hidden = false`,
    [sceneId]
  );

  const furniture: PositionedRow[] = [];
  for (const row of result.rows) {
    if (row.category !== "家具") continue;
    furniture.push({ ...resolvePosition(row), category: row.category });
  }

  const floorGrid = await loadFloorGrid(sceneId);

  const markers: RiskMarker[] = [];
  for (const row of result.rows) {
    const pos = resolvePosition(row);
    let riskType: RiskType | null = null;
    if (row.category === "門檻") riskType = "門檻";
    else if (row.category === "雜物" && isInOpenFloorSpace(pos, furniture) && isNearLocalFloor(pos, floorGrid))
      riskType = "走道障礙";
    if (!riskType) continue;

    markers.push({
      riskType,
      bboxMin: [pos.x - RISK_BBOX_HALF, pos.y, pos.z - RISK_BBOX_HALF],
      bboxMax: [pos.x + RISK_BBOX_HALF, pos.y + RISK_BBOX_HALF * 2, pos.z + RISK_BBOX_HALF],
    });
  }

  return markers;
}
