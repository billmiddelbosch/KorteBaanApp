import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { api } from '@/lib/axios'
import { errorMessage } from '@/lib/errors'
import { useAuthStore } from '@/stores/auth'
import type { Chat } from '@/types/analyse'

const POLL_MS = 2000

// One analysis chat: loads it, sends turns and polls while the AI is thinking
export function useAnalysis(id: () => string) {
  const auth = useAuthStore()
  const chat = ref<Chat | null>(null)
  const loading = ref(true)
  const loadError = ref<string | null>(null)
  const thinking = computed(() => chat.value?.status === 'thinking')

  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  // Keeps the AI notice and usage badge in the shell up to date
  async function refreshMe() {
    try {
      await auth.fetchMe()
    } catch {
      // The chat itself already shows what went wrong
    }
  }

  function schedulePoll() {
    clearTimeout(timer)
    if (stopped || !thinking.value) return
    timer = setTimeout(poll, POLL_MS)
  }

  async function poll() {
    try {
      chat.value = (await api.get<Chat>(`/analyses/${encodeURIComponent(id())}`)).data
    } catch {
      // A missed poll is harmless: try again on the next tick
    }
    schedulePoll()
  }

  async function load() {
    loading.value = true
    loadError.value = null
    try {
      chat.value = (await api.get<Chat>(`/analyses/${encodeURIComponent(id())}`)).data
    } catch (error) {
      loadError.value = errorMessage(error)
    } finally {
      loading.value = false
    }
  }

  async function post(path: string, body?: object) {
    chat.value = (await api.post<Chat>(`/analyses/${encodeURIComponent(id())}${path}`, body)).data
  }

  const send = (text: string) => post('/messages', { text })
  const retry = () => post('/retry')
  const restart = () => post('/restart')
  const lockAdvice = (messageId: string) => post('/advice', { messageId })

  watch(thinking, (now, before) => {
    if (now) schedulePoll()
    else if (before) void refreshMe()
  })

  onBeforeUnmount(() => {
    stopped = true
    clearTimeout(timer)
  })

  return { chat, loading, loadError, thinking, load, send, retry, restart, lockAdvice, refreshMe }
}
