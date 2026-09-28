export type OAuthScope = 'kb:read' | 'kb:write' | 'kb:sql'

// GET /oauth/authorize — what the consent page shows
export interface OAuthConsent {
  client: { name: string; redirectHost: string }
  scopes: { scope: OAuthScope; description: string }[]
}
