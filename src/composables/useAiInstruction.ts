import { ref } from 'vue'
import { api } from '@/lib/axios'
import { errorMessage } from '@/lib/errors'
import type { AiInstruction } from '@/types/analyse'

export function useAiInstruction() {
  const instruction = ref<AiInstruction | null>(null)
  const loading = ref(true)
  const loadError = ref<string | null>(null)

  async function load() {
    loading.value = true
    loadError.value = null
    try {
      instruction.value = (await api.get<AiInstruction>('/ai-instruction')).data
    } catch (error) {
      loadError.value = errorMessage(error)
    } finally {
      loading.value = false
    }
  }

  async function save(text: string) {
    instruction.value = (await api.put<AiInstruction>('/ai-instruction', { text })).data
  }

  async function revert(to: 'previous' | 'default') {
    instruction.value = (await api.post<AiInstruction>('/ai-instruction/revert', { to })).data
  }

  return { instruction, loading, loadError, load, save, revert }
}
