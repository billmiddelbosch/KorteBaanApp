import { ref } from 'vue'
import { api } from '@/lib/axios'
import { errorMessage } from '@/lib/errors'
import type { Friend, IssuedLink } from '@/types/account'

export function useFriends() {
  const friends = ref<Friend[]>([])
  const loading = ref(true)
  const loadError = ref<string | null>(null)

  function replace(friend: Friend) {
    const i = friends.value.findIndex((f) => f.id === friend.id)
    if (i >= 0) friends.value[i] = friend
    else
      friends.value = [...friends.value, friend].sort((a, b) => a.name.localeCompare(b.name, 'nl'))
  }

  async function load() {
    loading.value = true
    loadError.value = null
    try {
      friends.value = (await api.get<{ friends: Friend[] }>('/friends')).data.friends
    } catch (error) {
      loadError.value = errorMessage(error)
    } finally {
      loading.value = false
    }
  }

  async function invite(name: string, dailyLimit: number | null) {
    const { data } = await api.post<{ friend: Friend; link: IssuedLink }>('/friends', {
      name,
      dailyLimit,
    })
    replace(data.friend)
    return data.link
  }

  async function update(id: string, patch: { status?: 'active' | 'paused'; dailyLimit?: number | null }) {
    const { data } = await api.patch<{ friend: Friend }>(`/friends/${id}`, patch)
    replace(data.friend)
  }

  async function remove(id: string) {
    await api.delete(`/friends/${id}`)
    friends.value = friends.value.filter((f) => f.id !== id)
  }

  async function newLink(id: string) {
    const { data } = await api.post<{ friend: Friend; link: IssuedLink }>(`/friends/${id}/link`)
    replace(data.friend)
    return data.link
  }

  return { friends, loading, loadError, load, invite, update, remove, newLink }
}
