<script setup lang="ts">
import { computed } from 'vue'
import type { LibraryItem } from '../stores/library'
import { formatRelativeTime } from '../lib/formatTime'

const props = defineProps<{ item: LibraryItem; size?: [number, number, number] }>()
const emit = defineEmits<{ open: [] }>()

const timeLabel = computed(() => formatRelativeTime(props.item.createdAt))

function fmtSize(s: [number, number, number]) {
  return `${s[0].toFixed(2)}m × ${s[1].toFixed(2)}m × ${s[2].toFixed(2)}m`
}

function handleClick() {
  if (props.item.status === 'ready') emit('open')
}
</script>

<template>
  <button
    class="card"
    :class="{ 'card--generating': item.status === 'generating' }"
    type="button"
    @click="handleClick"
  >
    <div class="card__thumb-wrap">
      <img class="card__thumb" :src="item.thumbnail" alt="" />
      <div v-if="item.status === 'generating'" class="card__progress-ring" aria-label="建場中">
        <svg viewBox="0 0 44 44">
          <circle class="card__ring-track" cx="22" cy="22" r="18" />
          <circle class="card__ring-value" cx="22" cy="22" r="18" />
        </svg>
      </div>
    </div>
    <div class="card__meta">
      <p class="card__name">{{ item.name }}</p>
      <p v-if="size" class="card__size">{{ fmtSize(size) }}</p>
      <p class="card__time">{{ timeLabel }}</p>
    </div>
  </button>
</template>

<style scoped>
.card {
  display: flex;
  flex-direction: column;
  width: 100%;
  border: 1px solid var(--color-line);
  border-radius: var(--radius);
  background: var(--color-surface);
  padding: 0;
  overflow: hidden;
  text-align: left;
  cursor: pointer;
}

.card:not(.card--generating):hover {
  border-color: var(--color-sage);
}

.card--generating {
  cursor: default;
}

.card__thumb-wrap {
  position: relative;
  width: 100%;
  aspect-ratio: 4 / 3;
  overflow: hidden;
  background: var(--color-surface-2);
}

.card__thumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.card--generating .card__thumb {
  filter: blur(6px);
  transform: scale(1.08);
}

.card__progress-ring {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.card__progress-ring svg {
  width: 2.75rem;
  height: 2.75rem;
  animation: spin 1.4s linear infinite;
}

.card__ring-track {
  fill: none;
  stroke: rgba(255, 255, 255, 0.4);
  stroke-width: 4;
}

.card__ring-value {
  fill: none;
  stroke: var(--color-clay);
  stroke-width: 4;
  stroke-linecap: round;
  stroke-dasharray: 113;
  stroke-dashoffset: 80;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.card__meta {
  padding: 0.65rem 0.85rem 0.8rem;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.card__name {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 700;
  color: var(--color-ink);
}

.card__size {
  margin: 0;
  font-size: 0.72rem;
  color: var(--color-ink-soft);
}

.card__time {
  margin: 0;
  font-size: 0.75rem;
  color: var(--color-ink-soft);
}
</style>
