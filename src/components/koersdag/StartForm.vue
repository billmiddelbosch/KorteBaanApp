<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { CircleAlert, Flag } from '@lucide/vue'
import AlertBox from '@/components/account/AlertBox.vue'
import { formatEuro, parseEuro } from '@/lib/format'
import { ui } from '@/lib/ui'
import type { StartInput } from '@/stores/koersdag'
import type { KoersdagOption } from '@/types/koersdag'

const OTHER = '__other__'

// Pick today's draverij and the budget. Without draverijen today, only a place can be typed.
const props = defineProps<{
  options: KoersdagOption[]
  busy: boolean
  error: string | null
}>()

const emit = defineEmits<{ start: [input: StartInput] }>()

// Preselect the draverij with a locked advice: that's almost always the one
const choice = ref(
  props.options.find((o) => o.advice)?.draverij.id ?? props.options[0]?.draverij.id ?? OTHER,
)
const place = ref('')
const selected = computed(() => props.options.find((o) => o.draverij.id === choice.value) ?? null)

const budgetText = ref('')
const adviceBudget = computed(() => selected.value?.advice?.proposal.budget ?? null)
watch(
  adviceBudget,
  (budget) => {
    budgetText.value = budget !== null ? String(budget).replace('.', ',') : ''
  },
  { immediate: true },
)

const submitted = ref(false)
const budget = computed(() => parseEuro(budgetText.value))
const budgetError = computed(() => {
  if (!submitted.value) return null
  if (budget.value === null || budget.value <= 0) return 'Vul een budget in van meer dan € 0.'
  return null
})
const placeError = computed(() =>
  submitted.value && choice.value === OTHER && !place.value.trim()
    ? 'Vul de plaats van de draverij in.'
    : null,
)

function submit() {
  submitted.value = true
  if (budgetError.value || placeError.value || budget.value === null) return
  emit(
    'start',
    choice.value === OTHER
      ? { place: place.value.trim(), budget: budget.value }
      : { draverijId: choice.value, budget: budget.value },
  )
}
</script>

<template>
  <form :class="[ui.card, 'flex flex-col gap-5']" novalidate @submit.prevent="submit">
    <fieldset v-if="options.length" class="flex flex-col gap-2">
      <legend :class="[ui.label, 'mb-2']">Draverij van vandaag</legend>
      <label
        v-for="option in options"
        :key="option.draverij.id"
        :class="[
          'flex min-h-14 cursor-pointer items-center gap-3 rounded-lg border px-4 py-3 has-focus-visible:outline-2 has-focus-visible:outline-blue-600',
          choice === option.draverij.id
            ? 'border-blue-600 bg-blue-50 dark:border-blue-400 dark:bg-blue-400/10'
            : 'border-slate-300 hover:bg-slate-50 dark:border-white/15 dark:hover:bg-white/5',
        ]"
      >
        <input
          v-model="choice"
          type="radio"
          name="draverij"
          :value="option.draverij.id"
          class="size-4 accent-blue-600"
        />
        <span class="flex min-w-0 flex-col">
          <span class="font-semibold text-slate-900 dark:text-slate-100">
            {{ option.draverij.place }}
          </span>
          <span :class="ui.muted">
            <template v-if="option.advice">
              Advies vastgelegd<template v-if="option.advice.proposal.budget !== null">
                · budget {{ formatEuro(option.advice.proposal.budget) }}</template
              >
            </template>
            <template v-else>Geen vastgelegd advies: de AI maakt een eerste advies</template>
          </span>
        </span>
      </label>
      <label
        :class="[
          'flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-4 has-focus-visible:outline-2 has-focus-visible:outline-blue-600',
          choice === OTHER
            ? 'border-blue-600 bg-blue-50 dark:border-blue-400 dark:bg-blue-400/10'
            : 'border-slate-300 hover:bg-slate-50 dark:border-white/15 dark:hover:bg-white/5',
        ]"
      >
        <input v-model="choice" type="radio" name="draverij" :value="OTHER" class="size-4 accent-blue-600" />
        <span class="text-sm font-medium text-slate-800 dark:text-slate-200">Andere draverij</span>
      </label>
    </fieldset>

    <div v-if="choice === OTHER">
      <label for="koersdag-place" :class="ui.label">Plaats van de draverij</label>
      <input
        id="koersdag-place"
        v-model="place"
        type="text"
        maxlength="40"
        autocomplete="off"
        placeholder="Bijv. Wolvega"
        :class="ui.input"
        :aria-invalid="!!placeError"
        :aria-describedby="placeError ? 'koersdag-place-error' : undefined"
      />
      <p v-if="placeError" id="koersdag-place-error" :class="ui.fieldError">
        <CircleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />{{ placeError }}
      </p>
    </div>

    <div>
      <label for="koersdag-budget" :class="ui.label">Budget voor vandaag</label>
      <div class="relative">
        <span
          class="pointer-events-none absolute inset-y-0 left-3 mt-1.5 flex items-center text-slate-500 dark:text-slate-400"
          aria-hidden="true"
          >€</span
        >
        <input
          id="koersdag-budget"
          v-model="budgetText"
          type="text"
          inputmode="decimal"
          autocomplete="off"
          :class="[ui.input, 'pl-8 tabular-nums']"
          :aria-invalid="!!budgetError"
          :aria-describedby="budgetError ? 'koersdag-budget-error' : 'koersdag-budget-hint'"
        />
      </div>
      <p v-if="budgetError" id="koersdag-budget-error" :class="ui.fieldError">
        <CircleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />{{ budgetError }}
      </p>
      <p v-else id="koersdag-budget-hint" :class="ui.hint">
        {{
          adviceBudget !== null
            ? 'Overgenomen uit je vastgelegde advies; je kunt het aanpassen.'
            : 'Hoeveel wil je vandaag maximaal inzetten?'
        }}
      </p>
    </div>

    <AlertBox v-if="error">{{ error }}</AlertBox>

    <button type="submit" :class="[ui.btnPrimary, 'min-h-12 w-full text-base']" :disabled="busy">
      <Flag class="size-5" aria-hidden="true" />
      {{ busy ? 'Koersdag starten…' : 'Koersdag starten' }}
    </button>
  </form>
</template>
