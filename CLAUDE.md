# CLAUDE.md — KorteBaanApp

## Tech Stack

- **Frontend**: Vue 3 (`<script setup>`, Composition API) + Vite + TypeScript
- **State / routing**: Pinia, Vue Router
- **Styling**: Tailwind CSS v4 via `@tailwindcss/vite` — no `tailwind.config.ts`; `src/assets/main.css` starts with `@import "tailwindcss"`
- **HTTP**: Axios instance at `src/lib/axios.ts` (base URL `VITE_API_BASE_URL`, default `/api`; attaches `Authorization: Bearer <token>` from localStorage)
- **Mock backend**: MSW (`src/mocks/`), active in `npm run dev` only
- **Tests**: Vitest (unit), Playwright + MSW (E2E)
- **Lint / format**: oxlint + ESLint (flat config), Prettier
- **Hosting**: AWS Amplify (frontend), AWS CDK → API Gateway + Lambda in `eu-west-2` (backend)

## Repository layout

```
src/            Vue app (components, views, router, stores, lib, mocks)
e2e/            Playwright specs (<feature>.spec.ts) + fixtures.ts
lambda/         Lambda handlers — own package, bundled with esbuild
infra/          AWS CDK app (stacks in infra/lib, entry infra/bin/kortebaan.ts)
```

`lambda/` and `infra/` have their own `package.json` and `node_modules`; run `npm install` in each.

## Commands

```bash
npm run dev            # Dev server with MSW mock backend (http://localhost:5173)
npm run build          # Type-check + production build — run before marking any src change done
npm run test:unit      # Vitest
npm run test:e2e       # Playwright (starts its own dev server on port 5180)
npm run lint           # oxlint + ESLint with --fix
npm run format         # Prettier

cd lambda && npm run build && npm test     # Bundle handlers, run handler tests
cd infra && npm run synth                  # Synthesize CloudFormation (builds lambda first)
cd infra && npm run deploy                 # Deploy stacks (builds lambda first)
```

## Way of working — branches & deploy

Branch flow: `feature/<name>` → PR → `main` → PR `main` → `staging` → PR `main` → `production`.

| Branch | Frontend (Amplify) | API stage | Lambda alias |
|---|---|---|---|
| `feature/*`, `main` | — (local `npm run dev`, MSW) | — | — |
| `staging` | `https://test.kortebaan.nl` | `dev` | `dev` |
| `production` | `https://kortebaan.nl` | `prod` | `prod` |

- Never commit directly to `staging` or `production`; always merge `main` into them via a PR.
- Amplify builds each branch itself. Set `VITE_API_BASE_URL` per Amplify branch from the `ApiUrlDev` / `ApiUrlProd` stack outputs.
- Security headers live in `infra/amplify-custom-headers.yml` (paste into Amplify → Custom headers). Add any new external API/script domain to its CSP.
- Backend changes deploy manually with `cd infra && npm run deploy` (AWS credentials for `eu-west-2` required).
- Amplify build scripts must not use the AWS SDK to read S3 (the Amplify build role has no S3 access) — fetch public URLs over HTTP instead.

### Lambda conventions

- One handler per file in `lambda/src/<name>.ts`, exporting `handler`.
- Add `"bundle:<name>": "esbuild src/<name>.ts --bundle --platform=node --target=node22 --outfile=dist/<name>.js --external:@aws-sdk/*"` and append it to the `build` script. The AWS SDK v3 is provided by the runtime; everything else gets bundled.
- Register the function in `infra/lib/api-stack.ts` via `makeFn(...)` and add it to `functions` so it gets `dev`/`prod` aliases and invoke permissions.
- Every HTTP handler uses the helpers in `lambda/src/lib/http.ts`:
  ```ts
  const alias = aliasOf(context)
  const requestOrigin = requestOriginOf(event)
  return respond(200, body, alias, requestOrigin)
  ```
  Pass `requestOrigin` to **every** `respond()` call. `dev` serves `test.kortebaan.nl` + `localhost:5173`; `prod` serves `kortebaan.nl` + `www.kortebaan.nl`.
- When adding a domain/origin, update both `lambda/src/lib/http.ts` and `ALLOWED_ORIGINS` in `infra/lib/config.ts`.
- Per-environment resources (tables, buckets, secrets) are separate for dev and prod; the handler picks one based on `aliasOf(context)`.
- `lambda/tsconfig.json` is for type-checking only; the build is esbuild.

## Way of working — E2E testing (Playwright + MSW)

- The E2E suite never talks to a real backend. `src/main.ts` starts the MSW worker in dev mode, and Playwright always runs against the dev server (dedicated port 5180, so it never reuses another project's server on 5173).
- Mock API: `src/mocks/handlers.ts` (routes under `/api`, ~300 ms simulated latency, Dutch error messages) backed by the in-memory `db` in `src/mocks/data.ts`. **Every new API endpoint gets a matching MSW handler** so both `npm run dev` and E2E keep working.
- Auth in tests: use the `loginAs('user' | 'admin')` fixture from `e2e/fixtures.ts`; it seeds the fixed mock token into localStorage before the page loads. Import `test`/`expect` from `./fixtures`, not from `@playwright/test`.
- One spec per feature: `e2e/<feature>.spec.ts`. Cover rendering, route guards (guest → redirect, user vs admin), form validation messages and the main happy path against mock data.
- Prefer role/text locators (`getByRole`, `getByText`); assert on the user-visible Dutch copy.
- Wait for the mounted app before calling the API from the page: the app mounts only after MSW is ready.
- Keep IDs/tokens in `src/mocks/data.ts` stable — specs rely on them.

## Coding standards

- `<script setup lang="ts">` only; no Options API. Avoid `any`.
- Components PascalCase; composables `useXxx.ts`; Pinia stores `useXxxStore`.
- API calls go through `src/lib/axios.ts`, wrapped in composables or stores.
- `RouterLink` for internal navigation.
- `@/` maps to `src/`.
