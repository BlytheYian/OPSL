<script setup lang="ts">
import { useRoute } from 'vue-router'
const route = useRoute()
</script>

<template>
  <div class="stub">
    <p>場景 {{ route.params.id }} : (</p>
  </div>
</template>

<style scoped>
.stub {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-ink-soft);
}
</style>
