import { ref } from 'vue'
import { api } from '@/lib/axios'
import { errorMessage } from '@/lib/errors'
import type { Chat, ChatSummary, Draverij } from '@/types/analyse'

export type NewAnalysis = { draverijId: string } | { place: string; date: string }

// Start screen: running chats plus the upcoming draverijen to start a new one for
export function useAnalyses() {
  const chats = ref<ChatSummary[]>([])
  const draverijen = ref<Draverij[]>([])
  const loading = ref(true)
  const loadError = ref<string | null>(null)

  async function load() {
    loading.value = true
    loadError.value = null
    try {
      const [list, upcoming] = await Promise.all([
        api.get<ChatSummary[]>('/analyses'),
        api.get<Draverij[]>('/draverijen'),
      ])
      chats.value = list.data
      draverijen.value = upcoming.data
    } catch (error) {
      loadError.value = errorMessage(error)
    } finally {
      loading.value = false
    }
  }

  // Returns the new chat, or the existing one for this draverij (one chat per koers)
  async function start(body: NewAnalysis): Promise<Chat> {
    return (await api.post<Chat>('/analyses', body)).data
  }

  return { chats, draverijen, loading, loadError, load, start }
}
