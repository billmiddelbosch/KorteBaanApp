<script setup lang="ts">
import { computed, ref } from 'vue'
import { CircleAlert, Plus, Trash2 } from '@lucide/vue'
import { formatEuro, parseEuro } from '@/lib/format'
import { ui } from '@/lib/ui'
import type { Bet } from '@/types/koersdag'

// What the user actually bet today, with the payout per bet
const props = defineProps<{
  bets: Bet[]
  readonly?: boolean
  // Terugblik: only the payouts can be corrected, bets are not added or removed
  payoutsOnly?: boolean
  // The bet being saved (or 'new' for the add form)
  busyId?: string | null
}>()

const emit = defineEmits<{
  winnings: [betId: string, winnings: number | null]
  remove: [betId: string]
  add: [bet: { bet: string; amount: number }]
}>()

// Newest omloop first: that's where the user is
const sorted = computed(() =>
  [...props.bets].sort((a, b) => b.omloop - a.omloop || b.createdAt.localeCompare(a.createdAt)),
)

// ── Payout per bet: every open bet has its own field ──
const drafts = ref<Record<string, string>>({})
const winningsErrors = ref<Record<string, string>>({})
// Bets whose saved payout is being changed
const editing = ref<Set<string>>(new Set())

const showForm = (bet: Bet) => bet.winnings === null || editing.value.has(bet.id)

function editWinnings(bet: Bet) {
  drafts.value[bet.id] = bet.winnings ? String(bet.winnings).replace('.', ',') : ''
  editing.value = new Set(editing.value).add(bet.id)
}

function done(bet: Bet) {
  const next = new Set(editing.value)
  next.delete(bet.id)
  editing.value = next
  delete winningsErrors.value[bet.id]
}

function saveWinnings(bet: Bet) {
  const winnings = parseEuro(drafts.value[bet.id] ?? '')
  if (winnings === null) {
    winningsErrors.value[bet.id] = 'Vul het uitbetaalde bedrag in, bijv. 12,50.'
    return
  }
  emit('winnings', bet.id, winnings)
  done(bet)
}

function lost(bet: Bet) {
  emit('winnings', bet.id, 0)
  done(bet)
}

// ── Other bet ──
const adding = ref(false)
const newBet = ref('')
const newAmount = ref('')
const addSubmitted = ref(false)
const newBetError = computed(() =>
  addSubmitted.value && !newBet.value.trim() ? 'Vul in waarop je hebt ingezet.' : null,
)
const newAmountError = computed(() => {
  if (!addSubmitted.value) return null
  const amount = parseEuro(newAmount.value)
  return amount === null || amount <= 0 ? 'Vul een inzet in van meer dan € 0.' : null
})

function submitAdd() {
  addSubmitted.value = true
  const amount = parseEuro(newAmount.value)
  if (newBetError.value || newAmountError.value || amount === null) return
  emit('add', { bet: newBet.value.trim(), amount })
  adding.value = false
  addSubmitted.value = false
  newBet.value = ''
  newAmount.value = ''
}
</script>

<template>
  <section :class="[ui.card, 'flex flex-col gap-4']" aria-labelledby="bets-title">
    <h2 id="bets-title" :class="ui.h2">Mijn inzetten</h2>

    <p v-if="!bets.length && payoutsOnly" :class="ui.muted">Je hebt deze koersdag niets ingezet.</p>
    <p v-else-if="!bets.length" :class="ui.muted">
      Nog niets ingezet. Tik bij een advies op <strong class="font-semibold">Ingezet</strong> zodra
      je de inzet hebt geplaatst.
    </p>

    <ul v-else class="flex flex-col divide-y divide-slate-200 dark:divide-white/10">
      <li v-for="bet in sorted" :key="bet.id" class="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="font-semibold text-slate-900 dark:text-slate-100">{{ bet.bet }}</p>
            <p :class="ui.muted">
              {{ bet.omloop }}e omloop · ingezet
              <span class="tabular-nums">{{ formatEuro(bet.amount) }}</span>
            </p>
          </div>
          <button
            v-if="!readonly && !payoutsOnly"
            type="button"
            :class="[ui.btnGhost, 'size-11 shrink-0 px-0']"
            :disabled="busyId === bet.id"
            :aria-label="`Inzet verwijderen: ${bet.bet}`"
            @click="emit('remove', bet.id)"
          >
            <Trash2 class="size-4" aria-hidden="true" />
          </button>
        </div>

        <form
          v-if="!readonly && showForm(bet)"
          class="flex flex-col gap-1.5"
          novalidate
          @submit.prevent="saveWinnings(bet)"
        >
          <label :for="`winnings-${bet.id}`" class="text-sm text-slate-700 dark:text-slate-300">
            Uitbetaald
          </label>
          <div class="flex flex-wrap gap-2">
            <input
              :id="`winnings-${bet.id}`"
              v-model="drafts[bet.id]"
              type="text"
              inputmode="decimal"
              autocomplete="off"
              placeholder="€ 0,00"
              :class="[ui.input, 'mt-0 w-32 tabular-nums']"
              :aria-invalid="!!winningsErrors[bet.id]"
            />
            <button type="submit" :class="ui.btnSecondary" :disabled="busyId === bet.id">
              Opslaan
            </button>
            <button
              type="button"
              :class="ui.btnGhost"
              :disabled="busyId === bet.id"
              @click="lost(bet)"
            >
              Verloren
            </button>
          </div>
          <p v-if="winningsErrors[bet.id]" :class="ui.fieldError">
            <CircleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />{{
              winningsErrors[bet.id]
            }}
          </p>
        </form>
        <div v-else-if="bet.winnings !== null" class="flex items-center justify-between gap-3">
          <p
            :class="[
              'text-sm font-semibold tabular-nums',
              bet.winnings > 0
                ? 'text-emerald-700 dark:text-emerald-400'
                : 'text-slate-600 dark:text-slate-400',
            ]"
          >
            {{ bet.winnings > 0 ? `Uitbetaald ${formatEuro(bet.winnings)}` : 'Verloren' }}
          </p>
          <button v-if="!readonly" type="button" :class="ui.btnGhost" @click="editWinnings(bet)">
            Wijzigen
          </button>
        </div>
        <p v-else-if="readonly" :class="ui.muted">Uitbetaling niet ingevuld</p>
      </li>
    </ul>

    <template v-if="!readonly && !payoutsOnly">
      <form
        v-if="adding"
        class="flex flex-col gap-3 border-t border-slate-200 pt-4 dark:border-white/10"
        novalidate
        @submit.prevent="submitAdd"
      >
        <div>
          <label for="new-bet" :class="ui.label">Waarop heb je ingezet?</label>
          <input
            id="new-bet"
            v-model="newBet"
            type="text"
            maxlength="120"
            autocomplete="off"
            placeholder="Bijv. Winnaar: Hessel B"
            :class="ui.input"
            :aria-invalid="!!newBetError"
          />
          <p v-if="newBetError" :class="ui.fieldError">
            <CircleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />{{ newBetError }}
          </p>
        </div>
        <div>
          <label for="new-amount" :class="ui.label">Inzet</label>
          <input
            id="new-amount"
            v-model="newAmount"
            type="text"
            inputmode="decimal"
            autocomplete="off"
            :class="[ui.input, 'w-32 tabular-nums']"
            :aria-invalid="!!newAmountError"
          />
          <p v-if="newAmountError" :class="ui.fieldError">
            <CircleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />{{ newAmountError }}
          </p>
        </div>
        <div class="flex gap-2">
          <button type="submit" :class="ui.btnPrimary" :disabled="busyId === 'new'">
            {{ busyId === 'new' ? 'Toevoegen…' : 'Inzet toevoegen' }}
          </button>
          <button type="button" :class="ui.btnGhost" @click="adding = false">Annuleren</button>
        </div>
      </form>
      <button v-else type="button" :class="[ui.btnGhost, '-ml-2 w-fit']" @click="adding = true">
        <Plus class="size-4" aria-hidden="true" />
        Andere inzet toevoegen
      </button>
    </template>
  </section>
</template>
