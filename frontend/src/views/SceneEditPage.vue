<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useLibraryStore, upAxisFixFor, type LibraryItem } from '../stores/library'
import { useSceneObjectsStore, type RouteDetectionResult, type Vec3 } from '../stores/sceneObjects'
import GSplatViewer from '../components/GSplatViewer.vue'
import CompareGSplatViewer from '../components/CompareGSplatViewer.vue'
import PreviewModal from '../components/PreviewModal.vue'
import ModelCard from '../components/ModelCard.vue'
import type { GizmoMode } from '../lib/gsplatApp'

const route = useRoute()
const router = useRouter()
const library = useLibraryStore()
const sceneObjectsStore = useSceneObjectsStore()

const sceneId = computed(() => String(route.params.id))
const scene = computed(() => library.scenes.find((s) => s.id === sceneId.value))

const ready = ref(false)
const sessionVersionId = ref<number | null>(null)
let patchDebounceTimer: ReturnType<typeof setTimeout> | null = null

onMounted(async () => {
  await Promise.all([
    library.scenesLoaded ? Promise.resolve() : library.fetchScenes(),
    library.objectsLoaded ? Promise.resolve() : library.fetchObjects(),
    sceneObjectsStore.fetchInstancesForScene(sceneId.value),
  ])
  ready.value = true
  if (sceneObjectsStore.instancesForScene(sceneId.value).length > 0) {
    const v = await sceneObjectsStore.createVersion(sceneId.value).catch(() => null)
    if (v) sessionVersionId.value = v.id
  }
})

watch(
  () => sceneObjectsStore.pendingCommandsBySceneId[sceneId.value],
  (commands) => {
    if (!sessionVersionId.value || !commands?.length) return
    if (patchDebounceTimer) clearTimeout(patchDebounceTimer)
    patchDebounceTimer = setTimeout(() => {
      sceneObjectsStore.patchVersionCommands(sceneId.value, sessionVersionId.value!, commands).catch(() => {})
    }, 1500)
  }
)
const sceneInstances = computed(() => (scene.value ? sceneObjectsStore.instancesForScene(scene.value.id) : []))

const sceneModelUrls = computed(() => (scene.value ? sceneObjectsStore.sceneModelUrls(scene.value.id) : []))
const sceneModelIds = computed<string[]>(() => sceneInstances.value.map((i) => i.id))
const sceneTransforms = computed(() => sceneInstances.value.map((i) => ({ position: i.position, rotation: i.rotation, scale: i.scale })))

const sceneDataRotations = computed(() =>
  sceneInstances.value.map((i, idx) => upAxisFixFor(i.modelId, sceneModelUrls.value[idx]))
)
const sceneColors = computed(() => sceneInstances.value.map((i) => i.color))
const availableModels = computed(() => (scene.value ? sceneObjectsStore.availableModelsForScene() : []))
const modelSearchQuery = ref('')
const filteredAvailableModels = computed(() => {
  const q = modelSearchQuery.value.trim().toLowerCase()
  if (!q) return availableModels.value
  return availableModels.value.filter((obj) => obj.name.toLowerCase().includes(q))
})

const leftCollapsed = ref(false)
const rightCollapsed = ref(false)
const viewerRef = ref<InstanceType<typeof GSplatViewer> | null>(null)
const previewing = ref<LibraryItem | null>(null)

const selectedObjectId = ref<string | null>(null)
const gizmoMode = ref<GizmoMode>('translate')

function selectObject(id: string) {
  selectedObjectId.value = selectedObjectId.value === id ? null : id
}

async function confirmAddModel() {
  const obj = previewing.value
  if (!obj?.modelUrl || !scene.value) return
  const instance = await sceneObjectsStore.addInstance(scene.value.id, obj.id, obj.name)
  viewerRef.value?.addModel(obj.modelUrl, instance.id, upAxisFixFor(obj.id, obj.modelUrl))
  selectedObjectId.value = instance.id
  previewing.value = null
}

function removeInstance(id: string) {
  viewerRef.value?.removeModel(id)
  sceneObjectsStore.removeInstance(id)
  if (selectedObjectId.value === id) selectedObjectId.value = null
}

const editingInstanceId = ref<string | null>(null)
const editingLabel = ref('')
const renameInputRefs = ref<HTMLInputElement[]>([])

function startRename(id: string, currentLabel: string) {
  selectedObjectId.value = id
  editingInstanceId.value = id
  editingLabel.value = currentLabel
  nextTick(() => renameInputRefs.value[0]?.focus())
}
function commitRename() {
  if (editingInstanceId.value && editingLabel.value.trim()) {
    sceneObjectsStore.renameInstance(editingInstanceId.value, editingLabel.value.trim())
  }
  editingInstanceId.value = null
}

const hiddenObjectIds = computed(() => new Set(sceneInstances.value.filter((i) => i.hidden).map((i) => i.id)))

const selectedInstance = computed(() => sceneInstances.value.find((i) => i.id === selectedObjectId.value) ?? null)
const selectedModel = computed(() => selectedInstance.value ? library.objects.find((o) => o.id === selectedInstance.value!.modelId) ?? null : null)

const instanceListRef = ref<HTMLUListElement | null>(null)
watch(selectedObjectId, (id) => {
  if (!id) return
  nextTick(() => {
    const el = instanceListRef.value?.querySelector(`[data-instance-id="${id}"]`)
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  })
})

const detailPos = ref<[string, string, string]>(['0', '0', '0'])
const detailScalePct = ref(100)
const detailLabelText = ref('')
const colorPickerRef = ref<HTMLInputElement | null>(null)

watch(selectedInstance, (inst) => {
  if (!inst) return
  detailPos.value = inst.position.map(v => String(parseFloat(v.toFixed(3)))) as [string, string, string]
  detailScalePct.value = Math.round(inst.scale[0] * 100)
  detailLabelText.value = inst.label
  detailDimW.value = ''
  detailDimH.value = ''
  detailDimD.value = ''
  refreshAabbSize()
}, { immediate: true })

function applyDetailTransform() {
  if (!selectedInstance.value) return
  const id = selectedInstance.value.id
  const position: Vec3 = [parseFloat(detailPos.value[0]) || 0, parseFloat(detailPos.value[1]) || 0, parseFloat(detailPos.value[2]) || 0]
  const rotation: Vec3 = selectedInstance.value.rotation
  const s = (detailScalePct.value || 100) / 100
  const scale: Vec3 = [s, s, s]
  viewerRef.value?.updateInstanceTransform(id, { position, rotation, scale })
  sceneObjectsStore.updateTransform(id, { position, rotation, scale })
  refreshAabbSize()
}

function adjustScalePct(delta: number) {
  detailScalePct.value = Math.max(1, detailScalePct.value + delta)
  applyDetailTransform()
}

const detailDimW = ref('')
const detailDimH = ref('')
const detailDimD = ref('')
const detailAabbSize = ref<[number, number, number] | null>(null)
const instanceSizes = ref(new Map<string, [number, number, number]>())

function refreshAabbSize() {
  if (!selectedInstance.value) return
  nextTick(() => {
    detailAabbSize.value = viewerRef.value?.getInstanceAabbSize(selectedInstance.value!.id) ?? null
  })
}

function refreshAllInstanceSizes() {
  nextTick(() => {
    const map = new Map<string, [number, number, number]>()
    for (const inst of sceneInstances.value) {
      const size = viewerRef.value?.getInstanceAabbSize(inst.id)
      if (size) map.set(inst.id, size)
    }
    instanceSizes.value = map
    if (selectedInstance.value) {
      detailAabbSize.value = map.get(selectedInstance.value.id) ?? null
    }
  })
}

function fmtSize(s: [number, number, number]) {
  return `${s[0].toFixed(2)}m × ${s[1].toFixed(2)}m × ${s[2].toFixed(2)}m`
}

type RiskEntry = {
  label: string
  severity: '高' | '中' | '低'
  desc: string
  bboxes: { bboxMin: [number, number, number]; bboxMax: [number, number, number] }[]
}

type PathWaypoint = {
  position: [number, number, number]
  length: number
  width: number
  rotationY: number
}

type PathEntry = {
  label: string
  waypoints: PathWaypoint[]
}

const RISK_STORAGE_KEY = 'riskMarkers_v1'
function loadRisks(): RiskEntry[] {
  try { return JSON.parse(localStorage.getItem(RISK_STORAGE_KEY) ?? '[]') } catch { return [] }
}
function persistRisks(risks: RiskEntry[]) {
  localStorage.setItem(RISK_STORAGE_KEY, JSON.stringify(risks))
}

const savedRisks = ref<RiskEntry[]>(loadRisks())
const riskFlatMarkers = computed(() => savedRisks.value.flatMap((r) => r.bboxes))
const markerToRisk = computed(() => savedRisks.value.flatMap((r, i) => r.bboxes.map(() => i)))
const selectedRiskIdx = ref<number | null>(null)

const ROUTE_STORAGE_KEY = 'routePath_v1'
function loadPath(): PathEntry {
  try {
    const raw = JSON.parse(localStorage.getItem(ROUTE_STORAGE_KEY) ?? 'null')
    if (!raw) return { label: '路徑', waypoints: [] }
    const waypoints: PathWaypoint[] = (raw.waypoints ?? []).map((w: PathWaypoint | [number,number,number]) => {
      if (Array.isArray(w)) return { position: w as [number,number,number], length: 1.0, rotationY: 0 }
      return { position: w.position, length: w.length ?? 1.0, width: w.width ?? 0.2, rotationY: w.rotationY ?? 0 }
    })
    return { label: raw.label ?? '路徑', waypoints }
  } catch { return { label: '路徑', waypoints: [] } }
}
function persistPath(p: PathEntry) {
  localStorage.setItem(ROUTE_STORAGE_KEY, JSON.stringify(p))
}

const riskDebugActive = ref(false)
const editingRisk = ref<RiskEntry | null>(null)
const editingRiskIdx = ref<number | null>(null)
const placingMode = ref(false)
const placingBboxSlot = ref<number>(0)
const placingY = ref(0.75)
const debugFloorY = ref(parseFloat(localStorage.getItem('debugFloorY') ?? '0'))
const activeBboxGizmoIdx = ref<number | null>(null)

const editingPath = ref<PathEntry | null>(null)
const pathPlacingMode = ref(false)
const pathPlacingY = ref(0.75)

const _debugKeyBuf: string[] = []

function riskSelectedIndices(idx: number | null) {
  if (idx === null) return []
  return markerToRisk.value.flatMap((ri, mi) => ri === idx ? [mi] : [])
}

function onRiskPick(flatIndex: number | null) {
  if (rightTab.value !== 'risk' || flatIndex === null) return
  selectedRiskIdx.value = markerToRisk.value[flatIndex] ?? null
}

function refreshRiskMarkers() {
  if (rightTab.value !== 'risk') return
  viewerRef.value?.showRiskMarkers(riskFlatMarkers.value, riskSelectedIndices(selectedRiskIdx.value))
}

function startEditRisk(i: number) {
  const r = savedRisks.value[i]
  editingRiskIdx.value = i
  editingRisk.value = { ...r, bboxes: r.bboxes.map((b) => ({ bboxMin: [...b.bboxMin] as [number,number,number], bboxMax: [...b.bboxMax] as [number,number,number] })) }
  viewerRef.value?.showRiskMarkers(editingRisk.value.bboxes, [])
}

function addNewRisk() {
  const r: RiskEntry = { label: '新風險項目', severity: '中', desc: '', bboxes: [] }
  savedRisks.value.push(r)
  persistRisks(savedRisks.value)
  startEditRisk(savedRisks.value.length - 1)
}

function saveEditingRisk() {
  if (!editingRisk.value || editingRiskIdx.value === null) return
  deselectBboxGizmo()
  savedRisks.value[editingRiskIdx.value] = { ...editingRisk.value, bboxes: editingRisk.value.bboxes.map((b) => ({ bboxMin: [...b.bboxMin] as [number,number,number], bboxMax: [...b.bboxMax] as [number,number,number] })) }
  persistRisks(savedRisks.value)
  editingRisk.value = null
  editingRiskIdx.value = null
  refreshRiskMarkers()
}

function cancelEditRisk() {
  deselectBboxGizmo()
  if (editingRiskIdx.value !== null && savedRisks.value[editingRiskIdx.value]?.bboxes.length === 0) {
    savedRisks.value.splice(editingRiskIdx.value, 1)
    persistRisks(savedRisks.value)
  }
  editingRisk.value = null
  editingRiskIdx.value = null
  placingMode.value = false
}

function deleteRisk(i: number) {
  savedRisks.value.splice(i, 1)
  persistRisks(savedRisks.value)
  if (selectedRiskIdx.value === i) selectedRiskIdx.value = null
  refreshRiskMarkers()
}

function refreshPathArrows() {
  viewerRef.value?.showPathArrows(editingPath.value?.waypoints ?? [])
}

function saveEditingPath() {
  if (!editingPath.value) return
  persistPath(editingPath.value)
  refreshPathArrows()
}

function deleteWaypoint(i: number) {
  editingPath.value?.waypoints.splice(i, 1)
  refreshPathArrows()
}

function updateWaypointLength(i: number, raw: string) {
  if (!editingPath.value) return
  const v = parseFloat(raw)
  if (isNaN(v) || v <= 0) return
  editingPath.value.waypoints[i].length = v
  refreshPathArrows()
}

function updateWaypointWidth(i: number, raw: string) {
  if (!editingPath.value) return
  const v = parseFloat(raw)
  if (isNaN(v) || v <= 0) return
  editingPath.value.waypoints[i].width = v
  refreshPathArrows()
}

function updateWaypointRotation(i: number, raw: string) {
  if (!editingPath.value) return
  const v = parseFloat(raw)
  if (isNaN(v)) return
  editingPath.value.waypoints[i].rotationY = v
  refreshPathArrows()
}

function startPathPlacing() {
  pathPlacingMode.value = true
}

function onPathPlacingClick(e: MouseEvent) {
  if (!pathPlacingMode.value || !editingPath.value) return
  const pos = viewerRef.value?.pickWorldAtY(e.clientX, e.clientY, pathPlacingY.value)
  if (!pos) return
  editingPath.value.waypoints.push({ position: [pos[0], pos[1], pos[2]], length: 1.0, width: 0.2, rotationY: 0 })
  pathPlacingMode.value = false
  refreshPathArrows()
}

function deleteBbox(bi: number) {
  editingRisk.value?.bboxes.splice(bi, 1)
  previewEditingMarkers()
}

function bboxCenter(bbox: { bboxMin: [number,number,number]; bboxMax: [number,number,number] }): [number,number,number] {
  return [
    (bbox.bboxMin[0] + bbox.bboxMax[0]) / 2,
    (bbox.bboxMin[1] + bbox.bboxMax[1]) / 2,
    (bbox.bboxMin[2] + bbox.bboxMax[2]) / 2,
  ]
}

function bboxSize(bbox: { bboxMin: [number,number,number]; bboxMax: [number,number,number] }): number {
  return bbox.bboxMax[0] - bbox.bboxMin[0]
}

function updateBboxCenter(bi: number, axis: 0 | 1 | 2, raw: string) {
  if (!editingRisk.value) return
  const v = parseFloat(raw)
  if (isNaN(v)) return
  const bbox = editingRisk.value.bboxes[bi]
  const hs = bboxSize(bbox) / 2
  bbox.bboxMin[axis] = v - hs
  bbox.bboxMax[axis] = v + hs
  previewEditingMarkers()
  if (activeBboxGizmoIdx.value === bi) selectBboxGizmo(bi)
}

function bboxAxisSize(bbox: { bboxMin: [number,number,number]; bboxMax: [number,number,number] }, axis: 0|1|2): number {
  return Math.abs(bbox.bboxMax[axis] - bbox.bboxMin[axis])
}

function updateBboxSize(bi: number, raw: string) {
  if (!editingRisk.value) return
  const side = parseFloat(raw)
  if (isNaN(side) || side <= 0) return
  const hs = side / 2
  const bbox = editingRisk.value.bboxes[bi]
  const [cx, cy, cz] = bboxCenter(bbox)
  bbox.bboxMin = [cx - hs, cy - hs, cz - hs]
  bbox.bboxMax = [cx + hs, cy + hs, cz + hs]
  previewEditingMarkers()
  if (activeBboxGizmoIdx.value === bi) selectBboxGizmo(bi)
}

function updateBboxAxisSize(bi: number, axis: 0|1|2, raw: string) {
  if (!editingRisk.value) return
  const side = parseFloat(raw)
  if (isNaN(side) || side <= 0) return
  const hs = side / 2
  const bbox = editingRisk.value.bboxes[bi]
  const c = bboxCenter(bbox)[axis]
  bbox.bboxMin[axis] = c - hs
  bbox.bboxMax[axis] = c + hs
  previewEditingMarkers()
  if (activeBboxGizmoIdx.value === bi) selectBboxGizmo(bi)
}

function previewEditingMarkers() {
  if (!editingRisk.value) return
  const sel = activeBboxGizmoIdx.value !== null ? [activeBboxGizmoIdx.value] : []
  viewerRef.value?.showRiskMarkers(editingRisk.value.bboxes, sel)
}

function selectBboxGizmo(bi: number) {
  if (!editingRisk.value) return
  activeBboxGizmoIdx.value = bi
  const bbox = editingRisk.value.bboxes[bi]
  viewerRef.value?.attachRiskMarkerGizmo(bbox, (updated) => {
    if (!editingRisk.value) return
    editingRisk.value.bboxes[bi] = updated
    previewEditingMarkers()
  })
  previewEditingMarkers()
}

function deselectBboxGizmo() {
  activeBboxGizmoIdx.value = null
  viewerRef.value?.detachRiskMarkerGizmo()
  previewEditingMarkers()
}

function startPlacing(slot: number) {
  placingBboxSlot.value = slot
  placingMode.value = true
}

function onAnyPlacingClick(e: MouseEvent) {
  if (pathPlacingMode.value) { onPathPlacingClick(e); return }
  onPlacingClick(e)
}

function onPlacingClick(e: MouseEvent) {
  if (!placingMode.value || !editingRisk.value) return
  const pos = viewerRef.value?.pickWorldAtY(e.clientX, e.clientY, placingY.value)
  if (!pos) return
  const hs = 0.08
  const bbox = { bboxMin: [pos[0]-hs, pos[1]-hs, pos[2]-hs] as [number,number,number], bboxMax: [pos[0]+hs, pos[1]+hs, pos[2]+hs] as [number,number,number] }
  if (placingBboxSlot.value < editingRisk.value.bboxes.length) {
    editingRisk.value.bboxes[placingBboxSlot.value] = bbox
  } else {
    editingRisk.value.bboxes.push(bbox)
  }
  placingMode.value = false
  const newIdx = placingBboxSlot.value < editingRisk.value.bboxes.length ? placingBboxSlot.value : editingRisk.value.bboxes.length - 1
  selectBboxGizmo(newIdx)
}

function applyScaleFromDim(axis: 0 | 1 | 2, val: string) {
  const target = parseFloat(val)
  if (!target || !selectedInstance.value) return
  const size = viewerRef.value?.getInstanceAabbSize(selectedInstance.value.id)
  if (!size || !size[axis]) return
  const currentS = (detailScalePct.value || 100) / 100
  const naturalSize = size[axis] / currentS
  if (!naturalSize) return
  detailScalePct.value = Math.max(1, Math.round((target / naturalSize) * 100))
  applyDetailTransform()
}

function previewDetailColor(hex: string) {
  if (!selectedInstance.value) return
  const url = selectedModel.value?.modelUrl ?? null
  if (url) viewerRef.value?.updateInstanceColor(selectedInstance.value.id, hex, url)
}

async function applyDetailColor(hex: string) {
  if (!selectedInstance.value) return
  const id = selectedInstance.value.id
  const url = selectedModel.value?.modelUrl ?? null
  if (url) viewerRef.value?.updateInstanceColor(id, hex, url)
  await sceneObjectsStore.patchInstance(id, { color: hex }, `顏色改為 ${hex}`)
}

async function commitDetailLabel() {
  const name = detailLabelText.value.trim()
  if (!name || !selectedInstance.value || name === selectedInstance.value.label) return
  await sceneObjectsStore.renameInstance(selectedInstance.value.id, name)
}

const colorIconStroke = computed(() => {
  const hex = selectedInstance.value?.color
  if (!hex) return 'currentColor'
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const lum = 0.299 * r + 0.587 * g + 0.114 * b
  return lum > 0.5 ? '#000000' : '#ffffff'
})

const editingTitle = ref(false)
const titleInputText = ref('')
const titleInputRef = ref<HTMLInputElement | null>(null)

function startTitleEdit() {
  if (!scene.value) return
  titleInputText.value = scene.value.name
  editingTitle.value = true
  nextTick(() => titleInputRef.value?.select())
}
async function commitTitleEdit() {
  editingTitle.value = false
  const name = titleInputText.value.trim()
  if (!name || !scene.value || name === scene.value.name) return
  await library.renameScene(scene.value.id, name).catch(() => {})
}

function toggleHidden(id: string) {
  const inst = sceneInstances.value.find((i) => i.id === id)
  if (!inst) return
  const nowHidden = !inst.hidden
  sceneObjectsStore.setHidden(id, nowHidden)
  if (nowHidden && selectedObjectId.value === id) selectedObjectId.value = null
}

async function syncHistoryChange(change: Awaited<ReturnType<typeof sceneObjectsStore.undo>>) {
  if (!change) return
  for (const id of change.removedIds) {
    viewerRef.value?.removeModel(id)
    if (selectedObjectId.value === id) selectedObjectId.value = null
  }
  for (const inst of change.added) {
    const modelUrl = library.objects.find((o) => o.id === inst.modelId)?.modelUrl
    if (!modelUrl) continue
    await viewerRef.value?.addModel(modelUrl, inst.id, upAxisFixFor(inst.modelId, modelUrl))
    viewerRef.value?.updateInstanceTransform(inst.id, {
      position: inst.position,
      rotation: inst.rotation,
      scale: inst.scale,
    })
    viewerRef.value?.updateInstanceColor(inst.id, inst.color, modelUrl)
  }
  for (const inst of change.updated) {
    viewerRef.value?.updateInstanceTransform(inst.id, {
      position: inst.position,
      rotation: inst.rotation,
      scale: inst.scale,
    })
    const modelUrl = library.objects.find((o) => o.id === inst.modelId)?.modelUrl
    if (modelUrl) viewerRef.value?.updateInstanceColor(inst.id, inst.color, modelUrl)
  }
}
async function undo() {
  const change = await sceneObjectsStore.undo()
  if (!change) {
    editCommandFeedback.value = '（沒有可以復原的操作）'
    return
  }
  await syncHistoryChange(change)
  editCommandFeedback.value = '↺ 已復原上一步'
}
async function redo() {
  const change = await sceneObjectsStore.redo()
  if (!change) {
    editCommandFeedback.value = '（沒有可以取消復原的操作）'
    return
  }
  await syncHistoryChange(change)
  editCommandFeedback.value = '↻ 已取消復原'
}

function onKeydown(e: KeyboardEvent) {
  const target = e.target as HTMLElement | null
  if (!target || (!['INPUT', 'TEXTAREA'].includes(target.tagName) && !target.isContentEditable)) {
    _debugKeyBuf.push(e.key.toLowerCase())
    if (_debugKeyBuf.length > 4) _debugKeyBuf.shift()
    if (_debugKeyBuf.join('') === 'test') riskDebugActive.value = !riskDebugActive.value
  }
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
  const ctrlOrCmd = e.ctrlKey || e.metaKey
  if (ctrlOrCmd && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault()
    undo()
    return
  }
  if (ctrlOrCmd && ((e.shiftKey && (e.key === 'z' || e.key === 'Z')) || e.key === 'y' || e.key === 'Y')) {
    e.preventDefault()
    redo()
    return
  }
  if (!selectedObjectId.value) return
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault()
    removeInstance(selectedObjectId.value)
  } else if (e.key === 'g' || e.key === 'G') gizmoMode.value = 'translate'
  else if (e.key === 'r' || e.key === 'R') gizmoMode.value = 'rotate'
  else if (e.key === 's' || e.key === 'S') gizmoMode.value = 'scale'
  else if (e.key === 'Escape') selectedObjectId.value = null
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

const editCommandText = ref('')
const editCommandBusy = ref(false)
const editCommandFeedback = ref('')
const editCommandLog = ref<string[]>([])
const logExpanded = ref(false)
watch(editCommandFeedback, (val) => { if (val) editCommandLog.value.push(val) })
const lastEditContext = ref<{ command: string; instances: { id: string; label: string }[] } | null>(null)

async function waitForWorldPos(instanceId: string, timeoutMs = 5000): Promise<[number, number, number] | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const center = viewerRef.value?.getInstanceAabbCenter(instanceId)
    if (center) return center
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }
  return null
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('讀取截圖失敗'))
    reader.readAsDataURL(blob)
  })
}

async function submitEditCommand() {
  const command = editCommandText.value.trim()
  if (!command || !scene.value || editCommandBusy.value) return
  editCommandBusy.value = true
  editCommandFeedback.value = ''
  try {
    const positions = viewerRef.value?.getVisibleInstanceScreenPositions() ?? []
    if (positions.length === 0) {
      editCommandFeedback.value = '✗ 目前畫面上看不到任何物件,先讓要編輯的物件出現在畫面裡再試一次'
      return
    }
    const blob = await viewerRef.value?.captureCurrentView()
    if (!blob) {
      editCommandFeedback.value = '✗ 無法截取目前畫面'
      return
    }
    const image = await blobToBase64(blob)
    const instById = new Map(sceneInstances.value.map((i) => [i.id, i]))
    const instances = positions
      .map((p) => {
        const inst = instById.get(p.id)
        return inst
          ? { id: p.id, label: inst.label, x: p.x, y: p.y, modelId: inst.modelId, color: inst.color, distance: p.distance, worldPos: p.worldPos ?? null }
          : null
      })
      .filter((i): i is NonNullable<typeof i> => !!i?.label)
    const cameraAxes = viewerRef.value?.getCameraAxes() ?? null
    const result = await sceneObjectsStore.submitEditCommand(
      scene.value.id,
      command,
      image,
      instances,
      lastEditContext.value,
      cameraAxes
    )
    await syncHistoryChange({ updated: result.instances, added: result.added, removedIds: result.removedIds })

    const pendingCorrections = Object.entries(result.intendedPositions ?? {})
    if (pendingCorrections.length > 0) {
      for (const [instanceId, intendedWorldPos] of pendingCorrections) {
        const worldPos = await waitForWorldPos(instanceId)
        if (!worldPos) continue
        const correctedPos: [number, number, number] = [
          intendedWorldPos[0] - worldPos[0],
          intendedWorldPos[1] - worldPos[1],
          intendedWorldPos[2] - worldPos[2],
        ]
        await sceneObjectsStore.silentMoveInstance(instanceId, correctedPos)
        viewerRef.value?.updateInstanceTransform(instanceId, { position: correctedPos, rotation: [0, 0, 0], scale: [1, 1, 1] })
      }
    }

    const touchedIds = [...result.instances.map((i) => i.id), ...result.added.map((i) => i.id)]
    const last = touchedIds.at(-1)
    if (last) selectedObjectId.value = last
    const totalCount = result.instances.length + result.added.length + result.removedIds.length
    editCommandFeedback.value = result.reasoning
      ? `✓ ${result.reasoning}(共 ${totalCount} 個物件)`
      : `✓ 已套用(共 ${totalCount} 個物件)`
    lastEditContext.value = {
      command,
      instances: [...result.instances, ...result.added].map((i) => ({ id: i.id, label: i.label })),
    }
    editCommandText.value = ''
  } catch (err) {
    editCommandFeedback.value = err instanceof Error ? `✗ ${err.message}` : '✗ 指令失敗'
  } finally {
    editCommandBusy.value = false
  }
}

async function leaveEditor() {
  const currentScene = scene.value
  if (currentScene) {
    const blob = await viewerRef.value?.captureCurrentView().catch(() => null)
    if (blob) await library.saveThumbnail('scene', currentScene.id, blob).catch(() => {})
    const pending = sceneObjectsStore.pendingCommandsBySceneId[currentScene.id] ?? []
    if (sessionVersionId.value) {
      if (pending.length > 0) {
        if (patchDebounceTimer) { clearTimeout(patchDebounceTimer); patchDebounceTimer = null }
        await sceneObjectsStore.patchVersionCommands(currentScene.id, sessionVersionId.value, pending).catch(() => {})
      } else {
        await sceneObjectsStore.deleteVersion(currentScene.id, sessionVersionId.value).catch(() => {})
      }
    }
  }
  sceneObjectsStore.clearHistory(currentScene?.id)
  router.push('/dashboard')
}

const rightTab = ref<'model' | 'history' | 'chat' | 'risk' | 'ideas'>('model')

const activeCameraMode = ref('orbit')
const tpsCharPickerOpen = ref(false)
function selectTpsChar(item: { modelUrl?: string }) {
  tpsCharPickerOpen.value = false
  if (item.modelUrl) viewerRef.value?.loadTpsCharacter(item.modelUrl, debugFloorY.value)
}

const shareModalOpen = ref(false)
const shareCopied = ref(false)
const shareCodeCopied = ref(false)
const SHARE_URL = 'https://yiyu-anju.app/s/demo-a3f8c2'
const SHARE_CODE = SHARE_URL.split('/').pop() ?? ''
function copyShareUrl() {
  navigator.clipboard.writeText(SHARE_URL).catch(() => {})
  shareCopied.value = true
  setTimeout(() => { shareCopied.value = false }, 1800)
}
function copyShareCode() {
  navigator.clipboard.writeText(SHARE_CODE).catch(() => {})
  shareCodeCopied.value = true
  setTimeout(() => { shareCodeCopied.value = false }, 1800)
}

const fontSizeLevel = ref(0)
function cycleFontSize() { fontSizeLevel.value = (fontSizeLevel.value + 1) % 3 }

const STATIC_IDEAS = [
  {
    title: '安裝桌角防撞護角',
    risk: '方桌銳角導致碰撞風險',
    asset: '桌角防撞護角',
    assetId: 'opsl-ast-017',
    priority: '高' as const,
    status: '建議中' as const,
  },
  {
    title: '浴室入口鋪設防滑地墊',
    risk: '浴室地板濕滑容易跌倒',
    asset: '防滑地墊',
    assetId: 'opsl-ast-004',
    priority: '高' as const,
    status: '建議中' as const,
  },
  {
    title: '安裝直式扶手輔助起身',
    risk: '浴室缺乏扶持點，站立不穩',
    asset: '直式扶手',
    assetId: 'opsl-ast-001',
    priority: '中' as const,
    status: '評估中' as const,
  },
  {
    title: '玄關門檻加裝斜坡道',
    risk: '門檻落差造成輪椅或助行器通行障礙',
    asset: '門檻斜坡道',
    assetId: 'opsl-ast-006',
    priority: '中' as const,
    status: '已採納' as const,
  },
  {
    title: '走廊加裝感應夜燈',
    risk: '夜間走廊照明不足，易於跌倒',
    asset: '感應式走道夜燈',
    assetId: 'opsl-ast-014',
    priority: '低' as const,
    status: '建議中' as const,
  },
]

const pathEditorActive = computed(() => riskDebugActive.value && rightTab.value === 'risk')

watch(pathEditorActive, (active) => {
  if (active) {
    if (!editingPath.value) {
      editingPath.value = loadPath()
      viewerRef.value?.showPathArrows(editingPath.value.waypoints)
    }
  } else {
    pathPlacingMode.value = false
    editingPath.value = null
    viewerRef.value?.showPathArrows([])
  }
})

watch(rightTab, (tab) => {
  if (tab === 'risk') {
    viewerRef.value?.showRiskMarkers(riskFlatMarkers.value, riskSelectedIndices(selectedRiskIdx.value))
  } else {
    viewerRef.value?.showRiskMarkers([])
    selectedRiskIdx.value = null
    placingMode.value = false
    pathPlacingMode.value = false
  }
})

watch(selectedRiskIdx, (idx) => {
  if (rightTab.value === 'risk') {
    viewerRef.value?.showRiskMarkers(riskFlatMarkers.value, riskSelectedIndices(idx))
  }
})

function syncDebugGroundPlane() {
  if (riskDebugActive.value && rightTab.value === 'risk') {
    viewerRef.value?.showDebugGroundPlane(debugFloorY.value)
  } else {
    viewerRef.value?.hideDebugGroundPlane()
  }
}

watch(riskDebugActive, syncDebugGroundPlane)
watch(debugFloorY, (v) => { localStorage.setItem('debugFloorY', String(v)); syncDebugGroundPlane() })
watch(rightTab, (tab, prev) => {
  if (tab === 'risk' || prev === 'risk') syncDebugGroundPlane()
})

const historySubTab = ref<'ops' | 'versions'>('ops')
interface CompareMode {
  label: string
  instances: { id: string; modelId: string; position: Vec3; rotation: Vec3; scale: Vec3; color: string | null }[]
  confirmAction: () => Promise<void>
}
const compareMode = ref<CompareMode | null>(null)
const compareBusy = ref(false)
const compareInitialCamera = ref<{ position: Vec3; forward: Vec3 } | null>(null)
const compareKey = ref(0)

async function enterOpsCompare(targetIndex: number, label: string) {
  if (!scene.value || targetIndex === historyIndex.value) return
  if (!compareMode.value) compareInitialCamera.value = viewerRef.value?.getCameraState() ?? null
  const snapshots = sceneObjectsStore.snapshotAtIndex(scene.value.id, targetIndex)
  const instances = snapshots.map((s) => ({
    ...s,
    position: s.position as Vec3,
    rotation: s.rotation as Vec3,
    scale: s.scale as Vec3,
  }))
  compareMode.value = {
    label,
    instances,
    confirmAction: async () => {
      const change = await sceneObjectsStore.jumpToIndex(scene.value!.id, targetIndex)
      await syncHistoryChange(change)
      selectedObjectId.value = null
      editCommandFeedback.value = `↺ 已跳至${label}`
    },
  }
  compareKey.value++
}

async function enterVersionCompare(versionId: number, label: string) {
  if (!scene.value) return
  if (!compareMode.value) compareInitialCamera.value = viewerRef.value?.getCameraState() ?? null
  compareBusy.value = true
  try {
    const snapshots = await sceneObjectsStore.fetchVersionInstances(scene.value.id, versionId)
    const instances = snapshots.map((s) => ({
      ...s,
      position: s.position as Vec3,
      rotation: s.rotation as Vec3,
      scale: s.scale as Vec3,
    }))
    compareMode.value = {
      label,
      instances,
      confirmAction: async () => {
        const change = await sceneObjectsStore.restoreVersion(scene.value!.id, versionId)
        await syncHistoryChange(change)
        selectedObjectId.value = null
        editCommandFeedback.value = `↺ 已還原到${label}`
        await showRisksForVersion(versionId)
      },
    }
    compareKey.value++
  } finally {
    compareBusy.value = false
  }
}

async function confirmCompare() {
  if (!compareMode.value) return
  const action = compareMode.value.confirmAction
  compareMode.value = null
  await action()
}

const compareModelUrls = computed(() =>
  compareMode.value?.instances.map((s) => library.objects.find((o) => o.id === s.modelId)?.modelUrl ?? '') ?? []
)
const compareModelIds = computed(() => compareMode.value?.instances.map((s) => s.id) ?? [])
const compareTransforms = computed(() =>
  compareMode.value?.instances.map((s) => ({ position: s.position, rotation: s.rotation, scale: s.scale })) ?? []
)
const compareDataRotations = computed(() =>
  compareMode.value?.instances.map((s, idx) => upAxisFixFor(s.modelId, compareModelUrls.value[idx])) ?? []
)
const compareColors = computed(() => compareMode.value?.instances.map((s) => s.color) ?? [])

const versions = computed(() => (scene.value ? sceneObjectsStore.versionsBySceneId[scene.value.id] ?? [] : []))
const riskCount = ref(0)
const riskDisplayedCount = ref(0)
const riskCheckBusy = ref(false)
const routeDetectBusy = ref(false)
const routeData = ref<RouteDetectionResult | null>(null)

watch([rightTab, historySubTab], async ([tab, sub]) => {
  if (tab === 'history' && sub === 'versions' && scene.value) {
    await sceneObjectsStore.fetchVersions(scene.value.id)
  }
})

async function showRisksForVersion(versionId: number) {
  if (!scene.value) return
  const risks = await sceneObjectsStore.fetchRisks(scene.value.id, versionId)
  riskCount.value = risks.length
  riskDisplayedCount.value = Math.min(risks.length, 20)
  viewerRef.value?.showRiskMarkers(risks)
}
async function checkRisksNow() {
  if (!scene.value || riskCheckBusy.value) return
  riskCheckBusy.value = true
  try {
    const [risks, floorBounds] = await Promise.all([
      sceneObjectsStore.checkRisksNow(scene.value.id),
      sceneObjectsStore.fetchFloorDetection(scene.value.id),
    ])
    riskCount.value = risks.length
    riskDisplayedCount.value = Math.min(risks.length, 20)
    viewerRef.value?.showRiskMarkers(risks)
    viewerRef.value?.showFloor(floorBounds)
    const floorNote = floorBounds ? '，藍色為偵測到的地板範圍' : ''
    editCommandFeedback.value = `⚠ 偵測到 ${risks.length} 個風險(前 ${riskDisplayedCount.value} 筆顯示在 3D 畫面)${floorNote}`
  } finally {
    riskCheckBusy.value = false
  }
}
async function detectRoutePlan() {
  if (!scene.value || routeDetectBusy.value) return
  routeDetectBusy.value = true
  try {
    const result = await sceneObjectsStore.detectRoute(scene.value.id)
    routeData.value = result
    viewerRef.value?.showRoute(result)
    if (!result) {
      editCommandFeedback.value = '✗ 無法偵測動線：找不到背景地板資料'
    } else {
      const narrowCount = result.narrowCells.length
      const freeCount = result.freeCells.length - narrowCount
      const narrowNote = narrowCount > 0 ? `，其中 ${narrowCount} 格通道寬度不足 90cm（橙色標示）` : ''
      editCommandFeedback.value = `綠色為可通行動線（${freeCount} 格）${narrowNote}`
    }
  } finally {
    routeDetectBusy.value = false
  }
}
function versionLabel(versionId: number): string {
  const target = versions.value.find((v) => v.id === versionId)
  return target ? `第 ${target.versionNumber} 版` : `版本 id=${versionId}`
}

const historyTimeline = computed(() => sceneObjectsStore.historyTimeline)
const historyIndex = computed(() => sceneObjectsStore.historyIndex)
</script>

<template>
  <div class="editor" :class="`editor--font-${fontSizeLevel}`">
    <header class="editor__bar">
      <button class="editor__back" type="button" @click="leaveEditor">← 返回工作站</button>
      <input
        v-if="editingTitle"
        ref="titleInputRef"
        v-model="titleInputText"
        class="editor__title-input"
        @blur="commitTitleEdit"
        @keydown.enter.prevent="commitTitleEdit"
        @keydown.escape.prevent="editingTitle = false"
      />
      <button v-else class="editor__title editor__title--btn" type="button" @click="startTitleEdit">
        {{ scene?.name ?? '場景' }}
      </button>
      <div class="editor__bar-right">
        <button class="editor__bar-btn" type="button" title="調整字級" @click="cycleFontSize">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="4 7 4 4 20 4 20 7"/>
            <line x1="9" y1="20" x2="15" y2="20"/>
            <line x1="12" y1="4" x2="12" y2="20"/>
          </svg>
          <span class="editor__bar-btn-label">{{ ['小', '中', '大'][fontSizeLevel] }}</span>
        </button>
        <button class="editor__bar-btn" type="button" title="分享" @click="shareModalOpen = true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>
            <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
          </svg>
          分享
        </button>
      </div>
    </header>

    <Teleport to="body">
      <div v-if="tpsCharPickerOpen" class="share-overlay" @click.self="tpsCharPickerOpen = false">
        <div class="share-modal">
          <p class="share-modal__title">選擇操控模型</p>
          <ul class="tps-picker-list">
            <li
              v-for="obj in library.objects.filter(o => o.status === 'ready' && o.modelUrl)"
              :key="obj.id"
              class="tps-picker-item"
              @click="selectTpsChar(obj)"
            >{{ obj.name }}</li>
            <li v-if="!library.objects.filter(o => o.status === 'ready').length" style="color:var(--color-ink-soft);font-size:0.82rem;padding:0.5rem">模型庫尚無可用模型</li>
          </ul>
          <button class="share-modal__close" type="button" @click="tpsCharPickerOpen = false">取消</button>
        </div>
      </div>
    </Teleport>

    <Teleport to="body">
      <div v-if="shareModalOpen" class="share-overlay" @click.self="shareModalOpen = false">
        <div class="share-modal">
          <p class="share-modal__title">分享</p>
          <p class="share-modal__section-label">分享連結</p>
          <div class="share-modal__row">
            <span class="share-modal__url">{{ SHARE_URL }}</span>
            <button class="share-modal__copy" type="button" @click="copyShareUrl">
              {{ shareCopied ? '已複製！' : '複製' }}
            </button>
          </div>
          <p class="share-modal__section-label">分享碼</p>
          <div class="share-modal__row">
            <span class="share-modal__url share-modal__code">{{ SHARE_CODE }}</span>
            <button class="share-modal__copy" type="button" @click="copyShareCode">
              {{ shareCodeCopied ? '已複製！' : '複製' }}
            </button>
          </div>
          <p class="share-modal__note">對方可在上傳面板輸入分享碼匯入此場景</p>
          <button class="share-modal__close" type="button" @click="shareModalOpen = false">關閉</button>
        </div>
      </div>
    </Teleport>

    <div class="editor__body">
      <aside class="editor__panel editor__panel--wide" :class="{ 'editor__panel--collapsed': leftCollapsed }">
        <div class="editor__panel-header">
          <span v-if="!leftCollapsed" class="editor__panel-title">模型列表</span>
          <button
            class="editor__collapse-btn"
            type="button"
            :aria-label="leftCollapsed ? '展開模型列表' : '收合模型列表'"
            @click="leftCollapsed = !leftCollapsed"
          >
            {{ leftCollapsed ? '›' : '‹' }}
          </button>
        </div>
        <div v-if="!leftCollapsed" class="editor__panel-body">
          <input v-if="availableModels.length" v-model="modelSearchQuery" class="editor__search" type="text" placeholder="搜尋名稱…" />
          <div v-if="filteredAvailableModels.length" class="editor__card-grid">
            <ModelCard v-for="obj in filteredAvailableModels" :key="obj.id" :item="obj" @open="previewing = obj" />
          </div>
          <p v-else-if="availableModels.length" class="editor__empty">沒有符合「{{ modelSearchQuery }}」的模型。</p>
          <p v-else class="editor__empty">
            我的模型庫還沒有任何模型——可以從線上資產庫加入,或用「上傳場景 / 模型」新增。
          </p>
        </div>
      </aside>

      <main class="editor__viewport" :class="{ 'editor__viewport--split': !!compareMode }">
        <div
          v-if="placingMode || pathPlacingMode"
          class="editor__placing-overlay"
          @click="onAnyPlacingClick"
          @contextmenu.prevent="placingMode = false; pathPlacingMode = false"
        >
          <span class="editor__placing-hint">{{ pathPlacingMode ? '點擊場景新增路徑點　右鍵取消' : '點擊場景設定位置　右鍵取消' }}</span>
        </div>
        <div class="editor__main-half">
          <span v-if="compareMode" class="editor__compare-label">目前狀態</span>
          <div class="editor__canvas-actions">
            <button class="editor__canvas-icon-btn" type="button" title="復原 (Ctrl+Z)" @click="undo">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 7v6h6"/><path d="M3 13C5 8 9.5 5 15 5a9 9 0 0 1 9 9"/>
              </svg>
            </button>
            <button class="editor__canvas-icon-btn" type="button" title="取消復原 (Ctrl+Y)" @click="redo">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 7v6h-6"/><path d="M21 13C19 8 14.5 5 9 5a9 9 0 0 0-9 9"/>
              </svg>
            </button>
          </div>
          <p v-if="!ready" class="editor__missing">載入場景資料中…</p>
          <GSplatViewer
            v-else-if="sceneModelUrls.length"
            ref="viewerRef"
            :src="sceneModelUrls"
            :ids="sceneModelIds"
            :transforms="sceneTransforms"
            :data-rotations="sceneDataRotations"
            :colors="sceneColors"
            :selectable="true"
            :selected-id="selectedObjectId"
            :gizmo-mode="gizmoMode"
            :hidden-ids="Array.from(hiddenObjectIds)"
            @select="selectedObjectId = $event"
            @loaded="refreshAllInstanceSizes"
            @risk-pick="onRiskPick"
            @camera-mode="activeCameraMode = $event"
            @request-tps-char="tpsCharPickerOpen = true"
          />
          <p v-else-if="ready" class="editor__missing">找不到這個場景的模型資料</p>
          <div v-if="selectedObjectId && !compareMode" class="editor__gizmo-toolbar">
            <button type="button" :class="{ active: gizmoMode === 'translate' }" title="移動 (G)" @click="gizmoMode = 'translate'">移動</button>
            <button type="button" :class="{ active: gizmoMode === 'rotate' }" title="旋轉 (R)" @click="gizmoMode = 'rotate'">旋轉</button>
            <button type="button" :class="{ active: gizmoMode === 'scale' }" title="縮放 (S)" @click="gizmoMode = 'scale'">縮放</button>
            <button type="button" title="取消選取 (Esc)" @click="selectedObjectId = null">✕</button>
          </div>
        </div>

        <div v-if="compareMode" class="editor__compare-half">
          <span class="editor__compare-label">{{ compareMode.label }}</span>
          <CompareGSplatViewer
            v-if="compareModelUrls.length"
            :key="compareKey"
            :src="compareModelUrls"
            :ids="compareModelIds"
            :transforms="compareTransforms"
            :data-rotations="compareDataRotations"
            :colors="compareColors"
            :initial-camera="compareInitialCamera"
          />
          <p v-else class="editor__missing">無歷史物件</p>
          <div class="editor__compare-actions">
            <button class="editor__compare-cancel-btn" type="button" title="取消" @click="compareMode = null">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
            <button class="editor__compare-confirm-btn" type="button" title="確認回復" :disabled="compareBusy" @click="confirmCompare">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            </button>
          </div>
        </div>
      </main>

      <aside class="editor__panel" :class="{ 'editor__panel--collapsed': rightCollapsed }">
        <div class="editor__panel-header">
          <div class="editor__panel-header-group">
          <button
            class="editor__collapse-btn"
            type="button"
            :aria-label="rightCollapsed ? '展開' : '收合'"
            @click="rightCollapsed = !rightCollapsed"
          >{{ rightCollapsed ? '‹' : '›' }}</button>
          <template v-if="!rightCollapsed">
            <button
              class="editor__tab-icon"
              :class="{ 'editor__tab-icon--active': rightTab === 'model' }"
              title="場景模型列表"
              type="button"
              @click="rightTab = 'model'"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
                <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
                <line x1="12" y1="22.08" x2="12" y2="12"/>
              </svg>
            </button>
            <button
              class="editor__tab-icon"
              :class="{ 'editor__tab-icon--active': rightTab === 'history' }"
              title="歷史紀錄"
              type="button"
              @click="rightTab = 'history'"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <polyline points="12 6 12 12 16 14"/>
              </svg>
            </button>
            <button
              class="editor__tab-icon"
              :class="{ 'editor__tab-icon--active': rightTab === 'chat' }"
              title="語意指令"
              type="button"
              @click="rightTab = 'chat'"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
            </button>
            <button
              class="editor__tab-icon"
              :class="{ 'editor__tab-icon--active': rightTab === 'risk' }"
              title="風險偵測"
              type="button"
              @click="rightTab = 'risk'"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/>
                <line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
            </button>
            <button
              class="editor__tab-icon"
              :class="{ 'editor__tab-icon--active': rightTab === 'ideas' }"
              title="構想清單"
              type="button"
              @click="rightTab = 'ideas'"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="12" y1="2" x2="12" y2="6"/>
                <path d="M12 6a6 6 0 0 1 6 6c0 2.5-1.5 4.5-3.5 5.5V19a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-1.5C7.5 16.5 6 14.5 6 12a6 6 0 0 1 6-6z"/>
                <line x1="9" y1="22" x2="15" y2="22"/>
              </svg>
            </button>
          </template>
          </div>
        </div>

        <div v-if="rightCollapsed" class="editor__collapsed-tabs">
          <button
            class="editor__tab-icon"
            :class="{ 'editor__tab-icon--active': rightTab === 'model' }"
            title="場景模型列表"
            type="button"
            @click="rightTab = 'model'; rightCollapsed = false"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
              <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
              <line x1="12" y1="22.08" x2="12" y2="12"/>
            </svg>
          </button>
          <button
            class="editor__tab-icon"
            :class="{ 'editor__tab-icon--active': rightTab === 'history' }"
            title="歷史紀錄"
            type="button"
            @click="rightTab = 'history'; rightCollapsed = false"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <polyline points="12 6 12 12 16 14"/>
            </svg>
          </button>
          <button
            class="editor__tab-icon"
            :class="{ 'editor__tab-icon--active': rightTab === 'chat' }"
            title="語意指令"
            type="button"
            @click="rightTab = 'chat'; rightCollapsed = false"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
          </button>
          <button
            class="editor__tab-icon"
            :class="{ 'editor__tab-icon--active': rightTab === 'risk' }"
            title="風險偵測"
            type="button"
            @click="rightTab = 'risk'; rightCollapsed = false"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/>
              <line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
          </button>
          <button
            class="editor__tab-icon"
            :class="{ 'editor__tab-icon--active': rightTab === 'ideas' }"
            title="構想清單"
            type="button"
            @click="rightTab = 'ideas'; rightCollapsed = false"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="12" y1="2" x2="12" y2="6"/>
              <path d="M12 6a6 6 0 0 1 6 6c0 2.5-1.5 4.5-3.5 5.5V19a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-1.5C7.5 16.5 6 14.5 6 12a6 6 0 0 1 6-6z"/>
              <line x1="9" y1="22" x2="15" y2="22"/>
            </svg>
          </button>
        </div>

        <div v-if="!rightCollapsed" class="editor__panel-body">

          <!-- 場景模型列表 tab -->
          <template v-if="rightTab === 'model'">
            <div class="editor__model-tab">
              <div class="editor__instance-list-wrap">
                <ul v-if="sceneInstances.length" ref="instanceListRef" class="editor__item-list">
                  <li
                    v-for="inst in sceneInstances"
                    :key="inst.id"
                    :data-instance-id="inst.id"
                    class="editor__item"
                    :class="{
                      'editor__item--selected': selectedObjectId === inst.id,
                      'editor__item--hidden': hiddenObjectIds.has(inst.id),
                    }"
                    @click="selectObject(inst.id)"
                  >
                    <input
                      v-if="editingInstanceId === inst.id"
                      ref="renameInputRefs"
                      v-model="editingLabel"
                      class="editor__item-name-input"
                      type="text"
                      @click.stop
                      @keydown.enter="commitRename"
                      @keydown.esc="editingInstanceId = null"
                      @blur="commitRename"
                    />
                    <span v-else class="editor__item-name" @dblclick.stop="startRename(inst.id, inst.label)">{{ inst.label }}</span>
                    <button
                      class="editor__visibility-btn"
                      type="button"
                      :aria-label="hiddenObjectIds.has(inst.id) ? '顯示物件' : '隱藏物件'"
                      :title="hiddenObjectIds.has(inst.id) ? '顯示物件' : '隱藏物件'"
                      @click.stop="toggleHidden(inst.id)"
                    >{{ hiddenObjectIds.has(inst.id) ? '⊘' : '👁' }}</button>
                    <button
                      class="editor__visibility-btn"
                      type="button"
                      aria-label="移除物件"
                      title="移除物件"
                      @click.stop="removeInstance(inst.id)"
                    >🗑</button>
                  </li>
                </ul>
                <p v-else class="editor__empty">
                  這個場景還沒有擺放任何物件——從左側「模型列表」點選一個模型,預覽後按「確認添加」就會加進來。
                </p>
              </div>

              <div v-if="selectedInstance" class="editor__instance-detail">
                <div class="editor__detail-header">
                  <input
                    v-model="detailLabelText"
                    class="editor__detail-label-input"
                    type="text"
                    @keydown.enter="commitDetailLabel"
                    @blur="commitDetailLabel"
                  />
                  <span v-if="selectedModel" class="editor__detail-source">{{ selectedModel.name }}</span>
                  <span v-if="detailAabbSize" class="editor__detail-size">{{ fmtSize(detailAabbSize) }}</span>
                  <div class="editor__detail-actions" style="margin-top: 0.6rem;">
                  <button
                    class="editor__detail-action-btn editor__detail-color-btn"
                    type="button"
                    title="更改顏色"
                    :style="selectedInstance.color ? { background: selectedInstance.color } : {}"
                    @click="colorPickerRef?.click()"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" :stroke="selectedInstance.color ? colorIconStroke : 'currentColor'" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <circle cx="13.5" cy="6.5" r="2.5"/><circle cx="19" cy="13" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="10" cy="18.5" r="2.5"/>
                      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10c1.85 0 3-.75 3-2 0-.54-.2-1.02-.5-1.4-.29-.37-.5-.79-.5-1.35 0-1.1.9-2 2-2h2.35c3.1 0 5.15-2.26 5.15-5C23 6.57 18.08 2 12 2z"/>
                    </svg>
                    <input
                      ref="colorPickerRef"
                      type="color"
                      class="editor__color-input-hidden"
                      :value="selectedInstance.color ?? '#ffffff'"
                      @input="previewDetailColor(($event.target as HTMLInputElement).value)"
                      @change="applyDetailColor(($event.target as HTMLInputElement).value)"
                    />
                  </button>
                  <button
                    class="editor__detail-action-btn"
                    type="button"
                    :title="hiddenObjectIds.has(selectedInstance.id) ? '顯示' : '隱藏'"
                    @click="toggleHidden(selectedInstance.id)"
                  >
                    <svg v-if="hiddenObjectIds.has(selectedInstance.id)" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/>
                    </svg>
                    <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
                    </svg>
                  </button>
                  <button
                    class="editor__detail-action-btn editor__detail-remove-btn"
                    type="button"
                    title="移除物件"
                    @click="removeInstance(selectedInstance.id)"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
                    </svg>
                  </button>
                  </div>
                </div>

                <div class="editor__detail-section">
                  <div class="editor__detail-pos-row">
                    <span class="editor__detail-pos-label">X:</span><input v-model="detailPos[0]" class="editor__detail-pos-input" type="number" step="0.1" @change="applyDetailTransform" />
                    <span class="editor__detail-pos-label">Y:</span><input v-model="detailPos[1]" class="editor__detail-pos-input" type="number" step="0.1" @change="applyDetailTransform" />
                    <span class="editor__detail-pos-label">Z:</span><input v-model="detailPos[2]" class="editor__detail-pos-input" type="number" step="0.1" @change="applyDetailTransform" />
                  </div>
                </div>
                <div class="editor__detail-section editor__detail-section--scale">
                  <div class="editor__scale-stepper">
                    <span class="editor__detail-dim-label">縮放:</span>
                    <button type="button" class="editor__scale-btn" @click="adjustScalePct(-10)">‹</button>
                    <input v-model.number="detailScalePct" class="editor__scale-input" type="number" min="1" step="10" @change="applyDetailTransform" />
                    <span class="editor__scale-pct">%</span>
                    <button type="button" class="editor__scale-btn" @click="adjustScalePct(10)">›</button>
                  </div>
                  <div class="editor__dim-row">
                    <span class="editor__detail-dim-label">寬:</span>
                    <input v-model="detailDimW" class="editor__dim-input" type="number" min="0" step="0.1" placeholder="m" @change="applyScaleFromDim(0, detailDimW)" />
                    <span class="editor__detail-dim-label">高:</span>
                    <input v-model="detailDimH" class="editor__dim-input" type="number" min="0" step="0.1" placeholder="m" @change="applyScaleFromDim(1, detailDimH)" />
                    <span class="editor__detail-dim-label">深:</span>
                    <input v-model="detailDimD" class="editor__dim-input" type="number" min="0" step="0.1" placeholder="m" @change="applyScaleFromDim(2, detailDimD)" />
                  </div>
                </div>
              </div>
              <div v-else-if="sceneInstances.length" class="editor__detail-empty">點選上方物件查看詳細資訊</div>
            </div>
          </template>

          <!-- 歷史紀錄 tab -->
          <template v-if="rightTab === 'history'">
            <div class="editor__subtabs">
              <button
                class="editor__subtab"
                :class="{ 'editor__subtab--active': historySubTab === 'ops' }"
                type="button"
                @click="historySubTab = 'ops'"
              >操作歷史</button>
              <button
                class="editor__subtab"
                :class="{ 'editor__subtab--active': historySubTab === 'versions' }"
                type="button"
                @click="historySubTab = 'versions'"
              >版本歷史</button>
            </div>

            <!-- 操作歷史 -->
            <div v-if="historySubTab === 'ops'" class="editor__timeline">
              <div class="editor__timeline-track" />
              <button
                type="button"
                class="editor__timeline-node"
                :class="{ 'editor__timeline-node--current': historyIndex === 0 }"
                :disabled="historyIndex === 0"
                @click="enterOpsCompare(0, '（初始狀態）')"
              >
                <span class="editor__timeline-dot" />
                <span class="editor__timeline-label">（初始狀態）</span>
              </button>
              <button
                v-for="entry in historyTimeline"
                :key="entry.index"
                type="button"
                class="editor__timeline-node"
                :class="{ 'editor__timeline-node--current': historyIndex === entry.index }"
                :disabled="historyIndex === entry.index"
                @click="enterOpsCompare(entry.index, entry.label)"
              >
                <span class="editor__timeline-dot" />
                <span class="editor__timeline-label">{{ entry.label }}</span>
              </button>
            </div>

            <!-- 版本歷史 -->
            <template v-else>
              <p v-if="riskCount > 0" class="editor__empty">
                偵測到 {{ riskCount }} 個風險(前 {{ riskDisplayedCount }} 筆紅框標示)
              </p>
              <p v-if="versions.length === 0" class="editor__empty">還沒有任何版本紀錄</p>
              <div v-else class="editor__timeline">
                <div class="editor__timeline-track" />
                <div v-for="v in versions" :key="v.id" class="editor__timeline-item">
                  <button
                    type="button"
                    class="editor__timeline-node"
                    :disabled="compareBusy"
                    @click="enterVersionCompare(v.id, `第 ${v.versionNumber} 版`)"
                  >
                    <span class="editor__timeline-dot" />
                    <span class="editor__timeline-label">第 {{ v.versionNumber }} 版 · {{ new Date(v.createdAt).toLocaleString() }}</span>
                  </button>
                  <p v-if="v.revertedFromVersionId" class="editor__timeline-detail">
                    還原自{{ versionLabel(v.revertedFromVersionId) }}
                  </p>
                  <p v-if="v.sourceCommands.length" class="editor__timeline-detail">
                    {{ v.sourceCommands.join('、') }}
                  </p>
                </div>
              </div>
            </template>
          </template>

          <!-- 語意指令 tab -->
          <template v-if="rightTab === 'chat'">
            <div class="editor__chat-tools">
              <button class="editor__chat-tool-btn" type="button" title="上傳檔案">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="17 8 12 3 7 8"/>
                  <line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
              </button>
              <button class="editor__chat-tool-btn" type="button" title="語音輸入">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                  <line x1="12" y1="19" x2="12" y2="23"/>
                  <line x1="8" y1="23" x2="16" y2="23"/>
                </svg>
              </button>
            </div>
            <form @submit.prevent="submitEditCommand">
              <div class="editor__command-row">
                <textarea
                  v-model="editCommandText"
                  class="editor__command-input"
                  placeholder="用一句話編輯場景…"
                  rows="4"
                  :disabled="editCommandBusy"
                  @keydown.enter.exact.prevent="!editCommandBusy && editCommandText.trim() && submitEditCommand()"
                />
                <button class="editor__command-submit" type="submit" :disabled="editCommandBusy || !editCommandText.trim()">
                  {{ editCommandBusy ? '處理中…' : '送出' }}
                </button>
              </div>
            </form>
            <div v-if="editCommandLog.length" class="editor__console">
              <button type="button" class="editor__console-latest" @click="logExpanded = !logExpanded">
                <span class="editor__console-text">{{ editCommandLog.at(-1) }}</span>
                <span class="editor__console-arrow">{{ logExpanded ? '▲' : '▼' }}</span>
              </button>
              <div v-if="logExpanded" class="editor__console-history">
                <p v-for="(msg, i) in [...editCommandLog].reverse().slice(1)" :key="i" class="editor__console-entry">{{ msg }}</p>
              </div>
            </div>
          </template>

          <template v-if="rightTab === 'risk'">

            <!-- 編輯單筆 -->
            <template v-if="riskDebugActive && editingRisk">
              <div class="editor__risk-edit-header">
                <button class="editor__risk-edit-back" type="button" @click="cancelEditRisk">← 返回</button>
                <button class="editor__risk-edit-save" type="button" @click="saveEditingRisk">儲存</button>
              </div>
              <div class="editor__risk-edit-form">
                <label class="editor__risk-field">
                  <span>名稱</span>
                  <input v-model="editingRisk.label" class="editor__risk-input" />
                </label>
                <label class="editor__risk-field">
                  <span>嚴重程度</span>
                  <select v-model="editingRisk.severity" class="editor__risk-input">
                    <option value="高">高</option>
                    <option value="中">中</option>
                    <option value="低">低</option>
                  </select>
                </label>
                <label class="editor__risk-field editor__risk-field--col">
                  <span>說明</span>
                  <textarea v-model="editingRisk.desc" class="editor__risk-input editor__risk-textarea" rows="3" />
                </label>
                <div class="editor__risk-bboxes">
                  <div v-for="(bbox, bi) in editingRisk.bboxes" :key="bi" class="editor__risk-bbox-block" :class="{ 'editor__risk-bbox-block--active': activeBboxGizmoIdx === bi }">
                    <div class="editor__risk-bbox-row" style="cursor:pointer" @click="activeBboxGizmoIdx === bi ? deselectBboxGizmo() : selectBboxGizmo(bi)">
                      <span class="editor__risk-bbox-label">角 {{ bi + 1 }}</span>
                      <span :style="{ fontSize: 'calc(0.68rem * var(--ts))', color: 'var(--color-ink-soft)', flex: '1' }">{{ activeBboxGizmoIdx === bi ? '▶ gizmo 中' : '點擊選取' }}</span>
                      <button class="editor__risk-bbox-btn" type="button" title="重新點擊場景設定" @click.stop="startPlacing(bi)">↺</button>
                      <button class="editor__risk-bbox-btn editor__risk-bbox-btn--del" type="button" @click.stop="deleteBbox(bi)">×</button>
                    </div>
                    <div class="editor__risk-bbox-inputs">
                      <label class="editor__risk-xyz">X<input class="editor__risk-xyz-input" type="number" step="0.01" :value="bboxCenter(bbox)[0].toFixed(3)" @change="updateBboxCenter(bi, 0, ($event.target as HTMLInputElement).value)" /></label>
                      <label class="editor__risk-xyz">Y<input class="editor__risk-xyz-input" type="number" step="0.01" :value="bboxCenter(bbox)[1].toFixed(3)" @change="updateBboxCenter(bi, 1, ($event.target as HTMLInputElement).value)" /></label>
                      <label class="editor__risk-xyz">Z<input class="editor__risk-xyz-input" type="number" step="0.01" :value="bboxCenter(bbox)[2].toFixed(3)" @change="updateBboxCenter(bi, 2, ($event.target as HTMLInputElement).value)" /></label>
                    </div>
                    <div class="editor__risk-bbox-inputs">
                      <label class="editor__risk-xyz">寬<input class="editor__risk-xyz-input" type="number" step="0.01" min="0.01" :value="bboxAxisSize(bbox, 0).toFixed(3)" @change="updateBboxAxisSize(bi, 0, ($event.target as HTMLInputElement).value)" /></label>
                      <label class="editor__risk-xyz">高<input class="editor__risk-xyz-input" type="number" step="0.01" min="0.01" :value="bboxAxisSize(bbox, 1).toFixed(3)" @change="updateBboxAxisSize(bi, 1, ($event.target as HTMLInputElement).value)" /></label>
                      <label class="editor__risk-xyz">深<input class="editor__risk-xyz-input" type="number" step="0.01" min="0.01" :value="bboxAxisSize(bbox, 2).toFixed(3)" @change="updateBboxAxisSize(bi, 2, ($event.target as HTMLInputElement).value)" /></label>
                    </div>
                  </div>
                  <button class="editor__risk-add-bbox" type="button" @click="startPlacing(editingRisk.bboxes.length)">
                    + 點擊場景新增邊角
                  </button>
                </div>
              </div>
            </template>

            <!-- 列表 -->
            <template v-else>
              <div v-if="riskDebugActive" class="editor__risk-floor-row">
                <span>地面 Y</span>
                <input v-model.number="debugFloorY" type="number" step="0.05" class="editor__risk-input editor__risk-input--sm" />
                <span class="editor__risk-unit">m</span>
                <span :style="{ fontSize: 'calc(0.7rem * var(--ts))', color: 'var(--color-ink-soft)', marginLeft: 'auto' }">放置 Y</span>
                <input v-model.number="placingY" type="number" step="0.05" class="editor__risk-input editor__risk-input--sm" />
                <span class="editor__risk-unit">m</span>
              </div>
              <button v-if="riskDebugActive" class="editor__risk-new-btn" type="button" @click="addNewRisk">+ 新增風險</button>
              <ul class="editor__risk-list">
                <li
                  v-for="(risk, i) in savedRisks"
                  :key="i"
                  class="editor__risk-card"
                  :class="{ 'editor__risk-card--selected': selectedRiskIdx === i }"
                  @click="selectedRiskIdx = selectedRiskIdx === i ? null : i"
                >
                  <div class="editor__risk-card-header">
                    <svg class="editor__risk-badge-icon" :class="{ 'editor__risk-badge-icon--high': risk.severity === '高', 'editor__risk-badge-icon--mid': risk.severity === '中', 'editor__risk-badge-icon--low': risk.severity === '低' }" width="12" height="14" viewBox="0 0 12 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                      <polyline v-if="risk.severity === '高'" points="0,5 6,1 12,5"/>
                      <polyline v-if="risk.severity !== '低'" points="0,9 6,5 12,9"/>
                      <polyline points="0,13 6,9 12,13"/>
                    </svg>
                    <span class="editor__risk-label">{{ risk.label }}</span>
                    <template v-if="riskDebugActive">
                      <button class="editor__risk-edit-btn" type="button" @click.stop="startEditRisk(i)">編輯</button>
                      <button class="editor__risk-edit-btn editor__risk-edit-btn--del" type="button" @click.stop="deleteRisk(i)">刪除</button>
                    </template>
                  </div>
                  <p class="editor__risk-desc">{{ risk.desc }}</p>
                </li>
                <li v-if="!savedRisks.length" class="editor__empty">尚無風險記錄</li>
              </ul>

              <!-- 路徑偵測編輯（debug 模式自動出現） -->
              <template v-if="riskDebugActive && editingPath">
                <div class="editor__risk-floor-row editor__path-section-header">
                  <span class="editor__path-section-title">路徑偵測</span>
                  <span :style="{ fontSize: 'calc(0.7rem * var(--ts))', color: 'var(--color-ink-soft)', marginLeft: '0.5rem' }">放置 Y</span>
                  <input v-model.number="pathPlacingY" type="number" step="0.05" class="editor__risk-input editor__risk-input--sm" />
                  <span class="editor__risk-unit">m</span>
                  <button class="editor__risk-edit-save" type="button" style="margin-left: auto;" @click="saveEditingPath">儲存</button>
                </div>
                <label class="editor__risk-field">
                  <span>名稱</span>
                  <input v-model="editingPath.label" class="editor__risk-input" />
                </label>
                <div class="editor__risk-bboxes">
                  <div v-for="(wp, i) in editingPath.waypoints" :key="i" class="editor__risk-bbox-block">
                    <div class="editor__risk-bbox-row">
                      <span class="editor__risk-bbox-label">P{{ i + 1 }}</span>
                      <span :style="{ fontSize: 'calc(0.68rem * var(--ts))', color: 'var(--color-ink-soft)', flex: '1' }">
                        {{ wp.position[0].toFixed(2) }}, {{ wp.position[2].toFixed(2) }}
                      </span>
                      <button class="editor__risk-bbox-btn editor__risk-bbox-btn--del" type="button" @click.stop="deleteWaypoint(i)">×</button>
                    </div>
                    <div class="editor__risk-bbox-inputs">
                      <label class="editor__risk-xyz">長<input
                        class="editor__risk-xyz-input" type="number" step="0.1" min="0.1"
                        :value="wp.length.toFixed(2)"
                        @change="updateWaypointLength(i, ($event.target as HTMLInputElement).value)"
                      /></label>
                      <label class="editor__risk-xyz">寬<input
                        class="editor__risk-xyz-input" type="number" step="0.05" min="0.02"
                        :value="wp.width.toFixed(2)"
                        @change="updateWaypointWidth(i, ($event.target as HTMLInputElement).value)"
                      /></label>
                      <label class="editor__risk-xyz">旋轉<input
                        class="editor__risk-xyz-input" type="number" step="5"
                        :value="wp.rotationY.toFixed(0)"
                        @change="updateWaypointRotation(i, ($event.target as HTMLInputElement).value)"
                      />°</label>
                    </div>
                  </div>
                  <button class="editor__risk-add-bbox" type="button" @click="startPathPlacing">
                    + 點擊場景新增路徑點
                  </button>
                </div>
              </template>

            </template>

          </template>

          <!-- 構想清單 tab -->
          <template v-if="rightTab === 'ideas'">
            <ul class="editor__ideas-list">
              <li
                v-for="(idea, i) in STATIC_IDEAS"
                :key="i"
                class="editor__idea-item"
              >
                <div class="editor__idea-header">
                  <span class="editor__idea-title">{{ idea.title }}</span>
                  <span class="editor__idea-status">{{ idea.status }}</span>
                </div>
                <p class="editor__idea-risk">⚠ {{ idea.risk }}</p>
                <p class="editor__idea-asset">輔具：{{ idea.asset }}</p>
              </li>
            </ul>
          </template>

        </div>
      </aside>
    </div>

    <PreviewModal
      v-if="previewing"
      :item="previewing"
      kind="object"
      :allow-add="true"
      @close="previewing = null"
      @add="confirmAddModel"
    />
  </div>
</template>

<style scoped>
.editor {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--color-ink);
}

.editor { --ts: 1; }
.editor--font-1 { --ts: 1.1; }
.editor--font-2 { --ts: 1.22; }

.editor__bar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.75rem 1.25rem;
  background: var(--color-surface);
  border-bottom: 1px solid var(--color-line);
  z-index: 1;
}

.editor__bar-right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.editor__bar-btn {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  background: transparent;
  border: none;
  color: var(--color-ink-soft);
  font-size: calc(0.82rem * var(--ts));
  padding: 0.3rem 0.55rem;
  border-radius: calc(var(--radius) * 0.5);
  cursor: pointer;
}
.editor__bar-btn:hover { background: var(--color-surface-2); color: var(--color-ink); }
.editor__bar-btn-label { font-size: calc(0.75rem * var(--ts)); min-width: 0.8rem; text-align: center; }

.share-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}
.share-modal {
  background: var(--color-surface);
  border-radius: var(--radius);
  padding: 1.5rem 1.75rem;
  width: min(360px, 90vw);
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.share-modal__title { font-weight: 700; font-size: calc(1rem * var(--ts)); margin: 0; }
.share-modal__row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  background: var(--color-surface-2);
  border-radius: calc(var(--radius) * 0.5);
  padding: 0.4rem 0.6rem;
}
.share-modal__url { flex: 1; font-size: calc(0.78rem * var(--ts)); color: var(--color-ink-soft); word-break: break-all; }
.share-modal__copy {
  flex-shrink: 0;
  background: var(--color-sage);
  color: #fff;
  border: none;
  border-radius: calc(var(--radius) * 0.5);
  padding: 0.25rem 0.65rem;
  font-size: calc(0.78rem * var(--ts));
  cursor: pointer;
  white-space: nowrap;
}
.share-modal__section-label { margin: 0; font-size: calc(0.72rem * var(--ts)); font-weight: 600; color: var(--color-ink-soft); }
.share-modal__code { font-family: monospace; font-size: calc(0.88rem * var(--ts)) !important; letter-spacing: 0.05em; color: var(--color-ink) !important; }
.share-modal__note { margin: 0; font-size: calc(0.75rem * var(--ts)); color: var(--color-ink-soft); }
.share-modal__close {
  align-self: flex-end;
  background: transparent;
  border: 1px solid var(--color-line);
  border-radius: calc(var(--radius) * 0.5);
  padding: 0.25rem 0.75rem;
  font-size: calc(0.82rem * var(--ts));
  cursor: pointer;
  color: var(--color-ink-soft);
}
.share-modal__close:hover { background: var(--color-surface-2); }

.tps-picker-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 240px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.tps-picker-item {
  padding: 0.5rem 0.75rem;
  border-radius: calc(var(--radius) * 0.5);
  font-size: calc(0.85rem * var(--ts));
  cursor: pointer;
}
.tps-picker-item:hover { background: var(--color-surface-2); }

.editor__ideas-list {
  list-style: none;
  margin: 0;
  padding: 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.editor__idea-item {
  background: var(--color-surface-2);
  border-radius: calc(var(--radius) * 0.6);
  padding: 0.65rem 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.editor__idea-header {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.editor__idea-priority {
  font-size: calc(0.68rem * var(--ts));
  font-weight: 700;
  padding: 0.1rem 0.35rem;
  border-radius: 3px;
  flex-shrink: 0;
}
.editor__idea-priority--高 { background: #fee2e2; color: #b91c1c; }
.editor__idea-priority--中 { background: #fef9c3; color: #92400e; }
.editor__idea-priority--低 { background: #dcfce7; color: #166534; }
.editor__idea-title { font-size: calc(0.82rem * var(--ts)); font-weight: 600; flex: 1; }
.editor__idea-status { font-size: calc(0.7rem * var(--ts)); color: var(--color-ink-soft); flex-shrink: 0; }
.editor__idea-risk { margin: 0; font-size: calc(0.73rem * var(--ts)); color: var(--color-ink-soft); }
.editor__idea-asset { margin: 0; font-size: calc(0.73rem * var(--ts)); color: var(--color-sage); font-weight: 600; }

.editor__back {
  border: none;
  background: transparent;
  color: var(--color-ink-soft);
  font-size: calc(0.9rem * var(--ts));
  font-weight: 700;
  padding: 0.4rem 0.6rem;
  border-radius: calc(var(--radius) * 0.5);
}

.editor__back:hover {
  background: var(--color-surface-2);
}

.editor__title {
  font-family: var(--serif);
  font-weight: 700;
  color: var(--color-ink);
}

.editor__title--btn {
  border: none;
  background: transparent;
  padding: 0.2rem 0.35rem;
  border-radius: calc(var(--radius) * 0.5);
  cursor: text;
  font-family: var(--serif);
  font-weight: 700;
  font-size: inherit;
  color: var(--color-ink);
}

.editor__title--btn:hover {
  background: var(--color-surface-2);
}

.editor__title-input {
  font-family: var(--serif);
  font-weight: 700;
  font-size: inherit;
  color: var(--color-ink);
  background: var(--color-surface-2);
  border: 1px solid var(--color-clay);
  border-radius: calc(var(--radius) * 0.5);
  padding: 0.15rem 0.35rem;
  outline: none;
  min-width: 8rem;
}

.editor__canvas-actions {
  position: absolute;
  top: 0.75rem;
  right: calc(0.75rem + 2.25rem + 0.4rem);
  display: flex;
  align-items: center;
  gap: 0.25rem;
  z-index: 10;
}

.editor__canvas-icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 2.25rem;
  height: 2.25rem;
  border: none;
  border-radius: 0.5rem;
  background: rgba(0, 0, 0, 0.5);
  color: #fff;
  cursor: pointer;
  transition: background 0.15s;
}

.editor__canvas-icon-btn:hover {
  background: var(--color-clay, #c0855a);
}

.editor__versions {
  position: relative;
  margin-left: auto;
}

.editor__versions--secondary {
  margin-left: 0;
}

.editor__risk-check-btn {
  margin-left: auto;
}

.editor__risk-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.editor__risk-card {
  border: 1.5px solid var(--color-line);
  border-radius: var(--radius);
  padding: 0.7rem 0.8rem;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

.editor__risk-card:hover {
  border-color: var(--color-sage);
}

.editor__risk-card--selected {
  border-color: #f0b429;
  background: rgba(240, 180, 41, 0.07);
}

.editor__risk-card-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.4rem;
}

.editor__risk-badge-icon {
  flex-shrink: 0;
}

.editor__risk-badge-icon--high {
  color: #b91c1c;
}

.editor__risk-badge-icon--mid {
  color: #b45309;
}

.editor__risk-badge-icon--low {
  color: #059669;
}

.editor__risk-label {
  font-size: calc(0.85rem * var(--ts));
  font-weight: 600;
  color: var(--color-ink);
}

.editor__risk-desc {
  margin: 0;
  font-size: calc(0.78rem * var(--ts));
  color: var(--color-ink-soft);
  line-height: 1.5;
}

.editor__risk-label {
  flex: 1;
}

.editor__risk-floor-row {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: calc(0.78rem * var(--ts));
  color: var(--color-ink-soft);
  padding: 0.4rem 0.5rem;
  background: var(--color-surface-2, rgba(0,0,0,0.04));
  border-radius: var(--radius);
  margin-bottom: 0.5rem;
}

.editor__path-section-header {
  margin-top: 1rem;
  border-top: 1px solid var(--color-border);
  padding-top: 0.5rem;
  margin-bottom: 0.35rem;
}

.editor__path-section-title {
  font-weight: 600;
  color: var(--color-ink);
}

.editor__risk-new-btn {
  width: 100%;
  padding: 0.5rem;
  margin-bottom: 0.6rem;
  border: 1.5px dashed var(--color-line);
  border-radius: var(--radius);
  background: transparent;
  color: var(--color-ink-soft);
  font-size: calc(0.82rem * var(--ts));
  cursor: pointer;
}

.editor__risk-new-btn:hover {
  border-color: var(--color-sage);
  color: var(--color-sage);
}

.editor__risk-edit-btn {
  flex-shrink: 0;
  padding: 0.1rem 0.4rem;
  font-size: calc(0.72rem * var(--ts));
  border: 1px solid var(--color-line);
  border-radius: 3px;
  background: transparent;
  color: var(--color-ink-soft);
  cursor: pointer;
}

.editor__risk-edit-btn--del {
  color: #b91c1c;
  border-color: #fca5a5;
}

.editor__risk-edit-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.75rem;
}

.editor__risk-edit-back,
.editor__risk-edit-save {
  padding: 0.3rem 0.7rem;
  border-radius: var(--radius);
  font-size: calc(0.82rem * var(--ts));
  cursor: pointer;
  border: 1px solid var(--color-line);
  background: var(--color-surface);
  color: var(--color-ink);
}

.editor__risk-edit-save {
  background: var(--color-sage);
  color: #fff;
  border-color: var(--color-sage);
}

.editor__risk-edit-form {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.editor__risk-field {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: calc(0.8rem * var(--ts));
  color: var(--color-ink-soft);
}

.editor__risk-field--col {
  flex-direction: column;
  align-items: flex-start;
}

.editor__risk-field span:first-child {
  flex-shrink: 0;
  width: 5rem;
}

.editor__risk-field--col span:first-child {
  width: auto;
}

.editor__risk-input {
  flex: 1;
  padding: 0.25rem 0.4rem;
  border: 1px solid var(--color-line);
  border-radius: calc(var(--radius) * 0.5);
  background: var(--color-paper);
  color: var(--color-ink);
  font-size: calc(0.82rem * var(--ts));
  font-family: inherit;
  width: 100%;
  box-sizing: border-box;
}

.editor__risk-input--sm {
  flex: none;
  width: 4rem;
}

.editor__risk-unit {
  flex-shrink: 0;
}

.editor__risk-textarea {
  resize: vertical;
}

.editor__risk-bboxes {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding-top: 0.4rem;
  border-top: 1px solid var(--color-line);
}

.editor__risk-bbox-block {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  padding: 0.35rem 0.3rem;
  border-bottom: 1px solid var(--color-line);
  border-radius: 3px;
  transition: background 0.1s;
}

.editor__risk-bbox-block:last-of-type {
  border-bottom: none;
}

.editor__risk-bbox-block--active {
  background: rgba(240, 180, 41, 0.1);
  outline: 1px solid #f0b429;
}

.editor__risk-bbox-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: calc(0.75rem * var(--ts));
}

.editor__risk-bbox-label {
  flex: 1;
  color: var(--color-ink-soft);
  font-size: calc(0.75rem * var(--ts));
}

.editor__risk-bbox-inputs {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 0.25rem;
}

.editor__risk-xyz {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  font-size: calc(0.68rem * var(--ts));
  color: var(--color-ink-soft);
}

.editor__risk-xyz-input {
  width: 100%;
  padding: 0.2rem 0.3rem;
  border: 1px solid var(--color-line);
  border-radius: 3px;
  background: var(--color-paper);
  color: var(--color-ink);
  font-size: calc(0.72rem * var(--ts));
  font-family: inherit;
  box-sizing: border-box;
  -webkit-appearance: none;
  -moz-appearance: textfield;
}

.editor__risk-bbox-btn {
  flex-shrink: 0;
  padding: 0.1rem 0.35rem;
  border: 1px solid var(--color-line);
  border-radius: 3px;
  background: transparent;
  color: var(--color-ink-soft);
  cursor: pointer;
  font-size: calc(0.8rem * var(--ts));
}

.editor__risk-bbox-btn--del {
  color: #b91c1c;
}

.editor__risk-add-bbox {
  padding: 0.4rem;
  border: 1px dashed var(--color-line);
  border-radius: var(--radius);
  background: transparent;
  color: var(--color-ink-soft);
  font-size: calc(0.78rem * var(--ts));
  cursor: pointer;
  text-align: center;
}

.editor__risk-add-bbox:hover {
  border-color: var(--color-sage);
  color: var(--color-sage);
}

.editor__placing-overlay {
  position: absolute;
  inset: 0;
  z-index: 50;
  cursor: crosshair;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding-bottom: 2rem;
  background: rgba(0, 0, 0, 0.15);
}

.editor__placing-hint {
  background: rgba(0, 0, 0, 0.65);
  color: #fff;
  padding: 0.4rem 1rem;
  border-radius: 1rem;
  font-size: calc(0.82rem * var(--ts));
}

.editor__versions-toggle {
  border: 1px solid var(--color-line);
  background: var(--color-surface);
  color: var(--color-ink);
  font-size: calc(0.85rem * var(--ts));
  font-weight: 700;
  padding: 0.4rem 0.75rem;
  border-radius: calc(var(--radius) * 0.5);
}

.editor__versions-toggle:hover {
  background: var(--color-surface-2);
}

.editor__versions-panel {
  position: absolute;
  right: 0;
  top: calc(100% + 0.4rem);
  width: 18rem;
  max-height: 20rem;
  overflow-y: auto;
  background: var(--color-paper);
  border: 1px solid var(--color-line);
  border-radius: var(--radius);
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.12);
  padding: 0.75rem;
  z-index: 5;
}

.editor__timeline {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding-left: 0.1rem;
}

.editor__timeline-track {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0.35rem;
  width: 2px;
  background: var(--color-line);
  z-index: 0;
}

.editor__timeline-item {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  width: 100%;
}

.editor__timeline-node {
  position: relative;
  z-index: 1;
  border: none;
  background: transparent;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.2rem 0;
  width: 100%;
  text-align: left;
}

.editor__timeline-node:disabled {
  cursor: default;
}

.editor__timeline-dot {
  flex-shrink: 0;
  width: 0.6rem;
  height: 0.6rem;
  border-radius: 50%;
  background: var(--color-clay);
  border: 2px solid var(--color-paper);
  box-shadow: 0 0 0 1px var(--color-line);
}

.editor__timeline-label {
  font-size: calc(0.8rem * var(--ts));
  color: var(--color-ink-soft);
  line-height: 1.4;
}

.editor__timeline-node--current .editor__timeline-label {
  color: var(--color-ink);
  font-weight: 700;
}

.editor__timeline-node--current .editor__timeline-dot {
  background: var(--color-ink);
}

.editor__timeline-detail {
  margin: 0 0 0 1.1rem;
  font-size: calc(0.72rem * var(--ts));
  color: var(--color-ink-soft);
  opacity: 0.75;
  line-height: 1.3;
}

.editor__body {
  flex: 1;
  min-height: 0;
  display: flex;
}

.editor__panel {
  flex-shrink: 0;
  width: clamp(12rem, 16vw, 16rem);
  display: flex;
  flex-direction: column;
  background: var(--color-surface);
  transition: width 0.15s ease;
}

/* 模型列表要放圖片在上、文字在下的卡片,三個一排,比純文字清單需要的寬度多不少 */
.editor__panel--wide {
  width: clamp(18rem, 24vw, 24rem);
}

.editor__panel--collapsed {
  width: 2.75rem;
}

.editor__panel:first-child {
  border-right: 1px solid var(--color-line);
}

.editor__panel:last-child {
  border-left: 1px solid var(--color-line);
}

.editor__panel-header {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.6rem 0.75rem;
  border-bottom: 1px solid var(--color-line);
}

.editor__panel-title {
  font-size: calc(0.85rem * var(--ts));
  font-weight: 700;
  color: var(--color-ink-soft);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.editor__collapse-btn {
  flex-shrink: 0;
  width: 1.6rem;
  height: 1.6rem;
  border: none;
  border-radius: 50%;
  background: var(--color-surface-2);
  color: var(--color-ink-soft);
  font-size: calc(1rem * var(--ts));
  line-height: 1;
}

.editor__panel-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
  scrollbar-width: none;
}

.editor__panel-body::-webkit-scrollbar {
  display: none;
}

.editor__model-tab {
  display: flex;
  flex-direction: column;
  height: 100%;
  gap: 0;
}

.editor__instance-list-wrap {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  scrollbar-width: none;
}

.editor__instance-list-wrap::-webkit-scrollbar {
  display: none;
}

.editor__instance-detail {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  scrollbar-width: none;
  border-top: 1px solid var(--color-line);
  padding: 0.75rem 0 0;
  margin-top: 0.5rem;
}

.editor__instance-detail::-webkit-scrollbar {
  display: none;
}

.editor__detail-header {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  margin-bottom: 0.6rem;
}

.editor__detail-label-input {
  font-weight: 600;
  font-size: calc(0.9rem * var(--ts));
  color: var(--color-ink);
  background: transparent;
  border: none;
  border-bottom: 1px solid transparent;
  padding: 0.1rem 0;
  outline: none;
  width: 100%;
  transition: border-color 0.15s;
}

.editor__detail-label-input:hover,
.editor__detail-label-input:focus {
  border-bottom-color: var(--color-clay);
}

.editor__detail-size {
  font-size: calc(0.75rem * var(--ts));
  color: var(--color-ink-soft);
  font-variant-numeric: tabular-nums;
}

.editor__detail-source {
  font-size: calc(0.75rem * var(--ts));
  color: var(--color-ink-soft);
}

.editor__item-size {
  display: block;
  font-size: calc(0.72rem * var(--ts));
  font-weight: 400;
  color: var(--color-ink-soft);
  font-variant-numeric: tabular-nums;
  margin-top: 0.1rem;
}

.editor__detail-section {
  margin-bottom: 0.5rem;
}

.editor__detail-section--scale {
  border-top: 1px solid var(--color-line);
  margin-top: 0.25rem;
  padding-top: 0.5rem;
}

.editor__detail-section-title {
  display: block;
  font-size: calc(0.8rem * var(--ts));
  color: var(--color-ink-soft);
  margin-bottom: 0.2rem;
}

.editor__detail-dim-label {
  font-size: calc(0.8rem * var(--ts));
  color: var(--color-ink-soft);
  flex-shrink: 0;
}

.editor__detail-pos-row {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  font-variant-numeric: tabular-nums;
}

.editor__detail-pos-label {
  font-size: calc(0.8rem * var(--ts));
  color: var(--color-ink-soft);
  flex-shrink: 0;
}

.editor__detail-pos-input {
  flex: 1;
  min-width: 0;
  border: none;
  border-bottom: 1px solid transparent;
  background: transparent;
  color: var(--color-ink);
  font-size: calc(0.8rem * var(--ts));
  font-variant-numeric: tabular-nums;
  padding: 0.1rem 0.1rem;
  outline: none;
  transition: border-color 0.15s;
  -moz-appearance: textfield;
}

.editor__detail-pos-input:focus {
  border-bottom-color: var(--color-clay);
}

.editor__detail-pos-input::-webkit-inner-spin-button,
.editor__detail-pos-input::-webkit-outer-spin-button {
  -webkit-appearance: none;
}

.editor__scale-stepper {
  display: flex;
  align-items: center;
  gap: 0.2rem;
}

.editor__scale-btn {
  border: none;
  background: transparent;
  color: var(--color-ink-soft);
  font-size: calc(1rem * var(--ts));
  line-height: 1;
  padding: 0 0.2rem;
  cursor: pointer;
  border-radius: calc(var(--radius) * 0.4);
}

.editor__scale-btn:hover {
  color: var(--color-ink);
  background: var(--color-surface-2);
}

.editor__scale-input {
  width: 3rem;
  border: none;
  border-bottom: 1px solid transparent;
  background: transparent;
  color: var(--color-ink);
  font-size: calc(0.85rem * var(--ts));
  font-variant-numeric: tabular-nums;
  text-align: center;
  outline: none;
  padding: 0.1rem 0;
  transition: border-color 0.15s;
  -moz-appearance: textfield;
}

.editor__scale-input:focus {
  border-bottom-color: var(--color-clay);
}

.editor__scale-input::-webkit-inner-spin-button,
.editor__scale-input::-webkit-outer-spin-button {
  -webkit-appearance: none;
}

.editor__scale-pct {
  font-size: calc(0.8rem * var(--ts));
  color: var(--color-ink-soft);
}

.editor__dim-row {
  display: flex;
  align-items: center;
  gap: 0.2rem;
  margin-top: 0.35rem;
}

.editor__real-size {
  margin-top: 0.35rem;
  font-size: calc(0.75rem * var(--ts));
  color: var(--color-ink-soft);
}

.editor__dim-input {
  flex: 1;
  min-width: 0;
  border: none;
  border-bottom: 1px solid transparent;
  background: transparent;
  color: var(--color-ink);
  font-size: calc(0.8rem * var(--ts));
  font-variant-numeric: tabular-nums;
  padding: 0.1rem 0.1rem;
  outline: none;
  transition: border-color 0.15s;
  -moz-appearance: textfield;
}

.editor__dim-input:focus {
  border-bottom-color: var(--color-clay);
}

.editor__dim-input::-webkit-inner-spin-button,
.editor__dim-input::-webkit-outer-spin-button {
  -webkit-appearance: none;
}

.editor__dim-input::placeholder {
  color: var(--color-ink-soft);
  opacity: 0.5;
}

.editor__detail-actions {
  display: flex;
  gap: 0.4rem;
  margin-bottom: 0.6rem;
}

.editor__detail-action-btn {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  border: 1px solid var(--color-line);
  border-radius: calc(var(--radius) * 0.5);
  background: transparent;
  color: var(--color-ink-soft);
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}

.editor__detail-action-btn:hover {
  background: var(--color-surface-2);
  color: var(--color-ink);
}

.editor__detail-color-btn {
  overflow: hidden;
}

.editor__color-input-hidden {
  position: absolute;
  inset: 0;
  opacity: 0;
  width: 100%;
  height: 100%;
  cursor: pointer;
  border: none;
  padding: 0;
}

.editor__detail-remove-btn:hover {
  background: #fee2e2;
  color: #dc2626;
  border-color: #fca5a5;
}

.editor__detail-empty {
  flex-shrink: 0;
  border-top: 1px solid var(--color-line);
  padding: 0.75rem 0 0;
  margin-top: 0.5rem;
  font-size: calc(0.8rem * var(--ts));
  color: var(--color-ink-soft);
  text-align: center;
}

.editor__item-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.editor__search {
  width: 100%;
  margin-bottom: 0.6rem;
  border: 1px solid var(--color-line);
  border-radius: calc(var(--radius) * 0.5);
  padding: 0.4rem 0.6rem;
  background: var(--color-paper);
  color: var(--color-ink);
  font-size: calc(0.85rem * var(--ts));
}

/* 模型列表:圖片在上、文字在下的卡片,固定三個一排(不是依寬度自動排列) */
.editor__card-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.6rem;
}

.editor__item {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.4rem;
  border-radius: calc(var(--radius) * 0.6);
  cursor: pointer;
}

.editor__item:hover {
  background: var(--color-surface-2);
}

.editor__item--selected {
  background: var(--color-surface-2);
  outline: 1px solid var(--color-ink-soft);
  outline-offset: -1px;
}

.editor__item--hidden .editor__item-name {
  color: var(--color-ink-soft);
  opacity: 0.5;
}

.editor__item img {
  width: 2.5rem;
  height: 2.5rem;
  object-fit: cover;
  border-radius: calc(var(--radius) * 0.4);
  flex-shrink: 0;
}

.editor__item span {
  font-size: calc(0.85rem * var(--ts));
  color: var(--color-ink);
}

.editor__item-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.editor__item-name-input {
  flex: 1;
  min-width: 0;
  font-size: calc(0.85rem * var(--ts));
  color: var(--color-ink);
  border: 1px solid var(--color-ink-soft);
  border-radius: calc(var(--radius) * 0.4);
  padding: 0.1rem 0.3rem;
  background: var(--color-paper);
}

.editor__visibility-btn {
  flex-shrink: 0;
  border: none;
  background: transparent;
  font-size: calc(0.9rem * var(--ts));
  line-height: 1;
  padding: 0.2rem;
  border-radius: calc(var(--radius) * 0.4);
  color: var(--color-ink-soft);
}

.editor__visibility-btn:hover {
  background: var(--color-surface);
}

.editor__empty {
  margin: 0;
  font-size: calc(0.8rem * var(--ts));
  line-height: 1.7;
  color: var(--color-ink-soft);
}

.editor__viewport {
  flex: 1;
  min-width: 0;
  position: relative;
  display: flex;
}

.editor__main-half {
  flex: 1;
  min-width: 0;
  position: relative;
}

.editor__viewport--split .editor__main-half {
  border-right: 2px solid var(--color-line);
}

.editor__compare-half {
  flex: 1;
  min-width: 0;
  position: relative;
}

.editor__gizmo-toolbar {
  position: absolute;
  left: 50%;
  bottom: 1.25rem;
  transform: translateX(-50%);
  display: flex;
  gap: 0.4rem;
  padding: 0.4rem;
  border-radius: var(--radius);
  background: var(--color-surface);
  border: 1px solid var(--color-line);
  box-shadow: 0 0.5rem 1.5rem rgba(0, 0, 0, 0.15);
}

.editor__gizmo-toolbar button {
  border: none;
  background: transparent;
  color: var(--color-ink-soft);
  font-size: calc(0.85rem * var(--ts));
  font-weight: 700;
  padding: 0.45rem 0.8rem;
  border-radius: calc(var(--radius) * 0.6);
  cursor: pointer;
}

.editor__gizmo-toolbar button:hover {
  background: var(--color-surface-2);
}

.editor__gizmo-toolbar button.active {
  background: var(--color-ink);
  color: var(--color-paper);
}

.editor__missing {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-ink-soft);
  background: var(--color-paper);
  margin: 0;
}

.editor__command-feedback {
  margin: 0 0 0.5rem;
  font-size: calc(0.8rem * var(--ts));
  color: var(--color-ink-soft);
}

.editor__chat-tools {
  display: flex;
  gap: 0.25rem;
  margin-bottom: 0.25rem;
}

.editor__chat-tool-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 1.75rem;
  height: 1.75rem;
  border: none;
  border-radius: var(--radius);
  background: transparent;
  color: var(--color-ink-soft);
  cursor: pointer;
  transition: color 0.15s;
}

.editor__chat-tool-btn:hover {
  color: var(--color-sage);
}

.editor__command-row {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.editor__command-input {
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  border: 1px solid var(--color-line);
  border-radius: calc(var(--radius) * 0.5);
  padding: 0.6rem 0.85rem;
  background: var(--color-paper);
  color: var(--color-ink);
  font-size: calc(0.9rem * var(--ts));
  font-family: inherit;
  line-height: 1.5;
}

.editor__command-submit {
  width: 100%;
  border: none;
  border-radius: calc(var(--radius) * 0.5);
  padding: 0.55rem 1.2rem;
  background: var(--color-clay);
  color: var(--color-ink);
  font-weight: 700;
  cursor: pointer;
}

.editor__command-submit:disabled {
  opacity: 0.6;
  cursor: default;
}

.editor__console {
  margin-top: 0.5rem;
  font-size: calc(0.8rem * var(--ts));
}

.editor__console-latest {
  width: 100%;
  display: flex;
  align-items: flex-start;
  gap: 0.4rem;
  padding: 0.3rem 0;
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
}

.editor__console-latest:hover .editor__console-text {
  color: var(--color-ink);
}

.editor__console-text {
  flex: 1;
  color: var(--color-ink-soft);
  line-height: 1.4;
  word-break: break-all;
}

.editor__console-arrow {
  flex-shrink: 0;
  color: var(--color-ink-soft);
  font-size: calc(0.65rem * var(--ts));
  margin-top: 0.15rem;
}

.editor__console-history {
  max-height: 9rem;
  overflow-y: auto;
}

.editor__console-entry {
  margin: 0;
  padding: 0.2rem 0;
  color: var(--color-ink-soft);
  line-height: 1.4;
}

.editor__tab-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 1.8rem;
  height: 1.8rem;
  border: 1px solid var(--color-line);
  border-radius: calc(var(--radius) * 0.5);
  background: transparent;
  color: var(--color-ink-soft);
  cursor: pointer;
  flex-shrink: 0;
}

.editor__tab-icon:hover {
  background: var(--color-surface-2);
}

.editor__tab-icon--active {
  background: var(--color-clay);
  color: var(--color-ink);
  border-color: var(--color-clay);
}

.editor__panel-header-group {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.editor__collapsed-tabs {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0;
}

.editor__subtabs {
  display: flex;
  gap: 0;
  margin-bottom: 0.75rem;
  border: 1px solid var(--color-line);
  border-radius: calc(var(--radius) * 0.5);
  overflow: hidden;
  flex-shrink: 0;
}

.editor__subtab {
  flex: 1;
  font-size: calc(0.78rem * var(--ts));
  font-weight: 700;
  padding: 0.35rem 0;
  border: none;
  background: transparent;
  color: var(--color-ink-soft);
  cursor: pointer;
}

.editor__subtab:hover {
  background: var(--color-surface-2);
}

.editor__subtab--active {
  background: var(--color-clay);
  color: var(--color-ink);
}

.editor__version-confirm {
  position: sticky;
  bottom: 0;
  margin-top: 0.75rem;
  padding: 0.6rem 0.5rem;
  background: var(--color-surface);
  border-top: 1px solid var(--color-line);
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
}

.editor__version-confirm-label {
  flex: 1;
  font-size: calc(0.78rem * var(--ts));
  color: var(--color-ink);
  font-weight: 700;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.editor__version-confirm-btn {
  flex-shrink: 0;
  border: none;
  border-radius: calc(var(--radius) * 0.5);
  padding: 0.35rem 0.75rem;
  background: var(--color-clay);
  color: var(--color-ink);
  font-size: calc(0.8rem * var(--ts));
  font-weight: 700;
  cursor: pointer;
}

.editor__version-cancel-btn {
  flex-shrink: 0;
  border: 1px solid var(--color-line);
  border-radius: calc(var(--radius) * 0.5);
  padding: 0.35rem 0.6rem;
  background: transparent;
  color: var(--color-ink-soft);
  font-size: calc(0.8rem * var(--ts));
  cursor: pointer;
}

.editor__compare-label {
  position: absolute;
  top: 0.6rem;
  left: 50%;
  transform: translateX(-50%);
  z-index: 10;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: calc(0.78rem * var(--ts));
  font-weight: 700;
  padding: 0.25rem 0.75rem;
  border-radius: 1rem;
  pointer-events: none;
  white-space: nowrap;
}

.editor__compare-actions {
  position: absolute;
  bottom: 1.25rem;
  left: 50%;
  transform: translateX(-50%);
  z-index: 10;
  display: flex;
  gap: 0.6rem;
}

.editor__compare-confirm-btn,
.editor__compare-cancel-btn {
  width: 2.4rem;
  height: 2.4rem;
  border-radius: 50%;
  border: none;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: 0 0.2rem 0.6rem rgba(0, 0, 0, 0.25);
  flex-shrink: 0;
}

.editor__compare-confirm-btn {
  background: var(--color-clay);
  color: var(--color-ink);
}

.editor__compare-confirm-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.editor__compare-cancel-btn {
  background: var(--color-surface);
  color: var(--color-ink-soft);
  border: 1px solid var(--color-line);
}

.editor__compare-cancel-btn:hover {
  background: var(--color-surface-2);
}
</style>
