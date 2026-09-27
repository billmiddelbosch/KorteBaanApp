import axios from 'axios'
import { AUTH_TOKEN_KEY } from './constants'

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL ?? '/api',
  headers: { 'Content-Type': 'application/json' },
})

api.interceptors.request.use((config) => {
  const token = localStorage.getItem(AUTH_TOKEN_KEY)
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

let unauthorizedHandler: (() => void) | null = null

// Lets the auth store react to an expired session without a circular import
export function onUnauthorized(handler: () => void) {
  unauthorizedHandler = handler
}

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem(AUTH_TOKEN_KEY)
      unauthorizedHandler?.()
    }
    return Promise.reject(error)
  },
)
