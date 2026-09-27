<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { ChevronRight, Flag } from '@lucide/vue'
import AlertBox from '@/components/account/AlertBox.vue'
import PasswordInput from '@/components/account/PasswordInput.vue'
import { useSessions } from '@/composables/useSessions'
import { api } from '@/lib/axios'
import { errorMessage } from '@/lib/errors'
import { balanceClass, formatBalance, formatDate, formatEuro } from '@/lib/format'
import { ui } from '@/lib/ui'
import { useAuthStore } from '@/stores/auth'
import type { Me } from '@/types/account'

const PASSWORD_MIN = 10

const auth = useAuthStore()
const { overview, loading, loadError, load } = useSessions()

// ── Profile ──
const name = ref(auth.user?.name ?? '')
const nameError = ref<string | null>(null)
const nameSaved = ref(false)
const savingName = ref(false)

async function saveName() {
  nameSaved.value = false
  if (!name.value.trim()) {
    nameError.value = 'Vul een naam in.'
    return
  }
  savingName.value = true
  nameError.value = null
  try {
    auth.user = (await api.patch<Me>('/me', { name: name.value.trim() })).data
    name.value = auth.user.name
    nameSaved.value = true
  } catch (error) {
    nameError.value = errorMessage(error)
  } finally {
    savingName.value = false
  }
}

// ── Password ──
const currentPassword = ref('')
const newPassword = ref('')
const passwordErrors = ref<{ current?: string; next?: string }>({})
const passwordSaved = ref(false)
const savingPassword = ref(false)

async function savePassword() {
  passwordSaved.value = false
  passwordErrors.value = {
    current: currentPassword.value ? undefined : 'Vul je huidige wachtwoord in.',
    next:
      newPassword.value.length >= PASSWORD_MIN
        ? undefined
        : `Kies een wachtwoord van minimaal ${PASSWORD_MIN} tekens.`,
  }
  if (passwordErrors.value.current || passwordErrors.value.next) return

  savingPassword.value = true
  try {
    const { data } = await api.put<{ token: string }>('/me/password', {
      currentPassword: currentPassword.value,
      newPassword: newPassword.value,
    })
    auth.setToken(data.token)
    currentPassword.value = ''
    newPassword.value = ''
    passwordSaved.value = true
  } catch (error) {
    const message = errorMessage(error)
    passwordErrors.value = message.includes('huidige')
      ? { current: message }
      : { next: message }
  } finally {
    savingPassword.value = false
  }
}

onMounted(load)
</script>

<template>
  <div :class="ui.page">
    <header>
      <h1 :class="ui.h1">Mijn account</h1>
      <p :class="[ui.muted, 'mt-1']">Je profiel en je speelsessies.</p>
    </header>

    <!-- Speelsessies first: that's what people come here for -->
    <section aria-labelledby="sessions-title" :class="ui.card">
      <div class="flex items-baseline justify-between gap-4">
        <h2 id="sessions-title" :class="ui.h2">Mijn speelsessies</h2>
      </div>

      <div v-if="loading" class="mt-4 flex flex-col gap-3" aria-busy="true" aria-label="Laden">
        <div class="h-16 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800/60"></div>
        <div
          v-for="n in 3"
          :key="n"
          class="h-12 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800/60"
        ></div>
      </div>

      <div v-else-if="loadError" class="mt-4 flex flex-col items-start gap-3">
        <AlertBox>{{ loadError }}</AlertBox>
        <button type="button" :class="ui.btnSecondary" @click="load">Opnieuw proberen</button>
      </div>

      <div v-else-if="overview && overview.sessions.length === 0" class="mt-4 py-6 text-center">
        <div
          class="mx-auto grid size-12 place-items-center rounded-full bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300"
        >
          <Flag class="size-6" aria-hidden="true" />
        </div>
        <p class="mt-3 font-medium text-slate-900 dark:text-slate-100">Nog geen speelsessies</p>
        <p :class="[ui.muted, 'mx-auto mt-1 max-w-xs']">
          Start op een koersdag een sessie met je budget. Na afloop zie je hier wat je hebt ingezet
          en gewonnen.
        </p>
        <RouterLink to="/" :class="[ui.btnPrimary, 'mt-4']">Naar Koersdag</RouterLink>
      </div>

      <template v-else-if="overview">
        <dl class="mt-4 grid grid-cols-3 gap-2 rounded-lg bg-slate-50 p-3 dark:bg-slate-950/60">
          <div>
            <dt class="text-xs text-slate-500 dark:text-slate-400">Ingezet</dt>
            <dd class="mt-0.5 font-semibold tabular-nums">
              {{ formatEuro(overview.totals.staked) }}
            </dd>
          </div>
          <div>
            <dt class="text-xs text-slate-500 dark:text-slate-400">Uitbetaald</dt>
            <dd class="mt-0.5 font-semibold tabular-nums">
              {{ formatEuro(overview.totals.paidOut) }}
            </dd>
          </div>
          <div>
            <dt class="text-xs text-slate-500 dark:text-slate-400">Totaalsaldo</dt>
            <dd
              class="mt-0.5 font-semibold tabular-nums"
              :class="balanceClass(overview.totals.balance)"
              data-testid="total-balance"
            >
              {{ formatBalance(overview.totals.balance) }}
            </dd>
          </div>
        </dl>

        <ul class="mt-2 divide-y divide-slate-200 dark:divide-white/10">
          <li v-for="session in overview.sessions" :key="session.id">
            <RouterLink
              :to="{ path: '/terugblik', query: { sessie: session.id } }"
              class="-mx-2 flex min-h-14 items-center gap-3 rounded-lg px-2 py-2 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-blue-600 dark:hover:bg-white/5"
            >
              <div class="min-w-0 flex-1">
                <p class="truncate font-medium text-slate-900 dark:text-slate-100">
                  {{ session.draverij }}
                </p>
                <p class="text-sm text-slate-500 tabular-nums dark:text-slate-400">
                  {{ formatDate(session.date) }} · {{ formatEuro(session.staked) }} ingezet ·
                  {{ formatEuro(session.paidOut) }} uit
                </p>
              </div>
              <span class="font-semibold tabular-nums" :class="balanceClass(session.balance)">
                {{ formatBalance(session.balance) }}
              </span>
              <ChevronRight class="size-4 shrink-0 text-slate-400" aria-hidden="true" />
            </RouterLink>
          </li>
        </ul>
      </template>
    </section>

    <section aria-labelledby="profile-title" :class="ui.card">
      <h2 id="profile-title" :class="ui.h2">Profiel</h2>
      <p :class="[ui.muted, 'mt-1']">
        Je logt in als <span class="font-mono text-slate-800 dark:text-slate-200">{{ auth.user?.username }}</span>.
      </p>
      <form class="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end" novalidate @submit.prevent="saveName">
        <div class="flex-1">
          <label for="profile-name" :class="ui.label">Naam</label>
          <input
            id="profile-name"
            v-model="name"
            type="text"
            maxlength="40"
            autocomplete="given-name"
            :aria-invalid="!!nameError || undefined"
            :aria-describedby="nameError ? 'profile-name-error' : undefined"
            :class="ui.input"
            @input="nameSaved = false"
          />
        </div>
        <button type="submit" :class="ui.btnSecondary" :disabled="savingName">
          {{ savingName ? 'Opslaan…' : 'Naam opslaan' }}
        </button>
      </form>
      <p v-if="nameError" id="profile-name-error" :class="ui.fieldError">{{ nameError }}</p>
      <p v-if="nameSaved" class="mt-2 text-sm text-emerald-700 dark:text-emerald-400" role="status">
        Naam opgeslagen.
      </p>
    </section>

    <section aria-labelledby="password-title" :class="ui.card">
      <h2 id="password-title" :class="ui.h2">Wachtwoord wijzigen</h2>
      <p :class="[ui.muted, 'mt-1']">Andere apparaten worden daarna uitgelogd.</p>
      <form class="mt-4 flex flex-col gap-4" novalidate @submit.prevent="savePassword">
        <AlertBox v-if="passwordSaved" tone="success">Je wachtwoord is gewijzigd.</AlertBox>
        <div>
          <label for="current-password" :class="ui.label">Huidig wachtwoord</label>
          <PasswordInput
            id="current-password"
            v-model="currentPassword"
            autocomplete="current-password"
            :invalid="!!passwordErrors.current"
            :describedby="passwordErrors.current ? 'current-password-error' : undefined"
          />
          <p v-if="passwordErrors.current" id="current-password-error" :class="ui.fieldError">
            {{ passwordErrors.current }}
          </p>
        </div>
        <div>
          <label for="new-password" :class="ui.label">Nieuw wachtwoord</label>
          <PasswordInput
            id="new-password"
            v-model="newPassword"
            autocomplete="new-password"
            :invalid="!!passwordErrors.next"
            :describedby="passwordErrors.next ? 'new-password-error' : 'new-password-hint'"
          />
          <p v-if="passwordErrors.next" id="new-password-error" :class="ui.fieldError">
            {{ passwordErrors.next }}
          </p>
          <p v-else id="new-password-hint" :class="ui.hint">Minimaal {{ PASSWORD_MIN }} tekens.</p>
        </div>
        <div>
          <button type="submit" :class="ui.btnPrimary" :disabled="savingPassword">
            {{ savingPassword ? 'Opslaan…' : 'Wachtwoord wijzigen' }}
          </button>
        </div>
      </form>
    </section>
  </div>
</template>
