import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '../stores/auth'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'landing',
      component: () => import('../views/LandingPage.vue'),
    },
    {
      path: '/dashboard',
      name: 'dashboard',
      component: () => import('../views/DashboardPage.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/scenes/new',
      name: 'scene-new',
      component: () => import('../views/SceneNewPage.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/scenes/:id/status',
      name: 'scene-status',
      component: () => import('../views/SceneStatusPage.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/scenes/:id/edit',
      name: 'scene-edit',
      component: () => import('../views/SceneEditPage.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/capture',
      name: 'thumbnail-capture',
      component: () => import('../views/ThumbnailCapturePage.vue'),
    },
  ],
})

router.beforeEach((to) => {
  const auth = useAuthStore()
  if (to.meta.requiresAuth && !auth.isLoggedIn) {
    return { path: '/', query: { login: '1' } }
  }
})

export default router
