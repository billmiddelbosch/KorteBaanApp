import type { Component } from 'vue'

export interface NavItem {
  label: string
  to: string
  icon: Component
}

export interface ShellUser {
  name: string
  avatarUrl?: string
  // The owner manages friends and the AI connection
  isOwner: boolean
  aiStatus?: 'connected' | 'error'
}

// A running speelsessie, shown in the live bar
export interface LiveSession {
  draverij: string
  omloop: string
  budgetRemaining: number
  to: string
}
