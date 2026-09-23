<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { activateDevScene } from '../components/DevSceneCard.vue'

const router = useRouter()

const step = ref<1 | 2 | 3 | 4>(1)

type QueueItem = { id: string; name: string; locationType: string; stageIdx: number; stageProgress: number; etaLabel: string }
const MOCK_QUEUE: QueueItem[] = [
  { id: 'q1', name: '客廳', locationType: '客廳', stageIdx: 2, stageProgress: 67, etaLabel: '約 4 分鐘' },
  { id: 'q2', name: '臥室', locationType: '臥室', stageIdx: 0, stageProgress: 34, etaLabel: '約 12 分鐘' },
  { id: 'q3', name: '浴室', locationType: '浴室', stageIdx: -1, stageProgress: 0, etaLabel: '等待中' },
]
const selectedQueue = ref<QueueItem | null>(null)

const sceneName = ref('')
const locationType = ref('客廳')
const description = ref('')

const files = ref<File[]>([])
const dropActive = ref(false)

const LOCATION_TYPES = ['客廳', '臥室', '浴室', '廚房', '走廊', '全宅']

function onDrop(e: DragEvent) {
  dropActive.value = false
  const dropped = Array.from(e.dataTransfer?.files ?? [])
  files.value = [...files.value, ...dropped].slice(0, 12)
}

function onFileInput(e: Event) {
  const picked = Array.from((e.target as HTMLInputElement).files ?? [])
  files.value = [...files.value, ...picked].slice(0, 12)
}

function removeFile(i: number) {
  files.value = files.value.filter((_, idx) => idx !== i)
}

function fmtBytes(n: number) {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

const STAGES = [
  { label: '影像預處理', detail: 'COLMAP 特徵提取中…' },
  { label: '相機姿態估算', detail: '計算攝影機位置與朝向…' },
  { label: '高斯點雲訓練', detail: '3D Gaussian Splatting 訓練中…' },
  { label: '模型壓縮輸出', detail: '壓縮並匯出場景…' },
]
const stageIdx = ref(0)
const stageProgress = ref(0)
let stageTimer: ReturnType<typeof setInterval> | null = null

function startBuild() {
  step.value = 3
  stageIdx.value = 0
  stageProgress.value = 0
  runStage()
}

function runStage() {
  stageProgress.value = 0
  stageTimer = setInterval(() => {
    stageProgress.value += Math.random() * 4 + 1
    if (stageProgress.value >= 100) {
      stageProgress.value = 100
      clearInterval(stageTimer!)
      setTimeout(() => {
        if (stageIdx.value < STAGES.length - 1) {
          stageIdx.value++
          runStage()
        } else {
          step.value = 4
          activateDevScene()
        }
      }, 350)
    }
  }, 80)
}

const etaLabel = computed(() => {
  const remaining = STAGES.length - stageIdx.value - stageProgress.value / 100
  const mins = Math.max(1, Math.round(remaining * 2.5))
  return `約 ${mins} 分鐘`
})

const DEMO_SCENE_ID = 'scene-interiorgs839920'

function goEdit() {
  router.push(`/scenes/${DEMO_SCENE_ID}/edit`)
}
</script>

<template>
  <div class="new-scene">
    <button class="new-scene__back" type="button" @click="router.push('/dashboard')">
      ← 返回工作站
    </button>

    <div class="new-scene__body">

    <div class="new-scene__card">

      <!-- 步驟指示器 -->
      <div class="steps">
        <template v-for="n in 4" :key="n">
          <div
            class="steps__dot"
            :class="{
              'steps__dot--done': step > n,
              'steps__dot--active': step === n,
            }"
          >
            <svg v-if="step > n" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
            <span v-else>{{ n }}</span>
          </div>
          <div v-if="n < 4" class="steps__line" :class="{ 'steps__line--done': step > n }" />
        </template>
      </div>

      <!-- Step 1：基本資料 -->
      <template v-if="step === 1">
        <h2 class="new-scene__title">場景基本資料</h2>
        <p class="new-scene__sub">為這個空間建立一個 3D 高斯場景以進行無障礙評估</p>

        <div class="form__field">
          <label class="form__label">場景名稱 <span class="form__req">*</span></label>
          <input v-model="sceneName" class="form__input" type="text" placeholder="例：王奶奶的客廳" maxlength="40" />
        </div>

        <div class="form__field">
          <label class="form__label">空間類型</label>
          <div class="form__chips">
            <button
              v-for="t in LOCATION_TYPES"
              :key="t"
              class="form__chip"
              :class="{ 'form__chip--active': locationType === t }"
              type="button"
              @click="locationType = t"
            >{{ t }}</button>
          </div>
        </div>

        <div class="form__field">
          <label class="form__label">備註說明<span class="form__opt">（選填）</span></label>
          <textarea v-model="description" class="form__textarea" rows="3" placeholder="例：長者獨居，行動需輔助器具" maxlength="200" />
        </div>

        <div class="new-scene__actions">
          <button
            class="btn btn--primary"
            type="button"
            :disabled="!sceneName.trim()"
            @click="step = 2"
          >下一步</button>
        </div>
      </template>

      <!-- Step 2：上傳素材 -->
      <template v-else-if="step === 2">
        <h2 class="new-scene__title">上傳空間素材</h2>
        <p class="new-scene__sub">請上傳拍攝空間的影片或照片，建議環繞拍攝所有角落</p>

        <div
          class="dropzone"
          :class="{ 'dropzone--active': dropActive }"
          @dragenter.prevent="dropActive = true"
          @dragover.prevent="dropActive = true"
          @dragleave.prevent="dropActive = false"
          @drop.prevent="onDrop"
          @click="($refs.fileInput as HTMLInputElement).click()"
        >
          <input ref="fileInput" type="file" multiple accept="video/*,.jpg,.jpeg,.png,.heic" style="display:none" @change="onFileInput" />
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color:var(--color-ink-soft)">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          <p class="dropzone__text">拖曳影片或照片至此，或點擊選取</p>
          <p class="dropzone__hint">支援 .mp4 .mov .jpg .png .heic，最多 12 個檔案</p>
        </div>

        <ul v-if="files.length" class="file-list">
          <li v-for="(f, i) in files" :key="i" class="file-list__item">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;color:var(--color-sage)">
              <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/>
              <polyline points="13 2 13 9 20 9"/>
            </svg>
            <span class="file-list__name">{{ f.name }}</span>
            <span class="file-list__size">{{ fmtBytes(f.size) }}</span>
            <button class="file-list__remove" type="button" @click.stop="removeFile(i)">×</button>
          </li>
        </ul>

        <div class="tip">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;margin-top:2px">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <p>建議錄製 1–3 分鐘環繞影片，慢速移動，保持穩定光源。影片品質直接影響 3DGS 建場精度。</p>
        </div>

        <div class="new-scene__actions new-scene__actions--row">
          <button class="btn btn--ghost" type="button" @click="step = 1">返回</button>
          <button
            class="btn btn--primary"
            type="button"
            :disabled="!files.length"
            @click="startBuild"
          >開始建場</button>
        </div>
      </template>

      <!-- Step 3：建場中 -->
      <template v-else-if="step === 3">
        <h2 class="new-scene__title">建場處理中</h2>
        <p class="new-scene__sub">預計剩餘時間：{{ etaLabel }}，請勿關閉頁面</p>

        <div class="build-stages">
          <div
            v-for="(s, i) in STAGES"
            :key="i"
            class="build-stage"
            :class="{
              'build-stage--done': i < stageIdx,
              'build-stage--active': i === stageIdx,
              'build-stage--pending': i > stageIdx,
            }"
          >
            <div class="build-stage__icon">
              <svg v-if="i < stageIdx" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              <svg v-else-if="i === stageIdx" class="spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                <path d="M12 2a10 10 0 0 1 10 10"/>
              </svg>
              <span v-else class="build-stage__num">{{ i + 1 }}</span>
            </div>
            <div class="build-stage__body">
              <p class="build-stage__label">{{ s.label }}</p>
              <p v-if="i === stageIdx" class="build-stage__detail">{{ s.detail }}</p>
              <div v-if="i === stageIdx" class="build-stage__bar">
                <div class="build-stage__fill" :style="{ width: stageProgress + '%' }" />
              </div>
            </div>
          </div>
        </div>
      </template>

      <!-- Step 4：完成 -->
      <template v-else>
        <div class="done">
          <div class="done__icon">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </div>
          <h2 class="new-scene__title">場景建立完成！</h2>
          <p class="new-scene__sub">「{{ sceneName || '未命名場景' }}」已成功生成，可進入編輯器進行無障礙評估</p>

          <div class="done__meta">
            <div class="done__meta-row">
              <span class="done__meta-key">空間類型</span>
              <span>{{ locationType }}</span>
            </div>
            <div class="done__meta-row">
              <span class="done__meta-key">素材數量</span>
              <span>{{ files.length }} 個檔案</span>
            </div>
            <div class="done__meta-row">
              <span class="done__meta-key">建場時間</span>
              <span>約 8 分 42 秒</span>
            </div>
          </div>

          <div class="new-scene__actions new-scene__actions--row">
            <button class="btn btn--ghost" type="button" @click="router.push('/dashboard')">返回工作站</button>
            <button class="btn btn--primary" type="button" @click="goEdit">前往編輯</button>
          </div>
        </div>
      </template>

    </div>

    <!-- 右側等待佇列 -->
    <aside v-if="!selectedQueue" class="new-scene__queue">
      <p class="queue__title">等待佇列</p>
      <ul class="queue__list">
        <li
          v-for="item in MOCK_QUEUE"
          :key="item.id"
          class="queue__item"
          @click="selectedQueue = item"
        >
          <div class="queue__item-top">
            <span class="queue__item-name">{{ item.name }}</span>
            <span class="queue__item-type">{{ item.locationType }}</span>
          </div>
          <div v-if="item.stageIdx >= 0" class="queue__item-stage">
            <span class="queue__stage-dot queue__stage-dot--active" />
            <span class="queue__item-stage-label">{{ STAGES[item.stageIdx].label }}</span>
          </div>
          <div v-else class="queue__item-stage">
            <span class="queue__stage-dot" />
            <span class="queue__item-stage-label queue__item-stage-label--wait">等待中</span>
          </div>
          <div v-if="item.stageIdx >= 0" class="queue__progress-bar">
            <div class="queue__progress-fill" :style="{ width: item.stageProgress + '%' }" />
          </div>
          <span class="queue__item-eta">{{ item.etaLabel }}</span>
        </li>
      </ul>
    </aside>

    <!-- 選中佇列項目：顯示第三步驟 -->
    <div v-else class="new-scene__card">
      <button class="queue-back" type="button" @click="selectedQueue = null">← 返回佇列</button>
      <h2 class="new-scene__title">{{ selectedQueue.name }}</h2>
      <p class="new-scene__sub">建場處理中，預計剩餘時間：{{ selectedQueue.etaLabel }}</p>
      <div class="build-stages">
        <div
          v-for="(s, i) in STAGES"
          :key="i"
          class="build-stage"
          :class="{
            'build-stage--done': selectedQueue.stageIdx >= 0 && i < selectedQueue.stageIdx,
            'build-stage--active': selectedQueue.stageIdx >= 0 && i === selectedQueue.stageIdx,
            'build-stage--pending': selectedQueue.stageIdx < 0 || i > selectedQueue.stageIdx,
          }"
        >
          <div class="build-stage__icon">
            <svg v-if="selectedQueue.stageIdx >= 0 && i < selectedQueue.stageIdx" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            <svg v-else-if="selectedQueue.stageIdx >= 0 && i === selectedQueue.stageIdx" class="spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 2a10 10 0 0 1 10 10"/></svg>
            <span v-else class="build-stage__num">{{ i + 1 }}</span>
          </div>
          <div class="build-stage__body">
            <p class="build-stage__label">{{ s.label }}</p>
            <p v-if="selectedQueue.stageIdx >= 0 && i === selectedQueue.stageIdx" class="build-stage__detail">{{ s.detail }}</p>
            <div v-if="selectedQueue.stageIdx >= 0 && i === selectedQueue.stageIdx" class="build-stage__bar">
              <div class="build-stage__fill" :style="{ width: selectedQueue.stageProgress + '%' }" />
            </div>
          </div>
        </div>
      </div>
    </div>

    </div><!-- /.new-scene__body -->
  </div>
</template>

<style scoped>
.new-scene {
  min-height: 100vh;
  background: var(--color-paper);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 2rem 1rem 4rem;
}

.new-scene__body {
  display: flex;
  gap: 1.5rem;
  width: 100%;
  max-width: 900px;
  align-items: flex-start;
}

.new-scene__queue {
  width: 220px;
  flex-shrink: 0;
  background: var(--color-surface);
  border: 1px solid var(--color-line);
  border-radius: var(--radius);
  padding: 1.25rem 1rem;
}

.queue__title {
  margin: 0 0 0.85rem;
  font-size: 0.82rem;
  font-weight: 700;
  color: var(--color-ink-soft);
  letter-spacing: 0.03em;
}

.queue__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.queue__item {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  padding: 0.65rem 0.75rem;
  border-radius: calc(var(--radius) * 0.6);
  border: 1px solid var(--color-line);
  background: var(--color-surface-2, rgba(0,0,0,0.03));
  cursor: pointer;
  transition: border-color 0.15s;
}
.queue__item:hover { border-color: var(--color-sage); }

.queue__item-top {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 0.3rem;
}
.queue__item-name { font-size: 0.82rem; font-weight: 600; color: var(--color-ink); }
.queue__item-type { font-size: 0.7rem; color: var(--color-ink-soft); flex-shrink: 0; }

.queue__item-stage {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}
.queue__stage-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-line);
  flex-shrink: 0;
}
.queue__stage-dot--active { background: var(--color-pine); }

.queue__item-stage-label {
  font-size: 0.72rem;
  color: var(--color-ink-soft);
}
.queue__item-stage-label--wait { color: var(--color-ink-soft); opacity: 0.6; }

.queue__progress-bar {
  height: 3px;
  background: var(--color-line);
  border-radius: 2px;
  overflow: hidden;
}
.queue__progress-fill {
  height: 100%;
  background: var(--color-pine);
  border-radius: 2px;
}

.queue__item-eta { font-size: 0.68rem; color: var(--color-ink-soft); }

.queue-back {
  background: transparent;
  border: none;
  color: var(--color-ink-soft);
  font-size: 0.82rem;
  font-weight: 700;
  padding: 0.2rem 0;
  cursor: pointer;
  margin-bottom: 0.5rem;
}
.queue-back:hover { color: var(--color-ink); }

.new-scene__back {
  align-self: flex-start;
  background: transparent;
  border: none;
  color: var(--color-ink-soft);
  font-size: 0.88rem;
  font-weight: 700;
  padding: 0.4rem 0.6rem;
  border-radius: calc(var(--radius) * 0.5);
  margin-bottom: 1.5rem;
}
.new-scene__back:hover { background: var(--color-surface-2); }

.new-scene__card {
  background: var(--color-surface);
  border-radius: var(--radius);
  border: 1px solid var(--color-line);
  padding: 2.5rem 2.25rem;
  width: 100%;
  flex: 1;
  min-width: 0;
}

.new-scene__title {
  font-family: var(--serif);
  font-size: 1.35rem;
  color: var(--color-pine);
  margin-top: 1.5rem;
  margin-bottom: 0.35rem;
}

.new-scene__sub {
  margin: 0 0 1.5rem;
  font-size: 0.85rem;
  color: var(--color-ink-soft);
}

.new-scene__actions {
  margin-top: 1.75rem;
  display: flex;
  justify-content: flex-end;
}
.new-scene__actions--row { gap: 0.75rem; }

/* 步驟指示 */
.steps {
  display: flex;
  align-items: center;
  gap: 0;
}
.steps__dot {
  width: 2rem;
  height: 2rem;
  border-radius: 50%;
  border: 2px solid var(--color-line);
  background: var(--color-surface);
  color: var(--color-ink-soft);
  font-size: 0.78rem;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: all 0.2s;
}
.steps__dot--active {
  border-color: var(--color-pine);
  background: var(--color-pine);
  color: #fff;
}
.steps__dot--done {
  border-color: var(--color-sage);
  background: var(--color-sage);
  color: #fff;
}
.steps__line {
  flex: 1;
  height: 2px;
  background: var(--color-line);
  transition: background 0.3s;
}
.steps__line--done { background: var(--color-sage); }

/* 表單 */
.form__field { margin-bottom: 1.25rem; }
.form__label { display: block; font-size: 0.82rem; font-weight: 600; margin-bottom: 0.4rem; }
.form__req { color: var(--color-clay); margin-left: 2px; }
.form__opt { font-weight: 400; color: var(--color-ink-soft); font-size: 0.78rem; margin-left: 0.25rem; }
.form__input, .form__textarea {
  width: 100%;
  border: 1px solid var(--color-line);
  border-radius: calc(var(--radius) * 0.6);
  padding: 0.5rem 0.75rem;
  font-family: inherit;
  font-size: 0.9rem;
  background: var(--color-surface);
  color: var(--color-ink);
  outline: none;
  resize: vertical;
}
.form__input:focus, .form__textarea:focus { border-color: var(--color-sage); }

.form__chips { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.form__chip {
  background: var(--color-surface-2);
  border: 1px solid var(--color-line);
  border-radius: 2rem;
  padding: 0.25rem 0.75rem;
  font-size: 0.82rem;
  color: var(--color-ink-soft);
  transition: all 0.15s;
}
.form__chip--active {
  background: var(--color-pine);
  border-color: var(--color-pine);
  color: #fff;
}

/* 拖曳區 */
.dropzone {
  border: 2px dashed var(--color-line);
  border-radius: var(--radius);
  padding: 2rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.dropzone:hover, .dropzone--active {
  border-color: var(--color-sage);
  background: var(--color-surface-2);
}
.dropzone__text { margin: 0; font-size: 0.88rem; font-weight: 600; }
.dropzone__hint { margin: 0; font-size: 0.75rem; color: var(--color-ink-soft); }

/* 檔案清單 */
.file-list {
  list-style: none;
  margin: 0.75rem 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  max-height: 160px;
  overflow-y: auto;
}
.file-list__item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8rem;
  padding: 0.3rem 0.5rem;
  background: var(--color-surface-2);
  border-radius: calc(var(--radius) * 0.4);
}
.file-list__name { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.file-list__size { color: var(--color-ink-soft); flex-shrink: 0; }
.file-list__remove {
  background: transparent;
  border: none;
  color: var(--color-ink-soft);
  font-size: 1rem;
  line-height: 1;
  padding: 0 0.15rem;
  cursor: pointer;
}
.file-list__remove:hover { color: var(--color-clay); }

/* 提示 */
.tip {
  display: flex;
  gap: 0.5rem;
  background: var(--color-surface-2);
  border-radius: calc(var(--radius) * 0.6);
  padding: 0.65rem 0.75rem;
  margin-top: 0.75rem;
  font-size: 0.78rem;
  color: var(--color-ink-soft);
  line-height: 1.5;
}
.tip p { margin: 0; }

/* 建場進度 */
.build-stages {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  margin-top: 0.5rem;
}
.build-stage {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  opacity: 0.4;
  transition: opacity 0.3s;
}
.build-stage--active, .build-stage--done { opacity: 1; }
.build-stage__icon {
  width: 1.75rem;
  height: 1.75rem;
  border-radius: 50%;
  background: var(--color-surface-2);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: 0.72rem;
  font-weight: 700;
  color: var(--color-ink-soft);
}
.build-stage--done .build-stage__icon { background: var(--color-sage); color: #fff; }
.build-stage--active .build-stage__icon { background: var(--color-pine); color: #fff; }
.build-stage__body { flex: 1; }
.build-stage__label { margin: 0; font-size: 0.88rem; font-weight: 600; line-height: 1.75rem; }
.build-stage__detail { margin: 0.15rem 0 0; font-size: 0.75rem; color: var(--color-ink-soft); }
.build-stage__bar {
  margin-top: 0.4rem;
  height: 4px;
  background: var(--color-surface-2);
  border-radius: 2px;
  overflow: hidden;
}
.build-stage__fill {
  height: 100%;
  background: var(--color-pine);
  border-radius: 2px;
  transition: width 0.1s linear;
}
.build-stage__num { font-size: 0.72rem; }

@keyframes spin { to { transform: rotate(360deg); } }
.spin { animation: spin 0.8s linear infinite; }

/* 完成 */
.done { display: flex; flex-direction: column; align-items: center; text-align: center; }
.done__icon {
  width: 4rem;
  height: 4rem;
  border-radius: 50%;
  background: var(--color-sage);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0.5rem 0 1rem;
}
.done__meta {
  width: 100%;
  background: var(--color-surface-2);
  border-radius: calc(var(--radius) * 0.6);
  padding: 0.75rem 1rem;
  margin: 0.5rem 0 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  text-align: left;
}
.done__meta-row { display: flex; justify-content: space-between; font-size: 0.82rem; }
.done__meta-key { color: var(--color-ink-soft); }

/* 按鈕 */
.btn {
  padding: 0.55rem 1.25rem;
  border-radius: calc(var(--radius) * 0.6);
  font-size: 0.88rem;
  font-weight: 700;
  border: none;
  cursor: pointer;
  transition: all 0.15s;
}
.btn--primary { background: var(--color-pine); color: #fff; }
.btn--primary:hover:not(:disabled) { background: var(--color-sage); }
.btn--primary:disabled { opacity: 0.4; cursor: not-allowed; }
.btn--ghost { background: transparent; border: 1px solid var(--color-line); color: var(--color-ink-soft); }
.btn--ghost:hover { background: var(--color-surface-2); }
</style>
