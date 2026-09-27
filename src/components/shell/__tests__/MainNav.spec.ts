import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { Flag, History } from '@lucide/vue'
import MainNav from '../MainNav.vue'

const items = [
  { label: 'Koersdag', to: '/', icon: Flag },
  { label: 'Historie', to: '/historie', icon: History },
]

async function mountAt(path: string) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: ['/', '/historie', '/historie/:id'].map((p) => ({
      path: p,
      component: { render: () => null },
    })),
  })
  await router.push(path)
  return mount(MainNav, { props: { items, variant: 'bar' }, global: { plugins: [router] } })
}

const currentLabel = (wrapper: Awaited<ReturnType<typeof mountAt>>) =>
  wrapper.find('[aria-current="page"]').text()

describe('MainNav', () => {
  it('marks Koersdag active only on the root path', async () => {
    expect(currentLabel(await mountAt('/'))).toBe('Koersdag')
  })

  it('keeps a section active on its sub-routes', async () => {
    const wrapper = await mountAt('/historie/42')
    expect(currentLabel(wrapper)).toBe('Historie')
    expect(wrapper.findAll('[aria-current="page"]')).toHaveLength(1)
  })
})
