import { defineStore } from 'pinia'
import { api, ApiError } from '../lib/api'

interface UserDTO {
  id: number
  username: string
}

export const useAuthStore = defineStore('auth', {
  state: () => ({
    isLoggedIn: false,
    userEmail: null as string | null,
  }),
  actions: {
    async login(username: string, password: string) {
      try {
        const user = await api.post<UserDTO>('/auth/login', { username, password })
        this.isLoggedIn = true
        this.userEmail = user.username
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          const user = await api.post<UserDTO>('/auth/register', { username, password })
          this.isLoggedIn = true
          this.userEmail = user.username
        } else {
          throw err
        }
      }
    },
    async logout() {
      await api.post('/auth/logout')
      this.isLoggedIn = false
      this.userEmail = null
    },
    async restoreSession() {
      try {
        const user = await api.get<UserDTO>('/auth/me')
        this.isLoggedIn = true
        this.userEmail = user.username
      } catch {
        this.isLoggedIn = false
        this.userEmail = null
      }
    },
  },
})
