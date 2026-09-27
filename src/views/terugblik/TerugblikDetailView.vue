<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import {
  Camera,
  ChevronLeft,
  CircleAlert,
  CircleCheck,
  CircleMinus,
  CircleX,
  Pencil,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
} from '@lucide/vue'
import AlertBox from '@/components/account/AlertBox.vue'
import BetsList from '@/components/koersdag/BetsList.vue'
import { useTerugblik } from '@/composables/useTerugblik'
import { errorMessage, errorStatus } from '@/lib/errors'
import { balanceClass, formatBalance, formatDay, formatEuro } from '@/lib/format'
import { compressPhoto } from '@/lib/photo'
import { ui } from '@/lib/ui'
import type { OmloopEvaluation, OmloopResult, ReviewStep } from '@/types/terugblik'

const MAX_OMLOPEN = 12

const THINKING_TEXTS: Record<ReviewStep, string[]> = {
  results: ['Zoekt de uitslagen online…', 'Leest de uitslagen per omloop…'],
  photo: ['Leest het uitslagbord…', 'Zet de uitslagen op een rij…'],
  evaluate: [
    'Vergelijkt het advies met de uitslag…',
    'Zoekt wat er anders liep…',
    'Legt de lessen vast…',
  ],
}

const route = useRoute()
const {
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
} = useTerugblik(() => String(route.params.id))

const confirmed = computed(() => !!detail.value?.resultsConfirmedAt)
const step = computed(() => detail.value?.step ?? null)
const failed = computed(() => detail.value?.status === 'error')
// Failed while looking up or reading the uitslagen (before they were confirmed)
const resultsFailed = computed(() => failed.value && step.value !== 'evaluate')
const evaluateFailed = computed(() => failed.value && step.value === 'evaluate')

// ── Actions ──
const busy = ref<string | null>(null)
const actionError = ref<string | null>(null)

async function run(key: string, action: () => Promise<void>): Promise<boolean> {
  busy.value = key
  actionError.value = null
  try {
    await action()
    return true
  } catch (error) {
    // Refused by the AI connection or daily limit: the notice in the shell explains why
    if ([409, 429, 503].includes(errorStatus(error) ?? 0)) await refreshMe()
    actionError.value = errorMessage(error)
    return false
  } finally {
    busy.value = null
  }
}

// ── Thinking indicator ──
const thinkingIndex = ref(0)
const thinkingTexts = computed(() => THINKING_TEXTS[step.value ?? 'results'])
let thinkingTimer: ReturnType<typeof setInterval> | undefined
watch(
  thinking,
  (now) => {
    clearInterval(thinkingTimer)
    thinkingIndex.value = 0
    if (now) {
      thinkingTimer = setInterval(() => {
        thinkingIndex.value = (thinkingIndex.value + 1) % thinkingTexts.value.length
      }, 3500)
    }
  },
  { immediate: true },
)
onBeforeUnmount(() => clearInterval(thinkingTimer))

// ── Uitslagen form ──
// manual: the user fills in the uitslagen without the AI; editing: changing confirmed uitslagen
const manual = ref(false)
const editing = ref(false)
const drafts = ref<OmloopResult[]>([])
const submitted = ref(false)

function resetDrafts() {
  const results = detail.value?.results
  drafts.value = results?.length
    ? results.map((r) => ({ ...r }))
    : Array.from(
        { length: Math.max(1, Math.min(MAX_OMLOPEN, detail.value?.omloop ?? 1)) },
        (_, i) => ({
          omloop: i + 1,
          winner: '',
          places: '',
        }),
      )
  submitted.value = false
}

// New uitslagen from the AI replace the form
watch(
  () => JSON.stringify(detail.value?.results ?? null),
  () => resetDrafts(),
)

const showForm = computed(
  () =>
    !thinking.value &&
    (editing.value || (!confirmed.value && (!!detail.value?.results?.length || manual.value))),
)

const winnerError = (r: OmloopResult) =>
  submitted.value && !r.winner.trim() ? `Vul de winnaar van de ${r.omloop}e omloop in.` : null

function startManual() {
  resetDrafts()
  manual.value = true
}

function startEditing() {
  resetDrafts()
  editing.value = true
}

function addOmloop() {
  const last = drafts.value.at(-1)?.omloop ?? 0
  drafts.value.push({ omloop: last + 1, winner: '', places: '' })
}

function removeOmloop(index: number) {
  drafts.value.splice(index, 1)
}

async function submitResults() {
  submitted.value = true
  if (drafts.value.some((r) => winnerError(r))) return
  const results = drafts.value.map((r) => ({
    ...r,
    winner: r.winner.trim(),
    places: r.places.trim(),
  }))
  if (await run('confirm', () => confirmResults(results))) {
    manual.value = false
    editing.value = false
  }
}

// ── Photo of the uitslagbord ──
const photoInput = ref<HTMLInputElement | null>(null)

async function onPhoto(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (await run('photo', async () => sendPhoto(await compressPhoto(file)))) {
    manual.value = false
    editing.value = false
  }
}

// ── Evaluation ──
function verdict(o: OmloopEvaluation) {
  if (o.correct === true)
    return {
      icon: CircleCheck,
      text: 'Advies klopte',
      tone: 'text-emerald-700 dark:text-emerald-400',
    }
  if (o.correct === false)
    return { icon: CircleX, text: 'Advies klopte niet', tone: 'text-red-700 dark:text-red-400' }
  return {
    icon: CircleMinus,
    text: 'Geen advies gespeeld',
    tone: 'text-slate-600 dark:text-slate-400',
  }
}

// ── Bets: complete open payouts or correct one ──
const betBusy = ref<string | null>(null)
const betError = ref<string | null>(null)

async function saveWinnings(betId: string, winnings: number | null) {
  betBusy.value = betId
  betError.value = null
  try {
    await updateBet(betId, { winnings })
  } catch (error) {
    betError.value = errorMessage(error)
  } finally {
    betBusy.value = null
  }
}

// Opening a koersdag without uitslagen lets the AI look them up right away
onMounted(async () => {
  await load()
  const d = detail.value
  if (d && !d.results?.length && !d.resultsConfirmedAt && d.status === 'idle') {
    if (!(await run('fetch', fetchResults))) startManual()
  }
})
</script>

<template>
  <div :class="ui.page">
    <header class="flex flex-col gap-1">
      <RouterLink
        to="/terugblik"
        class="-ml-1 inline-flex min-h-11 w-fit items-center gap-1 text-sm font-medium text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
      >
        <ChevronLeft class="size-4" aria-hidden="true" />
        Terugblik
      </RouterLink>
      <h1 :class="[ui.h1, 'first-letter:uppercase']">
        {{ detail ? detail.draverij.place : 'Terugblik' }}
      </h1>
      <p v-if="detail" :class="[ui.muted, 'first-letter:uppercase']">
        {{ formatDay(detail.draverij.date, true) }}
      </p>
    </header>

    <!-- Loading -->
    <div v-if="loading && !detail" class="flex flex-col gap-3" aria-busy="true" aria-label="Laden">
      <div class="h-24 animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800/60"></div>
      <div class="h-48 animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800/60"></div>
    </div>

    <div v-else-if="loadError && !detail" class="flex flex-col items-start gap-3">
      <AlertBox>{{ loadError }}</AlertBox>
      <div class="flex flex-wrap gap-2">
        <button type="button" :class="ui.btnSecondary" @click="load">Opnieuw proberen</button>
        <RouterLink to="/terugblik" :class="ui.btnGhost">Terug naar Terugblik</RouterLink>
      </div>
    </div>

    <template v-else-if="detail">
      <!-- Saldo: updates live with every corrected payout -->
      <section
        :class="[ui.card, 'flex flex-wrap items-end justify-between gap-x-6 gap-y-2']"
        aria-label="Saldo"
      >
        <div>
          <p :class="ui.muted">Saldo</p>
          <p
            :class="[
              'text-3xl font-semibold tracking-tight tabular-nums',
              balanceClass(detail.balance),
            ]"
            data-testid="balance"
          >
            {{ formatBalance(detail.balance) }}
          </p>
        </div>
        <dl class="flex gap-5 text-sm tabular-nums">
          <div>
            <dt class="text-slate-500 dark:text-slate-400">Ingezet</dt>
            <dd class="font-semibold">{{ formatEuro(detail.staked) }}</dd>
          </div>
          <div>
            <dt class="text-slate-500 dark:text-slate-400">Uitbetaald</dt>
            <dd class="font-semibold">{{ formatEuro(detail.paidOut) }}</dd>
          </div>
        </dl>
      </section>

      <input
        ref="photoInput"
        type="file"
        accept="image/*"
        capture="environment"
        class="sr-only"
        tabindex="-1"
        aria-label="Foto van het uitslagbord"
        data-testid="photo-input"
        @change="onPhoto"
      />

      <!-- Uitslagen -->
      <section
        v-if="!confirmed || editing"
        :class="[ui.card, 'flex flex-col gap-4']"
        aria-labelledby="results-title"
      >
        <div>
          <h2 id="results-title" :class="ui.h2">Uitslagen</h2>
          <p :class="ui.muted">
            Controleer de uitslagen; daarna vergelijkt de AI ze met het advies.
          </p>
        </div>

        <div aria-live="polite" class="flex flex-col gap-3">
          <div
            v-if="thinking"
            class="flex items-center gap-2 rounded-lg bg-slate-100 px-4 py-3 text-sm text-slate-700 dark:bg-slate-800 dark:text-slate-300"
            data-testid="ai-thinking"
          >
            <Sparkles
              class="size-4 animate-pulse text-blue-600 motion-reduce:animate-none dark:text-blue-400"
              aria-hidden="true"
            />
            {{ thinkingTexts[thinkingIndex] }}
          </div>
          <AlertBox v-else-if="resultsFailed && !showForm">
            {{ detail.error ?? 'De AI kon de uitslagen niet ophalen.' }}
          </AlertBox>
          <AlertBox v-if="actionError && !thinking">{{ actionError }}</AlertBox>
        </div>

        <!-- Nothing yet: let the user choose how to get the uitslagen -->
        <div v-if="!thinking && !showForm" class="flex flex-wrap gap-2">
          <button
            v-if="resultsFailed || actionError"
            type="button"
            :class="ui.btnSecondary"
            :disabled="busy !== null"
            @click="run('fetch', fetchResults)"
          >
            <RotateCcw class="size-4" aria-hidden="true" />
            {{ busy === 'fetch' ? 'Opnieuw proberen…' : 'Opnieuw proberen' }}
          </button>
          <button
            type="button"
            :class="ui.btnSecondary"
            :disabled="busy !== null"
            @click="startManual"
          >
            <Pencil class="size-4" aria-hidden="true" />
            Zelf invullen
          </button>
          <button
            type="button"
            :class="ui.btnSecondary"
            :disabled="busy !== null"
            @click="photoInput?.click()"
          >
            <Camera class="size-4" aria-hidden="true" />
            {{ busy === 'photo' ? 'Foto versturen…' : 'Foto uploaden' }}
          </button>
        </div>

        <form
          v-if="showForm"
          class="flex flex-col gap-4"
          novalidate
          @submit.prevent="submitResults"
        >
          <fieldset
            v-for="(r, index) in drafts"
            :key="index"
            class="flex flex-col gap-3 border-t border-slate-200 pt-4 first-of-type:border-t-0 first-of-type:pt-0 dark:border-white/10"
          >
            <div class="flex items-center justify-between gap-3">
              <legend class="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {{ r.omloop }}e omloop
              </legend>
              <button
                v-if="drafts.length > 1"
                type="button"
                :class="[ui.btnGhost, 'size-11 shrink-0 px-0']"
                :aria-label="`${r.omloop}e omloop weghalen`"
                @click="removeOmloop(index)"
              >
                <Trash2 class="size-4" aria-hidden="true" />
              </button>
            </div>
            <div>
              <label :for="`winner-${index}`" :class="ui.label">Winnaar</label>
              <input
                :id="`winner-${index}`"
                v-model="r.winner"
                type="text"
                maxlength="120"
                autocomplete="off"
                :class="ui.input"
                :aria-invalid="!!winnerError(r)"
              />
              <p v-if="winnerError(r)" :class="ui.fieldError">
                <CircleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />{{
                  winnerError(r)
                }}
              </p>
            </div>
            <div>
              <label :for="`places-${index}`" :class="ui.label">Plaatsen</label>
              <input
                :id="`places-${index}`"
                v-model="r.places"
                type="text"
                maxlength="300"
                autocomplete="off"
                placeholder="Bijv. 2. Hessel B, 3. Zilvervos"
                :class="ui.input"
              />
            </div>
          </fieldset>

          <button
            v-if="drafts.length < MAX_OMLOPEN"
            type="button"
            :class="[ui.btnGhost, '-ml-2 w-fit']"
            @click="addOmloop"
          >
            <Plus class="size-4" aria-hidden="true" />
            Omloop toevoegen
          </button>

          <div class="flex flex-wrap gap-2 border-t border-slate-200 pt-4 dark:border-white/10">
            <button
              type="submit"
              :class="[ui.btnPrimary, 'w-full sm:w-fit']"
              :disabled="busy !== null"
            >
              {{ busy === 'confirm' ? 'Bevestigen…' : 'Uitslagen bevestigen' }}
            </button>
            <button
              type="button"
              :class="ui.btnGhost"
              :disabled="busy !== null"
              @click="photoInput?.click()"
            >
              <Camera class="size-4" aria-hidden="true" />
              {{ busy === 'photo' ? 'Foto versturen…' : 'Foto uploaden' }}
            </button>
            <button
              v-if="editing"
              type="button"
              :class="ui.btnGhost"
              :disabled="busy !== null"
              @click="editing = false"
            >
              Annuleren
            </button>
          </div>
        </form>
      </section>

      <!-- Evaluation -->
      <section v-else :class="[ui.card, 'flex flex-col gap-4']" aria-labelledby="evaluation-title">
        <div class="flex items-start justify-between gap-3">
          <h2 id="evaluation-title" :class="ui.h2">Evaluatie</h2>
          <button
            v-if="!thinking"
            type="button"
            :class="[ui.btnGhost, '-mr-2 shrink-0']"
            :disabled="busy !== null"
            @click="startEditing"
          >
            <Pencil class="size-4" aria-hidden="true" />
            Uitslagen aanpassen
          </button>
        </div>

        <div aria-live="polite" class="flex flex-col gap-3">
          <div
            v-if="thinking"
            class="flex items-center gap-2 rounded-lg bg-slate-100 px-4 py-3 text-sm text-slate-700 dark:bg-slate-800 dark:text-slate-300"
            data-testid="ai-thinking"
          >
            <Sparkles
              class="size-4 animate-pulse text-blue-600 motion-reduce:animate-none dark:text-blue-400"
              aria-hidden="true"
            />
            {{ thinkingTexts[thinkingIndex] }}
          </div>
          <template v-else-if="evaluateFailed || !detail.evaluation">
            <AlertBox v-if="evaluateFailed">
              {{ detail.error ?? 'De AI kon de dag niet evalueren.' }}
              De uitslagen zijn bewaard; probeer de evaluatie later opnieuw.
            </AlertBox>
            <p v-else :class="ui.muted">
              De uitslagen zijn bevestigd. De evaluatie is nog niet gemaakt.
            </p>
            <AlertBox v-if="actionError">{{ actionError }}</AlertBox>
            <button
              type="button"
              :class="[ui.btnSecondary, 'w-fit']"
              :disabled="busy !== null"
              @click="run('evaluate', evaluate)"
            >
              <RotateCcw class="size-4" aria-hidden="true" />
              {{
                busy === 'evaluate'
                  ? 'Evaluatie starten…'
                  : evaluateFailed
                    ? 'Evaluatie opnieuw proberen'
                    : 'Evaluatie starten'
              }}
            </button>
          </template>
        </div>

        <template v-if="detail.evaluation && !thinking">
          <p class="text-slate-900 dark:text-slate-100">{{ detail.evaluation.summary }}</p>
          <ul class="flex flex-col divide-y divide-slate-200 dark:divide-white/10">
            <li
              v-for="o in detail.evaluation.omlopen"
              :key="o.omloop"
              class="flex flex-col gap-1 py-3 first:pt-0 last:pb-0"
            >
              <div class="flex flex-wrap items-baseline justify-between gap-x-3">
                <h3 class="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {{ o.omloop }}e omloop
                </h3>
                <p
                  :class="['inline-flex items-center gap-1 text-sm font-semibold', verdict(o).tone]"
                >
                  <component :is="verdict(o).icon" class="size-4" aria-hidden="true" />
                  {{ verdict(o).text }}
                </p>
              </div>
              <p class="text-sm text-slate-700 dark:text-slate-300">
                Winnaar: <strong class="font-semibold">{{ o.winner }}</strong>
                <template v-if="o.advice"> · Advies: {{ o.advice }}</template>
              </p>
              <p :class="ui.muted">{{ o.reason }}</p>
            </li>
          </ul>
        </template>
      </section>

      <BetsList :bets="detail.bets" :busy-id="betBusy" payouts-only @winnings="saveWinnings" />
      <AlertBox v-if="betError">{{ betError }}</AlertBox>
    </template>
  </div>
</template>
