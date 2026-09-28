import { ref } from 'vue'
import { api } from '@/lib/axios'
import { errorMessage } from '@/lib/errors'
import type { OAuthConsent } from '@/types/oauth'

// The consent step of the kennisbank OAuth flow: the query is the one the MCP client
// (Claude Code, claude.ai) sent; the API checks it and answers with where to send the browser.
export function useOAuthConsent(query: Record<string, string>) {
  const consent = ref<OAuthConsent | null>(null)
  const loading = ref(true)
  const loadError = ref<string | null>(null)

  async function load() {
    loading.value = true
    loadError.value = null
    try {
      consent.value = (await api.get<OAuthConsent>('/oauth/authorize', { params: query })).data
    } catch (error) {
      loadError.value = errorMessage(error)
    } finally {
      loading.value = false
    }
  }

  async function decide(approve: boolean): Promise<string> {
    return (await api.post<{ redirectTo: string }>('/oauth/authorize', { ...query, approve })).data
      .redirectTo
  }

  return { consent, loading, loadError, load, decide }
}
