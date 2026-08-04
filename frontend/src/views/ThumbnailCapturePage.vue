<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import GSplatViewer from '../components/GSplatViewer.vue'
import type { Vec3 } from '../stores/sceneObjects'

interface CapturePayload {
  src: string[]
  transforms?: ({ position: Vec3; rotation: Vec3; scale: Vec3 } | null)[]
  dataRotations?: (Vec3 | null)[]
  colors?: (string | null)[]
}

const payload = ref<CapturePayload | null>(null)
const parseError = ref('')
const resultDataUrl = ref('')

function parsePayload(): CapturePayload | null {
  const raw = new URLSearchParams(window.location.search).get('payload')
  if (!raw) return null
  try {
    return JSON.parse(decodeURIComponent(raw)) as CapturePayload
  } catch {
    return null
  }
}

onMounted(() => {
  payload.value = parsePayload()
  if (!payload.value) {
    parseError.value = '缺少或無法解析 payload query 參數'
    document.title = 'CAPTURE_ERROR:' + parseError.value
  }
})

const viewerSrc = computed(() => payload.value?.src ?? [])
const viewerRef = ref<InstanceType<typeof GSplatViewer> | null>(null)

async function onLoaded() {
  const blob = await viewerRef.value?.captureThumbnail().catch((err) => {
    parseError.value = err instanceof Error ? err.message : String(err)
    return null
  })
  if (!blob) {
    document.title = 'CAPTURE_ERROR:' + (parseError.value || '截圖失敗(可能是包圍盒算不出來)')
    return
  }
  const reader = new FileReader()
  reader.onload = () => {
    resultDataUrl.value = String(reader.result)
    document.title = 'CAPTURE_READY'
  }
  reader.onerror = () => {
    document.title = 'CAPTURE_ERROR:讀取截圖 blob 失敗'
  }
  reader.readAsDataURL(blob)
}

function onError(message: string) {
  document.title = 'CAPTURE_ERROR:' + message
}
</script>

<template>
  <div class="capture-page">
    <div v-if="payload" class="capture-page__viewer">
      <GSplatViewer
        ref="viewerRef"
        :src="viewerSrc"
        :transforms="payload.transforms"
        :data-rotations="payload.dataRotations"
        :colors="payload.colors"
        @loaded="onLoaded"
        @error="onError"
      />
    </div>
    <div id="capture-result" :data-image="resultDataUrl" />
  </div>
</template>

<style scoped>
.capture-page {
  width: 512px;
  height: 384px;
}
.capture-page__viewer {
  width: 100%;
  height: 100%;
}
</style>
