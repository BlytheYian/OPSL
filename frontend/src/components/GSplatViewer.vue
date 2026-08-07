<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  claimCanvas,
  getSharedGSplatApp,
  releaseCanvas,
  setGizmoTarget,
  MAX_RISK_MARKERS,
  type GizmoMode,
  type ViewerSession,
} from '../lib/gsplatApp'
import { useSceneObjectsStore, type Vec3 } from '../stores/sceneObjects'

const sceneObjects = useSceneObjectsStore()

function kindForUrl(url: string): 'gsplat' | 'mesh' {
  return url.toLowerCase().endsWith('.glb') ? 'mesh' : 'gsplat'
}

function exclusiveAssetUrl(url: string, uniqueTag: string): string {
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}instance=${encodeURIComponent(uniqueTag)}`
}

function collectRenderComponents(entity: any, out: any[]) {
  if (entity.render) out.push(entity.render)
  for (const child of entity.children ?? []) collectRenderComponents(child, out)
}
function getWorldAabb(pc: any, content: any, kind: 'gsplat' | 'mesh'): any {
  if (kind === 'gsplat') {
    const localAabb = content.gsplat?.customAabb
    if (!localAabb) return null
    const worldAabb = new pc.BoundingBox()
    worldAabb.setFromTransformedAabb(localAabb, content.getWorldTransform())
    return worldAabb
  }
  const renderComponents: any[] = []
  collectRenderComponents(content, renderComponents)
  let combined: any = null
  for (const renderComp of renderComponents) {
    for (const mi of renderComp.meshInstances ?? []) {
      if (!combined) combined = mi.aabb.clone()
      else combined.add(mi.aabb)
    }
  }
  return combined
}

function hexToRgb01(hex: string): { r: number; g: number; b: number } {
  return {
    r: parseInt(hex.slice(1, 3), 16) / 255,
    g: parseInt(hex.slice(3, 5), 16) / 255,
    b: parseInt(hex.slice(5, 7), 16) / 255,
  }
}

function applyMeshColorTint(pc: any, content: any, colorHex: string) {
  const color = hexToRgb01(colorHex)
  const pcColor = new pc.Color(color.r, color.g, color.b)
  const renderComponents: any[] = []
  collectRenderComponents(content, renderComponents)
  for (const renderComp of renderComponents) {
    for (const mi of renderComp.meshInstances ?? []) {
      const cloned = mi.material.clone()
      cloned.diffuse = pcColor
      cloned.diffuseMap = null
      cloned.update()
      mi.material = cloned
    }
  }
}

function applyGsplatColorTint(pc: any, content: any, colorHex: string) {
  const resource = content.gsplat?.resource
  const gsplatData = resource?.gsplatData
  if (!resource || !gsplatData) return
  const texture = resource.streams?.getTexture?.('splatColor')
  if (!texture) return

  const tint = hexToRgb01(colorHex)
  const cr = gsplatData.getProp('f_dc_0')
  const cg = gsplatData.getProp('f_dc_1')
  const cb = gsplatData.getProp('f_dc_2')
  const ca = gsplatData.getProp('opacity')
  if (!cr || !cg || !cb || !ca) return
  const activated = gsplatData.activated
  const SH_C0 = 0.28209479177387814
  const float2Half = pc.FloatPacking.float2Half
  const numSplats = gsplatData.numSplats

  const data = texture.lock()
  for (let i = 0; i < numSplats; i++) {
    const r = cr[i] * SH_C0 + 0.5
    const g = cg[i] * SH_C0 + 0.5
    const b = cb[i] * SH_C0 + 0.5
    const a = activated ? ca[i] : 1 / (1 + Math.exp(-ca[i]))
    const luminance = 0.299 * r + 0.587 * g + 0.114 * b
    const shade = Math.min(2 * luminance, 2)
    data[i * 4 + 0] = float2Half(Math.min(tint.r * shade, 1))
    data[i * 4 + 1] = float2Half(Math.min(tint.g * shade, 1))
    data[i * 4 + 2] = float2Half(Math.min(tint.b * shade, 1))
    data[i * 4 + 3] = float2Half(a)
  }
  texture.unlock()
}

function applyColorTint(pc: any, content: any, kind: 'gsplat' | 'mesh', colorHex: string) {
  if (kind === 'mesh') applyMeshColorTint(pc, content, colorHex)
  else applyGsplatColorTint(pc, content, colorHex)
}

const props = defineProps<{
  src: string | string[]
  ids?: (string | null)[]
  transforms?: ({ position: Vec3; rotation: Vec3; scale: Vec3 } | null)[]
  dataRotations?: (Vec3 | null)[]
  colors?: (string | null)[]
  /** 是否允許點擊畫面選取物件(編輯頁面才需要,預覽彈窗不需要) */
  selectable?: boolean
  /** 目前選取中的物件 id,由父層(SceneEditPage)控制,側欄點擊也會改這個值 */
  selectedId?: string | null
  /** 目前啟用的手柄模式,null 代表不顯示手柄 */
  gizmoMode?: GizmoMode | null
  /** 目前被隱藏的物件 id 清單)——只是不渲染,不是刪除資料 */
  hiddenIds?: string[]
}>()
const emit = defineEmits<{
  loaded: []
  error: [message: string]
  select: [id: string | null]
  progress: [percent: number]
  'risk-pick': [index: number | null]
  'camera-mode': [mode: string]
  'request-tps-char': []
}>()

const wrapperRef = ref<HTMLDivElement | null>(null)
const loading = ref(true)

type LoadStage = 'assets' | 'refining' | 'done'
const loadStage = ref<LoadStage>('assets')
const loadedAssetCount = ref(0)
const totalAssetCount = ref(0)
const lodCurrentPending = ref(0)
let lodMaxPending = 0

const loadPercent = computed(() => {
  if (loadStage.value === 'assets') {
    return totalAssetCount.value > 0 ? Math.round((loadedAssetCount.value / totalAssetCount.value) * 100) : 0
  }
  if (loadStage.value === 'refining') {
    return lodMaxPending > 0 ? Math.round(((lodMaxPending - lodCurrentPending.value) / lodMaxPending) * 100) : 100
  }
  return 100
})
watch(loadPercent, (p) => emit('progress', p), { immediate: true })

function onGsplatFrameReady(_camera: unknown, _layer: unknown, _ready: boolean, loadingCount: number) {
  if (loadStage.value !== 'refining') return
  lodMaxPending = Math.max(lodMaxPending, loadingCount)
  lodCurrentPending.value = loadingCount
  if (loadingCount === 0) loadStage.value = 'done'
}

let resizeObserver: ResizeObserver | null = null
let resizeTimer: ReturnType<typeof setTimeout> | null = null
let sharedCanvas: HTMLCanvasElement | null = null
let isActive = true

let pcRef: any = null
let appRef: any = null
let cameraRef: any = null
let gizmosRef: any = null
let highlightLinesRef: any[] = []
let riskMarkerLinesRef: any[] = []
let riskMarkersForPick: { bboxMin: Vec3; bboxMax: Vec3 }[] = []
let riskGizmoEntity: any = null
let riskGizmoOnUpdate: ((bbox: { bboxMin: Vec3; bboxMax: Vec3 }) => void) | null = null
let debugGroundPlaneEntity: any = null
let entitiesById = new Map<string, { root: any; splat: any; kind: 'gsplat' | 'mesh' }>()
let allLoadedEntities: { root: any; splat: any; kind: 'gsplat' | 'mesh' }[] = []

const session: ViewerSession = { wrapper: null as unknown as HTMLElement, entities: new Set(), active: false, camera: null }

let highlightedEntity: any = null
let floorEntityRef: any = null
let routeFreeEntityRef: any = null
let routeNarrowEntityRef: any = null
let pathArrowEntities: any[] = []
let needsInitialFraming = false
let initialFramingDone = false
const BOX_EDGES: Array<[[number, number, number], [number, number, number]]> = [
  [[0, 0, 0], [1, 0, 0]], [[1, 0, 0], [1, 0, 1]], [[1, 0, 1], [0, 0, 1]], [[0, 0, 1], [0, 0, 0]],
  [[0, 1, 0], [1, 1, 0]], [[1, 1, 0], [1, 1, 1]], [[1, 1, 1], [0, 1, 1]], [[0, 1, 1], [0, 1, 0]],
  [[0, 0, 0], [0, 1, 0]], [[1, 0, 0], [1, 1, 0]], [[1, 0, 1], [1, 1, 1]], [[0, 0, 1], [0, 1, 1]],
]
const RISK_MARKER_LINE_THICKNESS = 0.02
function onAppUpdate() {
  if (!session.active) return

  if (needsInitialFraming && !initialFramingDone && pcRef && cameraRef && appRef) {
    const pc = pcRef
    const first = allLoadedEntities[0]
    if (first) {
      const worldAabb = getWorldAabb(pc, first.splat, first.kind)
      if (worldAabb) {
        const camera = cameraRef
        const center = worldAabb.center.clone()
        const min = worldAabb.getMin()
        const max = worldAabb.getMax()

        const halfWidth = Math.max((max.x - min.x) / 2, 1e-4)
        const halfHeight = Math.max((max.y - min.y) / 2, 1e-4)

        const { width: canvasWidth, height: canvasHeight } = appRef.graphicsDevice.clientRect
        const aspect = canvasWidth && canvasHeight ? canvasWidth / canvasHeight : 1
        const vFovRad = (camera.camera.fov * Math.PI) / 180
        const hFovRad = 2 * Math.atan(Math.tan(vFovRad / 2) * aspect)
        const distanceForHeight = halfHeight / Math.tan(vFovRad / 2)
        const distanceForWidth = halfWidth / Math.tan(hFovRad / 2)
        const halfDepth = Math.max((max.z - min.z) / 2, 1e-4)
        const distance = (Math.max(distanceForHeight, distanceForWidth) + halfDepth) * 1.08

        const finite = [center.x, center.y, center.z, distance].every((n: number) => Number.isFinite(n))
        if (finite) {
          const position = new pc.Vec3(center.x, center.y, center.z + distance)
          camera.script.cameraControls.reset(center, position)
          initialFramingDone = true
          fpsHeightBase = center.y + 1
          fpsHeight.value = fpsHeightBase
          fpsHeightMin.value = fpsHeightBase - 3
          fpsHeightMax.value = fpsHeightBase + 8
        }
      }
    }
  }

  if (!highlightedEntity || !pcRef || !highlightLinesRef.length) {
    for (const line of highlightLinesRef) line.entity.enabled = false
    return
  }
  const pc = pcRef
  const worldAabb = getWorldAabb(pc, highlightedEntity.splat, highlightedEntity.kind)
  if (!worldAabb) return

  if (gizmosRef && props.gizmoMode) {
    const center = worldAabb.center
    if (Number.isFinite(center.x) && Number.isFinite(center.y) && Number.isFinite(center.z)) {
      gizmosRef[props.gizmoMode].root.setLocalPosition(center)
    }
  }

  const min = worldAabb.getMin()
  const max = worldAabb.getMax()
  const pick = (t: [number, number, number]) =>
    new pc.Vec3(t[0] ? max.x : min.x, t[1] ? max.y : min.y, t[2] ? max.z : min.z)
  const color = new pc.Color(1, 0.82, 0.28) 
  const thickness = Math.max(worldAabb.halfExtents.length() * 2 * 0.006, 1e-4)
  BOX_EDGES.forEach(([a, b], i) => {
    const line = highlightLinesRef[i]
    line.entity.enabled = true
    line.thickness = thickness
    line.draw(pick(a), pick(b), 1, color)
  })
}

let pointerDownPos: { x: number; y: number } | null = null
const CLICK_DRAG_THRESHOLD = 4

function onCanvasPointerDown(e: PointerEvent) {
  if (!session.active) return
  pointerDownPos = { x: e.clientX, y: e.clientY }
}

function onCanvasPointerUp(e: PointerEvent) {
  if (!session.active || !props.selectable || !pointerDownPos) return
  const dx = e.clientX - pointerDownPos.x
  const dy = e.clientY - pointerDownPos.y
  pointerDownPos = null
  if (Math.hypot(dx, dy) > CLICK_DRAG_THRESHOLD) return

  const pc = pcRef
  const camera = cameraRef
  if (!pc || !camera || !sharedCanvas) return
  const rect = sharedCanvas.getBoundingClientRect()
  const x = e.clientX - rect.left
  const y = e.clientY - rect.top

  const near = camera.camera.screenToWorld(x, y, camera.camera.nearClip)
  const far = camera.camera.screenToWorld(x, y, camera.camera.farClip)
  const dir = far.clone().sub(near).normalize()
  const ray = new pc.Ray(near, dir)
  const hitPoint = new pc.Vec3()

  const hidden = new Set(props.hiddenIds ?? [])
  let closestId: string | null = null
  let closestDist = Infinity
  for (const [id, { splat, kind }] of entitiesById) {
    if (hidden.has(id)) continue // 隱藏的物件不該還能被點擊選到
    const worldAabb = getWorldAabb(pc, splat, kind)
    if (!worldAabb) continue
    if (worldAabb.intersectsRay(ray, hitPoint)) {
      const dist = hitPoint.distance(near)
      if (dist < closestDist) {
        closestDist = dist
        closestId = id
      }
    }
  }
  emit('select', closestId)

  if (riskMarkersForPick.length) {
    let pickedRisk: number | null = null
    let closestRiskDist = Infinity
    for (let i = 0; i < riskMarkersForPick.length; i++) {
      const { bboxMin, bboxMax } = riskMarkersForPick[i]
      const aabb = new pc.BoundingBox(
        new pc.Vec3((bboxMin[0] + bboxMax[0]) / 2, (bboxMin[1] + bboxMax[1]) / 2, (bboxMin[2] + bboxMax[2]) / 2),
        new pc.Vec3((bboxMax[0] - bboxMin[0]) / 2, (bboxMax[1] - bboxMin[1]) / 2, (bboxMax[2] - bboxMin[2]) / 2),
      )
      if (aabb.intersectsRay(ray, hitPoint)) {
        const dist = hitPoint.distance(near)
        if (dist < closestRiskDist) { closestRiskDist = dist; pickedRisk = i }
      }
    }
    emit('risk-pick', pickedRisk)
  }
}
function detachRiskGizmoInternal() {
  if (!riskGizmoEntity) return
  session.entities.delete(riskGizmoEntity)
  riskGizmoEntity.destroy()
  riskGizmoEntity = null
  riskGizmoOnUpdate = null
}

function applyGizmoState() {
  if (riskGizmoEntity) {
    if (gizmosRef) setGizmoTarget(gizmosRef, props.gizmoMode ?? null, riskGizmoEntity)
    return
  }
  const entity = props.selectedId ? entitiesById.get(props.selectedId) ?? null : null
  highlightedEntity = entity
  if (!gizmosRef) return
  setGizmoTarget(gizmosRef, props.gizmoMode ?? null, entity?.root ?? null)
}
session.reapply = applyGizmoState

const TRANSFORM_EPSILON = 1e-4
function vec3Unchanged(a: Vec3, b: Vec3): boolean {
  return (
    Math.abs(a[0] - b[0]) < TRANSFORM_EPSILON &&
    Math.abs(a[1] - b[1]) < TRANSFORM_EPSILON &&
    Math.abs(a[2] - b[2]) < TRANSFORM_EPSILON
  )
}

function persistSelectedTransform() {
  if (riskGizmoEntity && riskGizmoOnUpdate) {
    const pos = riskGizmoEntity.getPosition()
    const s = riskGizmoEntity.getLocalScale()
    riskGizmoOnUpdate({
      bboxMin: [pos.x - s.x / 2, pos.y - s.y / 2, pos.z - s.z / 2],
      bboxMax: [pos.x + s.x / 2, pos.y + s.y / 2, pos.z + s.z / 2],
    })
    return
  }
  if (!session.active || !props.selectedId) return
  const entry = entitiesById.get(props.selectedId)
  if (!entry) return
  const instance = sceneObjects.instances.find((i) => i.id === props.selectedId)
  if (!instance) return
  const p = entry.root.getLocalPosition()
  const r = entry.root.getLocalEulerAngles()
  const s = entry.root.getLocalScale()
  const position: Vec3 = [p.x, p.y, p.z]
  const rotation: Vec3 = [r.x, r.y, r.z]
  const scale: Vec3 = [s.x, s.y, s.z]
  if (
    vec3Unchanged(position, instance.position) &&
    vec3Unchanged(rotation, instance.rotation) &&
    vec3Unchanged(scale, instance.scale)
  ) {
    return
  }
  sceneObjects.updateTransform(props.selectedId, { position, rotation, scale })
}

onMounted(async () => {
  if (!wrapperRef.value) return
  const wrapper = wrapperRef.value
  session.wrapper = wrapper

  const { pc, app, canvas, editorCamera, previewCamera, gizmos, highlightLines, riskMarkerLines } = await getSharedGSplatApp()
  if (!isActive) return
  pcRef = pc
  appRef = app
  // 再額外加一個 prop。
  const camera = props.selectable ? editorCamera : previewCamera
  cameraRef = camera
  session.camera = camera
  gizmosRef = gizmos
  highlightLinesRef = highlightLines
  riskMarkerLinesRef = riskMarkerLines

  sharedCanvas = canvas
  const resize = () => {
    if (resizeTimer) clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => {
      const { width, height } = wrapper.getBoundingClientRect()
      app.resizeCanvas(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)))
    }, 200)
  }
  session.resize = resize

  claimCanvas(canvas, session, gizmos)
  canvas.addEventListener('pointerdown', onCanvasPointerDown)
  canvas.addEventListener('pointerup', onCanvasPointerUp)
  app.on('update', onAppUpdate)
  app.systems.gsplat.on('frame:ready', onGsplatFrameReady)
  for (const gizmo of Object.values(gizmos) as any[]) gizmo.on('pointer:up', persistSelectedTransform)

  resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(wrapper)
  resize()

  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  if (!isActive) return

  try {
    entitiesById = new Map()
    allLoadedEntities = []
    loadStage.value = 'assets'
    loadedAssetCount.value = 0
    lodCurrentPending.value = 0
    lodMaxPending = 0
    camera.script.cameraControls.reset(new pc.Vec3(0, 0, 0), new pc.Vec3(0, 0, 3))
    // 宣告處的說明。
    needsInitialFraming = !props.transforms
    initialFramingDone = false

    const urls = Array.isArray(props.src) ? props.src : [props.src]
    const ids = props.ids ?? []
    const transforms = props.transforms ?? []
    const dataRotations = props.dataRotations ?? []
    const colors = props.colors ?? []
    const hidden = new Set(props.hiddenIds ?? [])

    const kindForIndex = urls.map(kindForUrl)
    const urlToAsset = new Map<string, any>()
    const uniqueAssets: any[] = []
    const assetForIndex: any[] = urls.map((url, i) => {
      const kind = kindForIndex[i]
      const skipDedup = !!colors[i] && kind === 'gsplat'
      if (!skipDedup) {
        const existing = urlToAsset.get(url)
        if (existing) return existing
      }
      const assetUrl = skipDedup ? exclusiveAssetUrl(url, ids[i] ?? String(i)) : url
      const asset = new pc.Asset(`asset-${uniqueAssets.length}`, kind === 'mesh' ? 'container' : 'gsplat', { url: assetUrl })
      if (!skipDedup) urlToAsset.set(url, asset)
      uniqueAssets.push(asset)
      return asset
    })
    totalAssetCount.value = uniqueAssets.length

    const addEntityForIndex = (i: number) => {
      const asset = assetForIndex[i]
      const kind = kindForIndex[i]
      const root = new pc.Entity(`Instance-${i}`)
      const t = transforms[i]
      if (t) {
        root.setLocalPosition(t.position[0], t.position[1], t.position[2])
        root.setLocalEulerAngles(t.rotation[0], t.rotation[1], t.rotation[2])
        root.setLocalScale(t.scale[0], t.scale[1], t.scale[2])
      }
      app.root.addChild(root)
      const splat = new pc.Entity(`Splat-${i}`)
      const dataRotation = dataRotations[i] ?? (kind === 'mesh' ? [0, 0, 0] : [180, 0, 0])
      splat.setLocalEulerAngles(dataRotation[0], dataRotation[1], dataRotation[2])
      if (kind === 'mesh') {
        splat.addChild(asset.resource.instantiateRenderEntity())
      } else {
        splat.addComponent('gsplat', { asset })
      }
      root.addChild(splat)
      session.entities.add(root)
      allLoadedEntities.push({ root, splat, kind })
      const id = ids[i]
      if (id) entitiesById.set(id, { root, splat, kind })
      root.enabled = session.active && (!id || !hidden.has(id))
      const color = colors[i]
      if (color) applyColorTint(pc, splat, kind, color)
    }

    let firstAssetShown = false
    const pendingIndices: number[] = []
    const loader = new pc.AssetListLoader(uniqueAssets, app.assets)
    loader.on('progress', (asset: any) => {
      if (!isActive) return
      loadedAssetCount.value++
      const indices: number[] = []
      assetForIndex.forEach((a, idx) => { if (a === asset) indices.push(idx) })
      if (!firstAssetShown) {
        firstAssetShown = true
        for (const i of indices) addEntityForIndex(i)
        loading.value = false
      } else {
        pendingIndices.push(...indices)
      }
    })
    await new Promise<void>((resolve, reject) => {
      loader.load((err: unknown) => (err ? reject(err) : resolve()))
    })
    if (!isActive) return
    for (const i of pendingIndices) addEntityForIndex(i)
    loading.value = false
    loadStage.value = 'refining'
    if (allLoadedEntities.every((e) => e.kind !== 'gsplat')) loadStage.value = 'done'

    emit('loaded')
  } catch (err) {
    if (!isActive) return
    loading.value = false
    emit('error', err instanceof Error ? err.message : String(err))
  }
})

watch(() => [props.selectedId, props.gizmoMode] as const, () => {
  if (session.active) applyGizmoState()
})

watch(
  () => props.hiddenIds,
  (hiddenIds) => {
    const hidden = new Set(hiddenIds ?? [])
    for (const [id, { root }] of entitiesById) {
      root.enabled = !hidden.has(id)
    }
  },
  { deep: true },
)

const cameraMode = ref<'orbit' | 'fps' | 'tps' | 'top'>('orbit')

let tpsCharEntity: any = null
let tpsCharSplat: any = null
let tpsCharKind: 'gsplat' | 'mesh' = 'mesh'
let tpsCharHalfH = 0
const hasTpsChar = ref(false)
let tpsYaw = 0
let tpsPitch = 0.35
let TPS_DIST = 2.8
const TPS_ARM_UP = 0.6
const tpsKeys = new Set<string>()
let tpsDragging = false, tpsLastX = 0, tpsLastY = 0

function onTpsKeyDown(e: KeyboardEvent) { tpsKeys.add(e.code) }
function onTpsKeyUp(e: KeyboardEvent) { tpsKeys.delete(e.code) }
function onTpsPointerDown(e: PointerEvent) {
  tpsDragging = true; tpsLastX = e.clientX; tpsLastY = e.clientY
  ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
}
function onTpsPointerMove(e: PointerEvent) {
  if (!tpsDragging) return
  tpsYaw -= (e.clientX - tpsLastX) * 0.003
  tpsPitch = Math.max(0.1, Math.min(1.2, tpsPitch + (e.clientY - tpsLastY) * 0.003))
  tpsLastX = e.clientX; tpsLastY = e.clientY
}
function onTpsPointerUp() { tpsDragging = false }
function onTpsWheel(e: WheelEvent) {
  e.preventDefault()
  TPS_DIST = Math.max(0.5, Math.min(15, TPS_DIST * (1 + e.deltaY * 0.001)))
}
function destroyTpsChar() {
  if (tpsCharEntity) {
    session.entities.delete(tpsCharEntity)
    tpsCharEntity.destroy()
    tpsCharEntity = null
    tpsCharSplat = null
  }
  hasTpsChar.value = false
}

function onTpsUpdate(dt: number) {
  if (!cameraRef || cameraMode.value !== 'tps' || !tpsCharEntity) return
  const speed = 3 * dt
  let dx = 0, dz = 0
  if (tpsKeys.has('KeyW') || tpsKeys.has('ArrowUp'))    { dx -= Math.sin(tpsYaw); dz -= Math.cos(tpsYaw) }
  if (tpsKeys.has('KeyS') || tpsKeys.has('ArrowDown'))  { dx += Math.sin(tpsYaw); dz += Math.cos(tpsYaw) }
  if (tpsKeys.has('KeyA') || tpsKeys.has('ArrowLeft'))  { dx -= Math.cos(tpsYaw); dz += Math.sin(tpsYaw) }
  if (tpsKeys.has('KeyD') || tpsKeys.has('ArrowRight')) { dx += Math.cos(tpsYaw); dz -= Math.sin(tpsYaw) }
  const charPos = tpsCharEntity.getPosition()
  if (dx !== 0 || dz !== 0) {
    tpsCharEntity.setPosition(charPos.x + dx * speed, charPos.y, charPos.z + dz * speed)
  }
  tpsCharEntity.setLocalEulerAngles(0, tpsYaw * 180 / Math.PI + 180, 0)
  const p = tpsCharEntity.getPosition()
  const armBack = TPS_DIST * Math.cos(tpsPitch)
  const armUp = TPS_DIST * Math.sin(tpsPitch)
  const camX = p.x + Math.sin(tpsYaw) * armBack
  const camY = p.y + tpsCharHalfH + TPS_ARM_UP + armUp
  const camZ = p.z + Math.cos(tpsYaw) * armBack
  cameraRef.setPosition(camX, camY, camZ)
  const pc = pcRef
  if (pc) {
    const target = new pc.Vec3(p.x, p.y + tpsCharHalfH * 0.6, p.z)
    const eye = new pc.Vec3(camX, camY, camZ)
    const mat = new pc.Mat4().setLookAt(eye, target, pc.Vec3.UP)
    const rot = new pc.Quat().setFromMat4(mat)
    cameraRef.setRotation(rot)
  }
}

const fpsKeys = new Set<string>()
let fpsDragging = false, fpsLastX = 0, fpsLastY = 0
let fpsYaw = 0, fpsPitch = 0
let fpsHeightBase = 1.6
const fpsHeight = ref(1.6)
const fpsHeightMin = ref(-2)
const fpsHeightMax = ref(10)

function onFpsKeyDown(e: KeyboardEvent) { fpsKeys.add(e.code) }
function onFpsKeyUp(e: KeyboardEvent) { fpsKeys.delete(e.code) }
function onFpsPointerDown(e: PointerEvent) {
  fpsDragging = true; fpsLastX = e.clientX; fpsLastY = e.clientY
  ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
}
function onFpsPointerMove(e: PointerEvent) {
  if (!fpsDragging) return
  fpsYaw -= (e.clientX - fpsLastX) * 0.003
  fpsPitch = Math.max(-1.4, Math.min(1.4, fpsPitch - (e.clientY - fpsLastY) * 0.003))
  fpsLastX = e.clientX; fpsLastY = e.clientY
  cameraRef?.setLocalEulerAngles(fpsPitch * 180 / Math.PI, fpsYaw * 180 / Math.PI, 0)
}
function onFpsPointerUp() { fpsDragging = false }
function onFpsUpdate(dt: number) {
  if (!cameraRef || cameraMode.value !== 'fps') return
  const speed = 4 * dt
  let dx = 0, dz = 0
  if (fpsKeys.has('KeyW') || fpsKeys.has('ArrowUp'))    { dx -= Math.sin(fpsYaw); dz -= Math.cos(fpsYaw) }
  if (fpsKeys.has('KeyS') || fpsKeys.has('ArrowDown'))  { dx += Math.sin(fpsYaw); dz += Math.cos(fpsYaw) }
  if (fpsKeys.has('KeyA') || fpsKeys.has('ArrowLeft'))  { dx -= Math.cos(fpsYaw); dz += Math.sin(fpsYaw) }
  if (fpsKeys.has('KeyD') || fpsKeys.has('ArrowRight')) { dx += Math.cos(fpsYaw); dz -= Math.sin(fpsYaw) }
  const pos = cameraRef.getPosition()
  const h = fpsHeight.value
  if (dx !== 0 || dz !== 0) {
    cameraRef.setPosition(pos.x + dx * speed, h, pos.z + dz * speed)
  } else if (Math.abs(pos.y - h) > 0.001) {
    cameraRef.setPosition(pos.x, h, pos.z)
  }
}

let topDragging = false, topLastX = 0, topLastY = 0
let topHeight = 10, topPanX = 0, topPanZ = 0
function onTopPointerDown(e: PointerEvent) {
  topDragging = true; topLastX = e.clientX; topLastY = e.clientY
  ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
}
function onTopPointerMove(e: PointerEvent) {
  if (!topDragging || !cameraRef) return
  const scale = topHeight * 0.0015
  topPanX -= (e.clientX - topLastX) * scale
  topPanZ -= (e.clientY - topLastY) * scale
  topLastX = e.clientX; topLastY = e.clientY
  cameraRef.setPosition(topPanX, topHeight, topPanZ)
}
function onTopPointerUp() { topDragging = false }
function onTopWheel(e: WheelEvent) {
  e.preventDefault()
  topHeight = Math.max(0.5, topHeight * (1 + e.deltaY * 0.001))
  cameraRef?.setPosition(topPanX, topHeight, topPanZ)
}

function leaveCameraMode(canvas: HTMLCanvasElement) {
  if (cameraMode.value === 'fps') {
    appRef?.off('update', onFpsUpdate)
    canvas.removeEventListener('pointerdown', onFpsPointerDown)
    canvas.removeEventListener('pointermove', onFpsPointerMove)
    canvas.removeEventListener('pointerup', onFpsPointerUp)
    window.removeEventListener('keydown', onFpsKeyDown)
    window.removeEventListener('keyup', onFpsKeyUp)
    fpsKeys.clear()
  } else if (cameraMode.value === 'tps') {
    appRef?.off('update', onTpsUpdate)
    canvas.removeEventListener('pointerdown', onTpsPointerDown)
    canvas.removeEventListener('pointermove', onTpsPointerMove)
    canvas.removeEventListener('pointerup', onTpsPointerUp)
    window.removeEventListener('keydown', onTpsKeyDown)
    window.removeEventListener('keyup', onTpsKeyUp)
    tpsKeys.clear()
    canvas.removeEventListener('wheel', onTpsWheel)
    destroyTpsChar()
  } else if (cameraMode.value === 'top') {
    canvas.removeEventListener('pointerdown', onTopPointerDown)
    canvas.removeEventListener('pointermove', onTopPointerMove)
    canvas.removeEventListener('pointerup', onTopPointerUp)
    canvas.removeEventListener('wheel', onTopWheel)
  }
}

function switchCameraMode() {
  const modes = ['orbit', 'fps', 'tps', 'top'] as const
  const next = modes[(modes.indexOf(cameraMode.value) + 1) % 4]
  const canvas = sharedCanvas
  if (!canvas || !cameraRef) return

  leaveCameraMode(canvas)

  if (next === 'orbit') {
    cameraRef.script.cameraControls.enabled = true
  } else if (next === 'fps') {
    cameraRef.script.cameraControls.enabled = false
    const e = cameraRef.getLocalEulerAngles()
    fpsYaw = e.y * Math.PI / 180
    fpsPitch = e.x * Math.PI / 180
    appRef?.on('update', onFpsUpdate)
    canvas.addEventListener('pointerdown', onFpsPointerDown)
    canvas.addEventListener('pointermove', onFpsPointerMove)
    canvas.addEventListener('pointerup', onFpsPointerUp)
    window.addEventListener('keydown', onFpsKeyDown)
    window.addEventListener('keyup', onFpsKeyUp)
  } else if (next === 'tps') {
    cameraRef.script.cameraControls.enabled = false
    TPS_DIST = 2.8
    appRef?.on('update', onTpsUpdate)
    canvas.addEventListener('pointerdown', onTpsPointerDown)
    canvas.addEventListener('pointermove', onTpsPointerMove)
    canvas.addEventListener('pointerup', onTpsPointerUp)
    canvas.addEventListener('wheel', onTpsWheel, { passive: false })
    window.addEventListener('keydown', onTpsKeyDown)
    window.addEventListener('keyup', onTpsKeyUp)
  } else {
    cameraRef.script.cameraControls.enabled = false
    const pos = cameraRef.getPosition()
    topPanX = pos.x; topPanZ = pos.z
    topHeight = Math.max(5, pos.y + 4)
    cameraRef.setPosition(topPanX, topHeight, topPanZ)
    cameraRef.setLocalEulerAngles(-90, 0, 0)
    canvas.addEventListener('pointerdown', onTopPointerDown)
    canvas.addEventListener('pointermove', onTopPointerMove)
    canvas.addEventListener('pointerup', onTopPointerUp)
    canvas.addEventListener('wheel', onTopWheel, { passive: false })
  }
  cameraMode.value = next
  emit('camera-mode', next)
}

defineExpose({
  addModel(url: string, id: string, dataRotation?: Vec3): Promise<'added' | 'already-present' | 'not-ready'> {
    if (!isActive || !pcRef || !appRef) return Promise.resolve('not-ready')
    if (entitiesById.has(id)) return Promise.resolve('already-present')
    const pc = pcRef
    const app = appRef
    const kind = kindForUrl(url)
    const rotation = dataRotation ?? (kind === 'mesh' ? ([0, 0, 0] as Vec3) : ([180, 0, 0] as Vec3))
    const asset = new pc.Asset(`extra-${id}`, kind === 'mesh' ? 'container' : 'gsplat', { url })
    app.assets.add(asset)
    return new Promise((resolve) => {
      asset.once('load', () => {
        if (!isActive) {
          resolve('not-ready')
          return
        }
        const root = new pc.Entity(`Instance-extra-${id}`)
        app.root.addChild(root)
        const splat = new pc.Entity(`Splat-extra-${id}`)
        splat.setLocalEulerAngles(rotation[0], rotation[1], rotation[2])
        if (kind === 'mesh') {
          splat.addChild(asset.resource.instantiateRenderEntity())
        } else {
          splat.addComponent('gsplat', { asset })
        }
        root.addChild(splat)
        session.entities.add(root)
        root.enabled = session.active
        entitiesById.set(id, { root, splat, kind })
        resolve('added')
      })
      app.assets.load(asset)
    })
  },
  getInstanceAabbCenter(id: string): [number, number, number] | null {
    if (!isActive || !pcRef) return null
    const entry = entitiesById.get(id)
    if (!entry) return null
    const aabb = getWorldAabb(pcRef, entry.splat, entry.kind)
    if (aabb) return [aabb.center.x, aabb.center.y, aabb.center.z]
    const pos = entry.root.getPosition()
    return [pos.x, pos.y, pos.z]
  },
  showDebugGroundPlane(y: number) {
    if (debugGroundPlaneEntity) {
      session.entities.delete(debugGroundPlaneEntity)
      debugGroundPlaneEntity.destroy()
      debugGroundPlaneEntity = null
    }
    if (!pcRef || !appRef) return
    const pc = pcRef
    const app = appRef
    const half = 15
    const positions = [-half, y, -half, half, y, -half, -half, y, half, half, y, half]
    const indices = [0, 2, 1, 1, 2, 3]
    const mesh = new pc.Mesh(app.graphicsDevice)
    mesh.setPositions(positions)
    mesh.setIndices(indices)
    mesh.update()
    const mat = new pc.StandardMaterial()
    mat.emissive = new pc.Color(0.35, 0.75, 1.0)
    mat.emissiveIntensity = 1
    mat.cull = pc.CULLFACE_NONE
    mat.update()
    const entity = new pc.Entity('debug-ground-plane')
    app.root.addChild(entity)
    entity.addComponent('render')
    const mi = new pc.MeshInstance(mesh, mat, entity)
    mi.cull = false
    entity.render.meshInstances = [mi]
    session.entities.add(entity)
    debugGroundPlaneEntity = entity
  },
  hideDebugGroundPlane() {
    if (!debugGroundPlaneEntity) return
    session.entities.delete(debugGroundPlaneEntity)
    debugGroundPlaneEntity.destroy()
    debugGroundPlaneEntity = null
  },
  loadTpsCharacter(url: string, floorY: number) {
    if (!pcRef || !appRef) return
    destroyTpsChar()
    const pc = pcRef
    const app = appRef
    const kind = kindForUrl(url)
    const rotation = kind === 'mesh' ? [0, 0, 0] : [180, 0, 0]
    const asset = new pc.Asset('tps-char', kind === 'mesh' ? 'container' : 'gsplat', { url })
    app.assets.add(asset)
    asset.once('load', () => {
      if (!isActive) return
      const root = new pc.Entity('TpsChar')
      app.root.addChild(root)
      const splat = new pc.Entity('TpsChar-inner')
      splat.setLocalEulerAngles(rotation[0], rotation[1], rotation[2])
      if (kind === 'mesh') {
        splat.addChild(asset.resource.instantiateRenderEntity())
      } else {
        splat.addComponent('gsplat', { asset })
      }
      root.addChild(splat)
      session.entities.add(root)
      tpsCharEntity = root
      tpsCharSplat = splat
      tpsCharKind = kind
      hasTpsChar.value = true

      const tryAlign = (attempts = 0) => {
        const aabb = getWorldAabb(pc, splat, kind)
        if (!aabb && attempts < 10) { setTimeout(() => tryAlign(attempts + 1), 100); return }
        if (!aabb) return
        tpsCharHalfH = (aabb.max.y - aabb.min.y) / 2
        const bottomOffset = root.getPosition().y - aabb.min.y
        root.setPosition(0, floorY + bottomOffset, 0)
      }
      tryAlign()
    })
    app.assets.load(asset)
  },
  attachRiskMarkerGizmo(bbox: { bboxMin: Vec3; bboxMax: Vec3 }, onUpdate: (b: { bboxMin: Vec3; bboxMax: Vec3 }) => void) {
    if (!pcRef || !appRef) return
    detachRiskGizmoInternal()
    const pc = pcRef
    const app = appRef
    const cx = (bbox.bboxMin[0] + bbox.bboxMax[0]) / 2
    const cy = (bbox.bboxMin[1] + bbox.bboxMax[1]) / 2
    const cz = (bbox.bboxMin[2] + bbox.bboxMax[2]) / 2
    const sx = Math.max(Math.abs(bbox.bboxMax[0] - bbox.bboxMin[0]), 0.01)
    const sy = Math.max(Math.abs(bbox.bboxMax[1] - bbox.bboxMin[1]), 0.01)
    const sz = Math.max(Math.abs(bbox.bboxMax[2] - bbox.bboxMin[2]), 0.01)
    const entity = new pc.Entity('risk-gizmo-target')
    app.root.addChild(entity)
    entity.setPosition(cx, cy, cz)
    entity.setLocalScale(sx, sy, sz)
    session.entities.add(entity)
    riskGizmoEntity = entity
    riskGizmoOnUpdate = onUpdate
    applyGizmoState()
  },
  detachRiskMarkerGizmo() {
    detachRiskGizmoInternal()
    applyGizmoState()
  },
  pickWorldAtY(clientX: number, clientY: number, planeY: number): [number, number, number] | null {
    if (!pcRef || !cameraRef || !sharedCanvas) return null
    const pc = pcRef
    const camera = cameraRef
    const rect = sharedCanvas.getBoundingClientRect()
    const x = clientX - rect.left
    const y = clientY - rect.top
    const near = camera.camera.screenToWorld(x, y, camera.camera.nearClip)
    const far = camera.camera.screenToWorld(x, y, camera.camera.farClip)
    const dir = far.clone().sub(near).normalize()
    if (Math.abs(dir.y) < 0.001) return null
    const t = (planeY - near.y) / dir.y
    if (t < 0) return null
    return [near.x + dir.x * t, planeY, near.z + dir.z * t]
  },
  getInstanceAabbSize(id: string): [number, number, number] | null {
    if (!isActive || !pcRef) return null
    const entry = entitiesById.get(id)
    if (!entry) return null
    const aabb = getWorldAabb(pcRef, entry.splat, entry.kind)
    if (!aabb) return null
    return [aabb.halfExtents.x * 2, aabb.halfExtents.y * 2, aabb.halfExtents.z * 2]
  },
  getSceneAabbSize(): [number, number, number] | null {
    if (!isActive || !pcRef) return null
    const pc = pcRef
    let combined: any = null
    for (const { splat, kind } of allLoadedEntities) {
      const aabb = getWorldAabb(pc, splat, kind)
      if (!aabb) continue
      if (!combined) combined = aabb
      else combined.add(aabb)
    }
    if (!combined) return null
    return [combined.halfExtents.x * 2, combined.halfExtents.y * 2, combined.halfExtents.z * 2]
  },
  removeModel(id: string) {
    const entry = entitiesById.get(id)
    if (!entry) return
    if (highlightedEntity === entry) {
      highlightedEntity = null
      if (gizmosRef) {
        for (const gizmo of Object.values(gizmosRef) as any[]) gizmo.detach()
      }
    }
    entitiesById.delete(id)
    session.entities.delete(entry.root)
    entry.root.destroy()
  },
  showFloor(floor: { y: number; cellSize: number; cells: [number, number][] } | null) {
    if (floorEntityRef) {
      session.entities.delete(floorEntityRef)
      floorEntityRef.destroy()
      floorEntityRef = null
    }
    if (!floor || !floor.cells.length || !isActive || !pcRef || !appRef) return
    const pc = pcRef
    const app = appRef
    const { y, cellSize, cells } = floor
    const positions: number[] = []
    const indices: number[] = []
    for (const [cx, cz] of cells) {
      const x0 = cx * cellSize, x1 = (cx + 1) * cellSize
      const z0 = cz * cellSize, z1 = (cz + 1) * cellSize
      const base = positions.length / 3
      positions.push(x0, y, z0, x1, y, z0, x0, y, z1, x1, y, z1)
      indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3)
    }
    const mesh = new pc.Mesh(app.graphicsDevice)
    mesh.setPositions(positions)
    mesh.setIndices(indices)
    mesh.update()
    const mat = new pc.StandardMaterial()
    mat.diffuse = new pc.Color(0.25, 0.65, 1.0)
    mat.opacity = 0.28
    mat.blendType = pc.BLEND_NORMAL
    mat.depthWrite = false
    mat.cull = pc.CULLFACE_NONE
    mat.update()
    const entity = new pc.Entity('floor-plane')
    app.root.addChild(entity)
    entity.addComponent('render')
    const floorMi = new pc.MeshInstance(mesh, mat, entity)
    floorMi.cull = false
    entity.render.meshInstances = [floorMi]
    session.entities.add(entity)
    floorEntityRef = entity
  },
  showRoute(route: { floorY: number; cellSize: number; freeCells: [number, number][]; narrowCells: [number, number][] } | null) {
    for (const ref of [routeFreeEntityRef, routeNarrowEntityRef]) {
      if (ref) { session.entities.delete(ref); ref.destroy() }
    }
    routeFreeEntityRef = null
    routeNarrowEntityRef = null
    if (!route || !isActive || !pcRef || !appRef) return
    const pc = pcRef
    const app = appRef
    const { floorY, cellSize, freeCells, narrowCells } = route

    function buildMesh(cells: [number, number][], y: number): any {
      const positions: number[] = []
      const indices: number[] = []
      for (const [cx, cz] of cells) {
        const x0 = cx * cellSize, x1 = (cx + 1) * cellSize
        const z0 = cz * cellSize, z1 = (cz + 1) * cellSize
        const base = positions.length / 3
        positions.push(x0, y, z0, x1, y, z0, x0, y, z1, x1, y, z1)
        indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3)
      }
      const mesh = new pc.Mesh(app.graphicsDevice)
      mesh.setPositions(positions)
      mesh.setIndices(indices)
      mesh.update()
      return mesh
    }

    function createEntity(cells: [number, number][], y: number, r: number, g: number, b: number, name: string): any {
      if (!cells.length) return null
      const mat = new pc.StandardMaterial()
      mat.diffuse = new pc.Color(r, g, b)
      mat.opacity = 0.38
      mat.blendType = pc.BLEND_NORMAL
      mat.depthWrite = false
      mat.cull = pc.CULLFACE_NONE
      mat.update()
      const entity = new pc.Entity(name)
      app.root.addChild(entity)
      entity.addComponent('render')
      const mi = new pc.MeshInstance(buildMesh(cells, y), mat, entity)
      mi.cull = false
      entity.render.meshInstances = [mi]
      session.entities.add(entity)
      return entity
    }

    const routeY = floorY + 0.02
    const narrowSet = new Set(narrowCells.map(([cx, cz]) => `${cx},${cz}`))
    const pureFree = freeCells.filter(([cx, cz]) => !narrowSet.has(`${cx},${cz}`))

    routeFreeEntityRef = createEntity(pureFree, routeY, 0.18, 0.82, 0.32, 'route-free')
    routeNarrowEntityRef = createEntity(narrowCells, routeY, 1.0, 0.58, 0.1, 'route-narrow')
  },
  showRiskMarkers(markers: { bboxMin: Vec3; bboxMax: Vec3 }[], selectedIndices?: number[] | null) {
    riskMarkersForPick = markers
    if (!pcRef || !riskMarkerLinesRef.length) return
    const pc = pcRef
    const defaultColor = new pc.Color(0.9, 0.25, 0.15)
    const selectedColor = new pc.Color(1.0, 0.82, 0.0)
    const shown = markers.slice(0, MAX_RISK_MARKERS)
    shown.forEach((marker, markerIndex) => {
      const color = selectedIndices?.includes(markerIndex) ? selectedColor : defaultColor
      const [minX, minY, minZ] = marker.bboxMin
      const [maxX, maxY, maxZ] = marker.bboxMax
      const pick = (t: [number, number, number]) =>
        new pc.Vec3(t[0] ? maxX : minX, t[1] ? maxY : minY, t[2] ? maxZ : minZ)
      BOX_EDGES.forEach(([a, b], edgeIndex) => {
        const line = riskMarkerLinesRef[markerIndex * 12 + edgeIndex]
        line.entity.enabled = true
        line.thickness = RISK_MARKER_LINE_THICKNESS
        line.draw(pick(a), pick(b), 1, color)
      })
    })
    for (let i = shown.length * 12; i < riskMarkerLinesRef.length; i++) {
      riskMarkerLinesRef[i].entity.enabled = false
    }
  },
  showPathArrows(waypoints: { position: [number, number, number]; length: number; width: number; rotationY: number }[]) {
    for (const e of pathArrowEntities) { session.entities.delete(e); e.destroy() }
    pathArrowEntities = []
    if (!isActive || !pcRef || !appRef || !waypoints.length) return
    const pc = pcRef
    const app = appRef

    const positions: number[] = []
    const indices: number[] = []
    let base = 0

    for (const { position: [ox, oy, oz], length: len, width: W, rotationY } of waypoints) {
      const rad = (rotationY * Math.PI) / 180
      const fx = Math.sin(rad), fz = Math.cos(rad)
      const rx = -fz, rz = fx
      const hw = W / 2
      const H = Math.max(hw * 0.5, 0.04)

      const corners = (fw: number, fh: number, fl: number): [number, number, number] => [
        ox + rx * fw + fx * fl,
        oy + fh,
        oz + rz * fw + fz * fl,
      ]
      const v = [
        corners(-hw, -H, 0),
        corners( hw, -H, 0),
        corners(-hw,  H, 0),
        corners( hw,  H, 0),
        corners(-hw, -H, len),
        corners( hw, -H, len),
        corners(-hw,  H, len),
        corners( hw,  H, len),
      ]
      for (const [vx, vy, vz] of v) positions.push(vx, vy, vz)
      const b = base
      indices.push(
        b+2,b+3,b+6, b+3,b+7,b+6,
        b+0,b+4,b+1, b+1,b+4,b+5,
        b+0,b+1,b+2, b+1,b+3,b+2,
        b+4,b+6,b+5, b+5,b+6,b+7,
        b+0,b+2,b+4, b+2,b+6,b+4,
        b+1,b+5,b+3, b+3,b+5,b+7,
      )
      base += 8
    }

    const mesh = new pc.Mesh(app.graphicsDevice)
    mesh.setPositions(positions)
    mesh.setIndices(indices)
    mesh.update()

    const mat = new pc.StandardMaterial()
    mat.emissive = new pc.Color(0.2, 0.5, 1.0)
    mat.emissiveIntensity = 1.0
    mat.diffuse = new pc.Color(0, 0, 0)
    mat.cull = pc.CULLFACE_NONE
    mat.update()

    const entity = new pc.Entity('path-arrows')
    app.root.addChild(entity)
    entity.addComponent('render')
    const mi = new pc.MeshInstance(mesh, mat, entity)
    mi.cull = false
    entity.render.meshInstances = [mi]
    session.entities.add(entity)
    pathArrowEntities.push(entity)
  },
  async captureThumbnail(): Promise<Blob | null> {
    if (!isActive || !session.active || !pcRef || !cameraRef || !sharedCanvas) return null
    const lodDeadline = Date.now() + 60000
    while (loadStage.value !== 'done' && Date.now() < lodDeadline && isActive && session.active) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
    if (!isActive || !session.active) return null
    const pc = pcRef
    let combined: any = null
    for (const { splat, kind } of allLoadedEntities) {
      const worldAabb = getWorldAabb(pc, splat, kind)
      if (!worldAabb) continue
      if (!combined) combined = worldAabb
      else combined.add(worldAabb)
    }
    if (!combined) return null

    const camera = cameraRef
    const radius = Math.max(combined.halfExtents.length(), 1e-4)
    const fovRad = (camera.camera.fov * Math.PI) / 180
    const distance = (radius / Math.sin(fovRad / 2)) * 1.08
    const dir = new pc.Vec3(1, 0.75, 1).normalize()
    const center = combined.center.clone()

    const isFinitePos = [center.x, center.y, center.z, distance].every((n) => Number.isFinite(n))
    if (!isFinitePos) return null

    const position = center.clone().add(dir.mulScalar(distance))
    camera.script.cameraControls.reset(center, position)

    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    if (!isActive || !session.active) return null

    const postMoveDeadline = Date.now() + 60000
    while (lodCurrentPending.value > 0 && Date.now() < postMoveDeadline && isActive && session.active) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
    if (!isActive || !session.active) return null
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    if (!isActive || !session.active) return null

    return await new Promise<Blob | null>((resolve) => {
      sharedCanvas!.toBlob((blob) => resolve(blob), 'image/jpeg', 0.85)
    })
  },
  async captureCurrentView(): Promise<Blob | null> {
    if (!isActive || !session.active || !sharedCanvas) return null
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))

    if (!isActive || !session.active) return null
    return new Promise<Blob | null>((resolve) => {
      sharedCanvas!.toBlob((blob) => resolve(blob), 'image/jpeg', 0.85)
    })
  },
  getVisibleInstanceScreenPositions(): { id: string; x: number; y: number; distance: number; worldPos: [number, number, number] | null }[] {
    if (!isActive || !pcRef || !cameraRef || !appRef) return []
    const pc = pcRef
    const camera = cameraRef
    const { width, height } = appRef.graphicsDevice.clientRect
    if (!width || !height) return []
    const cameraPos = camera.getPosition()
    const cameraForward = camera.forward
    const screenPos = new pc.Vec3()
    const out: { id: string; x: number; y: number; distance: number; worldPos: [number, number, number] | null }[] = []
    for (const [id, { root, splat, kind }] of entitiesById) {
      if (!root.enabled) continue
      const worldAabb = getWorldAabb(pc, splat, kind)
      const worldPos = worldAabb ? worldAabb.center : root.getPosition()
      const toObject = worldPos.clone().sub(cameraPos)
      if (toObject.dot(cameraForward) <= 0) continue
      camera.camera.worldToScreen(worldPos, screenPos)
      const x = (screenPos.x / width) * 1000
      const y = (screenPos.y / height) * 1000
      if (x < 0 || x > 1000 || y < 0 || y > 1000) continue
      out.push({ id, x, y, distance: toObject.length(), worldPos: [worldPos.x, worldPos.y, worldPos.z] })
    }
    return out
  },
  getCameraAxes(): { right: Vec3; up: Vec3; forward: Vec3 } | null {
    if (!isActive || !cameraRef) return null
    const camera = cameraRef
    const toArray = (v: any): Vec3 => [v.x, v.y, v.z]
    return { right: toArray(camera.right), up: toArray(camera.up), forward: toArray(camera.forward) }
  },
  getCameraState(): { position: Vec3; forward: Vec3 } | null {
    if (!isActive || !cameraRef) return null
    const pos = cameraRef.getPosition()
    const fwd = cameraRef.forward
    return {
      position: [pos.x, pos.y, pos.z],
      forward: [fwd.x, fwd.y, fwd.z],
    }
  },
  updateInstanceTransform(id: string, transform: { position: Vec3; rotation: Vec3; scale: Vec3 }) {
    const entry = entitiesById.get(id)
    if (!entry) return
    entry.root.setLocalPosition(transform.position[0], transform.position[1], transform.position[2])
    entry.root.setLocalEulerAngles(transform.rotation[0], transform.rotation[1], transform.rotation[2])
    entry.root.setLocalScale(transform.scale[0], transform.scale[1], transform.scale[2])
  },
  updateInstanceColor(id: string, color: string | null, url: string) {
    const entry = entitiesById.get(id)
    if (!entry || !isActive || !pcRef || !appRef) return
    const pc = pcRef
    const app = appRef

    if (entry.kind === 'mesh') {
      if (color) {
        applyColorTint(pc, entry.splat, entry.kind, color)
        return
      }
      const freshAsset = new pc.Asset(`clear-${id}-${Date.now()}`, 'container', { url })
      app.assets.add(freshAsset)
      freshAsset.once('load', () => {
        if (!isActive) return
        const current = entitiesById.get(id)
        if (!current) return
        for (const child of [...current.splat.children]) child.destroy()
        current.splat.addChild(freshAsset.resource.instantiateRenderEntity())
      })
      app.assets.load(freshAsset)
      return
    }

    const tag = `${id}-${Date.now()}`
    // 復原成未染色時不用特地拿專屬 url——沒有要染色就不會mutate 到共用資源,直接跟別人共用
    // ResourceLoader 的快取也沒關係,見 exclusiveAssetUrl 的說明。
    const assetUrl = color ? exclusiveAssetUrl(url, tag) : url
    const freshAsset = new pc.Asset(`recolor-${tag}`, 'gsplat', { url: assetUrl })
    app.assets.add(freshAsset)
    freshAsset.once('load', () => {
      if (!isActive) return
      const current = entitiesById.get(id)
      if (!current) return
      current.splat.gsplat.asset = freshAsset
      if (color) applyColorTint(pc, current.splat, current.kind, color)
    })
    app.assets.load(freshAsset)
  },
})

onBeforeUnmount(() => {
  isActive = false
  resizeObserver?.disconnect()
  resizeObserver = null
  if (resizeTimer) { clearTimeout(resizeTimer); resizeTimer = null }
  sharedCanvas?.removeEventListener('pointerdown', onCanvasPointerDown)
  sharedCanvas?.removeEventListener('pointerup', onCanvasPointerUp)
  appRef?.off('update', onAppUpdate)
  appRef?.off('update', onFpsUpdate)
  appRef?.systems.gsplat.off('frame:ready', onGsplatFrameReady)
  window.removeEventListener('keydown', onFpsKeyDown)
  window.removeEventListener('keyup', onFpsKeyUp)
  if (gizmosRef) {
    for (const gizmo of Object.values(gizmosRef) as any[]) gizmo.off('pointer:up', persistSelectedTransform)
  }
  highlightedEntity = null
  floorEntityRef = null
  routeFreeEntityRef = null
  routeNarrowEntityRef = null
  for (const line of highlightLinesRef) line.entity.enabled = false
  for (const line of riskMarkerLinesRef) line.entity.enabled = false
  riskMarkersForPick = []
  detachRiskGizmoInternal()
  if (debugGroundPlaneEntity) { session.entities.delete(debugGroundPlaneEntity); debugGroundPlaneEntity.destroy(); debugGroundPlaneEntity = null }
  // 把畫布交還給底下(如果有的話)還在畫面上的上一個 GSplatViewer,銷毀自己建立的 entity——
  // 不是無條件把畫布從畫面上移除,不然編輯頁面的主畫面被疊在上面的預覽彈窗關掉後會整個變黑
  if (sharedCanvas) leaveCameraMode(sharedCanvas)
  destroyTpsChar()
  if (sharedCanvas) releaseCanvas(sharedCanvas, session, gizmosRef)
  sharedCanvas = null
})
</script>

<template>
  <div ref="wrapperRef" class="gsplat-viewer">
    <div v-if="loading" class="gsplat-viewer__loading">{{ loadPercent }}%</div>
    <div v-else-if="loadStage !== 'done'" class="gsplat-viewer__refining">{{ loadPercent }}%</div>
    <div v-if="loadStage === 'done' && cameraMode === 'fps'" class="gsplat-viewer__height-ctrl">
      <input
        type="range"
        class="gsplat-viewer__height-slider"
        v-model.number="fpsHeight"
        :min="fpsHeightMin"
        :max="fpsHeightMax"
        step="0.1"
        orient="vertical"
      />
    </div>
    <div v-if="cameraMode === 'tps' && !hasTpsChar" class="gsplat-viewer__tps-hint">
      點擊右上角按鈕選擇操控模型
    </div>
    <div v-if="loadStage === 'done'" class="gsplat-viewer__cam-stack">
      <button
        type="button"
        class="gsplat-viewer__cam-btn"
        :title="cameraMode === 'orbit' ? '切換第一人稱' : cameraMode === 'fps' ? '切換第三人稱' : cameraMode === 'tps' ? '切換頂視圖' : '切換預設視角'"
        @click="switchCameraMode"
      >
        <!-- orbit -->
        <svg v-if="cameraMode === 'orbit'" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 12a9 9 0 1 0 18 0 9 9 0 0 0-18 0"/>
          <path d="M3.6 9h16.8"/><path d="M3.6 15h16.8"/>
          <path d="M11.5 3a17 17 0 0 0 0 18"/><path d="M12.5 3a17 17 0 0 1 0 18"/>
        </svg>
        <!-- fps -->
        <svg v-else-if="cameraMode === 'fps'" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="5" r="2"/><path d="M12 7v6"/>
          <path d="M9 17l3-4 3 4"/><path d="M7 21l2-4"/><path d="M17 21l-2-4"/>
        </svg>
        <!-- tps: 人跟攝影機 -->
        <svg v-else-if="cameraMode === 'tps'" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="8" cy="5" r="2"/><path d="M8 7v5"/><path d="M5 18l3-6 3 6"/>
          <rect x="15" y="9" width="6" height="5" rx="1"/>
          <path d="M15 11.5l-3 0"/><circle cx="12" cy="11.5" r="0.5" fill="currentColor"/>
        </svg>
        <!-- top -->
        <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/>
          <rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/>
        </svg>
      </button>
      <button
        v-if="cameraMode === 'tps'"
        type="button"
        class="gsplat-viewer__cam-btn"
        title="選擇操控模型"
        @click="emit('request-tps-char')"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 7H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z"/>
          <circle cx="12" cy="12" r="2"/>
          <path d="M6 12h.01M18 12h.01"/>
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.gsplat-viewer {
  position: relative;
  width: 100%;
  height: 100%;
}

.gsplat-viewer :deep(canvas) {
  display: block;
  width: 100%;
  height: 100%;
}

.gsplat-viewer__loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 0.9rem;
  background: rgba(0, 0, 0, 0.25);
  pointer-events: none;
}

.gsplat-viewer__refining {
  position: absolute;
  top: 0.75rem;
  right: 0.75rem;
  padding: 0.35rem 0.7rem;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 0.75rem;
  pointer-events: none;
}

.gsplat-viewer__tps-hint {
  position: absolute;
  bottom: 2rem;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 0.85rem;
  padding: 0.5rem 1rem;
  border-radius: 0.5rem;
  pointer-events: none;
  white-space: nowrap;
}

.gsplat-viewer__cam-stack {
  position: absolute;
  top: 0.75rem;
  right: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  z-index: 10;
}

.gsplat-viewer__cam-btn {
  width: 2.25rem;
  height: 2.25rem;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 0.5rem;
  background: rgba(0, 0, 0, 0.5);
  color: #fff;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.gsplat-viewer__cam-btn:hover {
  background: var(--color-clay, #c0855a);
  color: #fff;
}

.gsplat-viewer__height-ctrl {
  position: absolute;
  top: calc(0.75rem + 2.25rem + 0.5rem);
  right: 0.75rem;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.5);
  border-radius: 0.5rem;
  padding: 0.5rem 0.4rem;
}

.gsplat-viewer__height-slider {
  writing-mode: vertical-lr;
  direction: rtl;
  width: 1.375rem;
  height: 7rem;
  cursor: pointer;
  accent-color: #fff;
  background: transparent;
}
</style>
