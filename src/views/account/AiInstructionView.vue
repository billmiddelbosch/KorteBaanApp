<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import AlertBox from '@/components/account/AlertBox.vue'
import ConfirmDialog from '@/components/account/ConfirmDialog.vue'
import { useAiInstruction } from '@/composables/useAiInstruction'
import { errorMessage } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { ui } from '@/lib/ui'

const MAX_LENGTH = 8000

const { instruction, loading, loadError, load, save, revert } = useAiInstruction()

const text = ref('')
const saving = ref(false)
const saveError = ref<string | null>(null)
const saved = ref<string | null>(null)

// Reset the editor whenever a new version comes from the server
watch(instruction, (value) => {
  if (value) text.value = value.text
})

const dirty = computed(() => !!instruction.value && text.value.trim() !== instruction.value.text)

async function submit() {
  saved.value = null
  if (!text.value.trim()) {
    saveError.value = 'De instructie mag niet leeg zijn.'
    return
  }
  saving.value = true
  saveError.value = null
  try {
    await save(text.value.trim())
    saved.value = 'Instructie opgeslagen. Nieuwe AI-antwoorden gebruiken deze versie.'
  } catch (error) {
    saveError.value = errorMessage(error)
  } finally {
    saving.value = false
  }
}

// ── Revert ──
const revertTo = ref<'previous' | 'default' | null>(null)
const reverting = ref(false)
const revertError = ref<string | null>(null)

function askRevert(to: 'previous' | 'default') {
  revertTo.value = to
  revertError.value = null
}

async function confirmRevert() {
  if (!revertTo.value) return
  reverting.value = true
  revertError.value = null
  try {
    const to = revertTo.value
    await revert(to)
    revertTo.value = null
    saveError.value = null
    saved.value =
      to === 'default' ? 'De standaardinstructie staat weer aan.' : 'De vorige versie staat weer aan.'
  } catch (error) {
    revertError.value = errorMessage(error)
  } finally {
    reverting.value = false
  }
}

onMounted(load)
</script>

<template>
  <div :class="ui.page">
    <header>
      <h1 :class="ui.h1">AI-instructie</h1>
      <p :class="[ui.muted, 'mt-1']">
        Deze instructie krijgt de AI bij elke analyse mee, voor jou en al je vrienden.
      </p>
    </header>

    <div v-if="loading" class="h-80 animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800/60" aria-busy="true" aria-label="Laden"></div>

    <div v-else-if="loadError" class="flex flex-col items-start gap-3">
      <AlertBox>{{ loadError }}</AlertBox>
      <button type="button" :class="ui.btnSecondary" @click="load">Opnieuw proberen</button>
    </div>

    <template v-else-if="instruction">
      <form :class="[ui.card, 'flex flex-col gap-4']" novalidate @submit.prevent="submit">
        <AlertBox v-if="saved" tone="success">{{ saved }}</AlertBox>
        <div>
          <div class="flex flex-wrap items-baseline justify-between gap-2">
            <label for="instruction" :class="ui.label">Instructie</label>
            <span class="text-xs text-slate-500 dark:text-slate-400">
              {{ instruction.isDefault ? 'Standaardversie' : 'Aangepast' }}
              <template v-if="instruction.updatedAt">
                · gewijzigd {{ formatDateTime(instruction.updatedAt) }}
              </template>
            </span>
          </div>
          <textarea
            id="instruction"
            v-model="text"
            rows="16"
            :maxlength="MAX_LENGTH"
            :class="[ui.input, 'py-2.5 font-mono text-sm leading-relaxed']"
            :aria-invalid="!!saveError"
            :aria-describedby="saveError ? 'instruction-error' : 'instruction-hint'"
            @input="saved = null"
          ></textarea>
          <p v-if="saveError" id="instruction-error" :class="ui.fieldError">{{ saveError }}</p>
          <p v-else id="instruction-hint" :class="ui.hint">
            {{ text.length }} van {{ MAX_LENGTH }} tekens. Lopende gesprekken gebruiken de nieuwe
            versie vanaf hun volgende antwoord.
          </p>
        </div>
        <div class="flex flex-wrap gap-3">
          <button type="submit" :class="ui.btnPrimary" :disabled="saving || !dirty">
            {{ saving ? 'Opslaan…' : 'Opslaan' }}
          </button>
          <button
            v-if="dirty"
            type="button"
            :class="ui.btnGhost"
            @click="((text = instruction.text), (saveError = null))"
          >
            Wijzigingen weggooien
          </button>
        </div>
      </form>

      <section aria-labelledby="revert-title" :class="ui.card">
        <h2 id="revert-title" :class="ui.h2">Terugzetten</h2>
        <p :class="[ui.muted, 'mt-1']">
          Ging er iets mis na een wijziging? Zet de vorige versie of de standaardinstructie terug.
        </p>
        <div class="mt-4 flex flex-wrap gap-3">
          <button
            type="button"
            :class="ui.btnSecondary"
            :disabled="!instruction.hasPrevious"
            @click="askRevert('previous')"
          >
            Terug naar vorige versie
          </button>
          <button
            type="button"
            :class="ui.btnSecondary"
            :disabled="instruction.isDefault"
            @click="askRevert('default')"
          >
            Terug naar standaard
          </button>
        </div>
      </section>
    </template>

    <ConfirmDialog
      :open="revertTo !== null"
      :title="revertTo === 'default' ? 'Standaardinstructie terugzetten?' : 'Vorige versie terugzetten?'"
      :confirm-label="revertTo === 'default' ? 'Standaard terugzetten' : 'Vorige versie terugzetten'"
      cancel-label="Huidige houden"
      :busy="reverting"
      @confirm="confirmRevert"
      @cancel="revertTo = null"
    >
      <p>
        De huidige instructie wordt vervangen. Je kunt daarna altijd weer terug naar de versie van
        nu via “Terug naar vorige versie”.
      </p>
      <p v-if="dirty" class="mt-2">Niet-opgeslagen wijzigingen gaan verloren.</p>
      <AlertBox v-if="revertError" class="mt-3">{{ revertError }}</AlertBox>
    </ConfirmDialog>
  </div>
</template>
