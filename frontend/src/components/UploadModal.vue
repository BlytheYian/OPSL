<script setup lang="ts">
import { ref } from 'vue'
import { useLibraryStore, upAxisFixFor, type Vec3 } from '../stores/library'
import GSplatViewer from './GSplatViewer.vue'

defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const library = useLibraryStore()

type UploadKind = 'object' | 'scene'

const chosenKind = ref<UploadKind | null>(null)
const chosenFile = ref<File | null>(null)
const fileInputRef = ref<HTMLInputElement | null>(null)
const uploading = ref(false)
const uploadError = ref('')
const uploadedName = ref('')

const KIND_ACCEPT: Record<UploadKind, string> = {
  object: '.ply,.glb',
  scene: '.usdz,.usd,.obj,.fbx',
}

function pickKind(kind: UploadKind) {
  chosenKind.value = kind
  chosenFile.value = null
  uploadError.value = ''
  uploadedName.value = ''
  fileInputRef.value?.click()
}

function onFileChosen(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  chosenFile.value = file ?? null
}

async function confirmUpload() {
  if (!chosenFile.value || chosenKind.value !== 'object') return
  uploading.value = true
  uploadError.value = ''
  try {
    const item = await library.uploadObject(chosenFile.value)
    uploadedName.value = item.name
    chosenFile.value = null
    if (item.modelUrl) {
      captureItem.value = { url: item.modelUrl, id: item.id, dataRotation: upAxisFixFor(item.id, item.modelUrl) }
    }
  } catch (err) {
    uploadError.value = err instanceof Error ? err.message : '上傳失敗'
  } finally {
    uploading.value = false
  }
}

const captureItem = ref<{ url: string; id: string; dataRotation: Vec3 } | null>(null)
const captureViewerRef = ref<InstanceType<typeof GSplatViewer> | null>(null)
async function onCaptureLoaded() {
  const item = captureItem.value
  if (!item) return
  const blob = await captureViewerRef.value?.captureCurrentView().catch(() => null)
  if (blob) await library.saveThumbnail('object', item.id, blob).catch(() => {})
  captureItem.value = null
}

function reset() {
  chosenKind.value = null
  chosenFile.value = null
  uploadError.value = ''
  uploadedName.value = ''
  if (fileInputRef.value) fileInputRef.value.value = ''
}

function handleClose() {
  reset()
  emit('close')
}
</script>

<template>
  <Transition name="upload-fade">
    <div v-if="open" class="upload-backdrop" @click.self="handleClose">
      <div class="upload-modal">
        <button class="upload-modal__close" type="button" aria-label="關閉" @click="handleClose">✕</button>
        <h1>上傳場景 / 模型</h1>

        <template v-if="!chosenKind || (!chosenFile && !uploadedName)">
          <p class="upload-modal__hint">選擇要上傳的是單一模型元件,還是包含多個模型的場景檔案</p>
          <div class="upload-modal__choices">
            <button class="upload-modal__choice" type="button" @click="pickKind('object')">
              <span class="upload-modal__choice-title">模型元件</span>
              <span class="upload-modal__choice-desc">單一模型檔案,.ply(gsplat)或 .glb(一般網格)格式</span>
            </button>
            <button class="upload-modal__choice" type="button" @click="pickKind('scene')">
              <span class="upload-modal__choice-title">場景資訊</span>
              <span class="upload-modal__choice-desc">包含多個模型的場景檔案,例如 .usdz / .obj / .fbx</span>
            </button>
          </div>
        </template>

        <div v-else-if="chosenKind === 'scene'" class="upload-modal__result">
          <p>已選擇檔案:<strong>{{ chosenFile?.name }}</strong></p>
          <p class="upload-modal__hint">場景包裝格式(.usdz/.obj/.fbx)目前沒有能轉成我們用的格式的管線,上傳功能尚未串接,先只是選檔案的畫面。</p>
          <button class="upload-modal__back" type="button" @click="reset">重新選擇</button>
        </div>

        <div v-else-if="uploadedName" class="upload-modal__result">
          <p>已上傳:<strong>{{ uploadedName }}</strong>,已加入你的模型庫。</p>
          <button class="upload-modal__back" type="button" @click="reset">再上傳一個</button>
        </div>

        <div v-else class="upload-modal__result">
          <p>已選擇檔案:<strong>{{ chosenFile?.name }}</strong></p>
          <p v-if="uploadError" class="upload-modal__error">{{ uploadError }}</p>
          <div class="upload-modal__actions">
            <button class="upload-modal__back" type="button" :disabled="uploading" @click="reset">重新選擇</button>
            <button class="upload-modal__confirm" type="button" :disabled="uploading" @click="confirmUpload">
              {{ uploading ? '上傳中…' : '確認上傳' }}
            </button>
          </div>
        </div>

        <input
          ref="fileInputRef"
          type="file"
          class="upload-modal__file-input"
          :accept="chosenKind ? KIND_ACCEPT[chosenKind] : undefined"
          @change="onFileChosen"
        />
      </div>
    </div>
  </Transition>
  <GSplatViewer
    v-if="captureItem"
    :key="captureItem.id"
    ref="captureViewerRef"
    :src="captureItem.url"
    :ids="[captureItem.id]"
    :data-rotations="[captureItem.dataRotation]"
    class="upload-modal__capture"
    @loaded="onCaptureLoaded"
    @error="() => (captureItem = null)"
  />
</template>

<style scoped>
.upload-fade-enter-active,
.upload-fade-leave-active {
  transition: opacity 0.2s ease;
}

.upload-fade-enter-from,
.upload-fade-leave-to {
  opacity: 0;
}

.upload-backdrop {
  position: fixed;
  inset: 0;
  z-index: 10;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.5rem;
}

.upload-modal {
  position: relative;
  width: min(100%, 26rem);
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
  background: var(--color-paper);
  border: 1px solid var(--color-line);
  border-radius: var(--radius);
  padding: 2rem;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.18);
}

.upload-modal h1 {
  font-size: 1.35rem;
  color: var(--color-ink);
}

.upload-modal__close {
  position: absolute;
  top: 0.9rem;
  right: 0.9rem;
  width: 2rem;
  height: 2rem;
  border: none;
  border-radius: 50%;
  background: var(--color-surface-2);
  color: var(--color-ink-soft);
  line-height: 1;
}

.upload-modal__hint {
  margin: 0;
  font-size: 0.85rem;
  color: var(--color-ink-soft);
  line-height: 1.6;
}

.upload-modal__choices {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.upload-modal__choice {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  text-align: left;
  border: 1px solid var(--color-line);
  border-radius: calc(var(--radius) * 0.7);
  padding: 0.9rem 1.1rem;
  background: var(--color-surface);
}

.upload-modal__choice:hover {
  border-color: var(--color-sage);
  background: var(--color-surface-2);
}

.upload-modal__choice-title {
  font-size: 1rem;
  font-weight: 700;
  color: var(--color-ink);
}

.upload-modal__choice-desc {
  font-size: 0.8rem;
  color: var(--color-ink-soft);
}

.upload-modal__result {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.upload-modal__result p {
  margin: 0;
  color: var(--color-ink);
  font-size: 0.9rem;
}

.upload-modal__back {
  align-self: flex-start;
  border: none;
  padding: 0.55em 1.2em;
  border-radius: calc(var(--radius) * 0.6);
  background: var(--color-surface-2);
  color: var(--color-ink);
  font-weight: 700;
}

.upload-modal__actions {
  display: flex;
  gap: 0.6rem;
}

.upload-modal__confirm {
  align-self: flex-start;
  border: none;
  padding: 0.55em 1.2em;
  border-radius: calc(var(--radius) * 0.6);
  background: var(--color-clay);
  color: var(--color-ink);
  font-weight: 700;
}

.upload-modal__confirm:disabled,
.upload-modal__back:disabled {
  opacity: 0.6;
}

.upload-modal__error {
  margin: 0;
  font-size: 0.8rem;
  color: #b3413a;
}

.upload-modal__file-input {
  display: none;
}

.upload-modal__capture {
  position: fixed;
  top: 0;
  left: -9999px;
  width: 512px;
  height: 384px;
  pointer-events: none;
}
</style>
