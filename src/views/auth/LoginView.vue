<script setup lang="ts">
import { ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import AlertBox from '@/components/account/AlertBox.vue'
import AuthLayout from '@/components/account/AuthLayout.vue'
import PasswordInput from '@/components/account/PasswordInput.vue'
import { errorMessage } from '@/lib/errors'
import { ui } from '@/lib/ui'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

const username = ref('')
const password = ref('')
const errors = ref<{ username?: string; password?: string }>({})
const formError = ref<string | null>(null)
const busy = ref(false)

// Only follow in-app redirects, never an absolute URL
function redirectTarget(): string {
  const target = route.query.redirect
  return typeof target === 'string' && target.startsWith('/') && !target.startsWith('//')
    ? target
    : '/'
}

async function submit() {
  errors.value = {
    username: username.value.trim() ? undefined : 'Vul je gebruikersnaam in.',
    password: password.value ? undefined : 'Vul je wachtwoord in.',
  }
  if (errors.value.username || errors.value.password) return

  busy.value = true
  formError.value = null
  try {
    await auth.login(username.value.trim(), password.value)
    await router.replace(redirectTarget())
  } catch (error) {
    formError.value = errorMessage(error)
    password.value = ''
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <AuthLayout title="Inloggen" intro="Welkom terug. Log in om je advies voor vandaag te zien.">
    <form class="flex flex-col gap-5" novalidate @submit.prevent="submit">
      <AlertBox v-if="auth.notice && !formError" tone="info">{{ auth.notice }}</AlertBox>
      <AlertBox v-if="formError">{{ formError }}</AlertBox>

      <div>
        <label for="username" :class="ui.label">Gebruikersnaam</label>
        <input
          id="username"
          v-model="username"
          type="text"
          autocomplete="username"
          autocapitalize="off"
          spellcheck="false"
          :aria-invalid="!!errors.username || undefined"
          :aria-describedby="errors.username ? 'username-error' : undefined"
          :class="ui.input"
        />
        <p v-if="errors.username" id="username-error" :class="ui.fieldError">
          {{ errors.username }}
        </p>
      </div>

      <div>
        <label for="password" :class="ui.label">Wachtwoord</label>
        <PasswordInput
          id="password"
          v-model="password"
          autocomplete="current-password"
          :invalid="!!errors.password"
          :describedby="errors.password ? 'password-error' : undefined"
        />
        <p v-if="errors.password" id="password-error" :class="ui.fieldError">
          {{ errors.password }}
        </p>
      </div>

      <button type="submit" :class="[ui.btnPrimary, 'w-full']" :disabled="busy">
        {{ busy ? 'Bezig met inloggen…' : 'Inloggen' }}
      </button>
    </form>

    <template #footer>
      <RouterLink
        to="/wachtwoord-vergeten"
        class="inline-flex min-h-11 items-center font-medium text-blue-700 hover:underline dark:text-blue-400"
        >Wachtwoord vergeten?</RouterLink
      >
    </template>
  </AuthLayout>
</template>
