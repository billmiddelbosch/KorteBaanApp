// Glicko-2 ratings for kortebaan horses (Glickman, "Example of the Glicko-2 system", 2012).
// One rating period per draverij day; a game is one koppel (the winner of the best-of-3).
// Horses that do not start in a period only gain uncertainty (rd grows).

export interface Rating {
  rating: number
  rd: number
  volatility: number
}

export const INITIAL: Rating = { rating: 1500, rd: 350, volatility: 0.06 }
const SCALE = 173.7178
const TAU = 0.5
const EPSILON = 0.000001
// Keep the uncertainty of a horse that hasn't run for years at the level of a newcomer
const MAX_RD = 350

const g = (phi: number) => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI))
const expected = (mu: number, muJ: number, phiJ: number) => 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)))

// Chance that a beats b; the uncertainty of both sides flattens the chance towards 50%
export function winChance(a: Rating, b: Rating): number {
  const mu = (a.rating - 1500) / SCALE
  const muJ = (b.rating - 1500) / SCALE
  const phi = Math.sqrt(a.rd * a.rd + b.rd * b.rd) / SCALE
  return 1 / (1 + Math.exp(-g(phi) * (mu - muJ)))
}

export interface Game {
  opponent: Rating
  score: 0 | 1
}

// One horse's rating after a period with these games (step 2–8 of the paper)
export function update(r: Rating, games: Game[]): Rating {
  const mu = (r.rating - 1500) / SCALE
  const phi = r.rd / SCALE
  if (!games.length) {
    const phiStar = Math.sqrt(phi * phi + r.volatility * r.volatility)
    return { ...r, rd: Math.min(MAX_RD, phiStar * SCALE) }
  }

  let vInv = 0
  let deltaSum = 0
  for (const game of games) {
    const muJ = (game.opponent.rating - 1500) / SCALE
    const phiJ = game.opponent.rd / SCALE
    const e = expected(mu, muJ, phiJ)
    vInv += g(phiJ) ** 2 * e * (1 - e)
    deltaSum += g(phiJ) * (game.score - e)
  }
  const v = 1 / vInv
  const delta = v * deltaSum

  // New volatility via the Illinois algorithm
  const a = Math.log(r.volatility ** 2)
  const f = (x: number) =>
    (Math.exp(x) * (delta * delta - phi * phi - v - Math.exp(x))) / (2 * (phi * phi + v + Math.exp(x)) ** 2) - (x - a) / (TAU * TAU)
  let A = a
  let B: number
  if (delta * delta > phi * phi + v) {
    B = Math.log(delta * delta - phi * phi - v)
  } else {
    let k = 1
    while (f(a - k * TAU) < 0) k++
    B = a - k * TAU
  }
  let fA = f(A)
  let fB = f(B)
  for (let i = 0; i < 100 && Math.abs(B - A) > EPSILON; i++) {
    const C = A + ((A - B) * fA) / (fB - fA)
    const fC = f(C)
    if (fC * fB <= 0) {
      A = B
      fA = fB
    } else {
      fA /= 2
    }
    B = C
    fB = fC
  }
  const sigma = Math.exp(A / 2)

  const phiStar = Math.sqrt(phi * phi + sigma * sigma)
  const phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v)
  const muNew = mu + phiNew * phiNew * deltaSum
  return { rating: muNew * SCALE + 1500, rd: Math.min(MAX_RD, phiNew * SCALE), volatility: sigma }
}

export interface Match {
  date: string
  a: string
  b: string
  // true: a won
  aWon: boolean
}

export interface RatingRow extends Rating {
  horseId: string
  date: string
}

export interface RatingRun {
  // Rating of each horse after every period in which it ran
  rows: RatingRow[]
  current: Map<string, Rating & { date: string }>
  // Win chance of a before each match, for the backtest
  forecasts: { date: string; p: number; aWon: boolean }[]
}

// Replays all matches in date order. Unplayed periods are applied lazily: a horse's rd grows
// once per period it sat out since its last start.
export function computeRatings(matches: Match[]): RatingRun {
  const byDate = new Map<string, Match[]>()
  for (const m of [...matches].sort((x, y) => x.date.localeCompare(y.date))) {
    const list = byDate.get(m.date) ?? []
    list.push(m)
    byDate.set(m.date, list)
  }
  const periods = [...byDate.keys()]
  const state = new Map<string, { r: Rating; period: number }>()
  const rows: RatingRow[] = []
  const forecasts: RatingRun['forecasts'] = []

  const at = (horse: string, period: number): Rating => {
    const s = state.get(horse)
    if (!s) return INITIAL
    let r = s.r
    for (let p = s.period + 1; p < period; p++) r = update(r, [])
    return r
  }

  periods.forEach((date, period) => {
    const list = byDate.get(date)!
    const before = new Map<string, Rating>()
    for (const m of list) for (const h of [m.a, m.b]) if (!before.has(h)) before.set(h, at(h, period))
    const games = new Map<string, Game[]>()
    for (const m of list) {
      const a = before.get(m.a)!
      const b = before.get(m.b)!
      forecasts.push({ date, p: winChance(a, b), aWon: m.aWon })
      games.set(m.a, [...(games.get(m.a) ?? []), { opponent: b, score: m.aWon ? 1 : 0 }])
      games.set(m.b, [...(games.get(m.b) ?? []), { opponent: a, score: m.aWon ? 0 : 1 }])
    }
    for (const [horse, list2] of games) {
      const r = update(before.get(horse)!, list2)
      state.set(horse, { r, period })
      rows.push({ horseId: horse, date, ...r })
    }
  })

  const current = new Map<string, Rating & { date: string }>()
  for (const [horse, s] of state) current.set(horse, { ...s.r, date: periods[s.period]! })
  return { rows, current, forecasts }
}

export interface Backtest {
  // Mean squared error of the forecasts; 0.25 = always 50%
  brier: number
  baseline: number
  matches: number
  // Share of matches where the favourite (p > 0.5) won
  hitRate: number
  from: string
}

// Brier score of the forecasts from `from` on (earlier matches are warm-up)
export function backtest(forecasts: RatingRun['forecasts'], from: string): Backtest {
  const test = forecasts.filter((f) => f.date >= from)
  const n = test.length || 1
  const brier = test.reduce((sum, f) => sum + (f.p - (f.aWon ? 1 : 0)) ** 2, 0) / n
  const decided = test.filter((f) => f.p !== 0.5)
  const hits = decided.filter((f) => (f.p > 0.5) === f.aWon).length
  return {
    brier: round(brier),
    baseline: 0.25,
    matches: test.length,
    hitRate: round(decided.length ? hits / decided.length : 0),
    from,
  }
}

const round = (n: number) => Math.round(n * 10000) / 10000

// The dossier shows rating chances only once they beat a coin flip clearly
export const ratingIsPredictive = (b: Backtest | null) => !!b && b.matches >= 100 && b.brier < 0.24
