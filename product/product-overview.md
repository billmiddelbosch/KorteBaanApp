# Sprintorakel

## Description
Sprintorakel is een webapp die je vóór en tijdens kortebaandraverijen weddenschapsadvies geeft, op basis van AI-analyse van historische uitslagen, paarden, pikeurs en actuele quota's. Binnen het budget dat je vooraf opgeeft weegt de AI alle inzetopties af, en een eigen kennissysteem leert bij van elk advies en elke uitslag.

## Problems & Solutions

### Problem 1: Versnipperde informatie over kortebaan
De AI-agent zoekt zelf online naar historische uitslagen, paarden, pikeurs en quota's, en slaat bruikbare data op voor gebruik vóór en tijdens de koers.

### Problem 2: Quota's en loting veranderen per omloop
Quota's worden automatisch opgehaald; na elke omloop kan de gebruiker een foto van het actuele quotabord uploaden, die de AI uitleest en meeneemt in het advies. Na elke omloop wordt ook de loting (de koppels) voor de volgende omloop online opgehaald, en de gebruiker kan die altijd via een foto uploaden — ook als de online loting al beschikbaar is.

### Problem 3: Onderbuikgevoel in plaats van onderbouwde keuzes
De gebruiker geeft vooraf een budget op; de AI weegt alle inzetopties af en geeft per omloop een concrete, onderbouwde inzet-suggestie.

### Problem 4: Niet leren van eerdere weddenschappen
Gebruikers koppelen uitslagen en resultaten terug; de AI analyseert advies versus uitkomst en legt lessen vast in een kennissysteem dat volgende adviezen aanvult, zonder de actuele AI-analyse te vervangen.

### Problem 5: Delen met vrienden
Elke gebruiker heeft een eigen account met eigen budget, adviezen en historie, terwijl het kennissysteem gedeeld wordt.

## Key Features
- AI-agent die zelfstandig online historische data en quota's zoekt en analyseert
- Opslag van relevante historische data voor snel gebruik vóór en tijdens de koers
- Automatisch ophalen van quota's, plus foto-upload van het quotabord na elke omloop
- Na elke omloop de loting voor de volgende omloop online ophalen, en altijd via een foto kunnen uploaden
- Budget vooraf opgeven en inzet-suggestie per omloop, met alle inzetopties afgewogen
- Resultaten terugkoppelen en AI-evaluatie van advies versus uitkomst
- Groeiend kennissysteem met lessen als aanvullende bron voor nieuw advies
- Eigen account per gebruiker (eigenaar en vrienden)
- AI-koppeling via Claude setup-token
