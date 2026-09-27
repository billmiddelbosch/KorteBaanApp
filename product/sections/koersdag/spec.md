# Koersdag Specification

## Overview
Op de dag zelf start de gebruiker met één knop de koersdag, waarna de AI de meest recente ontwikkelingen ophaalt (wie start wel/niet, wijzigingen in de loting, quoteringen) en het vastgelegde advies bekrachtigt of aanpast. Na elke omloop herhaalt dit zich, met een foto van het quotabord of de loting als controle. Het is geen AI-dialoog: per omloop ziet de gebruiker het resultaat van de analyse en een helder advies.

## User Flows
- Starten: de draverij van vandaag kiezen, het budget staat voorgevuld uit het vastgelegde advies en is aan te passen; "Koersdag starten" laat de AI de actuele info ophalen
- Zonder vastgelegd advies: de AI maakt bij de start een eerste advies op basis van budget en actuele info
- Resultaat per omloop: wat de AI vond (afmeldingen, lotingwijzigingen, quoteringen), het oordeel ("Advies blijft staan" of "Advies aangepast", met wat er veranderde en waarom) en het advies voor deze omloop (wat, hoeveel en waarom, of "niet (extra) inzetten")
- Foto ter controle: foto van quotabord of loting maken; de app vergelijkt met de bekende info en bevestigt ("Klopt met het bord") of toont de verschillen (bijv. "Quota Fleur de Lis 3,2 → 4,1"); de foto is leidend en het advies wordt daarop aangepast
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
