# Terugblik Specification

## Overview
Na een koersdag zie je hoe het ging: de AI haalt de uitslagen op, jij bevestigt ze, en daarna vergelijkt de AI per omloop het advies met de uitkomst en legt de lessen onzichtbaar vast in de gedeelde kennisbank. De eigenaar ziet winst en verlies per vriend per koersdag en kan onjuiste lessen verwijderen.

## User Flows
- Speler opent Terugblik → lijst van eigen afgeronde koersdagen (nieuwste eerst) met datum, draverij, inzet, uitbetaling, saldo en status (uitslagen nodig / geëvalueerd); bovenaan het totaalsaldo
- Speler opent een koersdag zonder uitslagen → AI haalt ze online op (laadstatus) → per omloop verschijnen winnaar en plaatsen, aanpasbaar → bij mislukken zelf invullen of foto van het uitslagbord uploaden → "Uitslagen bevestigen"
- Na bevestigen start de AI-evaluatie vanzelf → speler ziet een eindoordeel over de dag en per omloop: advies klopte (✓/✗ met tekst), wat won, één zin waarom; lessen gaan automatisch de kennisbank in zonder dat de speler ze ziet
- Speler rondt open inzetten af (uitbetaling invullen) of corrigeert een bedrag → saldo werkt direct mee
- Eigenaar opent tabblad "Overzicht" → totalen per vriend (inzet, uitbetaling, saldo) en daaronder een lijst van koersdagen met per gebruiker inzet, uitbetaling en saldo; filter per vriend
- Eigenaar opent tabblad "Lessen" → vastgelegde lessen (tekst, datum, bron-koersdag) → verwijdert een onjuiste les na bevestiging, zodat de AI hem niet meer gebruikt
- Eigenaar op de testomgeving zet een goede les na bevestiging "Naar productie" → de les krijgt origin `prod`, productie gebruikt hem vanaf dan en hij verdwijnt uit de testlijst (test leest hem nog wel mee). Productie toont deze knop niet

## UI Requirements
- Winst en verlies onderscheiden via teken (+/−), kleur én tekst; verlies zonder drama
- Lege staat: "Nog geen afgeronde koersdagen" met link naar Koersdag
- Mislukt ophalen: rustige melding met "Opnieuw proberen", "Zelf invullen" of "Foto uploaden"
- Ophalen en evalueren tellen mee voor de daglimiet; is die op, dan uitslagen handmatig invullen en evaluatie later
- Vrienden zien alleen hun eigen koersdagen; tabbladen "Overzicht" en "Lessen" alleen voor de eigenaar
- Telefoon: lijst en detail onder elkaar; eigenaarstotalen als kaarten, geen brede tabel

## Configuration
- shell: true
