<script setup lang="ts">
import { ref, useId, watch } from 'vue'
import { ui } from '@/lib/ui'

// Native <dialog>: focus trap, Escape and backdrop come from the browser
const props = defineProps<{
  open: boolean
  title: string
  confirmLabel: string
  cancelLabel: string
  busy?: boolean
  danger?: boolean
}>()
const emit = defineEmits<{ confirm: []; cancel: [] }>()

const dialog = ref<HTMLDialogElement | null>(null)
const titleId = useId()

watch(
  () => props.open,
  (open) => {
    if (!dialog.value) return
    if (open && !dialog.value.open) dialog.value.showModal()
    if (!open && dialog.value.open) dialog.value.close()
  },
  { flush: 'post' },
)

const onBackdrop = (event: MouseEvent) => {
  if (event.target === dialog.value && !props.busy) emit('cancel')
}
</script>

<template>
  <dialog
    ref="dialog"
    class="m-auto w-[calc(100%-2rem)] max-w-md rounded-xl border border-slate-200 bg-white p-0 text-slate-900 shadow-xl backdrop:bg-slate-950/50 dark:border-white/10 dark:bg-slate-900 dark:text-slate-100"
    :aria-labelledby="titleId"
    @cancel.prevent="!busy && emit('cancel')"
    @click="onBackdrop"
  >
    <div class="p-6">
      <h2 :id="titleId" class="text-lg font-semibold">{{ title }}</h2>
      <div class="mt-2 text-sm text-slate-600 dark:text-slate-400">
        <slot />
      </div>
      <div class="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button type="button" :class="ui.btnSecondary" :disabled="busy" @click="emit('cancel')">
          {{ cancelLabel }}
        </button>
        <button
          type="button"
          :class="danger ? ui.btnDanger : ui.btnPrimary"
          :disabled="busy"
          @click="emit('confirm')"
        >
          {{ busy ? 'Bezig…' : confirmLabel }}
        </button>
      </div>
    </div>
  </dialog>
</template>
