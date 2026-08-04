<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'

defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const username = ref('')
const password = ref('')
const errorMessage = ref('')
const submitting = ref(false)
const router = useRouter()
const auth = useAuthStore()

async function handleSubmit() {
  errorMessage.value = ''
  submitting.value = true
  try {
    await auth.login(username.value, password.value)
    emit('close')
    router.push('/dashboard')
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : '登入失敗'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <Transition name="login-fade">
    <div v-if="open" class="login-backdrop" @click.self="emit('close')">
      <form class="login-modal" @submit.prevent="handleSubmit">
        <h1>登入</h1>
        <label for="username">帳號</label>
        <input id="username" v-model="username" type="text" placeholder="帳號(至少 3 字元)" required autofocus minlength="3" />
        <label for="password">密碼</label>
        <input id="password" v-model="password" type="password" placeholder="密碼(至少 6 字元)" required minlength="6" />
        <p v-if="errorMessage" class="login-modal__error">{{ errorMessage }}</p>
        <button type="submit" :disabled="submitting">{{ submitting ? '登入中…' : '登入' }}</button>
      </form>
    </div>
  </Transition>
</template>

<style scoped>
.login-fade-enter-active,
.login-fade-leave-active {
  transition: opacity 0.2s ease;
}

.login-fade-enter-from,
.login-fade-leave-to {
  opacity: 0;
}

.login-backdrop {
  position: fixed;
  inset: 0;
  z-index: 10;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.5rem;
}

.login-modal {
  width: min(100%, 22rem);
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  background: var(--color-paper);
  border: 1px solid var(--color-line);
  border-radius: var(--radius);
  padding: 2rem;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.18);
}

.login-modal h1 {
  font-size: 1.5rem;
  margin-bottom: 0.5rem;
  color: var(--color-ink);
}

.login-modal label {
  font-size: 0.85rem;
  color: var(--color-ink-soft);
}

.login-modal input {
  font-size: 1rem;
  padding: 0.6rem 0.75rem;
  border: 1px solid var(--color-line);
  border-radius: calc(var(--radius) * 0.6);
  background: var(--color-surface);
  color: var(--color-ink);
}

.login-modal__error {
  margin: 0;
  font-size: 0.8rem;
  color: #b3413a;
}

.login-modal button {
  margin-top: 0.5rem;
  padding: 0.7rem 1rem;
  border: none;
  border-radius: calc(var(--radius) * 0.6);
  background: var(--color-clay);
  color: var(--color-ink);
  font-weight: 700;
}
</style>
