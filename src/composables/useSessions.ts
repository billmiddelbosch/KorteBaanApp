import { ref } from 'vue'
import { api } from '@/lib/axios'
import { errorMessage } from '@/lib/errors'
import type { SessionsOverview } from '@/types/account'

export function useSessions() {
  const overview = ref<SessionsOverview | null>(null)
  const loading = ref(true)
  const loadError = ref<string | null>(null)

  async function load() {
    loading.value = true
    loadError.value = null
    try {
      overview.value = (await api.get<SessionsOverview>('/me/sessions')).data
    } catch (error) {
      loadError.value = errorMessage(error)
    } finally {
      loading.value = false
    }
  }

  return { overview, loading, loadError, load }
}
