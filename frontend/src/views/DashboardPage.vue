<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useLibraryStore, PLACEHOLDER_THUMBNAIL, type LibraryItem } from '../stores/library'
import { useSceneObjectsStore } from '../stores/sceneObjects'
import { API_ORIGIN } from '../lib/api'
import ModelCard from '../components/ModelCard.vue'
import PreviewModal from '../components/PreviewModal.vue'
import UploadModal from '../components/UploadModal.vue'
import { DEV_SCENE_ID, devSceneActive, deactivateDevScene } from '../components/DevSceneCard.vue'
import iconGenerate from '../assets/icons/icon-generate.svg?raw'
import iconLibrary from '../assets/icons/icon-library.svg?raw'

const router = useRouter()
const library = useLibraryStore()
const sceneObjects = useSceneObjectsStore()

watch(devSceneActive, (active) => {
  if (!active) return
  const BG_ID = 'dev-australia-bg'
  const PLY_URL = `${API_ORIGIN}/storage/models/dev/point_cloud.ply`
  if (!library.objects.find((o) => o.id === BG_ID)) {
    library.objects.push({
      id: BG_ID, name: '背景', thumbnail: PLACEHOLDER_THUMBNAIL,
      createdAt: new Date(), status: 'ready',
      description: 'australia point_cloud.ply', modelUrl: PLY_URL,
    })
  }
  if (!sceneObjects.instances.find((i) => i.sceneId === DEV_SCENE_ID)) {
    sceneObjects.instances.push({
      id: 'dev-australia-bg-inst', sceneId: DEV_SCENE_ID, modelId: BG_ID,
      label: '背景', hidden: false,
      position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], color: null,
    })
    sceneObjects.loadedSceneIds.add(DEV_SCENE_ID)
  }
}, { immediate: true })

onMounted(() => {
  if (!library.scenesLoaded) library.fetchScenes()
  if (!library.objectsLoaded) library.fetchObjects()
})
const activeSection = ref<'mine' | 'catalog'>('mine')
watch(activeSection, (section) => {
  if (section !== 'catalog') return
  if (!library.catalogObjectsLoaded) library.fetchCatalogObjects()
})

const activeTab = ref<'scenes' | 'objects'>('scenes')
const effectiveTab = computed<'scenes' | 'objects'>(() => (activeSection.value === 'catalog' ? 'objects' : activeTab.value))
const DEV_SCENE_ITEM: LibraryItem = {
  id: DEV_SCENE_ID,
  name: '澳洲',
  thumbnail: '/dev-australia-thumb.png',
  createdAt: new Date(),
  status: 'ready',
  description: 'australia point_cloud.ply 開發用場景。',
}
const rawItems = computed<LibraryItem[]>(() => {
  if (activeSection.value === 'mine') {
    const base = effectiveTab.value === 'scenes' ? library.scenes : library.objects
    const filtered = effectiveTab.value === 'scenes' ? base.filter((i) => i.id !== DEV_SCENE_ID) : base
    if (devSceneActive.value && effectiveTab.value === 'scenes') return [DEV_SCENE_ITEM, ...filtered]
    return filtered
  }
  return library.catalogObjects
})
const searchQuery = ref('')
const items = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return rawItems.value
  return rawItems.value.filter((item) => item.name.toLowerCase().includes(q))
})
const loaded = computed(() => {
  if (activeSection.value === 'mine') return effectiveTab.value === 'scenes' ? library.scenesLoaded : library.objectsLoaded
  return library.catalogObjectsLoaded
})

const selected = ref<LibraryItem | null>(null)
const copyFeedback = ref('')

function openItem(item: LibraryItem) {
  copyFeedback.value = ''
  selected.value = item
}
function closePreview() {
  selected.value = null
}

async function copyToMyLibrary() {
  if (!selected.value) return
  const item = selected.value
  try {
    await library.copyObjectToMyLibrary(item.id)
    copyFeedback.value = `已加入我的模型庫:${item.name}`
    selected.value = null
  } catch (err) {
    copyFeedback.value = err instanceof Error ? `加入失敗:${err.message}` : '加入失敗'
  }
}

const uploadModalOpen = ref(false)
onBeforeUnmount(deactivateDevScene)
</script>

<template>
  <div class="dashboard">
    <aside class="sidebar">
      <button class="sidebar__nav-item sidebar__nav-item--accent" type="button" @click="router.push('/scenes/new')">
        <span class="sidebar__icon" v-html="iconGenerate" />
        生成模型
      </button>

      <button
        class="sidebar__nav-item"
        :class="{ 'sidebar__nav-item--active': activeSection === 'mine' }"
        type="button"
        @click="activeSection = 'mine'"
      >
        <span class="sidebar__icon" v-html="iconLibrary" />
        我的模型庫
      </button>

      <button
        class="sidebar__nav-item"
        :class="{ 'sidebar__nav-item--active': activeSection === 'catalog' }"
        type="button"
        @click="activeSection = 'catalog'"
      >
        <span class="sidebar__icon" v-html="iconLibrary" />
        線上資產庫
      </button>

    </aside>

    <main class="content">
      <p v-if="copyFeedback" class="content__feedback">{{ copyFeedback }}</p>

      <div class="content__tabs">
        <template v-if="activeSection === 'mine'">
          <button
            class="content__tab"
            :class="{ 'content__tab--active': activeTab === 'scenes' }"
            type="button"
            @click="activeTab = 'scenes'"
          >
            場景
          </button>
          <button
            class="content__tab"
            :class="{ 'content__tab--active': activeTab === 'objects' }"
            type="button"
            @click="activeTab = 'objects'"
          >
            模型元件
          </button>
        </template>
        <span v-else class="content__tab content__tab--active content__tab--static">模型元件</span>
        <input v-model="searchQuery" class="content__search" type="text" placeholder="搜尋名稱…" />
        <button v-if="activeSection === 'mine'" class="content__upload-btn" type="button" @click="uploadModalOpen = true">
          上傳場景 / 模型
        </button>
      </div>

      <p v-if="!loaded" class="content__loading">載入中…</p>
      <p v-else-if="rawItems.length === 0 && activeSection === 'mine'" class="content__loading">
        還沒有任何{{ effectiveTab === 'scenes' ? '場景' : '模型元件' }}——可以從「線上資產庫」加入,或按右上角上傳。
      </p>
      <p v-else-if="rawItems.length === 0" class="content__loading">線上資產庫目前還沒有任何資產。</p>
      <p v-else-if="items.length === 0" class="content__loading">沒有符合「{{ searchQuery }}」的項目。</p>
      <div v-else class="content__grid">
        <ModelCard v-for="item in items" :key="item.id" :item="item" @open="openItem(item)" />
      </div>
    </main>

    <PreviewModal
      v-if="selected"
      :item="selected"
      :kind="effectiveTab === 'scenes' ? 'scene' : 'object'"
      :allow-copy-to-library="activeSection === 'catalog'"
      @close="closePreview"
      @copy-to-library="copyToMyLibrary"
    />
    <UploadModal :open="uploadModalOpen" @close="uploadModalOpen = false" />
  </div>
</template>

<style scoped>
.dashboard {
  min-height: 100vh;
  display: flex;
  background: var(--color-paper);
}

.sidebar {
  width: clamp(14rem, 18vw, 18rem);
  flex-shrink: 0;
  background: var(--color-surface);
  border-right: 1px solid var(--color-line);
  padding: 1.5rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.sidebar__nav-item {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  text-align: left;
  border: none;
  background: transparent;
  padding: 0.7rem 0.85rem;
  border-radius: var(--radius);
  color: var(--color-ink-soft);
  font-size: 0.95rem;
  font-weight: 700;
}

.sidebar__nav-item--accent {
  color: var(--color-ink);
  background: var(--color-clay);
}

.sidebar__nav-item--active {
  background: var(--color-surface-2);
  color: var(--color-pine);
}

.sidebar__icon {
  display: inline-flex;
  width: 1.15rem;
  height: 1.15rem;
  flex-shrink: 0;
}

.sidebar__icon :deep(svg) {
  width: 100%;
  height: 100%;
}

.content {
  flex: 1;
  min-width: 0;
  background: var(--color-paper);
  padding: clamp(1.25rem, 3vw, 2.5rem);
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.content__feedback {
  margin: 0;
  padding: 0.6rem 0.9rem;
  border-radius: calc(var(--radius) * 0.6);
  background: var(--color-surface-2);
  color: var(--color-pine);
  font-size: 0.85rem;
  font-weight: 700;
}

.content__tabs {
  display: flex;
  gap: 0.5rem;
  border-bottom: 1px solid var(--color-line);
}

.content__tab {
  border: none;
  background: transparent;
  padding: 0.6rem 0.25rem;
  margin-bottom: -1px;
  border-bottom: 2px solid transparent;
  font-size: 1rem;
  font-weight: 700;
  color: var(--color-ink-soft);
}

.content__tab--active {
  color: var(--color-pine);
  border-bottom-color: var(--color-pine);
}

.content__tab--static {
  cursor: default;
}

.content__search {
  margin-left: auto;
  margin-bottom: 0.4rem;
  align-self: center;
  width: clamp(10rem, 18vw, 16rem);
  border: 1px solid var(--color-line);
  border-radius: calc(var(--radius) * 0.6);
  padding: 0.5rem 0.85rem;
  background: var(--color-surface);
  color: var(--color-ink);
  font-size: 0.85rem;
}

.content__upload-btn {
  margin-bottom: 0.4rem;
  align-self: center;
  border: 1px solid var(--color-line);
  border-radius: calc(var(--radius) * 0.6);
  padding: 0.5rem 1rem;
  background: var(--color-surface);
  color: var(--color-ink);
  font-size: 0.85rem;
  font-weight: 700;
}

.content__upload-btn:hover {
  background: var(--color-surface-2);
  border-color: var(--color-sage);
}

.content__loading {
  color: var(--color-ink-soft);
  font-size: 0.9rem;
}

.content__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
  gap: 1.25rem;
}
</style>
