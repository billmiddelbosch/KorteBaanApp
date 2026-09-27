<script setup lang="ts">
import BrandMark from './BrandMark.vue'
import LiveBar from './LiveBar.vue'
import MainNav from './MainNav.vue'
import UserMenu from './UserMenu.vue'
import type { LiveSession, NavItem, ShellUser } from './types'

// Phone: top header + bottom tab bar. Tablet: 72px icon sidebar. Desktop: 256px sidebar.
defineProps<{
  navigationItems: NavItem[]
  user?: ShellUser | null
  liveSession?: LiveSession | null
}>()

const emit = defineEmits<{ logout: [] }>()
</script>

<template>
  <div class="min-h-dvh md:flex">
    <aside
      class="sticky top-0 hidden h-dvh w-18 shrink-0 flex-col gap-6 border-r border-slate-200 bg-white px-3 py-4 md:flex lg:w-64 lg:px-4 dark:border-white/10 dark:bg-slate-900"
    >
      <div class="flex h-12 items-center md:max-lg:justify-center lg:px-2">
        <BrandMark collapsible />
      </div>
      <MainNav :items="navigationItems" variant="sidebar" class="flex-1" />
      <UserMenu v-if="user" :user="user" placement="up" @logout="emit('logout')" />
    </aside>

    <div class="flex min-w-0 flex-1 flex-col">
      <header
        class="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-slate-200 bg-white/85 px-4 backdrop-blur-md md:hidden dark:border-white/10 dark:bg-slate-900/85"
      >
        <BrandMark />
        <UserMenu v-if="user" :user="user" placement="down" @logout="emit('logout')" />
      </header>

      <LiveBar v-if="liveSession" :session="liveSession" class="sticky top-0 z-30 hidden md:flex" />

      <main
        :class="[
          'flex-1 md:pb-0',
          liveSession
            ? 'pb-[calc(6.75rem+env(safe-area-inset-bottom))]'
            : 'pb-[calc(4rem+env(safe-area-inset-bottom))]',
        ]"
      >
        <slot />
      </main>
    </div>

    <div
      class="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-md md:hidden dark:border-white/10 dark:bg-slate-900/90"
    >
      <LiveBar v-if="liveSession" :session="liveSession" />
      <MainNav :items="navigationItems" variant="bar" />
    </div>
  </div>
</template>
