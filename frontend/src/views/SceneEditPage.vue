<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useLibraryStore, upAxisFixFor, type LibraryItem } from '../stores/library'
import { useSceneObjectsStore } from '../stores/sceneObjects'
import GSplatViewer from '../components/GSplatViewer.vue'
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
onMounted(async () => {
  await Promise.all([
    library.scenesLoaded ? Promise.resolve() : library.fetchScenes(),
    library.objectsLoaded ? Promise.resolve() : library.fetchObjects(),
    sceneObjectsStore.fetchInstancesForScene(sceneId.value),
  ])
  ready.value = true
})
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
  if (e.key === 'g' || e.key === 'G') gizmoMode.value = 'translate'
  else if (e.key === 'r' || e.key === 'R') gizmoMode.value = 'rotate'
  else if (e.key === 's' || e.key === 'S') gizmoMode.value = 'scale'
  else if (e.key === 'Escape') selectedObjectId.value = null
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

const editCommandText = ref('')
const editCommandBusy = ref(false)
const editCommandFeedback = ref('')
const lastEditContext = ref<{ command: string; instances: { id: string; label: string }[] } | null>(null)

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
          ? { id: p.id, label: inst.label, x: p.x, y: p.y, modelId: inst.modelId, color: inst.color, distance: p.distance }
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
    if (sceneObjectsStore.canUndo) {
      await sceneObjectsStore.createVersion(currentScene.id).catch(() => {})
    }
  }
  sceneObjectsStore.clearHistory()
  router.push('/dashboard')
}

const versionsOpen = ref(false)
const versions = computed(() => (scene.value ? sceneObjectsStore.versionsBySceneId[scene.value.id] ?? [] : []))
async function toggleVersions() {
  versionsOpen.value = !versionsOpen.value
  if (versionsOpen.value && scene.value) {
    await sceneObjectsStore.fetchVersions(scene.value.id)
  }
}
async function restoreVersion(versionId: number, label: string) {
  if (!scene.value) return
  if (!window.confirm(`確定要還原到「${label}」嗎?目前場景內容會被蓋掉(這個還原動作本身也會留下一筆新版本紀錄)。`)) return
  const change = await sceneObjectsStore.restoreVersion(scene.value.id, versionId)
  await syncHistoryChange(change)
  selectedObjectId.value = null
  editCommandFeedback.value = '↺ 已還原到選取的版本'
}
function versionLabel(versionId: number): string {
  const target = versions.value.find((v) => v.id === versionId)
  return target ? `第 ${target.versionNumber} 版` : `版本 id=${versionId}`
}

const historyOpen = ref(false)
const historyTimeline = computed(() => sceneObjectsStore.historyTimeline)
const historyIndex = computed(() => sceneObjectsStore.historyIndex)
function toggleHistory() {
  historyOpen.value = !historyOpen.value
}
async function jumpToHistory(targetIndex: number, label: string) {
  if (!scene.value || targetIndex === historyIndex.value) return
  if (!window.confirm(`確定要跳至「${label}」這個操作點嗎?`)) return
  const change = await sceneObjectsStore.jumpToIndex(scene.value.id, targetIndex)
  await syncHistoryChange(change)
  selectedObjectId.value = null
  editCommandFeedback.value = '↺ 已跳至選取的操作'
}
</script>

<template>
  <div class="editor">
    <header class="editor__bar">
      <button class="editor__back" type="button" @click="leaveEditor">← 返回工作站</button>
      <span class="editor__title">{{ scene?.name ?? '場景' }}</span>
      <div class="editor__versions">
        <button class="editor__versions-toggle" type="button" @click="toggleHistory">操作歷史</button>
        <div v-if="historyOpen" class="editor__versions-panel">
          <p v-if="historyTimeline.length === 0" class="editor__empty">這次編輯 session 還沒有任何操作</p>
          <div v-else class="editor__timeline">
            <div class="editor__timeline-track" />
            <button
              type="button"
              class="editor__timeline-node"
              :class="{ 'editor__timeline-node--current': historyIndex === 0 }"
              :disabled="historyIndex === 0"
              @click="jumpToHistory(0, '（初始狀態）')"
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
              @click="jumpToHistory(entry.index, entry.label)"
            >
              <span class="editor__timeline-dot" />
              <span class="editor__timeline-label">{{ entry.label }}</span>
            </button>
          </div>
        </div>
      </div>
      <div class="editor__versions editor__versions--secondary">
        <button class="editor__versions-toggle" type="button" @click="toggleVersions">版本歷史</button>
        <div v-if="versionsOpen" class="editor__versions-panel">
          <p v-if="versions.length === 0" class="editor__empty">還沒有任何版本紀錄</p>
          <div v-else class="editor__timeline">
            <div class="editor__timeline-track" />
            <div v-for="v in versions" :key="v.id" class="editor__timeline-item">
              <button
                type="button"
                class="editor__timeline-node"
                @click="restoreVersion(v.id, `第 ${v.versionNumber} 版`)"
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
        </div>
      </div>
    </header>

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

      <main class="editor__viewport">
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
        />
        <p v-else class="editor__missing">找不到這個場景的模型資料</p>

        <div v-if="selectedObjectId" class="editor__gizmo-toolbar">
          <button type="button" :class="{ active: gizmoMode === 'translate' }" title="移動 (G)" @click="gizmoMode = 'translate'">移動</button>
          <button type="button" :class="{ active: gizmoMode === 'rotate' }" title="旋轉 (R)" @click="gizmoMode = 'rotate'">旋轉</button>
          <button type="button" :class="{ active: gizmoMode === 'scale' }" title="縮放 (S)" @click="gizmoMode = 'scale'">縮放</button>
          <button type="button" title="取消選取 (Esc)" @click="selectedObjectId = null">✕</button>
        </div>
      </main>

      <aside class="editor__panel" :class="{ 'editor__panel--collapsed': rightCollapsed }">
        <div class="editor__panel-header">
          <button
            class="editor__collapse-btn"
            type="button"
            :aria-label="rightCollapsed ? '展開場景模型列表' : '收合場景模型列表'"
            @click="rightCollapsed = !rightCollapsed"
          >
            {{ rightCollapsed ? '‹' : '›' }}
          </button>
          <span v-if="!rightCollapsed" class="editor__panel-title">場景模型列表</span>
        </div>
        <div v-if="!rightCollapsed" class="editor__panel-body">
          <ul v-if="sceneInstances.length" class="editor__item-list">
            <li
              v-for="inst in sceneInstances"
              :key="inst.id"
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
              >
                {{ hiddenObjectIds.has(inst.id) ? '⊘' : '👁' }}
              </button>
              <button
                class="editor__visibility-btn"
                type="button"
                aria-label="移除物件"
                title="移除物件"
                @click.stop="removeInstance(inst.id)"
              >
                🗑
              </button>
            </li>
          </ul>
          <p v-else class="editor__empty">
            這個場景還沒有擺放任何物件——從左側「模型列表」點選一個模型,預覽後按「確認添加」就會加進來。
          </p>
        </div>
      </aside>
    </div>

    <form class="editor__command-bar" @submit.prevent="submitEditCommand">
      <p v-if="editCommandFeedback" class="editor__command-feedback">{{ editCommandFeedback }}</p>
      <div class="editor__command-row">
        <input
          v-model="editCommandText"
          class="editor__command-input"
          type="text"
          placeholder="用一句話編輯場景,例如「把沙發往右移一點」「窗簾改成藍色」…"
          :disabled="editCommandBusy"
        />
        <button class="editor__command-submit" type="submit" :disabled="editCommandBusy || !editCommandText.trim()">
          {{ editCommandBusy ? '處理中…' : '送出' }}
        </button>
      </div>
    </form>

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

.editor__back {
  border: none;
  background: transparent;
  color: var(--color-ink-soft);
  font-size: 0.9rem;
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

.editor__versions {
  position: relative;
  margin-left: auto;
}

.editor__versions--secondary {
  margin-left: 0;
}

.editor__versions-toggle {
  border: 1px solid var(--color-line);
  background: var(--color-surface);
  color: var(--color-ink);
  font-size: 0.85rem;
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
  font-size: 0.8rem;
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
  font-size: 0.72rem;
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
  font-size: 0.85rem;
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
  font-size: 1rem;
  line-height: 1;
}

.editor__panel-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0.75rem;
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
  font-size: 0.85rem;
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
  font-size: 0.85rem;
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
  font-size: 0.85rem;
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
  font-size: 0.9rem;
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
  font-size: 0.8rem;
  line-height: 1.7;
  color: var(--color-ink-soft);
}

.editor__viewport {
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
  font-size: 0.85rem;
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

.editor__command-bar {
  flex-shrink: 0;
  padding: 0.75rem 1.25rem;
  background: var(--color-surface);
  border-top: 1px solid var(--color-line);
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.editor__command-feedback {
  margin: 0;
  font-size: 0.8rem;
  color: var(--color-ink-soft);
}

.editor__command-row {
  display: flex;
  gap: 0.6rem;
}

.editor__command-input {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--color-line);
  border-radius: calc(var(--radius) * 0.5);
  padding: 0.6rem 0.85rem;
  background: var(--color-paper);
  color: var(--color-ink);
  font-size: 0.9rem;
}

.editor__command-submit {
  flex-shrink: 0;
  border: none;
  border-radius: calc(var(--radius) * 0.5);
  padding: 0.6rem 1.2rem;
  background: var(--color-clay);
  color: var(--color-ink);
  font-weight: 700;
}

.editor__command-submit:disabled {
  opacity: 0.6;
}
</style>
