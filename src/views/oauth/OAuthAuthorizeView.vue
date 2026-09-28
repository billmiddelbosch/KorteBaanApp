<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import AlertBox from '@/components/account/AlertBox.vue'
import { useOAuthConsent } from '@/composables/useOAuthConsent'
import { errorMessage } from '@/lib/errors'
import { ui } from '@/lib/ui'

const route = useRoute()

// Pass the client's query on as-is (first value of each key)
const query: Record<string, string> = {}
for (const [key, value] of Object.entries(route.query)) {
  const first = Array.isArray(value) ? value[0] : value
  if (typeof first === 'string') query[key] = first
}

const { consent, loading, loadError, load, decide } = useOAuthConsent(query)

const busy = ref<'approve' | 'deny' | null>(null)
const decideError = ref<string | null>(null)
const done = ref(false)

async function choose(approve: boolean) {
  busy.value = approve ? 'approve' : 'deny'
  decideError.value = null
  try {
    const target = await decide(approve)
    done.value = true
    window.location.assign(target)
  } catch (error) {
    decideError.value = errorMessage(error)
  } finally {
    busy.value = null
  }
}

onMounted(load)
</script>

<template>
  <div class="flex min-h-dvh items-start justify-center bg-slate-50 px-4 py-10 dark:bg-slate-950">
    <main :class="[ui.card, 'flex w-full max-w-md flex-col gap-5']">
      <h1 :class="ui.h1">Koppelen met de kennisbank</h1>

      <p v-if="loading" :class="ui.muted">Even laden…</p>

      <AlertBox v-else-if="loadError" tone="error">{{ loadError }}</AlertBox>

      <p v-else-if="done" :class="ui.muted">
        Je wordt teruggestuurd naar de app. Je kunt dit venster sluiten.
      </p>

      <template v-else-if="consent">
        <p class="text-slate-800 dark:text-slate-200">
          <strong>{{ consent.client.name }}</strong> wil toegang tot de kennisbank namens jou.
        </p>
        <div>
          <h2 :class="ui.h2">Deze app mag</h2>
          <ul class="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700 dark:text-slate-300">
            <li v-for="item in consent.scopes" :key="item.scope">{{ item.description }}</li>
          </ul>
        </div>
        <p :class="ui.muted">
          Na toestaan ga je terug naar <strong>{{ consent.client.redirectHost }}</strong
          >. Herken je dit niet? Weiger dan.
        </p>

        <AlertBox v-if="decideError" tone="error">{{ decideError }}</AlertBox>

        <div class="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button type="button" :class="ui.btnSecondary" :disabled="!!busy" @click="choose(false)">
            {{ busy === 'deny' ? 'Bezig…' : 'Weigeren' }}
          </button>
          <button type="button" :class="ui.btnPrimary" :disabled="!!busy" @click="choose(true)">
            {{ busy === 'approve' ? 'Bezig…' : 'Toestaan' }}
          </button>
        </div>
      </template>
    </main>
  </div>
</template>
