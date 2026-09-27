<script setup lang="ts">
import { onBeforeUnmount, ref, useId, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { Bot, LogOut, Monitor, Moon, Sun, User, Users } from '@lucide/vue'
import { useTheme, type ThemeMode } from '@/composables/useTheme'
import type { ShellUser } from './types'

// `down` = header on phones, `up` = bottom of the sidebar (name shown on desktop only)
const props = defineProps<{ user: ShellUser; placement: 'down' | 'up' }>()
const emit = defineEmits<{ logout: [] }>()

const { mode } = useTheme()
const route = useRoute()
const menuId = useId()
const isOpen = ref(false)
const root = ref<HTMLElement | null>(null)

const themeOptions: { value: ThemeMode; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Licht', icon: Sun },
  { value: 'dark', label: 'Donker', icon: Moon },
  { value: 'auto', label: 'Auto', icon: Monitor },
]

const close = () => (isOpen.value = false)

const onPointerDown = (event: PointerEvent) => {
  if (root.value && !root.value.contains(event.target as Node)) close()
}
const onKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') close()
}

watch(isOpen, (open) => {
  if (open) {
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeydown)
  } else {
    document.removeEventListener('pointerdown', onPointerDown)
    document.removeEventListener('keydown', onKeydown)
  }
})
watch(() => route.fullPath, close)
onBeforeUnmount(close)

const handleLogout = () => {
  close()
  emit('logout')
}

const itemClass =
  'flex min-h-11 w-full items-center gap-3 rounded-md px-3 text-sm font-medium text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-blue-600 dark:text-slate-200 dark:hover:bg-white/5'
</script>

<template>
  <div ref="root" class="relative">
    <button
      type="button"
      :aria-expanded="isOpen"
      :aria-controls="menuId"
      :aria-label="`Gebruikersmenu van ${user.name}`"
      :class="[
        'flex min-h-11 items-center gap-3 rounded-lg p-1 text-left focus-visible:outline-2 focus-visible:outline-blue-600 dark:focus-visible:outline-blue-400',
        props.placement === 'up'
          ? 'w-full hover:bg-slate-100 md:max-lg:justify-center lg:px-2 dark:hover:bg-white/5'
          : '',
      ]"
      @click="isOpen = !isOpen"
    >
      <img
        v-if="user.avatarUrl"
        :src="user.avatarUrl"
        alt=""
        class="size-9 shrink-0 rounded-full object-cover"
      />
      <span
        v-else
        class="grid size-9 shrink-0 place-items-center rounded-full bg-slate-200 text-sm font-semibold text-slate-700 dark:bg-slate-700 dark:text-slate-100"
        aria-hidden="true"
        >{{ user.name.charAt(0).toUpperCase() }}</span
      >
      <span
        v-if="props.placement === 'up'"
        class="min-w-0 truncate text-sm font-medium text-slate-800 md:max-lg:hidden dark:text-slate-200"
        >{{ user.name }}</span
      >
    </button>

    <Transition
      enter-active-class="transition duration-150 ease-out motion-reduce:transition-none"
      enter-from-class="opacity-0 scale-95"
      leave-active-class="transition duration-100 ease-in motion-reduce:transition-none"
      leave-to-class="opacity-0 scale-95"
    >
      <div
        v-if="isOpen"
        :id="menuId"
        :class="[
          'absolute z-50 w-64 rounded-xl border border-slate-200 bg-white p-2 shadow-lg dark:border-white/10 dark:bg-slate-800 dark:shadow-none',
          props.placement === 'down'
            ? 'top-full right-0 mt-2 origin-top-right'
            : 'bottom-full left-0 mb-2 origin-bottom-left',
        ]"
      >
        <p class="truncate px-3 pt-1 pb-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
          {{ user.name }}
        </p>

        <ul class="flex flex-col gap-0.5">
          <li>
            <RouterLink to="/account" :class="itemClass">
              <User class="size-5 text-slate-500 dark:text-slate-400" aria-hidden="true" />
              Mijn account
            </RouterLink>
          </li>
          <template v-if="user.isOwner">
            <li>
              <RouterLink to="/account/vrienden" :class="itemClass">
                <Users class="size-5 text-slate-500 dark:text-slate-400" aria-hidden="true" />
                Vrienden beheren
              </RouterLink>
            </li>
            <li>
              <RouterLink to="/account/ai-koppeling" :class="itemClass">
                <Bot class="size-5 text-slate-500 dark:text-slate-400" aria-hidden="true" />
                <span class="flex-1">AI-koppeling</span>
                <span
                  v-if="user.aiStatus"
                  class="inline-flex items-center gap-1.5 text-xs font-medium"
                  :class="
                    user.aiStatus === 'connected'
                      ? 'text-emerald-700 dark:text-emerald-400'
                      : 'text-red-700 dark:text-red-400'
                  "
                >
                  <span
                    class="size-2 rounded-full"
                    :class="user.aiStatus === 'connected' ? 'bg-emerald-500' : 'bg-red-500'"
                    aria-hidden="true"
                  ></span>
                  {{ user.aiStatus === 'connected' ? 'Gekoppeld' : 'Probleem' }}
                </span>
              </RouterLink>
            </li>
          </template>
        </ul>

        <div class="my-2 border-t border-slate-200 dark:border-white/10"></div>

        <fieldset class="px-3 pb-2">
          <legend class="pb-2 text-xs font-medium text-slate-500 dark:text-slate-400">Thema</legend>
          <div class="grid grid-cols-3 gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-900">
            <label
              v-for="option in themeOptions"
              :key="option.value"
              :class="[
                'flex min-h-9 cursor-pointer items-center justify-center gap-1.5 rounded-md text-xs font-medium has-focus-visible:outline-2 has-focus-visible:outline-blue-600',
                mode === option.value
                  ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-100'
                  : 'text-slate-600 dark:text-slate-400',
              ]"
            >
              <input
                v-model="mode"
                type="radio"
                :name="`${menuId}-theme`"
                :value="option.value"
                class="sr-only"
              />
              <component :is="option.icon" class="size-4" aria-hidden="true" />
              {{ option.label }}
            </label>
          </div>
        </fieldset>

        <div class="my-2 border-t border-slate-200 dark:border-white/10"></div>

        <button type="button" :class="itemClass" @click="handleLogout">
          <LogOut class="size-5 text-slate-500 dark:text-slate-400" aria-hidden="true" />
          Uitloggen
        </button>
      </div>
    </Transition>
  </div>
</template>
