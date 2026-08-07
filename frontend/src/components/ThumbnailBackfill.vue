<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { useLibraryStore, PLACEHOLDER_THUMBNAIL, upAxisFixFor, type Vec3 } from '../stores/library'
import { useSceneObjectsStore } from '../stores/sceneObjects'
import GSplatViewer from './GSplatViewer.vue'

const library = useLibraryStore()
const sceneObjectsStore = useSceneObjectsStore()

interface QueueItem {
  kind: 'scene' | 'object'
  id: string
  src: string[]
  ids: (string | null)[]
  transforms?: ({ position: Vec3; rotation: Vec3; scale: Vec3 } | null)[]
  dataRotations: (Vec3 | null)[]
}

const props = defineProps<{ paused?: boolean }>()

const queue = ref<QueueItem[]>([])
const currentIndex = ref(-1)
const currentItem = computed(() => (currentIndex.value >= 0 ? queue.value[currentIndex.value] : null))
const viewerRef = ref<InstanceType<typeof GSplatViewer> | null>(null)
let resolveCurrent: (() => void) | null = null

async function buildQueue() {
  if (!library.scenesLoaded) await library.fetchScenes()
  if (!library.objectsLoaded) await library.fetchObjects()
  if (!library.catalogScenesLoaded) await library.fetchCatalogScenes()
  if (!library.catalogObjectsLoaded) await library.fetchCatalogObjects()

  const scenesById = new Map<string, (typeof library.scenes)[number]>()
  for (const scene of [...library.catalogScenes, ...library.scenes]) scenesById.set(scene.id, scene)
  const objectsById = new Map<string, (typeof library.objects)[number]>()
  for (const obj of [...library.catalogObjects, ...library.objects]) objectsById.set(obj.id, obj)

  const items: QueueItem[] = []
  for (const scene of scenesById.values()) {
    if (scene.thumbnail !== PLACEHOLDER_THUMBNAIL) continue
    await sceneObjectsStore.fetchInstancesForScene(scene.id)
    const instances = sceneObjectsStore.instancesForScene(scene.id)
    if (instances.length === 0) continue
    const urls = sceneObjectsStore.sceneModelUrls(scene.id)
    items.push({
      kind: 'scene',
      id: scene.id,
      src: urls,
      ids: instances.map((i) => i.id),
      transforms: instances.map((i) => ({ position: i.position, rotation: i.rotation, scale: i.scale })),
      dataRotations: instances.map((i, idx) => upAxisFixFor(i.modelId, urls[idx])),
    })
  }
  for (const obj of objectsById.values()) {
    if (!obj.modelUrl || obj.thumbnail !== PLACEHOLDER_THUMBNAIL) continue
    items.push({
      kind: 'object',
      id: obj.id,
      src: [obj.modelUrl],
      ids: [obj.id],
      dataRotations: [upAxisFixFor(obj.id, obj.modelUrl)],
    })
  }
  queue.value = items
}

async function onViewerLoaded() {
  const item = currentItem.value
  if (!item) return
  const blob = await viewerRef.value?.captureThumbnail().catch(() => null)
  if (blob) await library.saveThumbnail(item.kind, item.id, blob).catch(() => {})
  resolveCurrent?.()
  resolveCurrent = null
}
function onViewerError() {
  resolveCurrent?.()
  resolveCurrent = null
}

onMounted(async () => {
  await buildQueue()
  for (let i = 0; i < queue.value.length; i++) {
    while (props.paused) await new Promise((resolve) => setTimeout(resolve, 300))
    currentIndex.value = i
    await nextTick()
    await new Promise<void>((resolve) => { resolveCurrent = resolve })
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  currentIndex.value = -1
})
</script>

<template>
  <div class="thumbnail-backfill" aria-hidden="true">
    <GSplatViewer
      v-if="currentItem"
      :key="currentItem.id"
      ref="viewerRef"
      :src="currentItem.src"
      :ids="currentItem.ids"
      :transforms="currentItem.transforms"
      :data-rotations="currentItem.dataRotations"
      @loaded="onViewerLoaded"
      @error="onViewerError"
    />
  </div>
</template>

<style scoped>
.thumbnail-backfill {
  position: fixed;
  top: 0;
  left: -9999px;
  width: 512px;
  height: 384px;
  pointer-events: none;
}
</style>
