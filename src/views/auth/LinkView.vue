<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { LinkIcon } from '@lucide/vue'
import AlertBox from '@/components/account/AlertBox.vue'
import AuthLayout from '@/components/account/AuthLayout.vue'
import PasswordInput from '@/components/account/PasswordInput.vue'
import { api } from '@/lib/axios'
import { errorMessage, errorStatus } from '@/lib/errors'
import { ui } from '@/lib/ui'
import { useAuthStore } from '@/stores/auth'
import type { LinkInfo } from '@/types/account'

// One page for both invite links (/uitnodiging/:token) and reset links (/herstel/:token)
const PASSWORD_MIN = 10
const USERNAME_PATTERN = /^[a-z0-9._-]{3,30}$/

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const token = computed(() => String(route.params.token ?? ''))

const info = ref<LinkInfo | null>(null)
const state = ref<'loading' | 'ready' | 'gone' | 'error'>('loading')
const loadError = ref<string | null>(null)

const name = ref('')
const username = ref('')
const password = ref('')
const errors = ref<{ name?: string; username?: string; password?: string }>({})
const formError = ref<string | null>(null)
const busy = ref(false)

const isInvite = computed(() => info.value?.type === 'invite')
const title = computed(() => {
  if (state.value === 'gone') return 'Deze link werkt niet meer'
  if (!info.value) return route.name === 'herstel' ? 'Nieuw wachtwoord' : 'Uitnodiging'
  return isInvite.value ? `Welkom, ${info.value.name}` : 'Kies een nieuw wachtwoord'
})
const intro = computed(() => {
  if (state.value !== 'ready' || !info.value) return undefined
  return isInvite.value
    ? 'Je bent uitgenodigd voor Sprintorakel. Kies een gebruikersnaam en wachtwoord om te beginnen.'
    : `Voor ${info.value.username ?? info.value.name}. Daarna ben je direct ingelogd en worden andere apparaten uitgelogd.`
})

async function load() {
  state.value = 'loading'
  try {
    info.value = (await api.get<LinkInfo>(`/auth/links/${encodeURIComponent(token.value)}`)).data
    name.value = info.value.name
    state.value = 'ready'
  } catch (error) {
    if (errorStatus(error) === 410) state.value = 'gone'
    else {
      loadError.value = errorMessage(error)
      state.value = 'error'
    }
  }
}

function validate(): boolean {
  const next: typeof errors.value = {}
  if (isInvite.value) {
    if (!name.value.trim()) next.name = 'Vul je naam in.'
    if (!USERNAME_PATTERN.test(username.value.trim().toLowerCase())) {
      next.username = 'Gebruik 3 tot 30 tekens: letters, cijfers, punt, streepje of underscore.'
    }
  }
  if (password.value.length < PASSWORD_MIN) {
    next.password = `Kies een wachtwoord van minimaal ${PASSWORD_MIN} tekens.`
  }
  errors.value = next
  return Object.keys(next).length === 0
}

async function submit() {
  if (!validate()) return
  busy.value = true
  formError.value = null
  try {
    const body: Record<string, string> = isInvite.value
      ? { name: name.value.trim(), username: username.value.trim().toLowerCase(), password: password.value }
      : { password: password.value }
    await auth.acceptLink(token.value, body)
    await router.replace('/')
  } catch (error) {
    const status = errorStatus(error)
    if (status === 410) state.value = 'gone'
    else if (status === 409) errors.value = { username: errorMessage(error) }
    else formError.value = errorMessage(error)
  } finally {
    busy.value = false
  }
}

onMounted(load)
</script>

<template>
  <AuthLayout :title="title" :intro="intro">
    <div v-if="state === 'loading'" class="flex flex-col gap-5" aria-busy="true" aria-label="Laden">
      <div v-for="n in 3" :key="n" class="flex flex-col gap-2">
        <div class="h-4 w-28 animate-pulse rounded bg-slate-200 dark:bg-slate-800"></div>
        <div class="h-11 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800/60"></div>
      </div>
    </div>

    <div v-else-if="state === 'gone'" class="flex flex-col gap-4">
      <div
        class="grid size-12 place-items-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300"
      >
        <LinkIcon class="size-6" aria-hidden="true" />
      </div>
      <p class="text-sm text-slate-700 dark:text-slate-300">
        De link is verlopen, al gebruikt of vervangen door een nieuwere link. Vraag de eigenaar om
        een nieuwe link.
      </p>
      <RouterLink to="/inloggen" :class="[ui.btnSecondary, 'w-full']">Naar inloggen</RouterLink>
    </div>

    <div v-else-if="state === 'error'" class="flex flex-col gap-4">
      <AlertBox>{{ loadError }}</AlertBox>
      <button type="button" :class="[ui.btnSecondary, 'w-full']" @click="load">
        Opnieuw proberen
      </button>
    </div>

    <form v-else class="flex flex-col gap-5" novalidate @submit.prevent="submit">
      <AlertBox v-if="formError">{{ formError }}</AlertBox>

      <template v-if="isInvite">
        <div>
          <label for="name" :class="ui.label">Je naam</label>
          <input
            id="name"
            v-model="name"
            type="text"
            autocomplete="given-name"
            maxlength="40"
            :aria-invalid="!!errors.name || undefined"
            :aria-describedby="errors.name ? 'name-error' : 'name-hint'"
            :class="ui.input"
          />
          <p v-if="errors.name" id="name-error" :class="ui.fieldError">{{ errors.name }}</p>
          <p v-else id="name-hint" :class="ui.hint">Zo zien de anderen je in de app.</p>
        </div>

        <div>
          <label for="username" :class="ui.label">Gebruikersnaam</label>
          <input
            id="username"
            v-model="username"
            type="text"
            autocomplete="username"
            autocapitalize="off"
            spellcheck="false"
            maxlength="30"
            :aria-invalid="!!errors.username || undefined"
            :aria-describedby="errors.username ? 'username-error' : 'username-hint'"
            :class="ui.input"
          />
          <p v-if="errors.username" id="username-error" :class="ui.fieldError">
            {{ errors.username }}
          </p>
          <p v-else id="username-hint" :class="ui.hint">
            Hiermee log je in. Kleine letters, cijfers, punt of streepje.
          </p>
        </div>
      </template>

      <div>
        <label for="password" :class="ui.label">
          {{ isInvite ? 'Wachtwoord' : 'Nieuw wachtwoord' }}
        </label>
        <PasswordInput
          id="password"
          v-model="password"
          autocomplete="new-password"
          :invalid="!!errors.password"
          :describedby="errors.password ? 'password-error' : 'password-hint'"
        />
        <p v-if="errors.password" id="password-error" :class="ui.fieldError">
          {{ errors.password }}
        </p>
        <p v-else id="password-hint" :class="ui.hint">Minimaal {{ PASSWORD_MIN }} tekens.</p>
      </div>

      <button type="submit" :class="[ui.btnPrimary, 'w-full']" :disabled="busy">
        {{
          busy ? 'Bezig…' : isInvite ? 'Account aanmaken' : 'Wachtwoord opslaan en inloggen'
        }}
      </button>
    </form>
  </AuthLayout>
</template>
