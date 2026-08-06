import fs from "fs";
import path from "path";
import { pool } from "./db";
import { detectFloorFromPly } from "./floorDetection";

const CELL_SIZE = 0.25;
const FURNITURE_EXCLUSION_RADIUS = 0.5;
const NARROW_PASSAGE_CELLS = 4;

export interface RouteDetectionResult {
  floorY: number;
  cellSize: number;
  freeCells: [number, number][];
  narrowCells: [number, number][];
}

async function resolvePlyPath(sceneId: string): Promise<string | null> {
  const res = await pool.query<{ model_url: string }>(
    `SELECT lo.model_url FROM scene_object_instances si
     JOIN library_objects lo ON lo.id = si.model_id
     WHERE si.scene_id = $1 AND lo.name = '背景' LIMIT 1`,
    [sceneId]
  );
  if (!res.rows.length) return null;
  const m = res.rows[0].model_url.match(/\/storage\/(.+)$/);
  return m ? path.join(__dirname, "..", "storage", m[1]) : null;
}

function isBlockedWithin(
  cx: number,
  cz: number,
  dx: number,
  dz: number,
  occupiedSet: Set<string>,
  floorSet: Set<string>,
  steps: number
): boolean {
  for (let d = 1; d <= steps; d++) {
    const key = `${cx + dx * d},${cz + dz * d}`;
    if (occupiedSet.has(key)) return true;
    if (!floorSet.has(key)) return false;
  }
  return false;
}

export async function detectRoute(sceneId: string): Promise<RouteDetectionResult | null> {
  const plyPath = await resolvePlyPath(sceneId);
  if (!plyPath || !fs.existsSync(plyPath)) return null;

  const floor = detectFloorFromPly(plyPath);
  if (!floor.mainFloor) return null;
  const { cells: floorCellKeys, meanY: floorY_ply } = floor.mainFloor;

  // Convert PLY-space floor cells to PlayCanvas space: X stays same, Z negated
  const floorSet = new Set<string>();
  for (const key of floorCellKeys) {
    const comma = key.indexOf(",");
    const cx = parseInt(key.slice(0, comma));
    const cz_pc = -parseInt(key.slice(comma + 1));
    floorSet.add(`${cx},${cz_pc}`);
  }

  const furnitureRes = await pool.query(
    `SELECT si.pos_x, si.pos_z, lo.baked_centroid_x, lo.baked_centroid_z
     FROM scene_object_instances si
     JOIN library_objects lo ON lo.id = si.model_id
     WHERE si.scene_id = $1 AND si.hidden = false AND lo.name != '背景'`,
    [sceneId]
  );

  // Furniture positions: baked_centroid + pos are both in PlayCanvas space
  const exclusionCells = Math.ceil(FURNITURE_EXCLUSION_RADIUS / CELL_SIZE);
  const occupiedSet = new Set<string>();
  for (const row of furnitureRes.rows) {
    const bx = row.baked_centroid_x !== null ? Number(row.baked_centroid_x) : 0;
    const bz = row.baked_centroid_z !== null ? Number(row.baked_centroid_z) : 0;
    const worldX = bx + Number(row.pos_x);
    const worldZ = bz + Number(row.pos_z);
    const cx = Math.floor(worldX / CELL_SIZE);
    const cz = Math.floor(worldZ / CELL_SIZE);
    for (let ddx = -exclusionCells; ddx <= exclusionCells; ddx++) {
      for (let ddz = -exclusionCells; ddz <= exclusionCells; ddz++) {
        const key = `${cx + ddx},${cz + ddz}`;
        if (floorSet.has(key)) occupiedSet.add(key);
      }
    }
  }

  const freeCells: [number, number][] = [];
  const narrowCells: [number, number][] = [];

  for (const key of floorSet) {
    if (occupiedSet.has(key)) continue;
    const comma = key.indexOf(",");
    freeCells.push([parseInt(key.slice(0, comma)), parseInt(key.slice(comma + 1))]);
  }

  for (const [cx, cz] of freeCells) {
    const xNarrow =
      isBlockedWithin(cx, cz, 1, 0, occupiedSet, floorSet, NARROW_PASSAGE_CELLS) &&
      isBlockedWithin(cx, cz, -1, 0, occupiedSet, floorSet, NARROW_PASSAGE_CELLS);
    const zNarrow =
      isBlockedWithin(cx, cz, 0, 1, occupiedSet, floorSet, NARROW_PASSAGE_CELLS) &&
      isBlockedWithin(cx, cz, 0, -1, occupiedSet, floorSet, NARROW_PASSAGE_CELLS);
    if (xNarrow || zNarrow) narrowCells.push([cx, cz]);
  }

  return { floorY: -floorY_ply, cellSize: CELL_SIZE, freeCells, narrowCells };
}
