<script setup lang="ts">
import { computed } from 'vue'
import { CircleAlert, CircleCheck, Info } from '@lucide/vue'

const props = withDefaults(defineProps<{ tone?: 'error' | 'success' | 'info' }>(), {
  tone: 'error',
})

const styles = computed(
  () =>
    ({
      error:
        'border-red-200 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300',
      success:
        'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300',
      info: 'border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-200',
    })[props.tone],
)
const icon = computed(() => ({ error: CircleAlert, success: CircleCheck, info: Info })[props.tone])
</script>

<template>
  <div
    :role="tone === 'error' ? 'alert' : 'status'"
    :class="['flex items-start gap-3 rounded-lg border p-3 text-sm', styles]"
  >
    <component :is="icon" class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
    <div class="min-w-0 flex-1"><slot /></div>
  </div>
</template>
