<script setup lang="ts">
import { computed, ref } from 'vue'
import { Check, Copy, MessageCircle, Share2 } from '@lucide/vue'
import { formatDateTime } from '@/lib/format'
import { ui } from '@/lib/ui'
import type { IssuedLink } from '@/types/account'

// Shows a freshly made invite/reset link once, with copy / share / WhatsApp
const props = defineProps<{ link: IssuedLink; name: string }>()

const copied = ref(false)
const copyFailed = ref(false)
const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

const url = computed(
  () =>
    `${window.location.origin}/${props.link.type === 'invite' ? 'uitnodiging' : 'herstel'}/${props.link.token}`,
)
const message = computed(() =>
  props.link.type === 'invite'
    ? `Hoi ${props.name}, hier is je uitnodiging voor Sprintorakel: ${url.value}`
    : `Hoi ${props.name}, met deze link kies je een nieuw wachtwoord voor Sprintorakel: ${url.value}`,
)
const whatsappUrl = computed(() => `https://wa.me/?text=${encodeURIComponent(message.value)}`)

async function copy() {
  try {
    await navigator.clipboard.writeText(url.value)
    copied.value = true
    copyFailed.value = false
    setTimeout(() => (copied.value = false), 2500)
  } catch {
    copyFailed.value = true
  }
}

async function share() {
  try {
    await navigator.share({ title: 'Sprintorakel', text: message.value })
  } catch {
    // Cancelled by the user — nothing to do
  }
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <label class="sr-only" :for="`link-${link.token}`">Link voor {{ name }}</label>
    <input
      :id="`link-${link.token}`"
      :value="url"
      readonly
      class="block min-h-11 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 font-mono text-sm text-slate-800 dark:border-white/15 dark:bg-slate-950 dark:text-slate-200"
      @focus="($event.target as HTMLInputElement).select()"
    />
    <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
      <button type="button" :class="ui.btnPrimary" @click="copy">
        <component :is="copied ? Check : Copy" class="size-4" aria-hidden="true" />
        {{ copied ? 'Gekopieerd' : 'Kopieer link' }}
      </button>
      <a :href="whatsappUrl" target="_blank" rel="noopener" :class="ui.btnSecondary">
        <MessageCircle class="size-4" aria-hidden="true" />
        WhatsApp
      </a>
      <button v-if="canShare" type="button" :class="ui.btnSecondary" @click="share">
        <Share2 class="size-4" aria-hidden="true" />
        Delen
      </button>
    </div>
    <p v-if="copyFailed" class="text-sm text-red-700 dark:text-red-400">
      Kopiëren lukte niet. Selecteer de link hierboven en kopieer hem handmatig.
    </p>
    <p class="text-sm text-slate-500 dark:text-slate-400" aria-live="polite">
      Geldig tot {{ formatDateTime(link.expiresAt) }}. Een nieuwe link maakt deze ongeldig.
    </p>
  </div>
</template>
