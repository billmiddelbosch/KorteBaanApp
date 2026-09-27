# Application Shell Specification

## Overview
De shell van Sprintorakel is gebouwd voor gebruik buiten op de baan: één hand, telefoon, wisselend licht. Navigatie zit binnen duimbereik, de live speelsessie is altijd één tik weg, en op grotere schermen schuift dezelfde structuur door naar een zijbalk. Drie hoofdsecties staan plat naast elkaar (breadth over depth); accountzaken zitten in het gebruikersmenu.

## Navigation Structure
- Koersdag → `/` (startscherm; budget, live quota en inzet-suggesties per omloop)
- Analyse → `/analyse` (AI-chat vóór de koersdag die leidt tot een inzetadvies)
- Terugblik → `/terugblik` (resultaten terugkoppelen, lessen)
- Account-pagina's via het gebruikersmenu, niet in de hoofdnavigatie:
  - Mijn account → `/account`
  - Vrienden beheren → `/account/vrienden` (alleen eigenaar)
  - AI-koppeling → `/account/ai-koppeling` (alleen eigenaar)

Actieve sectie: achtergrond + zwaarder gewicht + `aria-current="page"`. Koersdag matcht alleen exact `/`; andere secties matchen ook hun sub-routes (bijv. `/analyse/42`).

## User Menu
- Telefoon: avatar rechts in de header, menu klapt naar beneden.
- Tablet/desktop: onderaan de zijbalk (desktop met naam), menu klapt naar boven.
- Inhoud: naam, Mijn account, Vrienden beheren en AI-koppeling met statusindicator (Gekoppeld / Probleem, kleur + tekst) — beide alleen voor de eigenaar —, themakeuze (Licht / Donker / Auto) en Uitloggen.
- Sluit bij klik buiten het menu, Escape en routewissel.

## Layout Pattern
Hybride: bottom tab bar op telefoon, zijbalk vanaf tablet. Tijdens een actieve speelsessie verschijnt een amberkleurige **live-balk** (LIVE · draverij · omloop · resterend budget) die direct naar het advies linkt — op telefoon boven de tab bar, vanaf tablet sticky bovenaan de content.

## Responsive Behavior
- **Desktop (≥1024px):** zijbalk 256px met logo, labels bij iconen en gebruikersmenu met naam onderaan. Live-balk sticky boven de content.
- **Tablet (768–1023px):** zijbalk 72px met alleen iconen (labels blijven voor schermlezers beschikbaar), avatar onderaan. Live-balk sticky boven de content.
- **Mobile (<768px):** sticky header van 56px (logo + avatar, backdrop blur), bottom tab bar van 64px met icoon + label, live-balk (44px) direct erboven. Safe-area insets worden gerespecteerd; content krijgt onderaan padding zodat niets achter de balken valt.

## Design Notes
- Kleuren: blue (primair/actief), amber (live-balk), slate (neutraal). Emerald/red alleen semantisch (gekoppeld/probleem, winst/verlies).
- Fonts Inter + JetBrains Mono zijn self-hosted via `@fontsource-variable/*`, zodat de CSP (`font-src 'self'`) ongewijzigd blijft en er geen verzoeken naar Google gaan.
- Dark mode is class-based (`.dark` op `<html>`) via `useTheme`, met keuze bewaard in localStorage; Auto volgt `prefers-color-scheme`. Diepte in dark mode via lichtere oppervlakken, niet via schaduwen.
- Touch targets ≥ 44px; tab bar-items 64px hoog, zijbalk-items 48px.
- Bedragen gebruiken `Intl` nl-NL EUR en `tabular-nums`.
- Iconen: `@lucide/vue` (Flag, MessageSquareText, ChartLine), 24px, uniforme stroke.
- Gebruiker en live-sessie zijn nu voorbeelddata in `App.vue`; die worden vervangen zodra de secties Account en Koersdag gebouwd zijn.
