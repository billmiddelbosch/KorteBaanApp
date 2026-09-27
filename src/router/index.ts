import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

declare module 'vue-router' {
  interface RouteMeta {
    title?: string
    description?: string
    /** Reachable without logging in */
    public?: boolean
    /** Rendered without the app shell (login, invite and reset pages) */
    standalone?: boolean
    /** Only the owner may open this page; friends are sent home */
    ownerOnly?: boolean
  }
}

// Placeholder views until each roadmap section gets its own screens
const placeholder = () => import('../views/PlaceholderView.vue')
const linkView = () => import('../views/auth/LinkView.vue')

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'koersdag',
      component: placeholder,
      meta: {
        title: 'Koersdag',
        description: 'Budget, live quota en inzet-suggesties per omloop.',
      },
    },
    {
      path: '/analyse',
      name: 'analyse',
      component: () => import('../views/analyse/AnalyseView.vue'),
      meta: {
        title: 'Analyse',
        description: 'AI-chat vóór de koersdag die leidt tot een inzetadvies.',
      },
    },
    {
      path: '/analyse/:id',
      name: 'analyse-chat',
      component: () => import('../views/analyse/AnalyseChatView.vue'),
      meta: { title: 'Analyse' },
    },
    {
      path: '/terugblik',
      name: 'terugblik',
      component: placeholder,
      meta: {
        title: 'Terugblik',
        description: 'Resultaten terugkoppelen en lessen uit het kennissysteem.',
      },
    },
    {
      path: '/account',
      name: 'account',
      component: () => import('../views/account/AccountView.vue'),
      meta: { title: 'Mijn account' },
    },
    {
      path: '/account/vrienden',
      name: 'vrienden',
      component: () => import('../views/account/FriendsView.vue'),
      meta: { title: 'Vrienden', ownerOnly: true },
    },
    {
      path: '/account/ai-koppeling',
      name: 'ai-koppeling',
      component: () => import('../views/account/AiConnectionView.vue'),
      meta: { title: 'AI-koppeling', ownerOnly: true },
    },
    {
      path: '/account/ai-instructie',
      name: 'ai-instructie',
      component: () => import('../views/account/AiInstructionView.vue'),
      meta: { title: 'AI-instructie', ownerOnly: true },
    },
    {
      path: '/inloggen',
      name: 'inloggen',
      component: () => import('../views/auth/LoginView.vue'),
      meta: { title: 'Inloggen', public: true, standalone: true },
    },
    {
      path: '/wachtwoord-vergeten',
      name: 'wachtwoord-vergeten',
      component: () => import('../views/auth/ForgotPasswordView.vue'),
      meta: { title: 'Wachtwoord vergeten', public: true, standalone: true },
    },
    {
      path: '/uitnodiging/:token',
      name: 'uitnodiging',
      component: linkView,
      meta: { title: 'Uitnodiging', public: true, standalone: true },
    },
    {
      path: '/herstel/:token',
      name: 'herstel',
      component: linkView,
      meta: { title: 'Nieuw wachtwoord', public: true, standalone: true },
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

router.beforeEach(async (to) => {
  const auth = useAuthStore()
  try {
    await auth.ensureLoaded()
  } catch {
    // Offline or server error: treat as signed out for protected pages
  }

  if (!to.meta.public && !auth.isLoggedIn) {
    return to.fullPath === '/'
      ? { name: 'inloggen' }
      : { name: 'inloggen', query: { redirect: to.fullPath } }
  }
  if (to.meta.ownerOnly && !auth.isOwner) return { path: '/' }
  if (to.name === 'inloggen' && auth.isLoggedIn) return { path: '/' }
})

router.afterEach((to) => {
  document.title = to.meta.title ? `${to.meta.title} · Sprintorakel` : 'Sprintorakel'
})

export default router
