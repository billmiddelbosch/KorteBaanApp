// Recomputes all Glicko-2 ratings from the official koppels and stores the backtest. A full
// replay takes well under a second for ten seasons, so there is no incremental update.
import type pg from 'pg'
import { insertMany, tx } from './db'
import { backtest, computeRatings, type Backtest, type Match } from './glicko'
import { day } from './queries'

export const BACKTEST_FROM = '2024-01-01'
const CHUNK = 500

export async function loadMatches(client: pg.Client): Promise<Match[]> {
  const res = await client.query<{ date: Date | string; horse_a: string; horse_b: string; winner: string }>(
    `select d.date, k.horse_a, k.horse_b, k.winner
     from kb.koppel k join kb.draverij d on d.id = k.draverij_id
     where k.status = 'definitief' and k.origin = 'shared' and k.horse_b is not null and k.winner is not null
       and k.winner in (k.horse_a, k.horse_b)
     order by d.date, k.omloop, k.nr`,
  )
  return res.rows.map((r) => ({ date: day(r.date), a: r.horse_a, b: r.horse_b, aWon: r.winner === r.horse_a }))
}

export async function recomputeRatings(client: pg.Client): Promise<{ rows: number; backtest: Backtest }> {
  const run = computeRatings(await loadMatches(client))
  const rows = run.rows.map((r) => [r.horseId, 'alle', r.date, r.rating, r.rd, r.volatility])
  for (let i = 0; i < rows.length; i += CHUNK) {
    await tx(client, (c) =>
      insertMany(
        c,
        'kb.rating',
        ['horse_id', 'surface', 'date', 'rating', 'rd', 'volatility'],
        rows.slice(i, i + CHUNK),
        'on conflict (horse_id, surface, date) do update set rating = excluded.rating, rd = excluded.rd, volatility = excluded.volatility',
      ),
    )
  }
  const result = backtest(run.forecasts, BACKTEST_FROM)
  await tx(client, (c) =>
    c.query(
      `insert into kb.meta (key, value, updated_at) values ('rating_backtest', $1, now())
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [JSON.stringify(result)],
    ),
  )
  return { rows: rows.length, backtest: result }
}
