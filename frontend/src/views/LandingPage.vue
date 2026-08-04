<script setup lang="ts">
import { ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import heroImage from '../assets/hero-living-room.jpg'
import LoginModal from '../components/LoginModal.vue'

const route = useRoute()
const showLogin = ref(route.query.login === '1')
watch(
  () => route.query.login,
  (val) => {
    if (val === '1') showLogin.value = true
  },
)
</script>

<template>
  <div class="landing">
    <img class="landing__bg" :src="heroImage" alt="" />
    <div class="landing__scrim" />

    <nav class="landing__nav">
      <span class="landing__brand">一語安居</span>
      <div class="landing__nav-actions">
        <router-link class="landing__workstation-link" to="/dashboard">工作站</router-link>
        <button class="landing__login-btn" type="button" @click="showLogin = true">登入</button>
      </div>
    </nav>

    <div class="landing__center">
      <h1 class="landing__title">一句話,重新設計你的家</h1>
      <p class="landing__subtitle">
        拍下你的空間,移除、換色、規劃——為每個年紀都安心安居而生
      </p>
    </div>

    <LoginModal :open="showLogin" @close="showLogin = false" />
  </div>
</template>

<style scoped>
.landing {
  position: relative;
  min-height: 100vh;
  width: 100%;
  overflow: hidden;
}

.landing__bg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.landing__scrim {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    to bottom,
    rgba(35, 40, 31, 0.55) 0%,
    rgba(35, 40, 31, 0.35) 40%,
    rgba(35, 40, 31, 0.6) 100%
  );
}

.landing__nav {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: clamp(1rem, 1vw, 1.75rem) clamp(1rem, 2vw, 3rem);
  background: rgba(255, 255, 255, 0.00);
}

.landing__brand {
  font-family: var(--serif);
  font-size: clamp(1.1rem, 2.5vw, 1.5rem);
  font-weight: 700;
  color: #fff;
  letter-spacing: 0.02em;
}

.landing__nav-actions {
  display: flex;
  align-items: center;
  gap: clamp(0.75rem, 2vw, 1.5rem);
}

.landing__workstation-link {
  text-decoration: none;
  font-weight: 700;
  font-size: clamp(0.85rem, 2vw, 1rem);
  color: #fff;
  white-space: nowrap;
}

.landing__login-btn {
  border: none;
  text-decoration: none;
  font-weight: 700;
  font-size: clamp(0.85rem, 2vw, 1rem);
  color: var(--color-ink);
  background: var(--color-clay);
  padding: 0.3em 1.0em;
  border-radius: 10px;
  white-space: nowrap;
}

.landing__center {
  position: relative;
  z-index: 1;
  min-height: calc(100vh - 5rem);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 1rem;
  padding: 2rem clamp(1rem, 6vw, 4rem);
}

.landing__title {
  color: #fff;
  font-size: clamp(1.75rem, 5vw, 3.25rem);
  max-width: 20ch;
}

.landing__subtitle {
  color: rgba(255, 255, 255, 0.9);
  font-size: clamp(0.95rem, 2vw, 1.25rem);
  max-width: 42ch;
  margin: 0;
}
</style>
