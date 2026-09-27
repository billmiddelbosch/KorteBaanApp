<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { ChevronRight, CircleCheck, Trash2 } from '@lucide/vue'
import AlertBox from '@/components/account/AlertBox.vue'
import ConfirmDialog from '@/components/account/ConfirmDialog.vue'
import { useLessons, useTerugblikList, useTerugblikOverview } from '@/composables/useTerugblik'
import { errorMessage } from '@/lib/errors'
import { balanceClass, formatBalance, formatDate, formatEuro } from '@/lib/format'
import { ui } from '@/lib/ui'
import { useAuthStore } from '@/stores/auth'
import type { Lesson } from '@/types/terugblik'

type Tab = 'mijn' | 'overzicht' | 'lessen'

const TABS: { id: Tab; label: string }[] = [
  { id: 'mijn', label: 'Mijn koersdagen' },
  { id: 'overzicht', label: 'Overzicht' },
  { id: 'lessen', label: 'Lessen' },
]

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

// The tab lives in the URL, so Back returns to the same tab; friends only have their own list
const tab = computed<Tab>(() => {
  const wanted = route.query.tab
  return auth.isOwner && (wanted === 'overzicht' || wanted === 'lessen') ? wanted : 'mijn'
})
const selectTab = (id: Tab) => router.replace({ query: id === 'mijn' ? {} : { tab: id } })

const list = useTerugblikList()
const overview = useTerugblikOverview()
const lessons = useLessons()

watch(
  tab,
  (now) => {
    const source = { mijn: list, overzicht: overview, lessen: lessons }[now]
    if (!source.data.value) void source.load()
  },
  { immediate: true },
)

// ── Overzicht: filter per friend ──
const friend = ref('')
const overviewRows = computed(() =>
  (overview.data.value?.koersdagen ?? []).filter((k) => !friend.value || k.userId === friend.value),
)

// ── Lessen: delete after confirmation ──
const toDelete = ref<Lesson | null>(null)
const deleting = ref(false)
const deleteError = ref<string | null>(null)

function askDelete(lesson: Lesson) {
  deleteError.value = null
  toDelete.value = lesson
}

async function confirmDelete() {
  if (!toDelete.value) return
  deleting.value = true
  deleteError.value = null
  try {
    await lessons.remove(toDelete.value.id)
    toDelete.value = null
  } catch (error) {
    deleteError.value = errorMessage(error)
  } finally {
    deleting.value = false
  }
}

const linkClass =
  'inline-flex min-h-11 w-fit items-center gap-1 font-semibold text-blue-700 underline-offset-2 hover:underline dark:text-blue-300'
const rowClass =
  'flex min-h-16 items-center justify-between gap-3 rounded-lg px-3 py-3 -mx-3 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-blue-600 dark:hover:bg-white/5 dark:focus-visible:outline-blue-400'
</script>

<template>
  <div :class="ui.page">
    <header>
      <h1 :class="ui.h1">Terugblik</h1>
      <p :class="ui.muted">Hoe ging het, en wat leert de AI ervan?</p>
    </header>

    <div
      v-if="auth.isOwner"
      role="tablist"
      aria-label="Terugblik"
      class="-mx-1 flex gap-1 overflow-x-auto border-b border-slate-200 px-1 dark:border-white/10"
    >
      <button
        v-for="t in TABS"
        :key="t.id"
        type="button"
        role="tab"
        :aria-selected="tab === t.id"
        :class="[
          'min-h-11 shrink-0 border-b-2 px-3 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-blue-600 dark:focus-visible:outline-blue-400',
          tab === t.id
            ? 'border-blue-600 text-blue-700 dark:border-blue-400 dark:text-blue-300'
            : 'border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100',
        ]"
        @click="selectTab(t.id)"
      >
        {{ t.label }}
      </button>
    </div>

    <!-- ── Mijn koersdagen ── -->
    <template v-if="tab === 'mijn'">
      <div
        v-if="list.loading.value"
        class="flex flex-col gap-3"
        aria-busy="true"
        aria-label="Laden"
      >
        <div class="h-24 animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800/60"></div>
        <div class="h-40 animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800/60"></div>
      </div>

      <div v-else-if="list.loadError.value" class="flex flex-col items-start gap-3">
        <AlertBox>{{ list.loadError.value }}</AlertBox>
        <button type="button" :class="ui.btnSecondary" @click="list.load">Opnieuw proberen</button>
      </div>

      <section
        v-else-if="!list.data.value?.koersdagen.length"
        :class="[ui.card, 'flex flex-col gap-2']"
        aria-label="Geen koersdagen"
      >
        <p class="font-semibold text-slate-900 dark:text-slate-100">
          Nog geen afgeronde koersdagen
        </p>
        <p :class="ui.muted">
          Rond een koersdag af; daarna zie je hier je saldo en wat de AI van de dag leerde.
        </p>
        <RouterLink to="/" :class="linkClass">
          Naar Koersdag
          <ChevronRight class="size-4" aria-hidden="true" />
        </RouterLink>
      </section>

      <template v-else-if="list.data.value">
        <section :class="[ui.card, 'flex flex-col gap-3']" aria-labelledby="total-title">
          <h2 id="total-title" :class="ui.muted">Totaalsaldo</h2>
          <p
            :class="[
              'text-3xl font-semibold tracking-tight tabular-nums',
              balanceClass(list.data.value.totals.balance),
            ]"
          >
            {{ formatBalance(list.data.value.totals.balance) }}
          </p>
          <dl class="flex gap-5 text-sm tabular-nums">
            <div>
              <dt class="text-slate-500 dark:text-slate-400">Ingezet</dt>
              <dd class="font-semibold">{{ formatEuro(list.data.value.totals.staked) }}</dd>
            </div>
            <div>
              <dt class="text-slate-500 dark:text-slate-400">Uitbetaald</dt>
              <dd class="font-semibold">{{ formatEuro(list.data.value.totals.paidOut) }}</dd>
            </div>
          </dl>
        </section>

        <section :class="ui.card" aria-labelledby="list-title">
          <h2 id="list-title" :class="[ui.h2, 'mb-2']">Koersdagen</h2>
          <ul class="flex flex-col divide-y divide-slate-200 dark:divide-white/10">
            <li v-for="k in list.data.value.koersdagen" :key="k.id">
              <RouterLink :to="`/terugblik/${k.id}`" :class="rowClass">
                <div class="min-w-0">
                  <p
                    class="font-semibold text-slate-900 first-letter:uppercase dark:text-slate-100"
                  >
                    {{ k.draverij }}
                  </p>
                  <p :class="ui.muted">
                    {{ formatDate(k.date) }} ·
                    <span class="tabular-nums">{{ formatEuro(k.staked) }} ingezet</span>
                  </p>
                  <p
                    v-if="k.evaluated"
                    class="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 dark:text-emerald-400"
                  >
                    <CircleCheck class="size-3.5" aria-hidden="true" />
                    Geëvalueerd
                  </p>
                  <p v-else class="mt-1 text-xs font-semibold text-amber-700 dark:text-amber-400">
                    Uitslagen nodig
                  </p>
                </div>
                <div class="flex shrink-0 items-center gap-2">
                  <span :class="['font-semibold tabular-nums', balanceClass(k.balance)]">
                    {{ formatBalance(k.balance) }}
                  </span>
                  <ChevronRight class="size-4 text-slate-400" aria-hidden="true" />
                </div>
              </RouterLink>
            </li>
          </ul>
        </section>
      </template>
    </template>

    <!-- ── Overzicht (owner) ── -->
    <template v-else-if="tab === 'overzicht'">
      <div
        v-if="overview.loading.value"
        class="flex flex-col gap-3"
        aria-busy="true"
        aria-label="Laden"
      >
        <div class="h-24 animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800/60"></div>
        <div class="h-40 animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800/60"></div>
      </div>

      <div v-else-if="overview.loadError.value" class="flex flex-col items-start gap-3">
        <AlertBox>{{ overview.loadError.value }}</AlertBox>
        <button type="button" :class="ui.btnSecondary" @click="overview.load">
          Opnieuw proberen
        </button>
      </div>

      <template v-else-if="overview.data.value">
        <section aria-labelledby="friends-title" class="flex flex-col gap-3">
          <h2 id="friends-title" :class="ui.h2">Per vriend</h2>
          <ul class="grid gap-3 sm:grid-cols-2">
            <li
              v-for="u in overview.data.value.users"
              :key="u.id"
              :class="[ui.card, 'flex flex-col gap-2']"
            >
              <div class="flex items-baseline justify-between gap-3">
                <p class="font-semibold text-slate-900 dark:text-slate-100">{{ u.name }}</p>
                <p :class="ui.muted">
                  {{ u.koersdagen }} {{ u.koersdagen === 1 ? 'koersdag' : 'koersdagen' }}
                </p>
              </div>
              <dl class="flex gap-5 text-sm tabular-nums">
                <div>
                  <dt class="text-slate-500 dark:text-slate-400">Ingezet</dt>
                  <dd class="font-semibold">{{ formatEuro(u.staked) }}</dd>
                </div>
                <div>
                  <dt class="text-slate-500 dark:text-slate-400">Uitbetaald</dt>
                  <dd class="font-semibold">{{ formatEuro(u.paidOut) }}</dd>
                </div>
                <div>
                  <dt class="text-slate-500 dark:text-slate-400">Saldo</dt>
                  <dd :class="['font-semibold', balanceClass(u.balance)]">
                    {{ formatBalance(u.balance) }}
                  </dd>
                </div>
              </dl>
            </li>
          </ul>
        </section>

        <section :class="[ui.card, 'flex flex-col gap-3']" aria-labelledby="all-title">
          <div class="flex flex-wrap items-end justify-between gap-3">
            <h2 id="all-title" :class="ui.h2">Koersdagen</h2>
            <div>
              <label for="friend-filter" :class="ui.label">Toon koersdagen van</label>
              <select id="friend-filter" v-model="friend" :class="[ui.input, 'w-48']">
                <option value="">Iedereen</option>
                <option v-for="u in overview.data.value.users" :key="u.id" :value="u.id">
                  {{ u.name }}
                </option>
              </select>
            </div>
          </div>
          <p v-if="!overviewRows.length" :class="ui.muted">Nog geen afgeronde koersdagen.</p>
          <ul v-else class="flex flex-col divide-y divide-slate-200 dark:divide-white/10">
            <li
              v-for="k in overviewRows"
              :key="`${k.userId}-${k.id}`"
              class="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
            >
              <div class="min-w-0">
                <p class="font-semibold text-slate-900 dark:text-slate-100">{{ k.userName }}</p>
                <p :class="[ui.muted, 'first-letter:uppercase']">
                  {{ k.draverij }} · {{ formatDate(k.date) }}
                </p>
                <p :class="[ui.muted, 'tabular-nums']">
                  {{ formatEuro(k.staked) }} ingezet · {{ formatEuro(k.paidOut) }} uitbetaald
                </p>
              </div>
              <span :class="['shrink-0 font-semibold tabular-nums', balanceClass(k.balance)]">
                {{ formatBalance(k.balance) }}
              </span>
            </li>
          </ul>
        </section>
      </template>
    </template>

    <!-- ── Lessen (owner) ── -->
    <template v-else>
      <div
        v-if="lessons.loading.value"
        class="flex flex-col gap-3"
        aria-busy="true"
        aria-label="Laden"
      >
        <div class="h-40 animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800/60"></div>
      </div>

      <div v-else-if="lessons.loadError.value" class="flex flex-col items-start gap-3">
        <AlertBox>{{ lessons.loadError.value }}</AlertBox>
        <button type="button" :class="ui.btnSecondary" @click="lessons.load">
          Opnieuw proberen
        </button>
      </div>

      <section v-else :class="[ui.card, 'flex flex-col gap-3']" aria-labelledby="lessons-title">
        <div>
          <h2 id="lessons-title" :class="ui.h2">Lessen</h2>
          <p :class="ui.muted">
            De AI legt deze lessen vast bij elke evaluatie en gebruikt ze bij volgende analyses.
            Verwijder een les die niet klopt.
          </p>
        </div>
        <p v-if="!lessons.data.value?.length" :class="ui.muted">
          Nog geen lessen. Ze verschijnen hier zodra een koersdag is geëvalueerd.
        </p>
        <ul v-else class="flex flex-col divide-y divide-slate-200 dark:divide-white/10">
          <li
            v-for="lesson in lessons.data.value"
            :key="lesson.id"
            class="flex items-start justify-between gap-3 py-3 first:pt-0 last:pb-0"
          >
            <div class="min-w-0">
              <p class="text-slate-900 dark:text-slate-100">{{ lesson.text }}</p>
              <p :class="[ui.muted, 'first-letter:uppercase']">
                <template v-if="lesson.place">{{ lesson.place }} · </template>
                {{ formatDate(lesson.date ?? lesson.createdAt) }}
              </p>
            </div>
            <button
              type="button"
              :class="[ui.btnGhost, 'size-11 shrink-0 px-0']"
              :aria-label="`Les verwijderen: ${lesson.text}`"
              @click="askDelete(lesson)"
            >
              <Trash2 class="size-4" aria-hidden="true" />
            </button>
          </li>
        </ul>
      </section>
    </template>

    <ConfirmDialog
      :open="!!toDelete"
      title="Les verwijderen?"
      confirm-label="Les verwijderen"
      cancel-label="Les houden"
      :busy="deleting"
      danger
      @confirm="confirmDelete"
      @cancel="toDelete = null"
    >
      <p>De AI gebruikt deze les daarna niet meer:</p>
      <p class="mt-2 font-medium">{{ toDelete?.text }}</p>
      <AlertBox v-if="deleteError" class="mt-3">{{ deleteError }}</AlertBox>
    </ConfirmDialog>
  </div>
</template>
