<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useLibraryStore, PLACEHOLDER_THUMBNAIL, type LibraryItem, upAxisFixFor } from '../stores/library'
import { useSceneObjectsStore } from '../stores/sceneObjects'
import GSplatViewer from './GSplatViewer.vue'

const props = defineProps<{
  item: LibraryItem
  kind: 'scene' | 'object'
  allowAdd?: boolean
  allowCopyToLibrary?: boolean
}>()
const emit = defineEmits<{ close: []; add: []; 'copy-to-library': [] }>()

const router = useRouter()
const library = useLibraryStore()
const sceneObjects = useSceneObjectsStore()
const zoom = ref(1)
const viewerError = ref<string | null>(null)
const viewerRef = ref<InstanceType<typeof GSplatViewer> | null>(null)

const previewSize = ref<[number, number, number] | null>(null)

async function onViewerLoaded() {
  const size = viewerRef.value?.getSceneAabbSize() ?? null
  previewSize.value = size
  if (size && props.kind === 'object') library.objectSizes[props.item.id] = size
  if (props.item.thumbnail !== PLACEHOLDER_THUMBNAIL) return
  await new Promise((resolve) => setTimeout(resolve, 1000))
  const blob = await viewerRef.value?.captureThumbnail().catch(() => null)
  if (!blob) return
  await library.saveThumbnail(props.kind, props.item.id, blob).catch(() => {})
}

function fmtSize(s: [number, number, number]) {
  return `${s[0].toFixed(2)}m × ${s[1].toFixed(2)}m × ${s[2].toFixed(2)}m`
}

const renaming = ref(false)
const renameValue = ref('')
const renameInputRef = ref<HTMLInputElement | null>(null)
function startRename() {
  renaming.value = true
  renameValue.value = props.item.name
  nextTick(() => renameInputRef.value?.focus())
}
async function commitRename() {
  if (!renaming.value) return
  renaming.value = false
  const name = renameValue.value.trim()
  if (!name || name === props.item.name) return
  try {
    if (props.kind === 'scene') await library.renameScene(props.item.id, name)
    else await library.renameObject(props.item.id, name)
  } catch {
  }
}
const sceneDataReady = ref(props.kind !== 'scene')
onMounted(async () => {
  if (props.kind !== 'scene') return
  await Promise.all([
    library.objectsLoaded ? Promise.resolve() : library.fetchObjects(),
    sceneObjects.fetchInstancesForScene(props.item.id),
    sceneObjects.fetchVersions(props.item.id),
  ])
  sceneDataReady.value = true
})
const versions = computed(() => sceneObjects.versionsBySceneId[props.item.id] ?? [])
const expandedVersionId = ref<number | null>(null)
function toggleVersionDetail(versionId: number) {
  expandedVersionId.value = expandedVersionId.value === versionId ? null : versionId
}
function versionLabel(versionId: number): string {
  const target = versions.value.find((v) => v.id === versionId)
  return target ? `第 ${target.versionNumber} 版` : `版本 id=${versionId}`
}
const entering = ref(false)
const enteringPercent = ref(0)

const viewerSrc = computed(() =>
  props.kind === 'scene' ? sceneObjects.sceneModelUrls(props.item.id) : props.item.modelUrl,
)
const viewerTransforms = computed(() =>
  props.kind === 'scene'
    ? sceneObjects.instancesForScene(props.item.id).map((i) => ({ position: i.position, rotation: i.rotation, scale: i.scale }))
    : undefined,
)
const viewerDataRotations = computed(() => {
  if (props.kind !== 'scene') return [upAxisFixFor(props.item.id, props.item.modelUrl)]
  const instances = sceneObjects.instancesForScene(props.item.id)
  const urls = sceneObjects.sceneModelUrls(props.item.id)
  return instances.map((i, idx) => upAxisFixFor(i.modelId, urls[idx]))
})
const viewerColors = computed(() =>
  props.kind === 'scene' ? sceneObjects.instancesForScene(props.item.id).map((i) => i.color) : undefined
)

function zoomIn() {
  zoom.value = Math.min(zoom.value + 0.2, 2.4)
}
function zoomOut() {
  zoom.value = Math.max(zoom.value - 0.2, 0.6)
}

const copyingToLibrary = ref(false)
function requestCopyToLibrary() {
  if (copyingToLibrary.value) return
  copyingToLibrary.value = true
  emit('copy-to-library')
}

async function enterEditor() {
  if (entering.value) return
  entering.value = true
  await nextTick()
  await router.push(`/scenes/${props.item.id}/edit`)
  emit('close')
}

const closing = ref(false)
async function closeModal(which: 'close' | 'add') {
  if (entering.value || closing.value) return
  closing.value = true
  await nextTick()
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  if (which === 'close') emit('close')
  else emit('add')
}
</script>

<template>
  <Transition name="preview-fade">
    <div class="preview-backdrop" @click.self="closeModal('close')">
      <div class="preview-modal">
        <button class="preview-modal__close" type="button" aria-label="關閉" @click="closeModal('close')">✕</button>

        <div v-if="entering || closing" class="preview-modal__entering">
          <span class="preview-modal__spinner" aria-hidden="true" />
          <span v-if="entering" class="preview-modal__entering-percent">{{ enteringPercent }}%</span>
          <p>{{ entering ? '正在進入編輯頁面…' : '正在處理…' }}</p>
        </div>

        <div class="preview-modal__viewer">
          <template v-if="!sceneDataReady">
            <div class="preview-modal__canvas-stub"><p>載入場景資料中…</p></div>
          </template>
          <template v-else-if="viewerSrc && viewerSrc.length !== 0">
            <GSplatViewer
              ref="viewerRef"
              :src="viewerSrc"
              :transforms="viewerTransforms"
              :data-rotations="viewerDataRotations"
              :colors="viewerColors"
              @error="(msg) => (viewerError = msg)"
              @progress="(p) => (enteringPercent = p)"
              @loaded="onViewerLoaded"
            />
            <p v-if="viewerError" class="preview-modal__viewer-error">3D 檢視器載入失敗:{{ viewerError }}</p>
          </template>
          <template v-else>
            <!-- 沒有真實 .ply 的項目(還是假資料)先用縮圖佔位 -->
            <div class="preview-modal__canvas-stub">
              <img :src="item.thumbnail" :style="{ transform: `scale(${zoom})` }" alt="" />
            </div>
            <div class="preview-modal__zoom-controls">
              <button type="button" @click="zoomOut">−</button>
              <button type="button" @click="zoomIn">+</button>
            </div>
          </template>
        </div>

        <div class="preview-modal__meta">
          <div v-if="renaming" class="preview-modal__rename">
            <input
              ref="renameInputRef"
              v-model="renameValue"
              type="text"
              @keydown.enter="commitRename"
              @keydown.esc="renaming = false"
              @blur="commitRename"
            />
          </div>
          <h2 v-else-if="!allowCopyToLibrary" class="preview-modal__title preview-modal__title--editable" @click="startRename">
            {{ item.name }}
            <span class="preview-modal__rename-hint">✎</span>
          </h2>
          <h2 v-else>{{ item.name }}</h2>
          <p v-if="previewSize" class="preview-modal__size">{{ fmtSize(previewSize) }}</p>

          <div v-if="kind === 'scene' && versions.length" class="preview-modal__timeline">
            <div class="preview-modal__timeline-track" />
            <div v-for="v in versions" :key="v.id" class="preview-modal__timeline-item">
              <button type="button" class="preview-modal__timeline-node" @click="toggleVersionDetail(v.id)">
                <span class="preview-modal__timeline-dot" />
                <span class="preview-modal__timeline-label">
                  第 {{ v.versionNumber }} 版 · {{ new Date(v.createdAt).toLocaleString() }}
                </span>
              </button>
              <div v-if="expandedVersionId === v.id" class="preview-modal__timeline-detail">
                <p v-if="v.revertedFromVersionId">還原自{{ versionLabel(v.revertedFromVersionId) }}</p>
                <ul v-if="v.sourceCommands.length">
                  <li v-for="(cmd, i) in v.sourceCommands" :key="i">{{ cmd }}</li>
                </ul>
                <p v-else-if="!v.revertedFromVersionId">（沒有記錄個別操作)</p>
              </div>
            </div>
          </div>

          <button
            v-if="kind === 'scene'"
            class="preview-modal__edit-btn"
            type="button"
            :disabled="entering"
            @click="enterEditor"
          >
            進入編輯頁面
          </button>

          <button v-if="allowAdd" class="preview-modal__edit-btn" type="button" :disabled="closing" @click="closeModal('add')">
            確認添加
          </button>

          <button
            v-if="allowCopyToLibrary"
            class="preview-modal__edit-btn"
            type="button"
            :disabled="copyingToLibrary"
            @click="requestCopyToLibrary"
          >
            {{ copyingToLibrary ? '加入中…' : '加入我的模型庫' }}
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.preview-fade-enter-active,
.preview-fade-leave-active {
  transition: opacity 0.2s ease;
}

.preview-fade-enter-from,
.preview-fade-leave-to {
  opacity: 0;
}

.preview-backdrop {
  position: fixed;
  inset: 0;
  z-index: 20;
  background: rgba(255, 255, 255, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: clamp(1rem, 3vw, 2.5rem);
}

/* 固定尺寸比例,不管內容(描述長短、有沒有編輯按鈕)都不會撐大或縮小彈窗 */
.preview-modal {
  position: relative;
  width: min(100%, 60rem);
  height: min(85vh, 38rem);
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
  background: var(--color-paper);
  border: 1px solid var(--color-line);
  border-radius: var(--radius);
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.18);
  overflow: hidden;
}

@media (max-width: 42rem) {
  .preview-modal {
    grid-template-columns: 1fr;
  }
}

.preview-modal__close {
  position: absolute;
  top: 0.6rem;
  right: 0.6rem;
  z-index: 1;
  width: 2rem;
  height: 2rem;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.35);
  color: #fff;
  line-height: 1;
}

.preview-modal__viewer {
  position: relative;
  background: var(--color-ink);
  min-height: 18rem;
}

.preview-modal__canvas-stub {
  width: 100%;
  height: 100%;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}

.preview-modal__canvas-stub p {
  margin: 0;
  color: #fff;
  font-size: 0.9rem;
}

.preview-modal__canvas-stub img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform 0.15s ease;
}

.preview-modal__zoom-controls {
  position: absolute;
  bottom: 0.75rem;
  right: 0.75rem;
  display: flex;
  gap: 0.4rem;
}

.preview-modal__viewer-error {
  position: absolute;
  bottom: 0.75rem;
  left: 0.75rem;
  right: 0.75rem;
  margin: 0;
  padding: 0.5rem 0.75rem;
  border-radius: calc(var(--radius) * 0.6);
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  font-size: 0.8rem;
}

.preview-modal__zoom-controls button {
  width: 2rem;
  height: 2rem;
  border: none;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.85);
  color: var(--color-ink);
  font-size: 1.1rem;
  font-weight: 700;
  line-height: 1;
}

.preview-modal__meta {
  padding: 1.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  overflow-y: auto;
}

.preview-modal__meta h2 {
  font-size: 1.35rem;
  color: var(--color-ink);
}

.preview-modal__title--editable {
  cursor: pointer;
  display: inline-flex;
  align-items: baseline;
  gap: 0.4rem;
}

.preview-modal__rename-hint {
  font-size: 0.8rem;
  color: var(--color-ink-soft);
}

.preview-modal__rename input {
  font-size: 1.35rem;
  font-weight: 700;
  font-family: inherit;
  color: var(--color-ink);
  border: 1px solid var(--color-sage);
  border-radius: calc(var(--radius) * 0.4);
  padding: 0.15rem 0.4rem;
  width: 100%;
  background: var(--color-surface);
}

.preview-modal__meta p {
  margin: 0;
  color: var(--color-ink-soft);
  font-size: 0.95rem;
  line-height: 1.7;
}

.preview-modal__size {
  font-size: 0.85rem;
  color: var(--color-ink-soft);
  font-variant-numeric: tabular-nums;
  margin-top: -0.25rem;
}

.preview-modal__timeline {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.25rem 0;
}

.preview-modal__timeline-track {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0.25rem;
  width: 2px;
  background: var(--color-line);
  z-index: 0;
}

.preview-modal__timeline-item {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  width: 100%;
}

.preview-modal__timeline-node {
  border: none;
  background: transparent;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.2rem 0;
}

.preview-modal__timeline-dot {
  flex-shrink: 0;
  width: 0.6rem;
  height: 0.6rem;
  border-radius: 50%;
  background: var(--color-clay);
  border: 2px solid var(--color-paper);
  box-shadow: 0 0 0 1px var(--color-line);
}

.preview-modal__timeline-label {
  font-size: 0.78rem;
  color: var(--color-ink-soft);
  text-align: left;
  line-height: 1.4;
}

.preview-modal__timeline-detail {
  margin-left: 1.1rem;
  max-width: 90%;
  text-align: left;
}

.preview-modal__timeline-detail p {
  margin: 0;
  font-size: 0.75rem;
  color: var(--color-ink-soft);
  line-height: 1.5;
}

.preview-modal__timeline-detail ul {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.preview-modal__timeline-detail li {
  font-size: 0.75rem;
  color: var(--color-ink-soft);
  line-height: 1.5;
}

.preview-modal__edit-btn {
  margin-top: auto;
  align-self: flex-start;
  border: none;
  padding: 0.65em 1.4em;
  border-radius: calc(var(--radius) * 0.6);
  background: var(--color-clay);
  color: var(--color-ink);
  font-weight: 700;
}

.preview-modal__edit-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.preview-modal__entering {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  background: var(--color-paper);
}

.preview-modal__entering p {
  margin: 0;
  color: var(--color-ink-soft);
  font-size: 0.9rem;
}

.preview-modal__entering-percent {
  color: var(--color-clay);
  font-size: 1.1rem;
  font-weight: 700;
}

.preview-modal__spinner {
  width: 2.25rem;
  height: 2.25rem;
  border: 0.25rem solid var(--color-line);
  border-top-color: var(--color-clay);
  border-radius: 50%;
  animation: preview-modal-spin 0.8s linear infinite;
  margin-bottom: 0.35rem;
}

@keyframes preview-modal-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
