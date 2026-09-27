<script setup lang="ts">
import { RouterLink } from 'vue-router'

// In the tablet sidebar (72px) only the mark fits; the name stays available to screen readers
defineProps<{ collapsible?: boolean }>()
</script>

<template>
  <RouterLink
    to="/"
    class="inline-flex min-h-11 items-center gap-2 rounded-md text-lg font-semibold tracking-tight text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:text-slate-100"
  >
    <span
      class="grid size-8 shrink-0 place-items-center rounded-md bg-blue-600 text-sm font-bold text-white dark:bg-blue-500"
      aria-hidden="true"
      >S</span
    >
    <span :class="{ 'md:max-lg:sr-only': collapsible }"
      >Sprint<span class="text-blue-600 dark:text-blue-400">orakel</span></span
    >
  </RouterLink>
</template>
