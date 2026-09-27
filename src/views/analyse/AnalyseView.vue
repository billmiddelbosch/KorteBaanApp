<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { ChevronRight, CircleAlert, CircleCheck, LoaderCircle, MessageSquareText, Plus } from '@lucide/vue'
import AlertBox from '@/components/account/AlertBox.vue'
import { useAnalyses, type NewAnalysis } from '@/composables/useAnalyses'
import { errorMessage, errorStatus } from '@/lib/errors'
import { daysUntil, formatDay } from '@/lib/format'
import { ui } from '@/lib/ui'
import { useAuthStore } from '@/stores/auth'
import type { ChatSummary } from '@/types/analyse'

const auth = useAuthStore()
const router = useRouter()
const { chats, draverijen, loading, loadError, load, start } = useAnalyses()

const chatFor = computed(() => new Map(chats.value.map((c) => [c.id, c])))

// ── New analysis ──
const pickerOpen = ref(false)
const ownKoers = ref(false)
const place = ref('')
const date = ref('')
const placeError = ref<string | null>(null)
const dateError = ref<string | null>(null)
const startError = ref<string | null>(null)
const starting = ref<string | null>(null)
const today = new Date().toISOString().slice(0, 10)

function openPicker() {
  pickerOpen.value = true
  startError.value = null
}

async function begin(key: string, body: NewAnalysis) {
  starting.value = key
  startError.value = null
  try {
    const chat = await start(body)
    await router.push({ name: 'analyse-chat', params: { id: chat.id } })
  } catch (error) {
    startError.value = errorMessage(error)
    // AI off or daily limit reached: refresh so the notice at the top explains it
    if ([409, 429, 503].includes(errorStatus(error) ?? 0)) {
      try {
        await auth.fetchMe()
      } catch {
        // The error above already tells the user what happened
      }
    }
  } finally {
    starting.value = null
  }
}

function submitOwn() {
  placeError.value = place.value.trim() ? null : 'Vul de plaats van de draverij in.'
  dateError.value = !date.value
    ? 'Kies de datum van de draverij.'
    : date.value < today
      ? 'Deze draverij is al voorbij. Kies een datum vanaf vandaag.'
      : null
  if (placeError.value || dateError.value) return
  void begin('own', { place: place.value.trim(), date: date.value })
}

function statusOf(chat: ChatSummary) {
  if (chat.status === 'thinking') return { label: 'AI denkt na…', icon: LoaderCircle, spin: true }
  if (chat.status === 'error') return { label: 'Antwoord mislukt', icon: CircleAlert, spin: false }
  return null
}

onMounted(load)
</script>

<template>
  <div :class="ui.page">
    <header class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 :class="ui.h1">Analyse</h1>
        <p :class="[ui.muted, 'mt-1']">Bespreek een koers met de AI en krijg een inzetadvies.</p>
      </div>
      <button
        v-if="!loading && !loadError && !pickerOpen"
        type="button"
        :class="ui.btnPrimary"
        @click="openPicker"
      >
        <Plus class="size-4" aria-hidden="true" />
        Nieuwe analyse
      </button>
    </header>

    <div v-if="loading" class="flex flex-col gap-3" aria-busy="true" aria-label="Laden">
      <div class="h-20 animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800/60"></div>
      <div class="h-20 animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800/60"></div>
    </div>

    <div v-else-if="loadError" class="flex flex-col items-start gap-3">
      <AlertBox>{{ loadError }}</AlertBox>
      <button type="button" :class="ui.btnSecondary" @click="load">Opnieuw proberen</button>
    </div>

    <template v-else>
      <!-- New analysis: pick a koers -->
      <section v-if="pickerOpen" aria-labelledby="new-title" :class="ui.card">
        <div class="flex items-start justify-between gap-3">
          <h2 id="new-title" :class="ui.h2">Voor welke koers?</h2>
          <button type="button" :class="[ui.btnGhost, '-my-2 -mr-2']" @click="pickerOpen = false">
            Annuleren
          </button>
        </div>

        <AlertBox v-if="startError" class="mt-3">{{ startError }}</AlertBox>

        <ul v-if="draverijen.length" class="mt-3 flex flex-col gap-2">
          <li v-for="d in draverijen" :key="d.id">
            <button
              type="button"
              class="flex min-h-14 w-full items-center justify-between gap-3 rounded-lg border border-slate-200 px-4 py-2 text-left transition-colors hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:opacity-60 dark:border-white/10 dark:hover:bg-white/5 dark:focus-visible:outline-blue-400"
              :disabled="starting !== null"
              @click="begin(d.id, { draverijId: d.id })"
            >
              <span class="min-w-0">
                <span class="block font-semibold text-slate-900 dark:text-slate-100">{{ d.place }}</span>
                <span class="block text-sm text-slate-600 first-letter:uppercase dark:text-slate-400">
                  {{ formatDay(d.date) }} · {{ daysUntil(d.date) }}
                </span>
              </span>
              <span class="flex shrink-0 items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
                <LoaderCircle v-if="starting === d.id" class="size-4 animate-spin" aria-hidden="true" />
                <template v-else-if="chatFor.get(d.id)">Verder</template>
                <ChevronRight class="size-4" aria-hidden="true" />
              </span>
            </button>
          </li>
        </ul>
        <p v-else :class="[ui.muted, 'mt-3']">
          Er staan geen draverijen in de lijst. Vul hieronder zelf de koers in.
        </p>

        <div class="mt-4 border-t border-slate-200 pt-4 dark:border-white/10">
          <button
            v-if="!ownKoers && draverijen.length"
            type="button"
            :class="[ui.btnSecondary, 'w-full sm:w-auto']"
            @click="ownKoers = true"
          >
            Andere koers
          </button>
          <form
            v-else
            class="flex flex-col gap-4"
            novalidate
            aria-label="Andere koers"
            @submit.prevent="submitOwn"
          >
            <div class="grid gap-4 sm:grid-cols-2">
              <div>
                <label for="koers-place" :class="ui.label">Plaats</label>
                <input
                  id="koers-place"
                  v-model="place"
                  type="text"
                  maxlength="40"
                  autocomplete="off"
                  placeholder="Bijv. Sint-Jacobiparochie"
                  :class="ui.input"
                  :aria-invalid="!!placeError"
                  :aria-describedby="placeError ? 'koers-place-error' : undefined"
                />
                <p v-if="placeError" id="koers-place-error" :class="ui.fieldError">{{ placeError }}</p>
              </div>
              <div>
                <label for="koers-date" :class="ui.label">Datum</label>
                <input
                  id="koers-date"
                  v-model="date"
                  type="date"
                  :min="today"
                  :class="ui.input"
                  :aria-invalid="!!dateError"
                  :aria-describedby="dateError ? 'koers-date-error' : undefined"
                />
                <p v-if="dateError" id="koers-date-error" :class="ui.fieldError">{{ dateError }}</p>
              </div>
            </div>
            <div>
              <button type="submit" :class="ui.btnPrimary" :disabled="starting !== null">
                {{ starting === 'own' ? 'Analyse starten…' : 'Analyse starten' }}
              </button>
            </div>
          </form>
        </div>
      </section>

      <!-- Running chats -->
      <section v-if="chats.length" aria-labelledby="chats-title" class="flex flex-col gap-3">
        <h2 id="chats-title" :class="ui.h2">Lopende analyses</h2>
        <ul class="flex flex-col gap-3">
          <li v-for="chat in chats" :key="chat.id">
            <RouterLink
              :to="{ name: 'analyse-chat', params: { id: chat.id } }"
              :class="[
                ui.card,
                'flex items-center justify-between gap-3 transition-colors hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 md:p-4 dark:hover:bg-white/5 dark:focus-visible:outline-blue-400',
              ]"
            >
              <span class="min-w-0">
                <span class="block font-semibold text-slate-900 dark:text-slate-100">
                  {{ chat.draverij.place }}
                </span>
                <span class="block text-sm text-slate-600 first-letter:uppercase dark:text-slate-400">
                  {{ formatDay(chat.draverij.date) }} · {{ daysUntil(chat.draverij.date) }}
                </span>
                <span class="mt-2 flex flex-wrap items-center gap-2 text-xs font-medium">
                  <span
                    v-if="chat.hasAdvice"
                    class="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-emerald-800 dark:bg-emerald-400/15 dark:text-emerald-200"
                  >
                    <CircleCheck class="size-3.5" aria-hidden="true" />
                    Advies vastgelegd
                  </span>
                  <span
                    v-else
                    class="rounded-full bg-slate-100 px-2 py-0.5 text-slate-700 dark:bg-white/10 dark:text-slate-300"
                  >
                    Nog geen advies
                  </span>
                  <span
                    v-if="statusOf(chat)"
                    class="inline-flex items-center gap-1 text-slate-600 dark:text-slate-400"
                  >
                    <component
                      :is="statusOf(chat)!.icon"
                      :class="['size-3.5', statusOf(chat)!.spin && 'animate-spin motion-reduce:animate-none']"
                      aria-hidden="true"
                    />
                    {{ statusOf(chat)!.label }}
                  </span>
                </span>
              </span>
              <ChevronRight class="size-5 shrink-0 text-slate-400" aria-hidden="true" />
            </RouterLink>
          </li>
        </ul>
      </section>

      <!-- Empty state -->
      <section
        v-else-if="!pickerOpen"
        class="flex flex-col items-center gap-4 rounded-xl border border-dashed border-slate-300 px-6 py-10 text-center dark:border-white/15"
      >
        <span class="grid size-12 place-items-center rounded-full bg-blue-100 text-blue-700 dark:bg-blue-400/15 dark:text-blue-300">
          <MessageSquareText class="size-6" aria-hidden="true" />
        </span>
        <div class="max-w-md">
          <h2 :class="ui.h2">Nog geen analyses</h2>
          <p :class="[ui.muted, 'mt-2']">
            Kies een draverij en praat met de AI over de paarden, pikeurs en je budget. De AI zoekt
            recente uitslagen op en komt met een inzetadvies per omloop, dat je kunt vastleggen
            voor de koersdag.
          </p>
        </div>
        <button type="button" :class="ui.btnPrimary" @click="openPicker">
          <Plus class="size-4" aria-hidden="true" />
          Nieuwe analyse
        </button>
      </section>
    </template>
  </div>
</template>
