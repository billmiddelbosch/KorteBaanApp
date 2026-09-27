# Account Specification

## Overview
Iedereen heeft een eigen account met profiel en een overzicht van de eigen speelsessies. De eigenaar nodigt vrienden uit via een persoonlijke link, beheert hun toegang en AI-gebruik, en beheert de Claude-koppeling via het setup-token. Voor niet-ingelogde gebruikers zijn er losse pagina's om in te loggen en een uitnodiging te accepteren.

## User Flows
- Inloggen: gebruikersnaam + wachtwoord → Koersdag (of de pagina waar je heen wilde); "Wachtwoord vergeten" legt uit dat je de eigenaar om een herstellink vraagt (er wordt geen e-mail gebruikt)
- Uitnodiging accepteren: vriend opent de link → kiest gebruikersnaam en wachtwoord → komt op Koersdag; een verlopen of ingetrokken link toont uitleg en de tip om de eigenaar om een nieuwe link te vragen
- Vriend uitnodigen (eigenaar): naam invullen → persoonlijke link maken → kopiëren of delen (bijv. via WhatsApp)
- Uitnodiging opnieuw sturen of wachtwoord herstellen (eigenaar): nieuwe uitnodigings- of herstellink maken; de oude link vervalt
- Herstellink openen: nieuw wachtwoord kiezen → ingelogd op Koersdag; de eigenaar zelf krijgt een herstellink via het beheerscript
- Toegang beheren (eigenaar): vriend pauzeren (omkeerbaar) of verwijderen (bevestiging die de gevolgen benoemt)
- AI-gebruik begrenzen (eigenaar): per vriend een maximaal aantal analyses per dag instellen
- Activiteit inzien (eigenaar): per vriend laatst actief en aantal analyses
- Profiel bijwerken: naam en wachtwoord wijzigen
- Mijn speelsessies: lijst per koersdag met totaalsaldo; tik op een sessie opent die in Terugblik
- AI-koppeling (eigenaar): setup-token plakken of vervangen (met uitleg over `claude setup-token`; het token wordt daarna nooit meer volledig getoond), verbinding testen met een duidelijke foutmelding, verbruik per dag en per gebruiker inzien, koppeling verwijderen (bevestiging: AI wordt voor iedereen uitgeschakeld)
- Limiet bereikt of koppelingsprobleem (vriend): melding met uitleg en wanneer het weer beschikbaar is; historie en eerdere adviezen blijven bruikbaar

## UI Requirements
- Mijn account: profielkaart en lijst speelsessies (datum, draverij, ingezet, uitbetaald, saldo) met het totaalsaldo bovenaan; winst in emerald en verlies in rood, altijd met een +/−-teken; bedragen in `tabular-nums`
- Mijn account: lege staat voor nieuwe gebruikers met een verwijzing naar Koersdag
- Vrienden beheren: lijst met naam, status (Actief / Gepauzeerd / Uitgenodigd / Link verlopen), laatst actief, analyses vandaag t.o.v. de limiet, en acties per vriend
- Vrienden beheren: knop "Vriend uitnodigen" en een lege staat die uitlegt hoe uitnodigen werkt
- AI-koppeling: statuskaart (Gekoppeld / Probleem, in kleur én tekst), tokeninvoer met gemaskeerde weergave, testknop, verbruikoverzicht en een gevarenzone om de koppeling te verwijderen
- Losse pagina's zonder shell: Inloggen, Uitnodiging accepteren, Wachtwoord vergeten (uitleg) en Nieuw wachtwoord (herstellink)
- Vrienden zien Vrienden beheren en AI-koppeling niet; bij een directe URL worden ze doorgestuurd
- Mobile-first; aanraakvlakken minimaal 44px
- Buiten scope: standaardbudget en inzetvoorkeuren, limieten voor verantwoord spelen

## Configuration
- shell: true
