<script setup lang="ts">
import { computed, ref } from 'vue'
import { Camera, CircleAlert, CircleCheck, Globe, RefreshCw, Sparkles, TriangleAlert } from '@lucide/vue'
import AlertBox from '@/components/account/AlertBox.vue'
import { formatEuro, parseEuro } from '@/lib/format'
import { ui } from '@/lib/ui'
import type { Bet, KoersdagUpdate, Suggestion } from '@/types/koersdag'

// One AI update for an omloop: the verdict, the advice (with "Ingezet") and what the AI found
const props = defineProps<{
  update: KoersdagUpdate
  bets: Bet[]
  // Finished koersdag: no betting any more
  readonly?: boolean
  // The suggestion whose bet is being saved
  busyId?: string | null
  error?: string | null
}>()

const emit = defineEmits<{ bet: [suggestion: Suggestion, amount: number] }>()

const verdict = computed(
  () =>
    ({
      first: {
        label: 'Eerste advies',
        icon: Sparkles,
        style: 'bg-blue-50 text-blue-900 dark:bg-blue-400/10 dark:text-blue-100',
      },
      kept: {
        label: 'Advies blijft staan',
        icon: CircleCheck,
        style: 'bg-emerald-50 text-emerald-900 dark:bg-emerald-400/10 dark:text-emerald-100',
      },
      changed: {
        label: 'Advies aangepast',
        icon: RefreshCw,
        style: 'bg-amber-50 text-amber-900 dark:bg-amber-400/10 dark:text-amber-100',
      },
    })[props.update.verdict],
)

const betFor = (suggestion: Suggestion) => props.bets.find((b) => b.suggestionId === suggestion.id)

const decimal = (n: number) => n.toLocaleString('nl-NL', { maximumFractionDigits: 2 })
const percent = (n: number) => `${Math.round(n * 100)}%`

// "Kans 40% · quota 3,2 · verwachting +28%", or the break-even quota when the board is unknown
function valueLine(s: Suggestion): { text: string; positive: boolean | null } | null {
  if (s.chance == null) return null
  const parts = [`Kans ${percent(s.chance)}`]
  if (s.odds != null && s.expectedValue != null) {
    parts.push(`quota ${decimal(s.odds)}`, `verwachting ${s.expectedValue > 0 ? '+' : ''}${percent(s.expectedValue)}`)
    return { text: parts.join(' · '), positive: s.expectedValue > 0 }
  }
  if (s.minOdds != null) parts.push(`zinvol vanaf quota ${decimal(s.minOdds)}`)
  return { text: parts.join(' · '), positive: null }
}

// ── Inline "Ingezet" form ──
const editingId = ref<string | null>(null)
const amountText = ref('')
const amountError = ref<string | null>(null)

function openBet(suggestion: Suggestion) {
  editingId.value = suggestion.id
  amountText.value = suggestion.amount !== null ? String(suggestion.amount).replace('.', ',') : ''
  amountError.value = null
}

function confirmBet(suggestion: Suggestion) {
  const amount = parseEuro(amountText.value)
  if (amount === null || amount <= 0) {
    amountError.value = 'Vul een inzet in van meer dan € 0.'
    return
  }
  emit('bet', suggestion, amount)
  editingId.value = null
}
</script>

<template>
  <article class="flex flex-col gap-4" :aria-label="`Update ${update.omloop}e omloop`">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <p
        :class="[
          'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold',
          verdict.style,
        ]"
      >
        <component :is="verdict.icon" class="size-4" aria-hidden="true" />
        {{ verdict.label }}
      </p>
      <p class="inline-flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-400">
        <component :is="update.kind === 'photo' ? Camera : Globe" class="size-4" aria-hidden="true" />
        {{ update.kind === 'photo' ? 'Gecontroleerd met foto' : 'Online opgehaald' }}
      </p>
    </div>

    <!-- Photo check: the photo wins -->
    <div
      v-if="update.photoCheck"
      :class="[
        'rounded-lg border p-3 text-sm',
        update.photoCheck.matches
          ? 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-400/20 dark:bg-emerald-400/10 dark:text-emerald-100'
          : 'border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-100',
      ]"
    >
      <p class="flex items-center gap-2 font-semibold">
        <component
          :is="update.photoCheck.matches ? CircleCheck : TriangleAlert"
          class="size-4 shrink-0"
          aria-hidden="true"
        />
        {{ update.photoCheck.matches ? 'Klopt met het bord' : 'Verschillen met het bord' }}
      </p>
      <ul v-if="update.photoCheck.differences.length" class="mt-1.5 flex flex-col gap-1 pl-6">
        <li v-for="(difference, i) in update.photoCheck.differences" :key="i" class="list-disc">
          {{ difference }}
        </li>
      </ul>
    </div>

    <!-- The advice: the most important part -->
    <section aria-label="Advies" class="flex flex-col gap-3">
      <p v-if="update.adviceNote" class="text-base font-medium text-slate-900 dark:text-slate-100">
        {{ update.adviceNote }}
      </p>
      <p
        v-if="!update.advice.length"
        class="rounded-lg border border-slate-200 bg-slate-50 p-3 font-semibold text-slate-800 dark:border-white/10 dark:bg-slate-800 dark:text-slate-100"
      >
        Niet (extra) inzetten deze omloop.
      </p>
      <ul v-else class="flex flex-col gap-3">
        <li
          v-for="suggestion in update.advice"
          :key="suggestion.id"
          :class="[
            'rounded-lg border p-3',
            suggestion.changed
              ? 'border-amber-300 border-l-4 dark:border-amber-400/50'
              : 'border-slate-200 dark:border-white/10',
          ]"
          data-testid="suggestion"
        >
          <div class="flex items-baseline justify-between gap-3">
            <p class="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              {{ suggestion.race }}
              <span
                v-if="suggestion.changed"
                class="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 normal-case tracking-normal text-amber-900 dark:bg-amber-400/20 dark:text-amber-100"
                >Gewijzigd</span
              >
            </p>
            <p
              v-if="suggestion.amount !== null"
              class="shrink-0 text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-100"
            >
              {{ formatEuro(suggestion.amount) }}
            </p>
          </div>
          <p class="mt-0.5 text-base font-semibold text-slate-900 dark:text-slate-100">
            {{ suggestion.bet }}
          </p>
          <p
            v-if="valueLine(suggestion)"
            :class="[
              'mt-0.5 text-sm font-medium tabular-nums',
              valueLine(suggestion)!.positive === true
                ? 'text-emerald-700 dark:text-emerald-400'
                : valueLine(suggestion)!.positive === false
                  ? 'text-red-700 dark:text-red-400'
                  : 'text-slate-700 dark:text-slate-300',
            ]"
            data-testid="suggestion-value"
          >
            {{ valueLine(suggestion)!.text }}
          </p>
          <p v-if="suggestion.reasoning" class="mt-0.5 text-sm text-slate-600 dark:text-slate-400">
            {{ suggestion.reasoning }}
          </p>

          <p
            v-if="betFor(suggestion)"
            class="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-emerald-700 dark:text-emerald-400"
          >
            <CircleCheck class="size-4" aria-hidden="true" />
            Ingezet: {{ formatEuro(betFor(suggestion)!.amount) }}
          </p>
          <template v-else-if="!readonly">
            <form
              v-if="editingId === suggestion.id"
              class="mt-3 flex flex-col gap-2"
              novalidate
              @submit.prevent="confirmBet(suggestion)"
            >
              <label :for="`bet-${suggestion.id}`" :class="ui.label">Hoeveel heb je ingezet?</label>
              <div class="flex gap-2">
                <input
                  :id="`bet-${suggestion.id}`"
                  v-model="amountText"
                  type="text"
                  inputmode="decimal"
                  autocomplete="off"
                  :class="[ui.input, 'mt-0 tabular-nums']"
                  :aria-invalid="!!amountError"
                />
                <button type="submit" :class="[ui.btnPrimary, 'shrink-0']">Opslaan</button>
                <button type="button" :class="[ui.btnGhost, 'shrink-0']" @click="editingId = null">
                  Annuleren
                </button>
              </div>
              <p v-if="amountError" :class="ui.fieldError">
                <CircleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />{{ amountError }}
              </p>
            </form>
            <button
              v-else
              type="button"
              :class="[ui.btnSecondary, 'mt-3 w-full sm:w-auto']"
              :disabled="busyId === suggestion.id"
              @click="openBet(suggestion)"
            >
              <CircleCheck class="size-4" aria-hidden="true" />
              {{ busyId === suggestion.id ? 'Opslaan…' : 'Ingezet' }}
            </button>
          </template>
        </li>
      </ul>
      <AlertBox v-if="error">{{ error }}</AlertBox>
    </section>

    <section v-if="update.changes.length" aria-label="Wat er veranderde">
      <h3 class="text-sm font-semibold text-slate-900 dark:text-slate-100">Wat er veranderde</h3>
      <ul class="mt-1.5 flex flex-col gap-1 pl-5 text-sm text-slate-700 dark:text-slate-300">
        <li v-for="(change, i) in update.changes" :key="i" class="list-disc">{{ change }}</li>
      </ul>
    </section>

    <section v-if="update.findings.length" aria-label="Wat de AI vond">
      <h3 class="text-sm font-semibold text-slate-900 dark:text-slate-100">Wat de AI vond</h3>
      <ul class="mt-1.5 flex flex-col gap-1 pl-5 text-sm text-slate-700 dark:text-slate-300">
        <li v-for="(finding, i) in update.findings" :key="i" class="list-disc">{{ finding }}</li>
      </ul>
    </section>

    <details v-if="update.sources.length" class="text-sm">
      <summary
        class="-mx-1 inline-flex min-h-11 cursor-pointer items-center rounded px-1 font-medium text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
      >
        Bronnen ({{ update.sources.length }})
      </summary>
      <ul class="mt-1 flex flex-col gap-1">
        <li v-for="source in update.sources" :key="source.url">
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
  </article>
</template>
