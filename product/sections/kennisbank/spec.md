# Kennisbank Specification

## Overview
De kennisbank is het gedeelde geheugen van Sprintorakel: tien jaar kortebaanhistorie (paarden, pikeurs, stallen, banen, koppels en ritten), omstandigheden, feiten die de AI online vindt, lessen uit Terugblik en de eigen voorspellingen van de AI met hun uitkomst. Er is één kennisbank, gedeeld door de test- (`dev`) en productieomgeving (`prod`).

De kennisbank maakt de AI van de webapp uniek: waar een algemene AI alleen het web kan doorzoeken, krijgt Sprintorakel bij elke analyse een kant-en-klaar dossier met onderlinge duels, rit-voor-rit historie, vermoeidheid, baanervaring, ratings en getoetste lessen. De AI combineert dat dossier altijd met een eigen realtime analyse op dat moment (web search, ZEturf, loting, quota, uitslagen van vandaag). Het dossier stuurt waar de AI online naar zoekt, en wat de AI online vindt en voorspelt, gaat weer terug de kennisbank in.

## User Flows
- Analysechat vóór een draverij → de worker bouwt het dossier van het deelnemersveld uit de kennisbank (zonder AI), met per onderdeel de datum → de AI krijgt dossier als één van de bronnen + opdracht → doet altijd een eigen, brede realtime zoektocht (deelnemers, vorm, nieuws, afmeldingen, pikeurwissels, weer) en controleert het dossier daartegen → kan tijdens het gesprek extra kennisbank-tools gebruiken → advies met onderbouwing die zegt wat uit de kennisbank, wat van het web van vandaag komt en waar die van elkaar afwijken → nieuwe feiten worden claims
- Koersdag per omloop → loting (online of foto) en uitslagen van vandaag gaan direct als voorlopige koppels/ritten de kennisbank in → dossier van de nieuwe koppels wordt vers berekend, inclusief vermoeidheid van vandaag (ritten gelopen, minuten sinds de vorige rit) en startzijde → AI combineert dat met de quota van dit moment en live web → advies en een voorspelling per koppel (winkans) worden vastgelegd
- Terugblik → uitslagen bevestigd → voorlopige koppels/ritten worden definitief → voorspellingen worden gescoord (AI vs. rating vs. totalisator) → AI legt lessen vast met subjects, scope en bewijs → controle-job herbeoordeelt bestaande lessen tegen de nieuwe uitslagen en de voorspellingsscores
- Na elke draverij → ingest haalt ritverloop- en uitslag-pdf van de Kortebaanbond en ZEturf op → overschrijft voorlopige data met officiële data → weer van die dag → ratings herberekend
- Eigenaar in Claude Code (deze of een andere repo) → `.mcp.json` met de kennisbank-endpoint → eenmalig inloggen via OAuth met het eigen KorteBaan-account → vragen via tools of alleen-lezen SQL, claims en lessen vastleggen, twijfelgevallen afhandelen
- Eigenaar in claude.ai → kennisbank als custom connector → zelfde OAuth-login → zelfde tools
- Eigenaar opent tabblad "Kennisbank" (vervangt "Lessen") → zoekt een paard/pikeur/baan → ziet profiel, claims, lessen en hoe goed de AI dit paard voorspelde → verwijdert of markeert als "betwist"

## Samenspel kennisbank en realtime analyse
- **De kennisbank is één bron, geen instructie**: het dossier staat in de prompt als bron "Kennisbank (stand <datum>)", naast web search, ZEturf, loting en quota. De opdracht aan de AI zegt expliciet: maak je eigen oordeel, gebruik het dossier als historie, zoek altijd zelf realtime en benoem waar je afwijkt van de kennisbank.
- **Realtime zoeken is altijd verplicht en breed**: elke analyse doet een eigen web search, ook als het dossier compleet lijkt. Het dossier noemt per paard aanvullend de open vragen (bijv. "geen start bekend sinds 12 aug") als extra zoekrichting, geen beperking. Zoekbudget voor de Analysechat ruimer dan nu (bijv. 8 zoekopdrachten).
- **Dossier in code, tools voor verdieping**: de worker haalt het dossier in code op (`kb_field` + `kb_matchups`), zodat de kennisbank altijd meedoet zonder extra AI-rondes. Kennisbank-tools zijn er voor verdieping; in Koersdag (tijdkritisch tussen omlopen) maximaal een paar tool-rondes, in de Analysechat ruimer.
- **Wat het dossier bevat** (per paard, compact): rating met onzekerheid en winkans per koppel; laatste 5 starts met ritten; baanervaring; vermoeidheid vandaag en sinds de vorige kortebaan; onderlinge duels met de mogelijke tegenstanders (ook onder vergelijkbare omstandigheden); pikeur-stats; actieve claims en lessen die bij deze deelnemers en deze scope horen, met confidence.
- **Ouderdom altijd zichtbaar**: elk onderdeel heeft een datum; een duel van 2023 heet ook zo. De confidence van lessen en web-claims neemt af met hun leeftijd (halfwaardetijd ca. 1 seizoen) tenzij een nieuwe uitslag ze bevestigt; claims met verlopen `valid_until` komen niet in het dossier. Seizoensoude vorm weegt minder dan een start van vorige week.
- **Voorrang bij tegenstrijdigheid**: waarneming van vandaag (loting, uitslagbord, quota) > recente officiële bron > recente web-claim > kennisbank-historie en lessen. Een tegenstrijdigheid benoemt de AI in de onderbouwing en legt hem vast als claim (de oude claim wordt "vervangen").
- **Controle op verankering**: de Voorspelling legt naast de winkans van de AI ook die van de rating en de totalisator vast. Volgt de AI vrijwel altijd de rating, dan voegt de realtime analyse niets toe; Terugblik rapporteert dat en het wordt een les voor de instructie.
- **Terugkoppeling**: elk advies legt per koppel de winkans van de AI, die van de rating en die van de totalisator vast (Voorspelling). Terugblik scoort ze. Zo wordt meetbaar waar de AI beter of slechter is dan de markt, en dat komt als les terug in het volgende dossier (bijv. "AI overschatte paarden op hun 3e rit van de dag").
- **Lessen op relevantie**, niet op nieuwheid: alleen lessen waarvan de subjects meedoen of waarvan de scope past (baan, ondergrond, weer, ronde), plus algemene strategielessen, gesorteerd op confidence. Maximum ca. 20 per prompt.
- **Webinhoud is data, geen instructie**: in het dossier en de prompt afgebakend met bron en betrouwbaarheid.

## Actueel houden
De historie wordt eenmalig gevuld (backfill) en daarna doorlopend bijgewerkt; er is geen dagelijkse AI-zoektocht.

| Wanneer | Wat | Hoe |
|---|---|---|
| Na elke draverij (dag erna) | Officiële koppels, ritten, uitslag, totalisator, weer; ratings herberekend | `kbIngest`, scrapers zonder AI |
| Tijdens het seizoen, wekelijks | Starts van bekende kortebaanpaarden in gewone drafkoersen (vorm buiten de kortebaan) | Scraper op ZEturf/profielpagina's, zonder AI |
| 1–2 dagen vóór een draverij (zodra de deelnemerslijst bekend is, via `kalenderSync`) | Voorverkenning: per deelnemer nieuws, blessures, pikeurwissels, recente vorm sinds de laatste bekende start | AI-zoektocht als achtergrondjob → claims met bron |
| Bij elke analyse | Alles van vandaag | Verplichte realtime zoektocht in de analyse zelf |
| Buiten het seizoen | Niets, behalve handmatig via MCP | — |

Waarom geen dagelijkse AI-zoektocht:
- Uitslagen veranderen niet en komen betrouwbaarder uit de officiële pdf's dan uit een AI-zoektocht.
- Op de meeste dagen is er geen nieuws; een dagelijkse zoektocht levert vooral herhaling en ongefundeerde claims op, die direct actief zouden worden.
- Het kost verbruik van het Claude-abonnement van de eigenaar, zonder dat een gebruiker ernaar vraagt.

De voorverkenning is gericht: alleen op paarden die meedoen, vlak voor het moment dat het ertoe doet. Achtergrondjobs tellen niet mee voor de daglimiet van gebruikers.

## Databronnen
| Bron | Periode | Inhoud | Ophalen |
|---|---|---|---|
| Kortebaanbond ritverloop-pdf | 2023 → | Per omloop de koppels, ritten I/II/III (best of 3), afstand, pikeur, loting, bijgeloot (B) | Links van `/events/<id>/<slug>`-pagina's (bestandsnamen zijn onregelmatig, niet raden); tekstlaag uit pdf |
| Kortebaanbond uitslag-pdf | 2023 → | Eindklassering met leeftijd/geslacht, pikeur, eigenaar, afstand, prijzengeld, totalisator-uitbetalingen per omloop, totale omzet | Idem |
| Kortebaanbond eventpagina | 2009 → (alleen winnaars) | "Statistieken sinds 2009": jaar, starters, datum, totalisator, winnaar, rijder | HTML |
| Kortebaanbond paard-/pikeurprofielen | 2023 → | Starts per paard: datum, baan, pikeur, klassering, punten, winsom | HTML (`/horses/<id>`, `/riders/<id>`) — voor aliassen/identiteit |
| ZEturf omloop-pagina's | 2022 → | Deelnemers met startnr, geslacht/leeftijd, pikeur, trainer, afstand, record, winsom, "prestaties" (recente vorm, ook uit andere koersen), starttijden per omloop, eindvolgorde | HTML (bestaande `zeturf.ts` uitbreiden) |
| Verenigingssites (Heemskerk, Wognum, …) | 2008/2014 → | Eindklassering top 3–4 met pikeur | HTML, per site een kleine parser |
| Open-Meteo archief / KNMI | alle jaren | Temperatuur, neerslag, wind per dag/uur op de locatie | Gratis API |
| Kortebaanreglement, uitleg totalisator | actueel | Spelregels (afstandshandicap, bijloting, inzetvormen) | Als MCP-resource en vaste context |
| Lotingfoto / uitslagbord (Koersdag) | vanaf nu | Koppels, startpositie links/rechts, uitslagen van vandaag | AI-vision, bestaand; als voorlopige data |
| AI web search | live | Nieuws, blessures, afmeldingen, pikeurwissels | Claims met bron en betrouwbaarheid |

Detailniveau: 2023 → volledig (koppels en ritten); 2022 deelnemers en eindvolgorde; 2016–2021 alleen eindklasseringen/winnaars (akkoord eigenaar). Startpositie is historisch onbekend en wordt vanaf nu vastgelegd.

Stand na fase 1: een draverij heeft `detail` `volledig` (rittenverloop-pdf), `uitslag` (uitslag-pdf of de uitslagtabel van de eventpagina) of `winnaar` (statistieken). Een lager niveau overschrijft nooit een hoger. De backfill-dry-run (28-09-2026) vond 105 eventpagina's van 25 kortebanen en 227 draverijen sinds 2016: 98 volledig (2023 →) en 129 alleen winnaar. ZEturf (2022) en de verenigingssites zijn uitgesteld, omdat de statistieken de winnaars sinds 2009 al dekken. Kortebanen die niet meer op de kalender van dit jaar staan, worden niet gevonden.

## Architectuur
- **Opslag**: één Aurora DSQL-cluster (Postgres 16-compatibel, serverless, free tier) in `eu-west-2`, als één `aws_dsql.CfnCluster` in `infra/lib/api-stack.ts` met deletion protection en `RemovalPolicy.RETAIN`; deploy gaat mee met `npm run deploy`. DynamoDB blijft per omgeving voor app-state (accounts, chats, koersdag, advies).
- **Eén kennisbank voor `dev` en `prod`**:
  - Harde data (draverijen, deelnames, koppels, ritten, weer, ratings) is één waarheid; alleen de `kbIngest`-job schrijft die, niet per omgeving.
  - Wat de AI of een gebruiker schrijft (claims, lessen, voorspellingen, voorlopige koppels uit Koersdag) krijgt `origin` = `dev` of `prod`. De prod-AI leest standaard alleen `prod`-kennis; de dev-AI leest alles. Testruns vervuilen zo het geheugen van de echte AI niet, en de eigenaar kan een dev-les promoveren.
  - Schemawijzigingen raken meteen productie: migraties alleen additief (kolom/tabel toevoegen; nooit hernoemen of verwijderen in dezelfde release), met een migratie-script dat de eigenaar vóór de deploy draait.
  - MCP en OAuth alleen op `prod` (inloggen met je productie-account); `dev` heeft geen MCP-endpoint.
- **Toegang vanuit Lambda**: `pg` + IAM-token via `@aws-sdk/dsql-signer`, geen VPC. `dsql-signer` zit niet in de Lambda-runtime, dus in deze bundles meebundelen (uitzondering op `--external:@aws-sdk/*`). Connectie buiten de handler hergebruiken (verbinden kost ~0,5 s, queries 30–90 ms).
- **Rollen**: `admin` alleen voor migraties; `kb_writer` voor ingest en workers; `kb_reader` (alleen `SELECT`) voor `kb_sql` en leestools, gekoppeld aan de Lambda-rol via `AWS IAM GRANT`.
- **Gedeelde module** `lambda/src/lib/kb/`: schema/migraties, queries, dossierbouwer, tooldefinities en -implementaties. Workers en MCP-server gebruiken dezelfde code.
- **Workers**: `askClaude` krijgt ondersteuning voor custom tools (tool_use → tool_result-loop naast de bestaande `pause_turn`-loop). Analysechat en Koersdag krijgen het dossier in de prompt; het `<feiten>`-blok vervalt.
- **MCP-server**: Lambda `kbMcp` (streamable HTTP) achter API Gateway `/mcp`, alleen prod.
- **OAuth 2.1** (authorization code + PKCE + dynamic client registration) in Lambda `oauth`, login via de bestaande KorteBaan-accounts (Vue-route `/oauth/authorize`), tokens gehasht in DynamoDB. Scopes: `kb:read` (alle gebruikers), `kb:write` en `kb:sql` (eigenaar).
- **Ingest**: Lambda `kbIngest` (na elke draverij, via EventBridge-schedule) en een lokaal backfill-script (`lambda/scripts/kb-backfill.ts`) met dezelfde parsers; idempotente upserts op natuurlijke sleutels, batches < 3.000 rijen per transactie, retry bij optimistic-concurrency-conflicten.
- **Ratings**: Glicko-2 per paard (en per ondergrond), herberekend na ingest; eerst backtest (Brier-score, rendement tegen historische totalisator-uitbetalingen) voordat de AI er gewicht aan geeft.

## Agent-tools (workers en MCP)
| Tool | Scope | Doel |
|---|---|---|
| `kb_field(draverijId, omloop?)` | read | Het dossier: deelnemers met rating, vorm, baanervaring, vermoeidheid, claims en relevante lessen |
| `kb_matchups(draverijId, omloop)` | read | Per koppel: onderling duel, winkans rating, startzijde, vermoeidheid beide paarden |
| `kb_entity(type, naam)` | read | Profiel, aliassen, recente claims en lessen, voorspellingsscore |
| `kb_form(paard, n, filters?)` | read | Laatste n starts met baan, pikeur, afstand, omloop bereikt, ritten |
| `kb_head_to_head(a, b, filters?)` | read | Onderlinge koppels en ritten, filterbaar op baan/ondergrond/weer/ronde |
| `kb_pikeur_stats(pikeur, filters?)` | read | Winpercentage per baan/ronde/combinatie met paard |
| `kb_conditions(draverijId)` | read | Weer, ondergrond, baanlengte, startzijde-statistiek |
| `kb_search(tekst)` | read | Zoeken in claims en lessen (`ILIKE`) |
| `kb_record_claim(...)` | write | Feit met subjects, predicate, bron, betrouwbaarheid |
| `kb_record_lesson(...)` | write | Les met subjects, scope en bewijs |
| `kb_resolve(naam)` | write | Twijfelgeval in entity resolution toewijzen of samenvoegen |
| `kb_sql(query)` | sql | Alleen-lezen SQL als `kb_reader` in een `READ ONLY`-transactie, met rijlimiet en client-side timeout |

Resources: `kb://schema` (tabellen en betekenis), `kb://reglement`, `kb://entity/<type>/<slug>` (Markdown-profiel).

## Requirements
- Het dossier wordt in code gebouwd en staat altijd in de prompt van Analysechat en Koersdag, als bron met datum, niet als instructie
- Elke analyse doet een eigen realtime zoektocht, ook als het dossier compleet lijkt; de onderbouwing maakt zichtbaar wat uit de kennisbank en wat van vandaag komt, en waar ze verschillen
- Kennisbank niet bereikbaar → de analyse gaat door op alleen web-data en meldt dat in de onderbouwing
- Claims van de AI zijn direct actief; bescherming via betrouwbaarheid per bron, `valid_until`, status (`actief`/`vervangen`/`betwist`), `origin` en de lescontrole na elke Terugblik
- `kb_record_claim` valideert subjects tegen bekende entiteiten; onbekende namen worden twijfelgevallen
- Afgeleide factoren (baanervaring, vermoeidheid, startzijde-voordeel per baan) worden berekend, niet opgeslagen
- Een les is een interpretatie met verwijzing naar bewijs (koppel-/rit-id's of voorspellingsscores); afleidbare statistiek wordt geen les
- Bestaande `KB/FACT#`-records worden niet gemigreerd en sterven uit. `KB/LESSON#` (prod) wordt eenmalig gemigreerd zonder subjects/scope
- Kosten: binnen de free tier van DSQL, Lambda en API Gateway; geen betaalde externe diensten
- Vrienden hebben alleen `kb:read`; schrijven en SQL alleen voor de eigenaar
- Elke nieuwe API-route krijgt een MSW-handler; de E2E-suite raakt DSQL nooit

## UI Requirements
- Tabblad "Kennisbank" alleen voor de eigenaar; vervangt het tabblad "Lessen" in Terugblik
- Zoekveld bovenaan (paard, pikeur, stal, baan) → profielkaart met recente starts, rating met onzekerheid, voorspellingsscore, claims en lessen
- Claims en lessen tonen bron, datum, confidence, status en herkomst (test/productie); acties "Betwist", "Verwijderen" (na bevestiging) en voor dev-lessen "Naar productie"
- Lijst "Twijfelgevallen" voor namen die de entity resolution niet zeker kon koppelen
- Lege staat: "Nog geen kennis over <naam>"
- Telefoon: profiel als gestapelde kaarten, geen brede tabellen
- `/oauth/authorize`: sobere pagina met de app die toegang vraagt, de gevraagde scopes in gewone taal en "Toestaan" / "Weigeren"

## Fasering
0. **Spike** — ✅ afgerond.
   - De bronnen zijn onderzocht (zie Databronnen).
   - Het DSQL-prototype in `eu-west-2` werkt: verbinding met IAM-token (~0,5 s), JSONB-operators, `ILIKE`, CTE's met window functions, views, foreign keys (worden gehandhaafd), een `ASYNC`-index, 2.500 rijen in één insert en een read-only rol via `AWS IAM GRANT` (schrijven en DDL worden geweigerd).
   - Niet ondersteund: `SET statement_timeout` en `SET TRANSACTION`. `BEGIN READ ONLY` werkt wel.
1. **Schema + ingest + backfill** — ✅ gebouwd, nog niet gedeployd.
   - DSQL-cluster (`KennisbankCluster`, deletion protection, RETAIN) in CDK.
   - Schema `kb` met rollen `kb_writer`/`kb_reader` in `lambda/src/lib/kb/migrations.ts`, uitgevoerd met `npm run kb-migrate`.
   - Parsers voor eventpagina, rittenverloop-pdf, uitslag-pdf en Open-Meteo.
   - Entity resolution: Kortebaanbond-id → genormaliseerde naam → alias. Verminkte pdf-namen worden gekoppeld aan de schone spelling.
   - `kbIngest` draait dagelijks om 05:00 UTC over de draverijen van de laatste 21 dagen (of handmatig met `{"event": "/events/…"}`). Het is één functie voor dev en prod.
   - `npm run kb-backfill` doet de eenmalige backfill. Met `--dry-run` wordt alleen opgehaald en geparsed.
   - Uitgesteld: ZEturf- en verenigingssite-parsers.
2. **Dossier + tools in de workers + ratings** — ✅ kern gebouwd, nog niet gedeployd.
   - Custom tools in `askClaude` (`runTool`, `maxToolRounds`, `searchBudget`). Het dossier staat in Analysechat en Koersdag, vóór het advies. Het `<feiten>`-blok is weg: feiten gaan via `kb_record_claim`.
   - Koersdag legt de winkansen per koppel vast (`kb.prediction`, AI, rating en tote).
   - Terugblik scoort die kansen tegen de uitslag. De scorecard (Brier-scores en missers) en de te toetsen lessen gaan mee in de evaluatie. Lessen zijn gestructureerd (`tekst`, `paarden`, `pikeurs`, `baan`) en worden bevestigd of weerlegd via `lescontrole`.
   - Lessen staan in de kennisbank (`kb.lesson`) in plaats van DynamoDB; `kb-migrate --lessons-table` zet de oude over.
   - Glicko-2 met backtest in `kb.meta` (`rating_backtest`). Ratings komen pas in het dossier bij ≥ 100 koppels en een Brier-score < 0,24.
   - `kbIngest` scoort voorspellingen van gewijzigde draverijen en herberekent de ratings. `{"ratings": true}` herberekent alleen.
   - KB_HOST en `dsql:DbConnect` gelden voor alle kennisbank-schrijvers (output `KbWriterRoleArns`).
   - Uitgesteld:
     - loting en uitslagbord als live voorlopige data, met de startzijde uit de lotingfoto
     - voorverkenning vóór een draverij
     - de wekelijkse vorm-scraper in het seizoen
     - ratings per ondergrond
     - vermoeidheid (minuten sinds de vorige rit)
3. **MCP + OAuth (prod)** — `kbMcp`, `oauth`, `/oauth/authorize`, `.mcp.json` in deze repo, claude.ai-connector
4. **Curatie-UI** — tabblad "Kennisbank" voor de eigenaar

## Configuration
- shell: true
