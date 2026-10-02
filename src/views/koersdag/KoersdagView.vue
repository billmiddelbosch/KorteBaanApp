<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { Camera, ChevronRight, Flag, Plus, RotateCcw, ScanSearch, Sparkles, X } from '@lucide/vue'
import AlertBox from '@/components/account/AlertBox.vue'
import ConfirmDialog from '@/components/account/ConfirmDialog.vue'
import BetsList from '@/components/koersdag/BetsList.vue'
import StartForm from '@/components/koersdag/StartForm.vue'
import UpdateCard from '@/components/koersdag/UpdateCard.vue'
import { errorMessage, errorStatus } from '@/lib/errors'
import { balanceClass, daysUntil, formatBalance, formatDay, formatEuro } from '@/lib/format'
import { type CompressedPhoto, compressPhoto } from '@/lib/photo'
import { ui } from '@/lib/ui'
import { MAX_BOARD_PHOTOS, type StartInput, useKoersdagStore } from '@/stores/koersdag'
import type { Suggestion } from '@/types/koersdag'

const THINKING_TEXTS = {
  fetch: [
    'Zoekt afmeldingen…',
    'Checkt wijzigingen in de loting…',
    'Haalt quoteringen op…',
    'Weegt het advies opnieuw…',
  ],
  photo: ['Leest het bord…', 'Vergelijkt met de bekende info…', 'Weegt het advies opnieuw…'],
}

const store = useKoersdagStore()
const koersdag = computed(() => store.current)
const finished = computed(() => !!koersdag.value?.finishedAt)

// Newest update of the current omloop on top; earlier ones collapse
const latest = computed(() => koersdag.value?.updates.at(-1) ?? null)
const earlier = computed(() => [...(koersdag.value?.updates.slice(0, -1) ?? [])].reverse())
const canFinishNow = computed(() => !!latest.value?.isFinal)

// Refused by the AI connection or daily limit: refresh so the notice in the shell explains why
async function handleActionError(error: unknown): Promise<string> {
  if ([409, 429, 503].includes(errorStatus(error) ?? 0)) await store.refreshMe()
  return errorMessage(error)
}

// One place for the error of the last action, shown above the action bar
const actionError = ref<string | null>(null)
const busy = ref<string | null>(null)

async function run(key: string, action: () => Promise<void>): Promise<boolean> {
  busy.value = key
  actionError.value = null
  try {
    await action()
    return true
  } catch (error) {
    actionError.value = await handleActionError(error)
    return false
  } finally {
    busy.value = null
  }
}

// ── Start ──
const startError = ref<string | null>(null)
const starting = ref(false)

async function start(input: StartInput) {
  starting.value = true
  startError.value = null
  try {
    await store.start(input)
  } catch (error) {
    startError.value = await handleActionError(error)
  } finally {
    starting.value = false
  }
}

// ── Thinking indicator ──
const thinkingIndex = ref(0)
const thinkingTexts = computed(() => THINKING_TEXTS[koersdag.value?.step ?? 'fetch'])
let thinkingTimer: ReturnType<typeof setInterval> | undefined
watch(
  () => store.thinking,
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

// ── Photo of the board ──
// The board doesn't always fit in one photo: collect a few, then check them together
const photoInput = ref<HTMLInputElement | null>(null)
const pendingPhotos = ref<CompressedPhoto[]>([])
const canAddPhoto = computed(() => pendingPhotos.value.length < MAX_BOARD_PHOTOS)
const photoSrc = (photo: CompressedPhoto) => `data:${photo.mediaType};base64,${photo.image}`

async function onPhoto(event: Event) {
  const input = event.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  input.value = ''
  if (!files.length) return
  await run('compress', async () => {
    for (const file of files) {
      if (!canAddPhoto.value) break
      pendingPhotos.value.push(await compressPhoto(file))
    }
  })
}

const removePhoto = (index: number) => pendingPhotos.value.splice(index, 1)

async function sendPhotos() {
  if (await run('photo', () => store.sendPhotos(pendingPhotos.value))) pendingPhotos.value = []
}

// ── Bets ──
const betBusy = ref<string | null>(null)
const betError = ref<string | null>(null)
// Show the error next to what was tapped: the advice card or the bets list
const betErrorKey = ref<string | null>(null)
const suggestionError = computed(() =>
  latest.value?.advice.some((s) => s.id === betErrorKey.value) ? betError.value : null,
)

async function betAction(key: string, action: () => Promise<void>) {
  betBusy.value = key
  betError.value = null
  betErrorKey.value = key
  try {
    await action()
  } catch (error) {
    betError.value = errorMessage(error)
  } finally {
    betBusy.value = null
  }
}

const placeBet = (suggestion: Suggestion, amount: number) =>
  betAction(suggestion.id, () =>
    store.addBet({
      bet: `${suggestion.race}: ${suggestion.bet}`,
      amount,
      suggestionId: suggestion.id,
    }),
  )

// ── Finish ──
const finishOpen = ref(false)

async function finish() {
  if (await run('finish', store.finish)) finishOpen.value = false
}

onMounted(() => {
  if (!store.today && !store.loading) void store.load()
})
</script>

<template>
  <div :class="[ui.page, koersdag && !finished ? 'pb-0 md:pb-0' : '']">
    <header>
      <h1 :class="ui.h1">Koersdag</h1>
      <p v-if="koersdag" :class="[ui.muted, 'first-letter:uppercase']">
        {{ koersdag.draverij.place }} · {{ formatDay(koersdag.draverij.date) }}
      </p>
    </header>

    <!-- Loading -->
    <div
      v-if="store.loading && !store.today"
      class="flex flex-col gap-3"
      aria-busy="true"
      aria-label="Laden"
    >
      <div class="h-24 animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800/60"></div>
      <div class="h-48 animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800/60"></div>
    </div>

    <div v-else-if="store.loadError" class="flex flex-col items-start gap-3">
      <AlertBox>{{ store.loadError }}</AlertBox>
      <button type="button" :class="ui.btnSecondary" @click="store.load">Opnieuw proberen</button>
    </div>

    <!-- No koersdag yet: start one -->
    <template v-else-if="store.today && !koersdag">
      <section
        v-if="!store.today.options.length"
        :class="[ui.card, 'flex flex-col gap-2']"
        aria-label="Geen draverij vandaag"
      >
        <p class="font-semibold text-slate-900 dark:text-slate-100">
          Vandaag staat er geen draverij met een analyse klaar.
        </p>
        <p v-if="store.today.next" :class="ui.muted">
          Je volgende vastgelegde advies is voor
          <strong class="font-semibold">{{ store.today.next.draverij.place }}</strong>
          ({{ daysUntil(store.today.next.draverij.date) }}).
        </p>
        <RouterLink
          :to="store.today.next ? `/analyse/${store.today.next.draverij.id}` : '/analyse'"
          class="inline-flex min-h-11 w-fit items-center gap-1 font-semibold text-blue-700 underline-offset-2 hover:underline dark:text-blue-300"
        >
          {{ store.today.next ? 'Naar deze analyse' : 'Naar Analyse' }}
          <ChevronRight class="size-4" aria-hidden="true" />
        </RouterLink>
        <p :class="ui.muted">Ben je toch op de baan? Vul hieronder de plaats in.</p>
      </section>
      <StartForm
        :options="store.today.options"
        :busy="starting"
        :error="startError"
        @start="start"
      />
    </template>

    <!-- Finished: the result of the day -->
    <template v-else-if="koersdag && finished">
      <section :class="[ui.card, 'flex flex-col gap-4']" aria-labelledby="summary-title">
        <h2 id="summary-title" :class="ui.h2">Koersdag afgerond</h2>
        <dl class="grid grid-cols-3 gap-3">
          <div>
            <dt :class="ui.muted">Ingezet</dt>
            <dd class="text-lg font-semibold tabular-nums">{{ formatEuro(koersdag.staked) }}</dd>
          </div>
          <div>
            <dt :class="ui.muted">Uitbetaald</dt>
            <dd class="text-lg font-semibold tabular-nums">{{ formatEuro(koersdag.paidOut) }}</dd>
          </div>
          <div>
            <dt :class="ui.muted">Saldo</dt>
            <dd
              :class="[
                'text-lg font-semibold tabular-nums',
                balanceClass(koersdag.paidOut - koersdag.staked),
              ]"
            >
              {{ formatBalance(koersdag.paidOut - koersdag.staked) }}
            </dd>
          </div>
        </dl>
        <RouterLink to="/terugblik" :class="[ui.btnPrimary, 'w-full sm:w-fit']">
          Naar Terugblik
          <ChevronRight class="size-4" aria-hidden="true" />
        </RouterLink>
      </section>
      <BetsList :bets="koersdag.bets" readonly />
    </template>

    <!-- Active koersdag -->
    <template v-else-if="koersdag">
      <!-- Budget -->
      <section
        :class="[ui.card, 'flex flex-wrap items-end justify-between gap-x-6 gap-y-2']"
        aria-label="Budget"
      >
        <div>
          <p :class="ui.muted">Nog over</p>
          <p
            class="text-3xl font-semibold tracking-tight tabular-nums text-slate-900 dark:text-slate-100"
          >
            {{ formatEuro(koersdag.remaining) }}
          </p>
        </div>
        <dl class="flex gap-5 text-sm tabular-nums">
          <div>
            <dt class="text-slate-500 dark:text-slate-400">Budget</dt>
            <dd class="font-semibold">{{ formatEuro(koersdag.budget) }}</dd>
          </div>
          <div>
            <dt class="text-slate-500 dark:text-slate-400">Ingezet</dt>
            <dd class="font-semibold">{{ formatEuro(koersdag.staked) }}</dd>
          </div>
          <div>
            <dt class="text-slate-500 dark:text-slate-400">Uitbetaald</dt>
            <dd class="font-semibold">{{ formatEuro(koersdag.paidOut) }}</dd>
          </div>
        </dl>
      </section>

      <!-- Current omloop -->
      <section :class="[ui.card, 'flex flex-col gap-4']" aria-labelledby="omloop-title">
        <h2 id="omloop-title" :class="ui.h2">{{ koersdag.omloop }}e omloop</h2>

        <div aria-live="polite" class="flex flex-col gap-3">
          <div
            v-if="store.thinking"
            class="flex items-center gap-2 rounded-lg bg-slate-100 px-4 py-3 text-sm text-slate-700 dark:bg-slate-800 dark:text-slate-300"
            data-testid="ai-thinking"
          >
            <Sparkles
              class="size-4 animate-pulse text-blue-600 motion-reduce:animate-none dark:text-blue-400"
              aria-hidden="true"
            />
            {{ thinkingTexts[thinkingIndex] }}
          </div>
          <template v-else-if="koersdag.status === 'error'">
            <AlertBox>
              {{ koersdag.error ?? 'De AI kon geen nieuwe update maken.' }}
              <template v-if="latest">Het laatste advies hieronder blijft staan.</template>
              Je kunt ook een foto van het bord sturen.
            </AlertBox>
            <button
              type="button"
              :class="[ui.btnSecondary, 'w-fit']"
              :disabled="busy !== null"
              @click="run('refresh', store.refresh)"
            >
              <RotateCcw class="size-4" aria-hidden="true" />
              {{ busy === 'refresh' ? 'Opnieuw proberen…' : 'Opnieuw proberen' }}
            </button>
          </template>
        </div>

        <UpdateCard
          v-if="latest"
          :update="latest"
          :bets="koersdag.bets"
          :busy-id="betBusy"
          :error="suggestionError"
          @bet="placeBet"
        />
        <p v-else-if="!store.thinking && koersdag.status !== 'error'" :class="ui.muted">
          Nog geen advies voor deze omloop.
        </p>

        <details v-if="earlier.length" class="border-t border-slate-200 pt-3 dark:border-white/10">
          <summary
            class="-mx-1 inline-flex min-h-11 cursor-pointer items-center rounded px-1 text-sm font-medium text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
          >
            Eerdere updates ({{ earlier.length }})
          </summary>
          <div class="mt-3 flex flex-col gap-6">
            <div v-for="update in earlier" :key="update.id" class="flex flex-col gap-2">
              <h3 class="text-sm font-semibold text-slate-500 dark:text-slate-400">
                {{ update.omloop }}e omloop
              </h3>
              <UpdateCard :update="update" :bets="koersdag.bets" readonly />
            </div>
          </div>
        </details>
      </section>

      <BetsList
        :bets="koersdag.bets"
        :busy-id="betBusy"
        @winnings="(id, winnings) => betAction(id, () => store.updateBet(id, { winnings }))"
        @remove="(id) => betAction(id, () => store.removeBet(id))"
        @add="(bet) => betAction('new', () => store.addBet(bet))"
      />
      <AlertBox v-if="betError && !suggestionError">{{ betError }}</AlertBox>

      <button
        v-if="!canFinishNow"
        type="button"
        :class="[ui.btnGhost, '-mt-2 w-fit self-center']"
        @click="finishOpen = true"
      >
        <Flag class="size-4" aria-hidden="true" />
        Koersdag nu afronden
      </button>

      <!-- Actions: always within thumb reach -->
      <div
        class="sticky bottom-[calc(var(--shell-bottom,0px)+env(safe-area-inset-bottom))] z-30 -mx-4 flex flex-col gap-2 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur-md md:bottom-0 md:-mx-8 md:px-8 dark:border-white/10 dark:bg-slate-950/95"
      >
        <AlertBox v-if="actionError">{{ actionError }}</AlertBox>
        <input
          ref="photoInput"
          type="file"
          accept="image/*"
          capture="environment"
          class="sr-only"
          tabindex="-1"
          aria-label="Foto van het bord"
          data-testid="photo-input"
          @change="onPhoto"
        />
        <!-- Photos waiting to be checked together -->
        <div v-if="pendingPhotos.length" class="flex flex-col gap-2" data-testid="pending-photos">
          <p :class="ui.muted">
            Staat niet het hele bord op de foto? Voeg nog een foto toe (maximaal
            {{ MAX_BOARD_PHOTOS }}).
          </p>
          <ul class="flex gap-2" aria-label="Foto's van het bord">
            <li v-for="(photo, index) in pendingPhotos" :key="index" class="relative">
              <img
                :src="photoSrc(photo)"
                :alt="`Foto ${index + 1} van het bord`"
                class="size-16 rounded-lg border border-slate-200 object-cover dark:border-white/10"
              />
              <button
                type="button"
                class="absolute -top-2 -right-2 flex size-7 items-center justify-center rounded-full bg-slate-900 text-white shadow hover:bg-slate-700 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
                :aria-label="`Foto ${index + 1} verwijderen`"
                :disabled="busy !== null"
                @click="removePhoto(index)"
              >
                <X class="size-4" aria-hidden="true" />
              </button>
            </li>
          </ul>
          <div class="flex gap-2">
            <button
              v-if="canAddPhoto"
              type="button"
              :class="[ui.btnSecondary, 'min-h-12 flex-1 text-base']"
              :disabled="store.thinking || busy !== null"
              @click="photoInput?.click()"
            >
              <Plus class="size-5" aria-hidden="true" />
              {{ busy === 'compress' ? 'Foto verwerken…' : 'Nog een foto' }}
            </button>
            <button
              type="button"
              :class="[ui.btnPrimary, 'min-h-12 flex-1 text-base']"
              :disabled="store.thinking || busy !== null"
              @click="sendPhotos"
            >
              <ScanSearch class="size-5" aria-hidden="true" />
              <template v-if="busy === 'photo'">Bord controleren…</template>
              <template v-else-if="pendingPhotos.length > 1">
                Controleer bord ({{ pendingPhotos.length }} foto's)
              </template>
              <template v-else>Controleer bord</template>
            </button>
          </div>
        </div>
        <div v-else class="flex gap-2">
          <button
            type="button"
            :class="[canFinishNow ? ui.btnSecondary : ui.btnPrimary, 'min-h-12 flex-1 text-base']"
            :disabled="store.thinking || busy !== null"
            @click="photoInput?.click()"
          >
            <Camera class="size-5" aria-hidden="true" />
            {{ busy === 'compress' ? 'Foto verwerken…' : 'Foto van het bord' }}
          </button>
          <button
            v-if="canFinishNow"
            type="button"
            :class="[ui.btnPrimary, 'min-h-12 flex-1 text-base']"
            :disabled="store.thinking || busy !== null"
            @click="run('finish', store.finish)"
          >
            <Flag class="size-5" aria-hidden="true" />
            {{ busy === 'finish' ? 'Afronden…' : 'Koersdag afronden' }}
          </button>
          <button
            v-else
            type="button"
            :class="[ui.btnSecondary, 'min-h-12 flex-1 text-base']"
            :disabled="store.thinking || busy !== null"
            @click="run('next', store.nextOmloop)"
          >
            {{ busy === 'next' ? 'Volgende omloop…' : 'Volgende omloop' }}
            <ChevronRight class="size-5" aria-hidden="true" />
          </button>
        </div>
      </div>
    </template>

    <ConfirmDialog
      :open="finishOpen"
      title="Koersdag nu afronden?"
      confirm-label="Koersdag afronden"
      cancel-label="Doorgaan met de koersdag"
      :busy="busy === 'finish'"
      @confirm="finish"
      @cancel="finishOpen = false"
    >
      <p>
        De finale is nog niet geweest. Na afronden kun je geen updates of inzetten meer toevoegen;
        de uitslag komt in Terugblik.
      </p>
      <AlertBox v-if="actionError" class="mt-3">{{ actionError }}</AlertBox>
    </ConfirmDialog>
  </div>
</template>
