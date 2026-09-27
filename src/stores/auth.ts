import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { api, onUnauthorized } from '@/lib/axios'
import { AUTH_TOKEN_KEY } from '@/lib/constants'
import { errorMessage, errorStatus } from '@/lib/errors'
import type { AuthResponse, Me } from '@/types/account'

function readToken(): string | null {
  try {
    return localStorage.getItem(AUTH_TOKEN_KEY)
  } catch {
    return null
  }
}

export const useAuthStore = defineStore('auth', () => {
  const user = ref<Me | null>(null)
  const token = ref<string | null>(readToken())
  // Shown once on the login page after a forced sign-out (e.g. access paused)
  const notice = ref<string | null>(null)
  let loading: Promise<void> | null = null

  const isLoggedIn = computed(() => !!token.value && !!user.value)
  const isOwner = computed(() => user.value?.role === 'owner')

  function setToken(value: string | null) {
    token.value = value
    if (value) localStorage.setItem(AUTH_TOKEN_KEY, value)
    else localStorage.removeItem(AUTH_TOKEN_KEY)
  }

  function clear(reason?: string) {
    setToken(null)
    user.value = null
    notice.value = reason ?? null
  }

  function applySession(res: AuthResponse) {
    setToken(res.token)
    user.value = res.user
    notice.value = null
  }

  async function fetchMe() {
    try {
      user.value = (await api.get<Me>('/me')).data
    } catch (error) {
      const status = errorStatus(error)
      if (status === 401 || status === 403) clear(status === 403 ? errorMessage(error) : undefined)
      else throw error
    }
  }

  // Resolves the session once on app start; route guards await this
  function ensureLoaded(): Promise<void> {
    if (!token.value || user.value) return Promise.resolve()
    loading ??= fetchMe().finally(() => (loading = null))
    return loading
  }

  async function login(username: string, password: string) {
    applySession((await api.post<AuthResponse>('/auth/login', { username, password })).data)
  }

  async function acceptLink(linkToken: string, body: Record<string, string>) {
    applySession(
      (await api.post<AuthResponse>(`/auth/links/${encodeURIComponent(linkToken)}/accept`, body))
        .data,
    )
  }

  function logout() {
    clear()
  }

  // A 401 anywhere else in the app means the session is gone (expired, or password reset)
  onUnauthorized(() => {
    if (token.value) clear('Je sessie is verlopen. Log opnieuw in.')
  })

  return {
    user,
    token,
    notice,
    isLoggedIn,
    isOwner,
    setToken,
    fetchMe,
    ensureLoaded,
    login,
    acceptLink,
    logout,
  }
})
