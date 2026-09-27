import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { api } from '@/lib/axios'
import { errorMessage } from '@/lib/errors'
import type { CompressedPhoto } from '@/lib/photo'
import { useAuthStore } from '@/stores/auth'
import type {
  Lesson,
  OmloopResult,
  TerugblikDetail,
  TerugblikList,
  TerugblikOverview,
} from '@/types/terugblik'

const POLL_MS = 2000

// Loads one resource with the usual loading / error state
function useLoad<T>(fetch: () => Promise<T>) {
  const data = ref<T | null>(null)
  const loading = ref(true)
  const loadError = ref<string | null>(null)

  async function load() {
    loading.value = true
    loadError.value = null
    try {
      data.value = await fetch()
    } catch (error) {
      loadError.value = errorMessage(error)
    } finally {
      loading.value = false
    }
  }

  return { data, loading, loadError, load }
}

// The player's finished koersdagen with the total saldo
export const useTerugblikList = () =>
  useLoad(async () => (await api.get<TerugblikList>('/terugblik')).data)

// Owner: totals per friend and every koersdag
export const useTerugblikOverview = () =>
  useLoad(async () => (await api.get<TerugblikOverview>('/terugblik/overview')).data)

// Owner: the lessons the AI learned from evaluations
export function useLessons() {
  const state = useLoad(async () => (await api.get<{ lessons: Lesson[] }>('/lessons')).data.lessons)

  async function remove(id: string) {
    await api.delete(`/lessons/${encodeURIComponent(id)}`)
    state.data.value = state.data.value?.filter((l) => l.id !== id) ?? null
  }

  return { ...state, remove }
}

// One finished koersdag: uitslagen, evaluation and bet corrections; polls while the AI works
export function useTerugblik(id: () => string) {
  const auth = useAuthStore()
  const path = () => `/terugblik/${encodeURIComponent(id())}`
  const {
    data: detail,
    loading,
    loadError,
    load,
  } = useLoad(async () => (await api.get<TerugblikDetail>(path())).data)
  const thinking = computed(() => detail.value?.status === 'thinking')

  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  // Keeps the AI notice and usage badge in the shell up to date
  async function refreshMe() {
    try {
      await auth.fetchMe()
    } catch {
      // The screen itself already shows what went wrong
    }
  }

  function schedulePoll() {
    clearTimeout(timer)
    if (stopped || !thinking.value) return
    timer = setTimeout(poll, POLL_MS)
  }

  async function poll() {
    try {
      detail.value = (await api.get<TerugblikDetail>(path())).data
    } catch {
      // A missed poll is harmless: try again on the next tick
    }
    schedulePoll()
  }

  async function send(request: Promise<{ data: TerugblikDetail }>) {
    detail.value = (await request).data
  }

  const fetchResults = () => send(api.post(`${path()}/results/fetch`))
  const sendPhoto = (photo: CompressedPhoto) => send(api.post(`${path()}/results/photo`, photo))
  const confirmResults = (results: OmloopResult[]) =>
    send(api.put(`${path()}/results`, { results }))
  const evaluate = () => send(api.post(`${path()}/evaluate`))
  const updateBet = (betId: string, change: { winnings: number | null }) =>
    send(api.patch(`${path()}/bets/${encodeURIComponent(betId)}`, change))

  watch(thinking, (now, before) => {
    if (now) schedulePoll()
    else if (before) void refreshMe()
  })

  onBeforeUnmount(() => {
    stopped = true
    clearTimeout(timer)
  })

  return {
    detail,
    loading,
    loadError,
    thinking,
    load,
    refreshMe,
    fetchResults,
    sendPhoto,
    confirmResults,
    evaluate,
    updateBet,
  }
}
