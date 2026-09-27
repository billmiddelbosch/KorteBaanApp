<script setup lang="ts">
import { computed, watch } from 'vue'
import { RouterView, useRoute, useRouter } from 'vue-router'
import { ChartLine, Flag, MessageSquareText } from '@lucide/vue'
import AiNotice from '@/components/account/AiNotice.vue'
import { AppShell, type NavItem, type ShellUser } from '@/components/shell'
import { useAuthStore } from '@/stores/auth'
import { useKoersdagStore } from '@/stores/koersdag'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const koersdag = useKoersdagStore()

const navigationItems: NavItem[] = [
  { label: 'Koersdag', to: '/', icon: Flag },
  { label: 'Analyse', to: '/analyse', icon: MessageSquareText },
  { label: 'Terugblik', to: '/terugblik', icon: ChartLine },
]

const shellUser = computed<ShellUser | null>(() => {
  const me = auth.user
  if (!me) return null
  return {
    name: me.name,
    isOwner: me.role === 'owner',
    aiStatus: me.ai.status === 'none' ? undefined : me.ai.status,
  }
})

// Wait for the first navigation so the shell doesn't flash on the login page
const ready = computed(() => route.matched.length > 0)
const standalone = computed(() => !!route.meta.standalone)

let loggingOut = false

async function handleLogout() {
  loggingOut = true
  auth.logout()
  await router.push({ name: 'inloggen' })
  loggingOut = false
}

// Session ended mid-use (expired, password reset elsewhere, access paused)
watch(
  () => auth.user,
  (user) => {
    if (!user && !loggingOut && ready.value && !route.meta.public) {
      router.replace({ name: 'inloggen', query: { redirect: route.fullPath } })
    }
  },
)
</script>

<template>
  <template v-if="ready">
    <RouterView v-if="standalone || !shellUser" />
    <AppShell
      v-else
      :navigation-items="navigationItems"
      :user="shellUser"
      :live-session="koersdag.live"
      @logout="handleLogout"
    >
      <AiNotice :me="auth.user!" />
      <RouterView />
    </AppShell>
  </template>
</template>
