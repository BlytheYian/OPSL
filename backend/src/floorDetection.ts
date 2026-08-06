import fs from "fs";
import path from "path";
import { pool } from "./db";

const CELL_SIZE = 0.25;
const MIN_CELL_POINTS = 5;
const FLOOR_Y_TOLERANCE = 0.15;
const BIN_SIZE = 0.04;

export interface SurfaceGroup {
  cells: string[];
  meanY: number;
  area: number;
}

export interface FloorDetectionResult {
  mainFloor: SurfaceGroup | null;
  allFloorSurfaces: SurfaceGroup[];
  heightDiffRisks: Array<{ x: number; y: number; z: number; yDiff: number }>;
}

function parsePlyXYZ(filePath: string): Float32Array {
  const buf = fs.readFileSync(filePath);
  const endMarker = Buffer.from("end_header\n");
  const markerIdx = buf.indexOf(endMarker);
  const dataStart = markerIdx + endMarker.length;
  const header = buf.toString("ascii", 0, dataStart);

  let vertexCount = 0;
  const props: string[] = [];
  for (const line of header.split("\n")) {
    const vm = line.match(/^element vertex (\d+)/);
    if (vm) vertexCount = Number(vm[1]);
    const pm = line.match(/^property \S+ (\S+)/);
    if (pm) props.push(pm[1]);
  }

  const stride = props.length * 4;
  const xOff = props.indexOf("x") * 4;
  const yOff = props.indexOf("y") * 4;
  const zOff = props.indexOf("z") * 4;

  const pts = new Float32Array(vertexCount * 3);
  let off = dataStart;
  for (let i = 0; i < vertexCount; i++) {
    pts[i * 3]     = buf.readFloatLE(off + xOff);
    pts[i * 3 + 1] = buf.readFloatLE(off + yOff);
    pts[i * 3 + 2] = buf.readFloatLE(off + zOff);
    off += stride;
  }
  return pts;
}

function findFloorY(pts: Float32Array): { peakY: number; surfaceY: number } | null {
  const n = pts.length / 3;

  let yMin = Infinity, yMax = -Infinity;
  for (let i = 0; i < n; i++) {
    const y = pts[i * 3 + 1];
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }
  const yRange = yMax - yMin;
  if (yRange < 0.1) return null;

  const ySearchFloor = yMax - yRange * 0.45;

  const binCells = new Map<number, Map<string, number>>();
  for (let i = 0; i < n; i++) {
    const y = pts[i * 3 + 1];
    if (y < ySearchFloor) continue;
    const bin = Math.round(y / BIN_SIZE);
    const cx = Math.floor(pts[i * 3]     / CELL_SIZE);
    const cz = Math.floor(pts[i * 3 + 2] / CELL_SIZE);
    const key = `${cx},${cz}`;
    let cellMap = binCells.get(bin);
    if (!cellMap) { cellMap = new Map(); binCells.set(bin, cellMap); }
    cellMap.set(key, (cellMap.get(key) ?? 0) + 1);
  }

  let bestBin = null as number | null;
  let bestDenseCount = 0;
  for (const [bin, cellMap] of binCells) {
    let denseCount = 0;
    for (const count of cellMap.values()) {
      if (count >= MIN_CELL_POINTS) denseCount++;
    }
    if (denseCount > bestDenseCount) {
      bestDenseCount = denseCount;
      bestBin = bin;
    }
  }
  if (bestBin === null) return null;

  // 從峰值往高 PLY Y 方向掃（地板 Gaussian 群的懸崖邊緣），
  // 找到密度掉到峰值 15% 以下的位置——那才是地板視覺表面
  let surfaceBin = bestBin;
  for (let bin = bestBin + 1; bin <= bestBin + 40; bin++) {
    const cellMap = binCells.get(bin);
    if (!cellMap) break;
    let denseCount = 0;
    for (const count of cellMap.values()) {
      if (count >= MIN_CELL_POINTS) denseCount++;
    }
    if (denseCount < bestDenseCount * 0.15) break;
    surfaceBin = bin;
  }

  return { peakY: bestBin * BIN_SIZE, surfaceY: surfaceBin * BIN_SIZE };
}

export function detectFloorFromPly(filePath: string): FloorDetectionResult {
  const empty: FloorDetectionResult = { mainFloor: null, allFloorSurfaces: [], heightDiffRisks: [] };
  const pts = parsePlyXYZ(filePath);
  const n = pts.length / 3;

  const floorResult = findFloorY(pts);
  if (floorResult === null) return empty;
  const { peakY, surfaceY } = floorResult;

  const bandLow = peakY - FLOOR_Y_TOLERANCE;
  const bandHigh = surfaceY + BIN_SIZE;

  const grid = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const y = pts[i * 3 + 1];
    if (y < bandLow || y > bandHigh) continue;
    const cx = Math.floor(pts[i * 3]     / CELL_SIZE);
    const cz = Math.floor(pts[i * 3 + 2] / CELL_SIZE);
    const key = `${cx},${cz}`;
    grid.set(key, (grid.get(key) ?? 0) + 1);
  }

  const floorCells: string[] = [];
  for (const [key, count] of grid) {
    if (count >= MIN_CELL_POINTS) floorCells.push(key);
  }
  if (floorCells.length === 0) return empty;

  const mainFloor: SurfaceGroup = {
    cells: floorCells,
    meanY: surfaceY,
    area: floorCells.length * CELL_SIZE * CELL_SIZE,
  };
  return { mainFloor, allFloorSurfaces: [mainFloor], heightDiffRisks: [] };
}

export function computeFloorBounds(
  group: SurfaceGroup
): { y: number; cellSize: number; cells: [number, number][] } {
  const cells: [number, number][] = group.cells.map(key => {
    const idx = key.indexOf(",");
    const cx = parseInt(key.slice(0, idx), 10);
    const cz = parseInt(key.slice(idx + 1), 10);
    return [cx, -cz];
  });
  return { y: -group.meanY, cellSize: CELL_SIZE, cells };
}

function resolvePlyPath(modelUrl: string): string | null {
  const m = modelUrl.match(/\/storage\/(.+)$/);
  return m ? path.join(__dirname, "..", "storage", m[1]) : null;
}

export async function detectSceneFloor(sceneId: string): Promise<FloorDetectionResult | null> {
  const res = await pool.query<{ model_url: string }>(
    `SELECT lo.model_url FROM scene_object_instances si
     JOIN library_objects lo ON lo.id = si.model_id
     WHERE si.scene_id = $1 AND lo.name = '背景' LIMIT 1`,
    [sceneId]
  );
  if (!res.rows.length) return null;
  const filePath = resolvePlyPath(res.rows[0].model_url);
  if (!filePath || !fs.existsSync(filePath)) return null;
  return detectFloorFromPly(filePath);
}
