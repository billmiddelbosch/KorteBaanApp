# Analyse Specification

## Overview
Analyse is een open AI-chat die de gebruiker vóór een koersdag begeleidt naar een inzetadvies voor een zelfgekozen draverij. De AI werkt vanuit een vaste instructie die de eigenaar beheert, zoekt zelf online naar actuele uitslagen en berichtgeving en gebruikt de gedeelde kennisbank. De chat eindigt met een vastgelegde inzetadvies-kaart die op de koersdag het startpunt is in Koersdag en na afloop in Terugblik wordt gebruikt.

## User Flows
- Koers kiezen: uit een lijst met komende draverijen (plaats + datum), of zelf plaats en datum invullen als de koers er niet tussen staat
- Chatten: de AI start met de vaste instructie plus de gekozen koers en stelt vragen (bijv. budget, risicobereidheid, paarden of pikeurs om mee te wegen); de gebruiker kan ook zelf vragen stellen
- Online zoeken: de AI zoekt tijdens de chat actuele uitslagen en berichtgeving; bruikbare feiten en bronnen gaan de gedeelde kennisbank in
- Advies vastleggen: de AI stelt een inzetadvies voor met onderbouwing per omloop/koppel; de gebruiker legt het met één knop vast, waarna het in Koersdag klaarstaat
- Eén chat per koers: verlaten en later verdergaan kan; na het vastleggen kan de gebruiker blijven doorpraten over het advies; zodra de draverij voorbij is verdwijnt de chat en blijft alleen het advies bewaard
- Opnieuw beginnen: een nieuwe chat starten voor dezelfde koers
- AI-instructie beheren (eigenaar): onder Account → AI-instructie het vaste deel bewerken, opslaan en terugzetten naar de vorige of standaardversie

## UI Requirements
- Startscherm: lopende chats voor komende koersen bovenaan (koers, datum, wel/geen vastgelegd advies), daaronder de knop "Nieuwe analyse" met koerskeuze; lege staat die uitlegt wat Analyse doet
- Chatscherm: koers en datum bovenaan, berichten in ballonnen, invoerveld sticky onderaan (mobielvriendelijk), zichtbare status terwijl de AI zoekt of denkt (bijv. "Zoekt recente uitslagen…")
- AI-berichten tonen welke bronnen zijn gebruikt, zodat herkomst en actualiteit controleerbaar zijn
- Adviesvoorstel als aparte kaart in de chat: per omloop/koppel de inzet en onderbouwing, met knop "Advies vastleggen"; na vastleggen een duidelijke bevestiging met link naar Koersdag
- Problemen met de AI-koppeling of een bereikte daglimiet tonen dezelfde melding als in Account; het getypte bericht gaat nooit verloren
- Mobile-first; aanraakvlakken minimaal 44px
- Buiten scope: een bladerbaar archief van paarden, pikeurs en stallen; live bijsturen per omloop met loting en quota (hoort bij Koersdag)

## Configuration
- shell: true
