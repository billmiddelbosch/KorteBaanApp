<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { ArrowLeft, CircleCheck, RotateCcw, SendHorizontal, Sparkles } from '@lucide/vue'
import AlertBox from '@/components/account/AlertBox.vue'
import ConfirmDialog from '@/components/account/ConfirmDialog.vue'
import AdviceCard from '@/components/analyse/AdviceCard.vue'
import MessageText from '@/components/analyse/MessageText.vue'
import { useAnalysis } from '@/composables/useAnalysis'
import { errorMessage, errorStatus } from '@/lib/errors'
import { formatDateTime, formatDay } from '@/lib/format'
import { ui } from '@/lib/ui'

const MAX_MESSAGE = 2000
const THINKING_TEXTS = [
  'Zoekt recente uitslagen…',
  'Bekijkt de vorm van paarden en pikeurs…',
  'Weegt de kansen…',
  'Stelt een antwoord op…',
]

const route = useRoute()
const { chat, loading, loadError, thinking, load, send, retry, restart, lockAdvice, refreshMe } =
  useAnalysis(() => String(route.params.id))

const lockedId = computed(() => chat.value?.advice?.messageId ?? null)

// Refused by the AI connection or daily limit: refresh so the notice at the top explains why
async function handleActionError(error: unknown): Promise<string> {
  if ([409, 429, 503].includes(errorStatus(error) ?? 0)) await refreshMe()
  return errorMessage(error)
}

// ── Thinking indicator ──
const thinkingIndex = ref(0)
let thinkingTimer: ReturnType<typeof setInterval> | undefined
watch(
  thinking,
  (now) => {
    clearInterval(thinkingTimer)
    thinkingIndex.value = 0
    if (now) {
      thinkingTimer = setInterval(() => {
        thinkingIndex.value = (thinkingIndex.value + 1) % THINKING_TEXTS.length
      }, 3500)
    }
  },
  { immediate: true },
)
onBeforeUnmount(() => clearInterval(thinkingTimer))

// ── Composer ──
const draft = ref('')
const sending = ref(false)
const sendError = ref<string | null>(null)
const canSend = computed(
  () => !!draft.value.trim() && !sending.value && !thinking.value && !!chat.value,
)

async function submit() {
  if (!canSend.value) return
  sending.value = true
  sendError.value = null
  try {
    await send(draft.value.trim())
    draft.value = ''
  } catch (error) {
    // The typed text stays in the field so nothing is lost
    sendError.value = await handleActionError(error)
  } finally {
    sending.value = false
  }
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault()
    void submit()
  }
}

// ── Retry ──
const retrying = ref(false)
const retryError = ref<string | null>(null)

async function runRetry() {
  retrying.value = true
  retryError.value = null
  try {
    await retry()
  } catch (error) {
    retryError.value = await handleActionError(error)
  } finally {
    retrying.value = false
  }
}

// ── Lock advice ──
const locking = ref<string | null>(null)
const lockError = ref<string | null>(null)

async function lock(messageId: string) {
  locking.value = messageId
  lockError.value = null
  try {
    await lockAdvice(messageId)
  } catch (error) {
    lockError.value = errorMessage(error)
  } finally {
    locking.value = null
  }
}

// ── Restart ──
const restartOpen = ref(false)
const restarting = ref(false)
const restartError = ref<string | null>(null)

async function confirmRestart() {
  restarting.value = true
  restartError.value = null
  try {
    await restart()
    restartOpen.value = false
    sendError.value = null
    retryError.value = null
  } catch (error) {
    restartError.value = await handleActionError(error)
  } finally {
    restarting.value = false
  }
}

// ── Scroll to the newest message ──
const bottom = ref<HTMLElement | null>(null)
function scrollToBottom(smooth: boolean) {
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  bottom.value?.scrollIntoView({ block: 'end', behavior: smooth && !reduce ? 'smooth' : 'auto' })
}
watch(
  () => [chat.value?.messages.length, chat.value?.status],
  async (_, before) => {
    await nextTick()
    scrollToBottom(before?.[0] !== undefined)
  },
)

onMounted(load)
</script>

<template>
  <div class="mx-auto flex min-h-full max-w-3xl flex-col">
    <!-- Header -->
    <header class="flex flex-col gap-2 px-4 pt-4 md:px-8 md:pt-8">
      <RouterLink
        to="/analyse"
        class="-ml-2 inline-flex min-h-11 w-fit items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-slate-600 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-blue-600 dark:text-slate-400 dark:hover:text-slate-100"
      >
        <ArrowLeft class="size-4" aria-hidden="true" />
        Alle analyses
      </RouterLink>
      <div v-if="chat" class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <h1 :class="ui.h1">{{ chat.draverij.place }}</h1>
          <p :class="[ui.muted, 'first-letter:uppercase']">
            {{ formatDay(chat.draverij.date, true) }}
          </p>
        </div>
        <button
          type="button"
          :class="ui.btnGhost"
          :disabled="thinking"
          @click="((restartOpen = true), (restartError = null))"
        >
          <RotateCcw class="size-4" aria-hidden="true" />
          Opnieuw beginnen
        </button>
      </div>
      <h1 v-else class="sr-only">Analyse</h1>
    </header>

    <div v-if="loading" class="flex flex-col gap-3 px-4 py-6 md:px-8" aria-busy="true" aria-label="Laden">
      <div class="h-16 w-3/4 self-end animate-pulse rounded-2xl bg-slate-100 dark:bg-slate-800/60"></div>
      <div class="h-28 w-5/6 animate-pulse rounded-2xl bg-slate-100 dark:bg-slate-800/60"></div>
    </div>

    <div v-else-if="loadError" class="flex flex-col items-start gap-3 px-4 py-6 md:px-8">
      <AlertBox>{{ loadError }}</AlertBox>
      <div class="flex flex-wrap gap-3">
        <button type="button" :class="ui.btnSecondary" @click="load">Opnieuw proberen</button>
        <RouterLink to="/analyse" :class="ui.btnGhost">Naar alle analyses</RouterLink>
      </div>
    </div>

    <template v-else-if="chat">
      <!-- Locked advice banner -->
      <div
        v-if="chat.advice"
        role="status"
        class="mx-4 mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900 md:mx-8 dark:border-emerald-400/20 dark:bg-emerald-400/10 dark:text-emerald-100"
      >
        <CircleCheck class="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
        <span>
          <strong class="font-semibold">Advies vastgelegd</strong>
          op {{ formatDateTime(chat.advice.lockedAt) }}.
        </span>
        <RouterLink to="/" class="font-semibold underline underline-offset-2 hover:no-underline">
          Naar Koersdag
        </RouterLink>
      </div>

      <!-- Messages -->
      <ol class="flex flex-1 flex-col gap-4 px-4 py-6 md:px-8" aria-label="Gesprek">
        <li
          v-for="message in chat.messages"
          :key="message.id"
          :class="['flex flex-col gap-2', message.role === 'user' ? 'items-end' : 'items-start']"
        >
          <div
            :class="[
              'max-w-[85%] rounded-2xl px-4 py-3 text-[15px] leading-relaxed',
              message.role === 'user'
                ? 'rounded-br-md bg-blue-600 text-white dark:bg-blue-500 dark:text-slate-950'
                : 'rounded-bl-md bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100',
            ]"
          >
            <span class="sr-only">{{ message.role === 'user' ? 'Jij:' : 'AI:' }}</span>
            <MessageText :text="message.text" />
            <details v-if="message.sources.length" class="mt-2 text-sm">
              <summary
                class="-mx-1 inline-flex min-h-11 cursor-pointer items-center rounded px-1 font-medium text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
              >
                Bronnen ({{ message.sources.length }})
              </summary>
              <ul class="mt-1 flex flex-col gap-1">
                <li v-for="source in message.sources" :key="source.url">
                  <a
                    :href="source.url"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="break-words text-blue-700 underline underline-offset-2 hover:no-underline dark:text-blue-300"
                  >
                    {{ source.title || source.url }}
                  </a>
                </li>
              </ul>
            </details>
          </div>
          <AdviceCard
            v-if="message.proposal"
            class="w-full max-w-[85%]"
            :proposal="message.proposal"
            :locked="lockedId === message.id"
            :busy="locking === message.id"
            :disabled="locking !== null"
            @lock="lock(message.id)"
          />
        </li>

        <!-- Status of the AI turn -->
        <li aria-live="polite" class="flex flex-col items-start gap-3">
          <div
            v-if="thinking"
            class="flex items-center gap-2 rounded-2xl rounded-bl-md bg-slate-100 px-4 py-3 text-sm text-slate-700 dark:bg-slate-800 dark:text-slate-300"
            data-testid="ai-thinking"
          >
            <Sparkles
              class="size-4 animate-pulse text-blue-600 motion-reduce:animate-none dark:text-blue-400"
              aria-hidden="true"
            />
            {{ THINKING_TEXTS[thinkingIndex] }}
          </div>
          <template v-else-if="chat.status === 'error'">
            <AlertBox class="w-full">
              {{ chat.error ?? 'De AI kon geen antwoord geven.' }} Je bericht is bewaard.
            </AlertBox>
            <AlertBox v-if="retryError" class="w-full">{{ retryError }}</AlertBox>
            <button type="button" :class="ui.btnSecondary" :disabled="retrying" @click="runRetry">
              <RotateCcw class="size-4" aria-hidden="true" />
              {{ retrying ? 'Opnieuw proberen…' : 'Opnieuw proberen' }}
            </button>
          </template>
          <AlertBox v-if="lockError" class="w-full">{{ lockError }}</AlertBox>
        </li>
      </ol>
      <div ref="bottom"></div>

      <!-- Composer -->
      <form
        class="sticky bottom-[calc(var(--shell-bottom,0px)+env(safe-area-inset-bottom))] z-30 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur-md md:bottom-0 md:px-8 dark:border-white/10 dark:bg-slate-950/95"
        novalidate
        @submit.prevent="submit"
      >
        <AlertBox v-if="sendError" class="mb-2">{{ sendError }}</AlertBox>
        <label for="chat-input" class="sr-only">Bericht aan de AI</label>
        <div class="flex items-end gap-2">
          <textarea
            id="chat-input"
            v-model="draft"
            rows="2"
            :maxlength="MAX_MESSAGE"
            placeholder="Typ je vraag of antwoord…"
            class="block min-h-11 w-full resize-none rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-base text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-2 focus:outline-blue-600/30 dark:border-white/15 dark:bg-slate-900 dark:text-slate-100 dark:focus:border-blue-400"
            aria-describedby="chat-input-hint"
            @keydown="onKeydown"
          ></textarea>
          <button
            type="submit"
            :class="[ui.btnPrimary, 'size-11 shrink-0 px-0']"
            :disabled="!canSend"
            aria-label="Versturen"
          >
            <SendHorizontal class="size-5" aria-hidden="true" />
          </button>
        </div>
        <p id="chat-input-hint" class="mt-1 hidden text-xs text-slate-500 md:block dark:text-slate-400">
          {{ thinking ? 'Wacht tot de AI klaar is met antwoorden.' : 'Ctrl + Enter om te versturen.' }}
        </p>
      </form>
    </template>

    <ConfirmDialog
      :open="restartOpen"
      title="Opnieuw beginnen?"
      confirm-label="Opnieuw beginnen"
      cancel-label="Gesprek houden"
      :busy="restarting"
      @confirm="confirmRestart"
      @cancel="restartOpen = false"
    >
      <p>
        Het gesprek wordt gewist en de AI begint opnieuw aan deze koers.
        <template v-if="chat?.advice">Je vastgelegde advies blijft staan.</template>
      </p>
      <AlertBox v-if="restartError" class="mt-3">{{ restartError }}</AlertBox>
    </ConfirmDialog>
  </div>
</template>
