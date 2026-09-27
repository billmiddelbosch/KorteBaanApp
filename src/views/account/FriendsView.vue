<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { UserPlus, Users } from '@lucide/vue'
import AlertBox from '@/components/account/AlertBox.vue'
import ConfirmDialog from '@/components/account/ConfirmDialog.vue'
import ShareLink from '@/components/account/ShareLink.vue'
import { useFriends } from '@/composables/useFriends'
import { errorMessage } from '@/lib/errors'
import { formatDateTime, formatRelative } from '@/lib/format'
import { ui } from '@/lib/ui'
import type { Friend, FriendStatus, IssuedLink } from '@/types/account'

const DEFAULT_LIMIT = 10

const { friends, loading, loadError, load, invite, update, remove, newLink } = useFriends()

const STATUS: Record<FriendStatus, { label: string; class: string }> = {
  active: {
    label: 'Actief',
    class: 'bg-emerald-50 text-emerald-800 ring-emerald-600/20 dark:bg-emerald-400/10 dark:text-emerald-300 dark:ring-emerald-400/30',
  },
  paused: {
    label: 'Gepauzeerd',
    class: 'bg-slate-100 text-slate-700 ring-slate-500/20 dark:bg-white/5 dark:text-slate-300 dark:ring-white/15',
  },
  invited: {
    label: 'Uitgenodigd',
    class: 'bg-blue-50 text-blue-800 ring-blue-600/20 dark:bg-blue-400/10 dark:text-blue-300 dark:ring-blue-400/30',
  },
  expired: {
    label: 'Link verlopen',
    class: 'bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-400/10 dark:text-amber-300 dark:ring-amber-400/30',
  },
}

// Empty field = no limit; otherwise a whole number 0–1000
function parseLimit(value: string): number | null | undefined {
  const trimmed = value.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  return Number.isInteger(n) && n >= 0 && n <= 1000 ? n : undefined
}
const LIMIT_ERROR = 'Vul een heel getal van 0 tot 1000 in, of laat het veld leeg voor geen limiet.'

// ── Invite ──
const inviteOpen = ref(false)
const inviteName = ref('')
const inviteLimit = ref(String(DEFAULT_LIMIT))
const inviteErrors = ref<{ name?: string; limit?: string }>({})
const inviteError = ref<string | null>(null)
const inviting = ref(false)
const invited = ref<{ name: string; link: IssuedLink } | null>(null)
const inviteNameInput = ref<HTMLInputElement | null>(null)

async function openInvite() {
  inviteOpen.value = true
  invited.value = null
  inviteName.value = ''
  inviteLimit.value = String(DEFAULT_LIMIT)
  inviteErrors.value = {}
  inviteError.value = null
  await nextTick()
  inviteNameInput.value?.focus()
}

async function submitInvite() {
  const limit = parseLimit(inviteLimit.value)
  inviteErrors.value = {
    name: inviteName.value.trim() ? undefined : 'Vul de naam van je vriend in.',
    limit: limit === undefined ? LIMIT_ERROR : undefined,
  }
  if (inviteErrors.value.name || limit === undefined) return

  inviting.value = true
  inviteError.value = null
  try {
    const name = inviteName.value.trim()
    invited.value = { name, link: await invite(name, limit) }
  } catch (error) {
    inviteError.value = errorMessage(error)
  } finally {
    inviting.value = false
  }
}

// ── Per-friend actions ──
const busyId = ref<string | null>(null)
const rowErrors = ref<Record<string, string>>({})
const links = ref<Record<string, IssuedLink>>({})
const limitEditId = ref<string | null>(null)
const limitDraft = ref('')
const limitError = ref<string | null>(null)

async function run(friend: Friend, action: () => Promise<void>) {
  busyId.value = friend.id
  delete rowErrors.value[friend.id]
  try {
    await action()
  } catch (error) {
    rowErrors.value[friend.id] = errorMessage(error)
  } finally {
    busyId.value = null
  }
}

const togglePause = (friend: Friend) =>
  run(friend, () => update(friend.id, { status: friend.status === 'paused' ? 'active' : 'paused' }))

const issueLink = (friend: Friend) =>
  run(friend, async () => {
    links.value[friend.id] = await newLink(friend.id)
  })

function editLimit(friend: Friend) {
  limitEditId.value = friend.id
  limitDraft.value = friend.dailyLimit === null ? '' : String(friend.dailyLimit)
  limitError.value = null
}

function saveLimit(friend: Friend) {
  const limit = parseLimit(limitDraft.value)
  if (limit === undefined) {
    limitError.value = LIMIT_ERROR
    return
  }
  return run(friend, async () => {
    await update(friend.id, { dailyLimit: limit })
    limitEditId.value = null
  })
}

// ── Delete ──
const toDelete = ref<Friend | null>(null)
const deleting = ref(false)
const deleteError = ref<string | null>(null)

async function confirmDelete() {
  if (!toDelete.value) return
  deleting.value = true
  deleteError.value = null
  try {
    await remove(toDelete.value.id)
    toDelete.value = null
  } catch (error) {
    deleteError.value = errorMessage(error)
  } finally {
    deleting.value = false
  }
}

const hasAccount = (friend: Friend) => friend.status === 'active' || friend.status === 'paused'
const linkLabel = (friend: Friend) =>
  hasAccount(friend) ? 'Herstellink maken' : 'Nieuwe uitnodigingslink'
const limitText = (friend: Friend) =>
  friend.dailyLimit === null
    ? `${friend.usedToday} vandaag · geen limiet`
    : `${friend.usedToday} van ${friend.dailyLimit} vandaag`
const activeCount = computed(() => friends.value.filter((f) => f.status === 'active').length)

onMounted(load)
</script>

<template>
  <div :class="ui.page">
    <header class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 :class="ui.h1">Vrienden</h1>
        <p :class="[ui.muted, 'mt-1']">
          Nodig vrienden uit en bepaal hoeveel AI-analyses ze per dag mogen doen.
        </p>
      </div>
      <button v-if="!inviteOpen" type="button" :class="ui.btnPrimary" @click="openInvite">
        <UserPlus class="size-4" aria-hidden="true" />
        Vriend uitnodigen
      </button>
    </header>

    <!-- Invite -->
    <section v-if="inviteOpen" aria-labelledby="invite-title" :class="ui.card">
      <h2 id="invite-title" :class="ui.h2">
        {{ invited ? `Uitnodiging voor ${invited.name}` : 'Vriend uitnodigen' }}
      </h2>

      <template v-if="invited">
        <p :class="[ui.muted, 'mt-1']">
          Stuur deze link naar {{ invited.name }}. Daarmee kiest {{ invited.name }} zelf een
          gebruikersnaam en wachtwoord.
        </p>
        <ShareLink class="mt-4" :link="invited.link" :name="invited.name" />
        <div class="mt-4 flex flex-wrap gap-2">
          <button type="button" :class="ui.btnSecondary" @click="inviteOpen = false">Klaar</button>
          <button type="button" :class="ui.btnGhost" @click="openInvite">
            Nog iemand uitnodigen
          </button>
        </div>
      </template>

      <form v-else class="mt-4 flex flex-col gap-4" novalidate @submit.prevent="submitInvite">
        <AlertBox v-if="inviteError">{{ inviteError }}</AlertBox>
        <div>
          <label for="invite-name" :class="ui.label">Naam</label>
          <input
            id="invite-name"
            ref="inviteNameInput"
            v-model="inviteName"
            type="text"
            maxlength="40"
            autocomplete="off"
            :aria-invalid="!!inviteErrors.name || undefined"
            :aria-describedby="inviteErrors.name ? 'invite-name-error' : 'invite-name-hint'"
            :class="ui.input"
          />
          <p v-if="inviteErrors.name" id="invite-name-error" :class="ui.fieldError">
            {{ inviteErrors.name }}
          </p>
          <p v-else id="invite-name-hint" :class="ui.hint">
            Je vriend kan de naam later zelf aanpassen.
          </p>
        </div>
        <div>
          <label for="invite-limit" :class="ui.label">AI-analyses per dag</label>
          <input
            id="invite-limit"
            v-model="inviteLimit"
            type="text"
            inputmode="numeric"
            :aria-invalid="!!inviteErrors.limit || undefined"
            :aria-describedby="inviteErrors.limit ? 'invite-limit-error' : 'invite-limit-hint'"
            :class="[ui.input, 'max-w-32']"
          />
          <p v-if="inviteErrors.limit" id="invite-limit-error" :class="ui.fieldError">
            {{ inviteErrors.limit }}
          </p>
          <p v-else id="invite-limit-hint" :class="ui.hint">
            Leeg laten = geen limiet. Je kunt dit later altijd wijzigen.
          </p>
        </div>
        <div class="flex flex-wrap gap-2">
          <button type="submit" :class="ui.btnPrimary" :disabled="inviting">
            {{ inviting ? 'Link maken…' : 'Uitnodigingslink maken' }}
          </button>
          <button type="button" :class="ui.btnGhost" :disabled="inviting" @click="inviteOpen = false">
            Annuleren
          </button>
        </div>
      </form>
    </section>

    <!-- List -->
    <section aria-labelledby="friends-title">
      <h2 id="friends-title" class="sr-only">Je vrienden</h2>

      <div v-if="loading" class="flex flex-col gap-3" aria-busy="true" aria-label="Laden">
        <div
          v-for="n in 3"
          :key="n"
          class="h-28 animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800/60"
        ></div>
      </div>

      <div v-else-if="loadError" class="flex flex-col items-start gap-3">
        <AlertBox>{{ loadError }}</AlertBox>
        <button type="button" :class="ui.btnSecondary" @click="load">Opnieuw proberen</button>
      </div>

      <div v-else-if="friends.length === 0" :class="[ui.card, 'py-10 text-center']">
        <div
          class="mx-auto grid size-12 place-items-center rounded-full bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300"
        >
          <Users class="size-6" aria-hidden="true" />
        </div>
        <p class="mt-3 font-medium text-slate-900 dark:text-slate-100">Nog geen vrienden</p>
        <p :class="[ui.muted, 'mx-auto mt-1 max-w-sm']">
          Maak een uitnodigingslink en stuur die via WhatsApp. Je vriend kiest zelf een
          gebruikersnaam en wachtwoord; de link werkt 7 dagen.
        </p>
        <button v-if="!inviteOpen" type="button" :class="[ui.btnPrimary, 'mt-4']" @click="openInvite">
          <UserPlus class="size-4" aria-hidden="true" />
          Vriend uitnodigen
        </button>
      </div>

      <template v-else>
        <p :class="[ui.muted, 'mb-3']">
          {{ friends.length }} {{ friends.length === 1 ? 'vriend' : 'vrienden' }} ·
          {{ activeCount }} actief
        </p>
        <ul class="flex flex-col gap-3">
          <li
            v-for="friend in friends"
            :key="friend.id"
            :class="ui.card"
            :aria-label="friend.name"
            data-testid="friend"
          >
            <div class="flex flex-wrap items-start justify-between gap-2">
              <div class="min-w-0">
                <p class="truncate font-semibold text-slate-900 dark:text-slate-100">
                  {{ friend.name }}
                </p>
                <p class="text-sm text-slate-500 dark:text-slate-400">
                  <span v-if="friend.username" class="font-mono">{{ friend.username }}</span>
                  <span v-else>Nog geen account</span>
                </p>
              </div>
              <span
                class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset"
                :class="STATUS[friend.status].class"
                >{{ STATUS[friend.status].label }}</span
              >
            </div>

            <dl class="mt-3 grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
              <div class="flex gap-1.5">
                <dt class="text-slate-500 dark:text-slate-400">AI-analyses:</dt>
                <dd class="tabular-nums text-slate-800 dark:text-slate-200">
                  {{ limitText(friend) }}
                </dd>
              </div>
              <div v-if="hasAccount(friend)" class="flex gap-1.5">
                <dt class="text-slate-500 dark:text-slate-400">Laatst actief:</dt>
                <dd class="text-slate-800 dark:text-slate-200">
                  {{ friend.lastActiveAt ? formatRelative(friend.lastActiveAt) : 'nog niet' }}
                </dd>
              </div>
              <div v-else-if="friend.linkExpiresAt" class="flex gap-1.5">
                <dt class="text-slate-500 dark:text-slate-400">
                  {{ friend.status === 'expired' ? 'Verlopen op:' : 'Link geldig tot:' }}
                </dt>
                <dd class="text-slate-800 dark:text-slate-200">
                  {{ formatDateTime(friend.linkExpiresAt) }}
                </dd>
              </div>
            </dl>

            <!-- Daily limit editor -->
            <form
              v-if="limitEditId === friend.id"
              class="mt-4 flex flex-col gap-2 rounded-lg bg-slate-50 p-3 dark:bg-slate-950/60"
              novalidate
              @submit.prevent="saveLimit(friend)"
            >
              <label :for="`limit-${friend.id}`" :class="ui.label">AI-analyses per dag</label>
              <div class="flex flex-wrap items-start gap-2">
                <input
                  :id="`limit-${friend.id}`"
                  v-model="limitDraft"
                  type="text"
                  inputmode="numeric"
                  :aria-invalid="!!limitError || undefined"
                  :aria-describedby="`limit-${friend.id}-help`"
                  :class="[ui.input, 'mt-0 max-w-32']"
                />
                <button type="submit" :class="ui.btnPrimary" :disabled="busyId === friend.id">
                  Opslaan
                </button>
                <button type="button" :class="ui.btnGhost" @click="limitEditId = null">
                  Annuleren
                </button>
              </div>
              <p
                :id="`limit-${friend.id}-help`"
                :class="limitError ? ui.fieldError : 'text-sm text-slate-500 dark:text-slate-400'"
              >
                {{ limitError ?? 'Leeg laten = geen limiet.' }}
              </p>
            </form>

            <AlertBox v-if="rowErrors[friend.id]" class="mt-4">{{ rowErrors[friend.id] }}</AlertBox>

            <div v-if="links[friend.id]" class="mt-4">
              <ShareLink :link="links[friend.id]!" :name="friend.name" />
            </div>

            <div class="mt-4 flex flex-wrap gap-2 border-t border-slate-200 pt-3 dark:border-white/10">
              <button
                v-if="hasAccount(friend)"
                type="button"
                :class="ui.btnSecondary"
                :disabled="busyId === friend.id"
                @click="togglePause(friend)"
              >
                {{ friend.status === 'paused' ? 'Hervatten' : 'Pauzeren' }}
              </button>
              <button
                v-if="limitEditId !== friend.id"
                type="button"
                :class="ui.btnSecondary"
                :disabled="busyId === friend.id"
                @click="editLimit(friend)"
              >
                Daglimiet wijzigen
              </button>
              <button
                type="button"
                :class="ui.btnSecondary"
                :disabled="busyId === friend.id"
                @click="issueLink(friend)"
              >
                {{ linkLabel(friend) }}
              </button>
              <button
                type="button"
                :class="[ui.btnGhost, 'text-red-700 dark:text-red-400']"
                :disabled="busyId === friend.id"
                @click="((toDelete = friend), (deleteError = null))"
              >
                Verwijderen
              </button>
            </div>
          </li>
        </ul>
      </template>
    </section>

    <ConfirmDialog
      :open="!!toDelete"
      :title="`${toDelete?.name ?? 'Vriend'} verwijderen?`"
      :confirm-label="`${toDelete?.name ?? 'Vriend'} verwijderen`"
      cancel-label="Behouden"
      :busy="deleting"
      danger
      @confirm="confirmDelete"
      @cancel="toDelete = null"
    >
      <p>
        {{ toDelete?.name }} kan dan niet meer inloggen en openstaande links werken niet meer. Dit
        kun je niet ongedaan maken; wil je alleen tijdelijk de toegang stoppen, kies dan
        Pauzeren.
      </p>
      <AlertBox v-if="deleteError" class="mt-3">{{ deleteError }}</AlertBox>
    </ConfirmDialog>
  </div>
</template>
