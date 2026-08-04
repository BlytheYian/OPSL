<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { claimCanvas, getSharedGSplatApp, releaseCanvas, setGizmoTarget, type GizmoMode, type ViewerSession } from '../lib/gsplatApp'
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
  /** 載入百分比(涵蓋檔案下載 + LOD 細節收斂兩階段),外層想自己畫載入提示時可以用這個 */
  progress: [percent: number]
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
let sharedCanvas: HTMLCanvasElement | null = null
let isActive = true

let pcRef: any = null
let appRef: any = null
let cameraRef: any = null
let gizmosRef: any = null
let highlightLinesRef: any[] = []
let entitiesById = new Map<string, { root: any; splat: any; kind: 'gsplat' | 'mesh' }>()
let allLoadedEntities: { root: any; splat: any; kind: 'gsplat' | 'mesh' }[] = []

const session: ViewerSession = { wrapper: null as unknown as HTMLElement, entities: new Set(), active: false, camera: null }

let highlightedEntity: any = null
let needsInitialFraming = false
let initialFramingDone = false
const BOX_EDGES: Array<[[number, number, number], [number, number, number]]> = [
  [[0, 0, 0], [1, 0, 0]], [[1, 0, 0], [1, 0, 1]], [[1, 0, 1], [0, 0, 1]], [[0, 0, 1], [0, 0, 0]],
  [[0, 1, 0], [1, 1, 0]], [[1, 1, 0], [1, 1, 1]], [[1, 1, 1], [0, 1, 1]], [[0, 1, 1], [0, 1, 0]],
  [[0, 0, 0], [0, 1, 0]], [[1, 0, 0], [1, 1, 0]], [[1, 0, 1], [1, 1, 1]], [[0, 0, 1], [0, 1, 1]],
]
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
}
function applyGizmoState() {
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

  const { pc, app, canvas, editorCamera, previewCamera, gizmos, highlightLines } = await getSharedGSplatApp()
  if (!isActive) return
  pcRef = pc
  appRef = app
  // 再額外加一個 prop。
  const camera = props.selectable ? editorCamera : previewCamera
  cameraRef = camera
  session.camera = camera
  gizmosRef = gizmos
  highlightLinesRef = highlightLines

  sharedCanvas = canvas
  const resize = () => {
    const { width, height } = wrapper.getBoundingClientRect()
    app.resizeCanvas(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)))
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
  async captureThumbnail(): Promise<Blob | null> {
    if (!isActive || !session.active || !pcRef || !cameraRef || !sharedCanvas) return null
    const lodDeadline = Date.now() + 60000
    while (lodCurrentPending.value > 0 && Date.now() < lodDeadline && isActive && session.active) {
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
  getVisibleInstanceScreenPositions(): { id: string; x: number; y: number; distance: number }[] {
    if (!isActive || !pcRef || !cameraRef || !appRef) return []
    const pc = pcRef
    const camera = cameraRef
    const { width, height } = appRef.graphicsDevice.clientRect
    if (!width || !height) return []
    const cameraPos = camera.getPosition()
    const cameraForward = camera.forward
    const screenPos = new pc.Vec3()
    const out: { id: string; x: number; y: number; distance: number }[] = []
    for (const [id, { root, splat, kind }] of entitiesById) {
      if (!root.enabled) continue
      const worldAabb = getWorldAabb(pc, splat, kind)
      const worldPos = worldAabb ? worldAabb.center : root.getPosition()
      const toObject = worldPos.clone().sub(cameraPos)
      if (toObject.dot(cameraForward) <= 0) continue // 在相機後面,不可能在畫面上看得到
      camera.camera.worldToScreen(worldPos, screenPos)
      const x = (screenPos.x / width) * 1000
      const y = (screenPos.y / height) * 1000
      if (x < 0 || x > 1000 || y < 0 || y > 1000) continue 
      out.push({ id, x, y, distance: toObject.length() })
    }
    return out
  },
  getCameraAxes(): { right: Vec3; up: Vec3; forward: Vec3 } | null {
    if (!isActive || !cameraRef) return null
    const camera = cameraRef
    const toArray = (v: any): Vec3 => [v.x, v.y, v.z]
    return { right: toArray(camera.right), up: toArray(camera.up), forward: toArray(camera.forward) }
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
  sharedCanvas?.removeEventListener('pointerdown', onCanvasPointerDown)
  sharedCanvas?.removeEventListener('pointerup', onCanvasPointerUp)
  appRef?.off('update', onAppUpdate)
  appRef?.systems.gsplat.off('frame:ready', onGsplatFrameReady)
  if (gizmosRef) {
    for (const gizmo of Object.values(gizmosRef) as any[]) gizmo.off('pointer:up', persistSelectedTransform)
  }
  highlightedEntity = null
  for (const line of highlightLinesRef) line.entity.enabled = false
  // 把畫布交還給底下(如果有的話)還在畫面上的上一個 GSplatViewer,銷毀自己建立的 entity——
  // 不是無條件把畫布從畫面上移除,不然編輯頁面的主畫面被疊在上面的預覽彈窗關掉後會整個變黑
  if (sharedCanvas) releaseCanvas(sharedCanvas, session, gizmosRef)
  sharedCanvas = null
})
</script>

<template>
  <div ref="wrapperRef" class="gsplat-viewer">
    <div v-if="loading" class="gsplat-viewer__loading">{{ loadPercent }}%</div>
    <div v-else-if="loadStage !== 'done'" class="gsplat-viewer__refining">{{ loadPercent }}%</div>
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
</style>
