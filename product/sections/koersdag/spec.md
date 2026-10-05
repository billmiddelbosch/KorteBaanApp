# Koersdag Specification

## Overview
Op de dag zelf start de gebruiker met één knop de koersdag, waarna de AI de meest recente ontwikkelingen ophaalt (wie start wel/niet, wijzigingen in de loting, quoteringen) en het vastgelegde advies bekrachtigt of aanpast. Na elke omloop herhaalt dit zich, met een foto van het quotabord of de loting als controle. Het is geen AI-dialoog: per omloop ziet de gebruiker het resultaat van de analyse en een helder advies.

## User Flows
- Starten: de draverij van vandaag kiezen, het budget staat voorgevuld uit het vastgelegde advies en is aan te passen; "Koersdag starten" laat de AI de actuele info ophalen
- Zonder vastgelegd advies: de AI maakt bij de start een eerste advies op basis van budget en actuele info
- Resultaat per omloop: wat de AI vond (afmeldingen, lotingwijzigingen, quoteringen), het oordeel ("Advies blijft staan" of "Advies aangepast", met wat er veranderde en waarom) en het advies voor deze omloop (wat, hoeveel en waarom, of "niet (extra) inzetten")
- Advies als geheel: bij meer dan één keuze toont de kaart "Totaal advies" (totale inzet en verwachte winst over de keuzes met quota; keuzes zonder quota worden apart genoemd). De AI beoordeelt de keuzes ook samen (elkaar uitsluitende keuzes alleen als het geheel winst kan opleveren), vat het geheel samen in de toelichting, krijgt het resultaat van de afgerekende inzetten mee en jaagt verlies niet na
- Drempel per keuze: elke keuze met een kans toont "alleen inzetten bij quota ≥ X", met de marge erin (1,1 / kans), ook als de bordquota bekend is. Is de quota onbekend of krap, dan zegt de onderbouwing wat de gebruiker anders doet ("anders …")
- Niet doen: duidelijk overgespeelde paarden (bordkans duidelijk boven de AI-kans, met een concrete reden) staan in de bevindingen als "Niet doen: <paard> op <quota>, <reden>"
- Trefzekerheid: de kennisbank geeft de AI zijn eigen Brier-score tegenover die van de tote mee (eerdere draverijen, eigen omgeving). Onder 50 getoetste koppels, of zolang de tote beter voorspelt, blijft de AI dicht bij het bord en wijkt alleen af met een concrete, actuele reden
- Foto ter controle: foto van quotabord of loting maken; de app vergelijkt met de bekende info en bevestigt ("Klopt met het bord") of toont de verschillen (bijv. "Quota Fleur de Lis 3,2 → 4,1"); de foto is leidend en het advies wordt daarop aangepast. Past het bord niet op één foto, dan voegt de gebruiker er meer toe (maximaal 3, elk met een verwijderknop) en controleert ze samen met "Controleer bord"; de AI leest ze als één bord en telt dubbele regels één keer
- Inzet bijhouden: per suggestie "Ingezet" aantikken met aanpasbaar bedrag; na de omloop de winst invullen; het resterende budget wordt live bijgewerkt
- Volgende omloop: na elke omloop dezelfde cyclus: loting en quoteringen ophalen, optioneel foto, advies of er (extra) ingezet moet worden
- Ophalen mislukt (geen bereik, AI-limiet, niets online te vinden): melding wat er misging met "Opnieuw proberen"; foto maken blijft altijd mogelijk en het laatst bekende advies blijft zichtbaar
- Einde: na de finale automatisch een samenvatting (ingezet, gewonnen, saldo) met een link naar Terugblik; de Live-balk verdwijnt

## UI Requirements
- De huidige omloop staat bovenaan met het advies als belangrijkste element; eerdere omlopen ingeklapt eronder
- Budget toont wat er nog over is en loopt gelijk met de Live-balk in de shell
- Zichtbare status tijdens het ophalen ("Zoekt afmeldingen…", "Haalt quoteringen op…"), zoals in Analyse
- Grote, met één duim bereikbare fotoknop die direct de camera opent
- Wijzigingen ten opzichte van het vorige advies visueel gemarkeerd, niet alleen met kleur
- Touch targets minimaal 44px, hoog contrast voor gebruik in de zon, alle tekst in het Nederlands
- Lege staat zonder koersdag vandaag: de eerstvolgende koers met vastgelegd advies, of een verwijzing naar Analyse
- Buiten scope: een AI-chat op koersdag (dat is Analyse); evaluatie van advies versus uitkomst (dat is Terugblik)

## Configuration
- shell: true
