<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { ChevronRight } from '@lucide/vue'
import type { LiveSession } from './types'

const props = defineProps<{ session: LiveSession }>()

const budget = computed(() =>
  new Intl.NumberFormat('nl-NL', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 0,
  }).format(props.session.budgetRemaining),
)
</script>

<template>
  <RouterLink
    :to="session.to"
    class="flex min-h-11 items-center gap-2 bg-amber-400 px-4 text-sm text-slate-950 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-slate-950"
    :aria-label="`Live: ${session.draverij}, ${session.omloop}, ${budget} over. Naar het advies`"
  >
    <span class="relative flex size-2.5 shrink-0" aria-hidden="true">
      <span
        class="absolute inline-flex size-full rounded-full bg-red-600 opacity-75 motion-safe:animate-ping"
      ></span>
      <span class="relative inline-flex size-2.5 rounded-full bg-red-600"></span>
    </span>
    <span class="text-xs font-bold tracking-wider uppercase">Live</span>
    <span class="min-w-0 flex-1 truncate">
      <span class="font-semibold">{{ session.draverij }}</span>
      <span class="text-slate-800"> · {{ session.omloop }}</span>
    </span>
    <span class="shrink-0 font-semibold tabular-nums">{{ budget }} over</span>
    <ChevronRight class="size-5 shrink-0" aria-hidden="true" />
  </RouterLink>
</template>
