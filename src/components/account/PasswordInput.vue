<script setup lang="ts">
import { ref } from 'vue'
import { Eye, EyeOff } from '@lucide/vue'
import { ui } from '@/lib/ui'

// Typing a password on a phone outdoors is error-prone, so it can be shown
defineProps<{ id: string; autocomplete: string; invalid?: boolean; describedby?: string }>()
const model = defineModel<string>({ required: true })
const visible = ref(false)
</script>

<template>
  <div class="relative">
    <input
      :id="id"
      v-model="model"
      :type="visible ? 'text' : 'password'"
      :autocomplete="autocomplete"
      :aria-invalid="invalid || undefined"
      :aria-describedby="describedby"
      autocapitalize="off"
      spellcheck="false"
      :class="[ui.input, 'pr-12']"
    />
    <button
      type="button"
      class="absolute top-0 right-0 mt-1.5 grid size-11 place-items-center rounded-lg text-slate-500 hover:text-slate-800 focus-visible:outline-2 focus-visible:outline-blue-600 dark:text-slate-400 dark:hover:text-slate-200"
      :aria-label="visible ? 'Wachtwoord verbergen' : 'Wachtwoord tonen'"
      :aria-pressed="visible"
      @click="visible = !visible"
    >
      <component :is="visible ? EyeOff : Eye" class="size-5" aria-hidden="true" />
    </button>
  </div>
</template>
