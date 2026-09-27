import { fileURLToPath } from 'node:url'
import { mergeConfig, defineConfig, configDefaults } from 'vitest/config'
import viteConfig from './vite.config.ts'

export default defineConfig((env) =>
  mergeConfig(viteConfig(env), {
    test: {
      environment: 'jsdom',
      // e2e = Playwright; lambda/ and infra/ have their own test setups
      exclude: [...configDefaults.exclude, 'e2e/**', 'lambda/**', 'infra/**'],
      root: fileURLToPath(new URL('./', import.meta.url)),
    },
  }),
)
