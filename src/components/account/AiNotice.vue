<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { TriangleAlert } from '@lucide/vue'
import type { Me } from '@/types/account'

// Explains why AI advice is unavailable; the rest of the app keeps working
const props = defineProps<{ me: Me }>()

const reason = computed<'limit' | 'connection' | null>(() => {
  const { status, usedToday, dailyLimit } = props.me.ai
  if (status !== 'connected') return 'connection'
  if (dailyLimit !== null && usedToday >= dailyLimit) return 'limit'
  return null
})
</script>

<template>
  <div
    v-if="reason"
    role="status"
    class="border-b border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 md:px-8 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-100"
  >
    <div class="mx-auto flex max-w-5xl items-start gap-3">
      <TriangleAlert
        class="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
        aria-hidden="true"
      />
      <p v-if="reason === 'limit'">
        <strong class="font-semibold">Je daglimiet voor AI-analyses is bereikt</strong>
        ({{ me.ai.usedToday }} van {{ me.ai.dailyLimit }}). Morgen kun je weer nieuwe adviezen
        vragen. Historie en eerdere adviezen blijven gewoon beschikbaar.
      </p>
      <p v-else-if="me.role === 'owner'">
        <strong class="font-semibold">AI-advies staat uit.</strong>
        {{
          me.ai.status === 'none'
            ? 'Er is nog geen setup-token gekoppeld.'
            : 'De koppeling met Claude werkt niet.'
        }}
        <RouterLink
          to="/account/ai-koppeling"
          class="font-semibold underline underline-offset-2 hover:no-underline"
          >Naar AI-koppeling</RouterLink
        >
      </p>
      <p v-else>
        <strong class="font-semibold">AI-advies is tijdelijk niet beschikbaar.</strong>
        Laat het de eigenaar weten als dit zo blijft. Historie en eerdere adviezen blijven gewoon
        beschikbaar.
      </p>
    </div>
  </div>
</template>
