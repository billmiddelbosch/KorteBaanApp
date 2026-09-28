// Baanzijde per koppel, afgeleid uit het NDR Kortebaan Wedstrijdreglement (art. 22, per 18-02-2025):
//   I.a  bij gelijke afstand start het laagste startnummer in rit 1 (gezien vanaf de start) rechts;
//   I.b  in rit 2 start het laagste startnummer links;
//   I.c  in de kamprit geldt de situatie van rit 1.
// Medemblik hanteerde dezelfde indeling al eerder (bijlage bij OB-1, aug. 2020). Voor ongelijke
// afstand geeft het reglement geen regel: de zijde blijft dan onbekend.
// kb.koppel.zijde_a/zijde_b is de zijde in rit 1 en de kamprit; in rit 2 is het omgekeerd
// (view kb.rit_zijde geeft de zijde per rit).

export type Zijde = 'links' | 'rechts'

// Vanaf deze datum geldt de regel op alle banen; de banen in ZIJDE_ALTIJD volgen hem al langer
export const ZIJDE_REGEL_VANAF = '2025-01-01'
export const ZIJDE_ALTIJD = ['medemblik']

export interface Starter {
  startnr: number | null
  afstand: number | null
}

export function zijdeOf(
  date: string,
  baanId: string,
  a: Starter | undefined,
  b: Starter | undefined,
): { a: Zijde | null; b: Zijde | null } {
  const none = { a: null, b: null }
  if (date < ZIJDE_REGEL_VANAF && !ZIJDE_ALTIJD.includes(baanId)) return none
  if (!a || !b || a.afstand === null || a.afstand !== b.afstand) return none
  // Zonder startnummers geldt de volgorde op het rittenverloop (laagste nummer staat bovenaan)
  const bLager = a.startnr !== null && b.startnr !== null && b.startnr < a.startnr
  return bLager ? { a: 'links', b: 'rechts' } : { a: 'rechts', b: 'links' }
}
