import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { LiveSession } from '@/components/shell'
import { api } from '@/lib/axios'
import { errorMessage } from '@/lib/errors'
import type { CompressedPhoto } from '@/lib/photo'
import { useAuthStore } from '@/stores/auth'
import type { Koersdag, KoersdagToday } from '@/types/koersdag'

const POLL_MS = 2000

export type StartInput = { budget: number } & ({ draverijId: string } | { place: string })

// Today's koersdag. Global, so the Live bar in the shell stays in step on every page
// and polling continues while the user looks elsewhere.
export const useKoersdagStore = defineStore('koersdag', () => {
  const auth = useAuthStore()
  const today = ref<KoersdagToday | null>(null)
  const loading = ref(false)
  const loadError = ref<string | null>(null)

  const current = computed(() => today.value?.current ?? null)
  const thinking = computed(() => current.value?.status === 'thinking')

  const live = computed<LiveSession | null>(() => {
    const k = current.value
    if (!k || k.finishedAt) return null
    return {
      draverij: k.draverij.place,
      omloop: `${k.omloop}e omloop`,
      budgetRemaining: k.remaining,
      to: '/',
    }
  })

  let timer: ReturnType<typeof setTimeout> | undefined

  function setCurrent(koersdag: Koersdag) {
    if (today.value) today.value = { ...today.value, current: koersdag }
    else today.value = { current: koersdag, options: [], next: null }
  }

  function schedulePoll() {
    clearTimeout(timer)
    if (!thinking.value) return
    timer = setTimeout(poll, POLL_MS)
  }

  async function poll() {
    const id = current.value?.id
    if (!id) return
    try {
      const { data } = await api.get<Koersdag>(`/koersdagen/${encodeURIComponent(id)}`)
      // Ignore an answer that arrives after logout or a switch to another koersdag
      if (current.value?.id === id) setCurrent(data)
    } catch {
      // A missed poll is harmless: try again on the next tick
    }
    schedulePoll()
  }

  async function load() {
    loading.value = true
    loadError.value = null
    try {
      today.value = (await api.get<KoersdagToday>('/koersdagen/today')).data
    } catch (error) {
      loadError.value = errorMessage(error)
    } finally {
      loading.value = false
    }
  }

  function reset() {
    clearTimeout(timer)
    today.value = null
    loadError.value = null
  }

  async function post(path: string, body?: object) {
    const id = current.value?.id
    if (!id) return
    setCurrent((await api.post<Koersdag>(`/koersdagen/${encodeURIComponent(id)}${path}`, body)).data)
  }

  async function start(input: StartInput) {
    setCurrent((await api.post<Koersdag>('/koersdagen', input)).data)
  }

  const refresh = () => post('/refresh')
  const nextOmloop = () => post('/next')
  const finish = () => post('/finish')
  const sendPhoto = (photo: CompressedPhoto) => post('/photo', photo)
  const addBet = (bet: { bet: string; amount: number; suggestionId?: string }) => post('/bets', bet)

  async function updateBet(betId: string, change: { amount?: number; winnings?: number | null }) {
    const id = current.value?.id
    if (!id) return
    const url = `/koersdagen/${encodeURIComponent(id)}/bets/${encodeURIComponent(betId)}`
    setCurrent((await api.patch<Koersdag>(url, change)).data)
  }

  async function removeBet(betId: string) {
    const id = current.value?.id
    if (!id) return
    const url = `/koersdagen/${encodeURIComponent(id)}/bets/${encodeURIComponent(betId)}`
    setCurrent((await api.delete<Koersdag>(url)).data)
  }

  // Keeps the AI notice and usage badge in the shell up to date
  async function refreshMe() {
    try {
      await auth.fetchMe()
    } catch {
      // The koersdag itself already shows what went wrong
    }
  }

  watch(thinking, (now, before) => {
    if (now) schedulePoll()
    else if (before) void refreshMe()
  })

  // Load on login (also for the Live bar on other pages); forget everything on logout
  watch(
    () => auth.user?.id,
    (id, before) => {
      if (id === before) return
      reset()
      if (id) void load()
    },
    { immediate: true },
  )

  return {
    today,
    current,
    loading,
    loadError,
    thinking,
    live,
    load,
    start,
    refresh,
    nextOmloop,
    finish,
    sendPhoto,
    addBet,
    updateBet,
    removeBet,
    refreshMe,
  }
})
