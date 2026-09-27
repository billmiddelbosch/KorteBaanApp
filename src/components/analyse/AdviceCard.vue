<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { CircleCheck, Lock } from '@lucide/vue'
import { formatEuro } from '@/lib/format'
import { ui } from '@/lib/ui'
import type { AdviceProposal } from '@/types/analyse'

// An advice proposal inside the chat. `locked`: this is the advice that is currently vastgelegd.
defineProps<{
  proposal: AdviceProposal
  locked: boolean
  busy?: boolean
  disabled?: boolean
}>()

const emit = defineEmits<{ lock: [] }>()
</script>

<template>
  <section
    aria-label="Adviesvoorstel"
    :class="[
      'rounded-xl border bg-white p-4 text-slate-900 dark:bg-slate-900 dark:text-slate-100',
      locked
        ? 'border-emerald-300 ring-1 ring-emerald-300 dark:border-emerald-400/40 dark:ring-emerald-400/40'
        : 'border-slate-200 dark:border-white/10',
    ]"
    data-testid="advice-card"
  >
    <div class="flex items-start justify-between gap-3">
      <h3 class="font-semibold">Adviesvoorstel</h3>
      <p
        v-if="proposal.budget !== null"
        class="shrink-0 text-sm tabular-nums text-slate-600 dark:text-slate-400"
      >
        Budget {{ formatEuro(proposal.budget) }}
      </p>
    </div>
    <p v-if="proposal.summary" class="mt-1 text-sm text-slate-700 dark:text-slate-300">
      {{ proposal.summary }}
    </p>

    <ol class="mt-3 flex flex-col divide-y divide-slate-200 dark:divide-white/10">
      <li v-for="(pick, i) in proposal.picks" :key="i" class="py-3 first:pt-0 last:pb-0">
        <div class="flex items-baseline justify-between gap-3">
          <p class="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            {{ pick.race }}
          </p>
          <p v-if="pick.amount !== null" class="shrink-0 font-semibold tabular-nums">
            {{ formatEuro(pick.amount) }}
          </p>
        </div>
        <p class="mt-0.5 font-medium">{{ pick.bet }}</p>
        <p v-if="pick.reasoning" class="mt-0.5 text-sm text-slate-600 dark:text-slate-400">
          {{ pick.reasoning }}
        </p>
      </li>
    </ol>

    <div
      v-if="locked"
      role="status"
      class="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900 dark:bg-emerald-400/10 dark:text-emerald-100"
    >
      <CircleCheck class="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
      <span class="font-semibold">Vastgelegd</span>
      <RouterLink to="/" class="font-semibold underline underline-offset-2 hover:no-underline">
        Naar Koersdag
      </RouterLink>
    </div>
    <button
      v-else
      type="button"
      :class="[ui.btnPrimary, 'mt-4 w-full sm:w-auto']"
      :disabled="busy || disabled"
      @click="emit('lock')"
    >
      <Lock class="size-4" aria-hidden="true" />
      {{ busy ? 'Vastleggen…' : 'Advies vastleggen' }}
    </button>
  </section>
</template>
