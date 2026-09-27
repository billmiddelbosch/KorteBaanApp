<script setup lang="ts">
import { RouterLink, useRoute } from 'vue-router'
import type { NavItem } from './types'

// `bar` = bottom tab bar on phones, `sidebar` = vertical list on tablet/desktop
const props = defineProps<{ items: NavItem[]; variant: 'bar' | 'sidebar' }>()

const route = useRoute()

// '/' (Koersdag) only matches exactly; other sections also match their sub-routes
const isActive = (to: string) =>
  to === '/' ? route.path === '/' : route.path === to || route.path.startsWith(`${to}/`)

const focusRing =
  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-blue-600 dark:focus-visible:outline-blue-400'
</script>

<template>
  <nav aria-label="Hoofdnavigatie">
    <ul v-if="props.variant === 'bar'" class="flex h-16">
      <li v-for="item in items" :key="item.to" class="flex-1">
        <RouterLink
          :to="item.to"
          :aria-current="isActive(item.to) ? 'page' : undefined"
          :class="[
            'flex h-full flex-col items-center justify-center gap-1 text-xs transition-colors duration-150',
            focusRing,
            isActive(item.to)
              ? 'font-semibold text-blue-700 dark:text-blue-300'
              : 'font-medium text-slate-600 dark:text-slate-400',
          ]"
        >
          <span
            :class="[
              'grid h-8 w-14 place-items-center rounded-full transition-colors duration-150',
              isActive(item.to) ? 'bg-blue-100 dark:bg-blue-400/15' : '',
            ]"
          >
            <component
              :is="item.icon"
              class="size-6"
              :stroke-width="isActive(item.to) ? 2.25 : 2"
              aria-hidden="true"
            />
          </span>
          {{ item.label }}
        </RouterLink>
      </li>
    </ul>

    <ul v-else class="flex flex-col gap-1">
      <li v-for="item in items" :key="item.to">
        <RouterLink
          :to="item.to"
          :aria-current="isActive(item.to) ? 'page' : undefined"
          :class="[
            'flex h-12 items-center gap-3 rounded-lg px-3 text-[15px] transition-colors duration-150 md:max-lg:justify-center',
            focusRing,
            isActive(item.to)
              ? 'bg-blue-50 font-semibold text-blue-700 dark:bg-blue-400/15 dark:text-blue-300'
              : 'font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-white/5 dark:hover:text-slate-100',
          ]"
        >
          <component
            :is="item.icon"
            class="size-6 shrink-0"
            :stroke-width="isActive(item.to) ? 2.25 : 2"
            aria-hidden="true"
          />
          <span class="md:max-lg:sr-only">{{ item.label }}</span>
        </RouterLink>
      </li>
    </ul>
  </nav>
</template>
