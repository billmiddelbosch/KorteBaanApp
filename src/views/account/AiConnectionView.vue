<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { CircleAlert, CircleCheck, CircleDashed } from '@lucide/vue'
import AlertBox from '@/components/account/AlertBox.vue'
import ConfirmDialog from '@/components/account/ConfirmDialog.vue'
import PasswordInput from '@/components/account/PasswordInput.vue'
import { useAiConnection } from '@/composables/useAiConnection'
import { errorMessage } from '@/lib/errors'
import { formatDate, formatDateTime, formatRelative } from '@/lib/format'
import { ui } from '@/lib/ui'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const { connection, loading, loadError, load, saveToken, test, remove } = useAiConnection()

// Keep the shell badge and AI notice in step with this page
async function refreshMe() {
  try {
    await auth.fetchMe()
  } catch {
    // The page itself already shows the up-to-date status
  }
}

const statusView = computed(() => {
  switch (connection.value?.status) {
    case 'connected':
      return {
        label: 'Gekoppeld',
        text: 'AI-advies werkt voor iedereen.',
        icon: CircleCheck,
        class: 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-400/20 dark:bg-emerald-400/10 dark:text-emerald-100',
        iconClass: 'text-emerald-600 dark:text-emerald-400',
      }
    case 'error':
      return {
        label: 'Probleem met de koppeling',
        text: 'AI-advies staat uit tot de koppeling weer werkt. De rest van de app blijft bruikbaar.',
        icon: CircleAlert,
        class: 'border-red-200 bg-red-50 text-red-900 dark:border-red-400/20 dark:bg-red-400/10 dark:text-red-100',
        iconClass: 'text-red-600 dark:text-red-400',
      }
    default:
      return {
        label: 'Niet gekoppeld',
        text: 'Koppel een setup-token om AI-advies aan te zetten.',
        icon: CircleDashed,
        class: 'border-slate-200 bg-slate-50 text-slate-900 dark:border-white/10 dark:bg-white/5 dark:text-slate-100',
        iconClass: 'text-slate-500 dark:text-slate-400',
      }
  }
})

// ── Token ──
const tokenInput = ref('')
const tokenError = ref<string | null>(null)
const tokenSaved = ref(false)
const savingToken = ref(false)
const hasToken = computed(() => !!connection.value && connection.value.status !== 'none')

async function submitToken() {
  tokenSaved.value = false
  if (!tokenInput.value.trim()) {
    tokenError.value = 'Plak hier de setup-token.'
    return
  }
  savingToken.value = true
  tokenError.value = null
  try {
    await saveToken(tokenInput.value.trim())
    tokenInput.value = ''
    tokenSaved.value = true
    await refreshMe()
  } catch (error) {
    tokenError.value = errorMessage(error)
  } finally {
    savingToken.value = false
  }
}

// ── Test ──
const testing = ref(false)
const testError = ref<string | null>(null)
const tested = ref(false)

async function runTest() {
  testing.value = true
  testError.value = null
  tested.value = false
  try {
    await test()
    tested.value = true
    await refreshMe()
  } catch (error) {
    testError.value = errorMessage(error)
  } finally {
    testing.value = false
  }
}

// ── Delete ──
const confirmOpen = ref(false)
const deleting = ref(false)
const deleteError = ref<string | null>(null)

async function confirmDelete() {
  deleting.value = true
  deleteError.value = null
  try {
    await remove()
    confirmOpen.value = false
    tokenSaved.value = false
    tested.value = false
    await refreshMe()
  } catch (error) {
    deleteError.value = errorMessage(error)
  } finally {
    deleting.value = false
  }
}

const maxDay = computed(() =>
  Math.max(1, ...(connection.value?.usage.days.map((d) => d.count) ?? [])),
)
const totalToday = computed(
  () => connection.value?.usage.today.reduce((sum, u) => sum + u.count, 0) ?? 0,
)

onMounted(load)
</script>

<template>
  <div :class="ui.page">
    <header>
      <h1 :class="ui.h1">AI-koppeling</h1>
      <p :class="[ui.muted, 'mt-1']">
        Sprintorakel gebruikt jouw Claude-abonnement voor alle adviezen, ook die van je vrienden.
      </p>
    </header>

    <div v-if="loading" class="flex flex-col gap-4" aria-busy="true" aria-label="Laden">
      <div class="h-24 animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800/60"></div>
      <div class="h-48 animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800/60"></div>
    </div>

    <div v-else-if="loadError" class="flex flex-col items-start gap-3">
      <AlertBox>{{ loadError }}</AlertBox>
      <button type="button" :class="ui.btnSecondary" @click="load">Opnieuw proberen</button>
    </div>

    <template v-else-if="connection">
      <!-- Status -->
      <section
        aria-labelledby="status-title"
        class="rounded-xl border p-4 md:p-6"
        :class="statusView.class"
        data-testid="ai-status"
      >
        <div class="flex items-start gap-3">
          <component
            :is="statusView.icon"
            class="mt-0.5 size-5 shrink-0"
            :class="statusView.iconClass"
            aria-hidden="true"
          />
          <div class="min-w-0 flex-1">
            <h2 id="status-title" class="font-semibold">{{ statusView.label }}</h2>
            <p class="mt-0.5 text-sm opacity-90">{{ statusView.text }}</p>
            <p v-if="connection.status === 'error' && connection.lastError" class="mt-2 text-sm">
              <span class="font-medium">Melding:</span> {{ connection.lastError }}
            </p>
            <dl v-if="hasToken" class="mt-3 grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
              <div v-if="connection.tokenHint" class="flex gap-1.5">
                <dt class="opacity-75">Token:</dt>
                <dd class="font-mono">{{ connection.tokenHint }}</dd>
              </div>
              <div v-if="connection.connectedAt" class="flex gap-1.5">
                <dt class="opacity-75">Gekoppeld op:</dt>
                <dd>{{ formatDateTime(connection.connectedAt) }}</dd>
              </div>
              <div class="flex gap-1.5">
                <dt class="opacity-75">Laatst getest:</dt>
                <dd>
                  {{ connection.lastTestedAt ? formatRelative(connection.lastTestedAt) : 'nog niet' }}
                </dd>
              </div>
            </dl>
          </div>
        </div>
        <div v-if="hasToken" class="mt-4 flex flex-col items-start gap-3">
          <button type="button" :class="ui.btnSecondary" :disabled="testing" @click="runTest">
            {{ testing ? 'Bezig met testen…' : 'Verbinding testen' }}
          </button>
          <p
            v-if="tested && connection.status === 'connected'"
            role="status"
            class="text-sm font-medium"
          >
            De verbinding werkt.
          </p>
          <AlertBox v-if="testError">{{ testError }}</AlertBox>
        </div>
      </section>

      <!-- Token -->
      <section aria-labelledby="token-title" :class="ui.card">
        <h2 id="token-title" :class="ui.h2">
          {{ hasToken ? 'Token vervangen' : 'Setup-token koppelen' }}
        </h2>
        <ol :class="[ui.muted, 'mt-2 list-decimal space-y-1 pl-5']">
          <li>
            Open een terminal op je computer en voer
            <code class="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-slate-900 dark:bg-white/10 dark:text-slate-100">claude setup-token</code>
            uit.
          </li>
          <li>Log in met je Claude-account als daarom gevraagd wordt.</li>
          <li>Kopieer de token die begint met <span class="font-mono">sk-ant-</span> en plak hem hieronder.</li>
        </ol>
        <form class="mt-4 flex flex-col gap-3" novalidate @submit.prevent="submitToken">
          <AlertBox v-if="tokenSaved" tone="success">
            Token opgeslagen{{ connection.status === 'connected' ? ' en getest. AI-advies staat aan.' : '.' }}
          </AlertBox>
          <div>
            <label for="setup-token" :class="ui.label">Setup-token</label>
            <PasswordInput
              id="setup-token"
              v-model="tokenInput"
              autocomplete="off"
              :invalid="!!tokenError"
              :describedby="tokenError ? 'setup-token-error' : 'setup-token-hint'"
            />
            <p v-if="tokenError" id="setup-token-error" :class="ui.fieldError">{{ tokenError }}</p>
            <p v-else id="setup-token-hint" :class="ui.hint">
              De token wordt versleuteld opgeslagen en is daarna niet meer in te zien.
            </p>
          </div>
          <div>
            <button type="submit" :class="ui.btnPrimary" :disabled="savingToken">
              {{ savingToken ? 'Opslaan en testen…' : hasToken ? 'Token vervangen' : 'Token koppelen' }}
            </button>
          </div>
        </form>
      </section>

      <!-- Usage -->
      <section aria-labelledby="usage-title" :class="ui.card">
        <h2 id="usage-title" :class="ui.h2">Verbruik</h2>
        <p :class="[ui.muted, 'mt-1']">
          {{ totalToday }} {{ totalToday === 1 ? 'analyse' : 'analyses' }} vandaag.
        </p>

        <h3 class="mt-4 text-sm font-semibold text-slate-800 dark:text-slate-200">Vandaag per persoon</h3>
        <p v-if="connection.usage.today.length === 0" :class="[ui.muted, 'mt-1']">
          Vandaag nog geen analyses.
        </p>
        <ul v-else class="mt-2 divide-y divide-slate-200 text-sm dark:divide-white/10">
          <li
            v-for="row in connection.usage.today"
            :key="row.userId"
            class="flex min-h-10 items-center justify-between gap-3"
          >
            <span class="truncate text-slate-800 dark:text-slate-200">{{ row.name }}</span>
            <span class="tabular-nums text-slate-600 dark:text-slate-400">
              {{ row.count }}{{ row.dailyLimit === null ? '' : ` van ${row.dailyLimit}` }}
            </span>
          </li>
        </ul>

        <h3 class="mt-6 text-sm font-semibold text-slate-800 dark:text-slate-200">Afgelopen dagen</h3>
        <ul class="mt-2 flex flex-col gap-1.5 text-sm">
          <li
            v-for="day in connection.usage.days"
            :key="day.date"
            class="grid grid-cols-[7rem_1fr_2.5rem] items-center gap-3"
          >
            <span class="text-slate-600 dark:text-slate-400">{{ formatDate(day.date) }}</span>
            <span class="h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-white/5" aria-hidden="true">
              <span
                class="block h-full rounded-full bg-blue-500 dark:bg-blue-400"
                :style="{ width: `${(day.count / maxDay) * 100}%` }"
              ></span>
            </span>
            <span class="text-right tabular-nums text-slate-800 dark:text-slate-200">{{ day.count }}</span>
          </li>
        </ul>
      </section>

      <!-- Danger zone -->
      <section
        v-if="hasToken"
        aria-labelledby="danger-title"
        class="rounded-xl border border-red-200 p-4 md:p-6 dark:border-red-500/30"
      >
        <h2 id="danger-title" :class="ui.h2">Koppeling verwijderen</h2>
        <p :class="[ui.muted, 'mt-1']">
          De token wordt gewist. AI-advies staat daarna voor iedereen uit tot je een nieuwe token
          koppelt.
        </p>
        <button
          type="button"
          :class="[ui.btnDangerOutline, 'mt-4']"
          @click="((confirmOpen = true), (deleteError = null))"
        >
          Koppeling verwijderen
        </button>
      </section>
    </template>

    <ConfirmDialog
      :open="confirmOpen"
      title="AI-koppeling verwijderen?"
      confirm-label="Koppeling verwijderen"
      cancel-label="Koppeling houden"
      :busy="deleting"
      danger
      @confirm="confirmDelete"
      @cancel="confirmOpen = false"
    >
      <p>
        AI-advies stopt direct voor jou en al je vrienden. Eerdere adviezen en resultaten blijven
        bewaard.
      </p>
      <AlertBox v-if="deleteError" class="mt-3">{{ deleteError }}</AlertBox>
    </ConfirmDialog>
  </div>
</template>
