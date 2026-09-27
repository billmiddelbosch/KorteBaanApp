# Data Model

## Entities

### Gebruiker
De eigenaar of een vriend met een eigen account, eigen speelsessies en eigen historie.

### Draverij
Een kortebaandraverij op een plaats en datum. Bij elke draverij vindt een verse AI-analyse plaats op basis van de meest recente online data.

### Omloop
Een ronde binnen een draverij (bijv. 1e omloop, herkansing, finale). Voor elke omloop vindt opnieuw een AI-analyse plaats met de actuele stand, uitslagen en quota's.

### Koppel
Twee deelnames die in een omloop tegen elkaar lopen, met de winnaar als uitslag.

### Paard
Een draver waarvan prestaties over draverijen heen worden gevolgd.

### Pikeur
De menner van een paard.

### Stal
De eigenaar- of trainingsstal van een paard. Wordt per deelname vastgelegd zoals de bron die op dat moment vermeldt; verbanden tussen stal, paard en pikeur leidt de AI zelf af.

### Deelname
De start van een paard in een draverij, met de pikeur en stal van dat moment.

### Quota
Een momentopname van de quota's in een omloop, automatisch opgehaald of uitgelezen van een door de gebruiker geüploade foto.

### Analyse
Een AI-analyse van een draverij of omloop, uitgevoerd op het moment zelf met de meest recente online data. Opgeslagen data en lessen zijn aanvullende input, maar vervangen de actuele analyse nooit.

### Speelsessie
De koersdag van een gebruiker bij een draverij, met het vooraf opgegeven budget.

### Advies
De inzet-suggestie van de AI voor een omloop binnen een speelsessie, gebaseerd op een analyse en het resterende budget, met onderbouwing.

### Weddenschap
De werkelijke inzet van een gebruiker en het resultaat daarvan.

### Les
Een inzicht in het gedeelde kennissysteem, vastgelegd na evaluatie van advies versus uitkomst. Heeft een vrij onderwerp en kan gaan over paarden, pikeurs, stallen, draverijen, adviesstrategie of overige zaken.

### Bron
Een online bron waar de AI-agent data vandaan heeft gehaald, zodat herkomst en actualiteit controleerbaar zijn.

## Relationships

- Draverij has many Omloop
- Omloop has many Koppel
- Draverij has many Deelname
- Deelname belongs to Paard, Pikeur and Stal
- Koppel links two Deelname
- Omloop has many Quota
- Draverij and Omloop each have many Analyse (a fresh one per draverij and per omloop)
- Analyse uses Deelname, Quota, Les and Bron as input
- Gebruiker has many Speelsessie
- Speelsessie belongs to Draverij
- Speelsessie has many Advies (one or more per Omloop) and many Weddenschap
- Advies belongs to Analyse
- Weddenschap optionally belongs to Advies
- Les optionally references Paard, Pikeur, Stal, Draverij or Advies (or none, for general lessons)
- Draverij, Deelname, Quota, Analyse and Les reference one or more Bron
