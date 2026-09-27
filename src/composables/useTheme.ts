import { ref, watch } from 'vue'

export type ThemeMode = 'light' | 'dark' | 'auto'

const STORAGE_KEY = 'theme'

function readStoredMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'auto') return stored
  } catch {
    // Storage unavailable (private mode) — fall back to the system preference
  }
  return 'auto'
}

// Module-level state: one theme for the whole app
const mode = ref<ThemeMode>(readStoredMode())
const media = window.matchMedia('(prefers-color-scheme: dark)')

function apply() {
  const dark = mode.value === 'dark' || (mode.value === 'auto' && media.matches)
  document.documentElement.classList.toggle('dark', dark)
}

watch(mode, (value) => {
  try {
    localStorage.setItem(STORAGE_KEY, value)
  } catch {
    // Not persisted; the choice still applies for this visit
  }
  apply()
})
media.addEventListener('change', apply)
apply()

export function useTheme() {
  return { mode }
}
