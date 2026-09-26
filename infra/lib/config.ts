// Single place for project-wide infra settings.
export const PROJECT = 'kortebaan'
export const REGION = 'eu-west-2'

// Browser origins allowed by the API Gateway CORS preflight (both stages).
// Keep in sync with PROD_ORIGINS / DEV_ORIGINS in lambda/src/lib/http.ts.
export const ALLOWED_ORIGINS = [
  'https://kortebaan.nl',
  'https://www.kortebaan.nl',
  'https://test.kortebaan.nl',
  'http://localhost:5173',
]
