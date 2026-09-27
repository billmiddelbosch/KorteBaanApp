<script setup lang="ts">
import BrandMark from '@/components/shell/BrandMark.vue'

// Standalone pages (no shell) for guests: login, invite, reset
defineProps<{ title: string; intro?: string }>()
</script>

<template>
  <div class="flex min-h-dvh flex-col items-center px-4 py-10 md:justify-center">
    <div class="w-full max-w-sm">
      <div class="mb-8 flex justify-center">
        <BrandMark />
      </div>
      <main
        class="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-slate-900 dark:shadow-none"
      >
        <h1 class="text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
          {{ title }}
        </h1>
        <p v-if="intro" class="mt-2 text-sm text-slate-600 dark:text-slate-400">{{ intro }}</p>
        <div class="mt-6">
          <slot />
        </div>
      </main>
      <div class="mt-6 text-center text-sm">
        <slot name="footer" />
      </div>
    </div>
  </div>
</template>
