import { ref } from 'vue'
import { api } from '@/lib/axios'
import { errorMessage } from '@/lib/errors'
import type { AiConnection } from '@/types/account'

export function useAiConnection() {
  const connection = ref<AiConnection | null>(null)
  const loading = ref(true)
  const loadError = ref<string | null>(null)

  async function load() {
    loading.value = true
    loadError.value = null
    try {
      connection.value = (await api.get<AiConnection>('/ai-connection')).data
    } catch (error) {
      loadError.value = errorMessage(error)
    } finally {
      loading.value = false
    }
  }

  async function saveToken(token: string) {
    connection.value = (await api.put<AiConnection>('/ai-connection', { token })).data
  }

  async function test() {
    connection.value = (await api.post<AiConnection>('/ai-connection/test')).data
  }

  async function remove() {
    connection.value = (await api.delete<AiConnection>('/ai-connection')).data
  }

  return { connection, loading, loadError, load, saveToken, test, remove }
}
