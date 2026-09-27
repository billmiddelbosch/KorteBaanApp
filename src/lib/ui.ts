// Shared Tailwind class sets so buttons, inputs and cards look the same on every screen.
// Buttons and inputs share the 44px height (touch targets outdoors at the track).

const focus =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:focus-visible:outline-blue-400'

const button = `inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${focus}`

export const ui = {
  btnPrimary: `${button} bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-400 dark:text-slate-950`,
  btnSecondary: `${button} border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 dark:border-white/15 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800`,
  btnGhost: `${button} text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-white/5`,
  btnDanger: `${button} bg-red-600 text-white hover:bg-red-700 dark:bg-red-500 dark:hover:bg-red-400 dark:text-slate-950`,
  btnDangerOutline: `${button} border border-red-300 bg-white text-red-700 hover:bg-red-50 dark:border-red-500/40 dark:bg-transparent dark:text-red-400 dark:hover:bg-red-500/10`,
  label: 'block text-sm font-medium text-slate-800 dark:text-slate-200',
  hint: 'mt-1 text-sm text-slate-500 dark:text-slate-400',
  input:
    'mt-1.5 block min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-base text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-2 focus:outline-blue-600/30 aria-invalid:border-red-600 dark:border-white/15 dark:bg-slate-900 dark:text-slate-100 dark:focus:border-blue-400 dark:aria-invalid:border-red-400',
  fieldError: 'mt-1.5 flex items-start gap-1.5 text-sm text-red-700 dark:text-red-400',
  card: 'rounded-xl border border-slate-200 bg-white p-4 md:p-6 dark:border-white/10 dark:bg-slate-900',
  h1: 'text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100',
  h2: 'text-lg font-semibold text-slate-900 dark:text-slate-100',
  page: 'mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6 md:px-8 md:py-8',
  muted: 'text-sm text-slate-600 dark:text-slate-400',
} as const
