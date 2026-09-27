const euro = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' })

export const formatEuro = (amount: number) => euro.format(amount)

// Always show the sign so winst/verlies never relies on colour alone
export function formatBalance(amount: number): string {
  if (amount === 0) return euro.format(0)
  return `${amount > 0 ? '+' : '−'}${euro.format(Math.abs(amount))}`
}

export const balanceClass = (amount: number) =>
  amount > 0
    ? 'text-emerald-700 dark:text-emerald-400'
    : amount < 0
      ? 'text-red-700 dark:text-red-400'
      : 'text-slate-700 dark:text-slate-300'

export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' }).format(
    new Date(iso),
  )
}

export function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat('nl-NL', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso))
}

// "zojuist", "12 min geleden", "3 uur geleden", "gisteren", "5 dagen geleden", or a date
export function formatRelative(iso: string, now = Date.now()): string {
  const minutes = Math.round((now - Date.parse(iso)) / 60_000)
  if (minutes < 2) return 'zojuist'
  if (minutes < 60) return `${minutes} min geleden`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} uur geleden`
  const days = Math.round(hours / 24)
  if (days === 1) return 'gisteren'
  if (days < 14) return `${days} dagen geleden`
  return formatDate(iso)
}
