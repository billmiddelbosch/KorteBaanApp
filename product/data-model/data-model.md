# Data Model

## Entities

### Gebruiker
De eigenaar of een vriend met een eigen account, eigen speelsessies en eigen historie.

### Draverij
Een kortebaandraverij op een plaats en datum. Bij elke draverij vindt een verse AI-analyse plaats op basis van de meest recente online data.

### Omloop
Een ronde binnen een draverij (bijv. 1e omloop, herkansing, finale). Voor elke omloop vindt opnieuw een AI-analyse plaats met de actuele stand, uitslagen en quota's.

### Koppel
Twee deelnames die in een omloop tegen elkaar lopen, beslist in maximaal drie ritten (best of 3), met de winnaar als uitslag. De koppels van een omloop volgen uit de loting. Per deelname in het koppel wordt de startzijde (links/rechts) vastgelegd zodra die bekend is (vanaf 2026 via de lotingfoto; historisch onbekend).

### Rit
Eén heat binnen een koppel (I, II of III) met de winnende deelname. Het aantal gereden ritten per deelname op een dag is de basis voor vermoeidheid.

### Baan
De vaste locatie van een draverij (bijv. Roden, Wognum), met ondergrond, baanlengte en coördinaten voor het weer.

### Omstandigheden
Het weer (temperatuur, neerslag, wind) en de baanstaat op de dag van een draverij, uit Open-Meteo/KNMI of de verslaggeving.

### Paard
Een draver waarvan prestaties over draverijen heen worden gevolgd.

### Pikeur
De menner van een paard.

### Stal
De eigenaar- of trainingsstal van een paard. Wordt per deelname vastgelegd zoals de bron die op dat moment vermeldt; verbanden tussen stal, paard en pikeur leidt de AI zelf af.

### Deelname
De start van een paard in een draverij, met de pikeur, stal, afstand (handicap 270–305 m), leeftijd en geslacht van dat moment, startnummer, of het paard is bijgeloot, de bereikte omloop en de eindklassering.

Afgeleide factoren (niet opgeslagen, berekend bij opvragen): ervaring op de baan (eerdere starts en resultaten daar), vermoeidheid op de dag (omlopen en ritten al gelopen, minuten sinds de vorige rit) en over dagen (dagen sinds de vorige kortebaan en het resultaat daar).

### Loting
De indeling van de koppels voor een omloop, bekendgemaakt na afloop van de vorige omloop. Wordt na elke omloop automatisch online opgehaald, en kan altijd door de gebruiker via een foto worden geüpload die de AI uitleest — ook als er al een online loting is, bijvoorbeeld omdat die ontbreekt, te laat komt of afwijkt.

### Quota
Een momentopname van de quota's in een omloop, automatisch opgehaald of uitgelezen van een door de gebruiker geüploade foto.

### Analysechat
Het gesprek van een gebruiker met de AI vóór een draverij, gericht op een inzetadvies. Eén per gebruiker per draverij; blijft beschikbaar tot de draverij voorbij is en verdwijnt daarna, het vastgelegde advies blijft.

### AI-instructie
Het vaste deel van de opdracht aan de AI (rol, werkwijze), beheerd door de eigenaar, met eerdere versies om naar terug te zetten.

### Analyse
Een AI-analyse van een draverij of omloop, uitgevoerd op het moment zelf met de meest recente online data. Opgeslagen data en lessen zijn aanvullende input, maar vervangen de actuele analyse nooit.

### Speelsessie
De koersdag van een gebruiker bij een draverij, met het vooraf opgegeven budget.

### Advies
De inzet-suggestie van de AI voor een omloop binnen een speelsessie, gebaseerd op een analyse en het resterende budget, met onderbouwing.

### Weddenschap
De werkelijke inzet van een gebruiker en het resultaat daarvan.

### Claim
Een los feit dat de AI online vindt of de eigenaar vastlegt (bijv. "paard X heeft een nieuwe pikeur"), met onderwerpen (paarden, pikeurs, stallen, banen), een soort (predicate), tekst, datum waarop het gold, optionele geldigheid tot, confidence, status (actief / vervangen / betwist), bron en maker (AI-run of eigenaar). Direct actief. Vervangt de oude "feiten" (`KB/FACT#`), die niet worden gemigreerd en uitsterven.

### Les
Een interpretatie in het gedeelde kennissysteem, vastgelegd na evaluatie van advies versus uitkomst of door de eigenaar. Heeft één of meer onderwerpen (ook entiteit tegen entiteit, bijv. twee paarden of paard + pikeur), een scope (baan, ondergrond, weer, ronde, afstand) waarbinnen hij geldt, bewijs (verwijzingen naar koppels/ritten), confidence, status en de datum van de laatste controle. Na elke Terugblik worden bestaande lessen tegen de nieuwe uitslagen herbeoordeeld. Wat puur uit data af te leiden is (bijv. een onderling resultaat) wordt geen les maar een query.

### Rating
De sterkte van een paard (Glicko-2: waarde en onzekerheid), algemeen en per ondergrond, per datum herberekend na elke draverij. Input voor de AI, nooit een opdracht.

### Voorspelling
Per koppel bij een advies: de winkans volgens de AI, volgens de rating en volgens de totalisator op dat moment, met de latere uitkomst en score. Maakt meetbaar waar de AI beter of slechter is dan de markt; de uitkomsten voeden de lessen.

### Dossier
Geen opgeslagen entiteit, maar de compacte samenvatting uit de kennisbank die de worker bij elke analyse in de prompt zet: per deelnemer rating, vorm, baanervaring, vermoeidheid, onderlinge duels, claims en relevante lessen.

### Bron
Een online bron (of geüploade foto) waar data vandaan komt, met een betrouwbaarheid per soort (officiële uitslag-pdf > ZEturf > verenigingssite > nieuws/forum), zodat herkomst en actualiteit controleerbaar zijn.

### Alias
Een alternatieve schrijfwijze van een paard-, pikeur- of stalnaam in een bron, gekoppeld aan de juiste entiteit. Twijfelgevallen blijven open tot de eigenaar ze toewijst.

## Relationships

- Draverij has many Omloop
- Omloop has one Loting (the latest, from online or photo)
- Loting determines the Koppel of its Omloop
- Omloop has many Koppel
- Draverij has many Deelname
- Deelname belongs to Paard, Pikeur and Stal
- Koppel links two Deelname, each with a startzijde
- Koppel has one to three Rit; Rit has one winning Deelname
- Baan has many Draverij; Draverij has one Omstandigheden
- Omloop has many Quota
- Draverij and Omloop each have many Analyse (a fresh one per draverij and per omloop)
- Analyse uses Deelname, Loting, Quota, Les and Bron as input
- Gebruiker has many Analysechat (one per Draverij)
- Analysechat belongs to Draverij and uses the current AI-instructie, Les and Bron
- Analysechat produces an Advies that becomes the starting point of the Speelsessie for that Draverij
- Gebruiker has many Speelsessie
- Speelsessie belongs to Draverij
- Speelsessie has many Advies (one or more per Omloop) and many Weddenschap
- Advies belongs to Analyse
- Weddenschap optionally belongs to Advies
- Les references zero or more subjects (Paard, Pikeur, Stal, Baan; none for general lessons) and optionally a Draverij or Advies; its evidence references Koppel and Rit
- Claim references one or more subjects (Paard, Pikeur, Stal, Baan) and one Bron; a newer Claim can replace an older one
- Paard has many Rating (per date, general and per ondergrond)
- Advies has many Voorspelling (one per Koppel); Voorspelling belongs to Koppel
- Paard, Pikeur and Stal have many Alias
- Draverij, Deelname, Loting, Quota, Omstandigheden, Analyse, Claim and Les reference one or more Bron (an uploaded photo counts as a source for Loting and Quota)

## Opslag

App-state (Gebruiker, Analysechat, Speelsessie, Advies, Weddenschap, AI-instructie) blijft in DynamoDB. De kennisbank (Baan, Draverij-historie, Deelname, Koppel, Rit, Omstandigheden, Claim, Les, Rating, Voorspelling, Bron, Alias) gaat naar één Aurora DSQL-cluster, gedeeld door test en productie. Harde data is gedeeld; Claim, Les, Voorspelling en voorlopige Koppels dragen een herkomst (`dev`/`prod`) zodat de productie-AI geen testkennis gebruikt. Zie `product/sections/kennisbank/spec.md`.
