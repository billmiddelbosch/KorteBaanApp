<script setup lang="ts">
import { useRoute } from 'vue-router'

const route = useRoute()
</script>

<template>
  <div class="mx-auto max-w-5xl px-4 py-6 md:px-8 md:py-8">
    <h1 class="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
      {{ route.meta.title }}
    </h1>
    <p class="mt-2 text-slate-600 dark:text-slate-400">{{ route.meta.description }}</p>
    <div
      class="mt-8 rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-white/15 dark:text-slate-400"
    >
      Dit scherm wordt ontworpen in een volgende stap.
    </div>
  </div>
</template>
