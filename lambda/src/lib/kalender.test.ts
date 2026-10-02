import { describe, expect, it } from 'vitest'
import { inWindow, parseKalender } from './kalender'

// Trimmed copy of the Kortebaanbond page layout
const page = `
<div class="bard"><h2>Alle kortebanen in 2026</h2><p>De kalender is altijd onder voorbehoud.</p><table><tbody>
<tr><td rowspan="1" colspan="1"><p>za 9 mei</p></td><td rowspan="1" colspan="1"><p><a href="/events/109/kb-assendelft"><strong>Assendelft</strong></a></p></td><td><p><a href="/events/109/kb-assendelft">Meer info</a></p></td></tr>
<tr><td><p>vr 19 jun</p></td><td><p><a href="/events/86/sassenheim-2026"><strong>Sassenheim</strong></a><strong> </strong>(NK, <a href="/aankondigingen/x">afgelast</a>)</p></td><td><p>Meer info</p></td></tr>
<tr><td><p>ma 21 sep</p></td><td><p><a href="/events/104/medemblik-2026"><strong>Medemblik</strong></a><strong> (NK, <a href="/nieuws/y">zie toelichting</a>)</strong></p></td><td><p>Meer info</p></td></tr>
<tr><td><p>ma 12 okt</p></td><td><p><a href="/events/108/tzand-2026"><strong>&#039;t Zand</strong></a></p></td><td><p>Meer info</p></td></tr>
</tbody></table></div>`

describe('parseKalender', () => {
  it('reads date, place and cancellation per row', () => {
    expect(parseKalender(page)).toEqual([
      { place: 'Assendelft', date: '2026-05-09', cancelled: false, event: '/events/109/kb-assendelft' },
      { place: 'Sassenheim', date: '2026-06-19', cancelled: true, event: '/events/86/sassenheim-2026' },
      { place: 'Medemblik', date: '2026-09-21', cancelled: false, event: '/events/104/medemblik-2026' },
      { place: "'t Zand", date: '2026-10-12', cancelled: false, event: '/events/108/tzand-2026' },
    ])
  })

  it('returns nothing without the year heading', () => {
    expect(parseKalender('<table><tr><td>za 9 mei</td><td>Assendelft</td></tr></table>')).toEqual([])
  })
})

describe('inWindow', () => {
  it('keeps today up to one year ahead', () => {
    expect(inWindow('2026-09-27', '2026-09-27')).toBe(true)
    expect(inWindow('2027-09-27', '2026-09-27')).toBe(true)
    expect(inWindow('2027-09-28', '2026-09-27')).toBe(false)
    expect(inWindow('2026-09-26', '2026-09-27')).toBe(false)
  })
})
