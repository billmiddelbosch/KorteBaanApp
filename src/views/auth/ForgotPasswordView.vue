<script setup lang="ts">
import { RouterLink } from 'vue-router'
import AuthLayout from '@/components/account/AuthLayout.vue'
import { ui } from '@/lib/ui'
</script>

<template>
  <AuthLayout
    title="Wachtwoord vergeten"
    intro="Sprintorakel gebruikt geen e-mail. De eigenaar maakt een persoonlijke herstel-link voor je."
  >
    <ol class="flex flex-col gap-4 text-sm text-slate-700 dark:text-slate-300">
      <li class="flex gap-3">
        <span
          class="grid size-6 shrink-0 place-items-center rounded-full bg-blue-100 text-xs font-semibold text-blue-800 dark:bg-blue-500/20 dark:text-blue-200"
          aria-hidden="true"
          >1</span
        >
        <span>Vraag de eigenaar om een nieuwe link, bijvoorbeeld via WhatsApp.</span>
      </li>
      <li class="flex gap-3">
        <span
          class="grid size-6 shrink-0 place-items-center rounded-full bg-blue-100 text-xs font-semibold text-blue-800 dark:bg-blue-500/20 dark:text-blue-200"
          aria-hidden="true"
          >2</span
        >
        <span>Open de link en kies een nieuw wachtwoord. De link werkt 24 uur.</span>
      </li>
      <li class="flex gap-3">
        <span
          class="grid size-6 shrink-0 place-items-center rounded-full bg-blue-100 text-xs font-semibold text-blue-800 dark:bg-blue-500/20 dark:text-blue-200"
          aria-hidden="true"
          >3</span
        >
        <span>Je bent daarna meteen ingelogd; andere apparaten worden uitgelogd.</span>
      </li>
    </ol>
    <RouterLink to="/inloggen" :class="[ui.btnSecondary, 'mt-6 w-full']">
      Terug naar inloggen
    </RouterLink>
  </AuthLayout>
</template>
