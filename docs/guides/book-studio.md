# EMBER Studio: Guide für den Bereich `Book`

EMBER ist im Book-Modus kein normaler Editor, sondern ein Arbeitsraum für geplantes, szenenbasiertes Schreiben mit Modell-Orchestrierung. Gute Ergebnisse entstehen hier nicht durch einen einzigen Prompt, sondern durch saubere Vorbereitung im Blueprint, klare Szenenführung im Writer und anschließende Kontrolle der Job-Ergebnisse.

So gehst du in Ember vor

  1. Setze im Blueprint den Markt sauber: Premise, Reader Promise, Hook, Category Lane, Ending Promise. Verkäufe kommen
     nicht nur aus Prosa, sondern aus Verpackung und klarem Versprechen.
  2. Schreibe 5 bis 10 klare Writer Rules. Sie sind Kompass, nicht Käfig.
  3. Plane nicht in „300 Seiten“, sondern in Szenen. Für 300 Taschenbuchseiten bist du grob bei 75.000–90.000 Wörtern.
     In Ember heißt das meist 45–65 Szenen mit etwa 1.100–1.700 Wörtern.
  4. Gib jeder Szene eine belastbare Summary: Ziel, Widerstand, Wendung, Enddruck.
  5. Setze pro Szene klare Intention: POV, Ort/Zeit falls wichtig, Situation, Want, Pressure, Material, Turn, irreversible Veränderung und Avoid.
  6. Nutze Director Note nur für den aktuellen Eingriff, nicht für die gesamte Poetik.
  7. Erzeuge Jobs szenenweise, übernimm nur starke Drafts, prüfe dann Review, offene Fäden und Kontinuität.

## 1. Wofür der Book-Bereich da ist

Der Book-Bereich ist für lineares Erzählen gedacht:

- Roman
- Novelle
- Serienband
- psychologisch oder marktorientiert geplante Spannungsliteratur

Die Grundidee:

- Du definierst zuerst die Leitplanken des Buchs.
- Du strukturierst dann Akte, Kapitel und Szenen.
- Für einzelne Szenen erzeugt EMBER Draft-Jobs mit `context`, `draft`, `length_control`, `extract`, `continuity` und `quality_eval`.
- Die Ergebnisse landen nicht nur als Text, sondern auch als nutzbarer Zustand für Kanon, Figuren, offene Fäden und spätere Szenenarbeit.

## 2. Die drei Modi oben links

Im Book-Projekt wechselst du hauptsächlich zwischen drei Modi:

1. `Plan` / Blueprint  
   Hier legst du Stoff, Marktspur und Schreibregeln fest.

2. `Book` / Writer  
   Hier bearbeitest du Szenen und startest KI-Jobs.

3. `Review`  
   Hier prüfst du Logik, Kontinuität und Projektreife.

Praktisch:

- Blueprint ist die strategische Ebene.
- Writer ist die operative Ebene.
- Review ist die Kontroll- und Korrekturebene.

## 3. So arbeitet man sinnvoll in EMBER

Die effizienteste Reihenfolge ist fast immer:

1. Buch im Blueprint sauber schärfen.
2. Akte, Kapitel und Szenen grob anlegen.
3. Pro Szene eine belastbare Summary schreiben.
4. Erst dann KI-Jobs im Writer starten.
5. Gute Jobs übernehmen, schwache Jobs mit klarer Director Note neu ansetzen.
6. Kontinuität und offene Threads regelmäßig prüfen.

Wenn du zu früh generierst, bekommst du fast immer generischen oder zu weichen Output.

## 4. Blueprint: Was wo hineingehört

Der Blueprint ist die wichtigste Qualitätsquelle für alle späteren Jobs.

### Master Brief

Hier definierst du den Kern der Geschichte.

- `Premise`  
  Was ist der Stoff in einem harten, klaren Satz?

- `Reader Promise`  
  Was bekommt der Leser emotional und dramaturgisch?

- `Ending Promise`  
  Was soll sich am Ende bezahlt machen?

- `Thematic Core`  
  Welcher innere Konflikt oder welche Leitspannung arbeitet unter dem Plot?

- `Author Intent`  
  Was soll dieses Buch langfristig bleiben, auch wenn Szenen neu gedraftet oder umgebaut werden?

- `Current Focus`  
  Worauf sollen die nächsten 1 bis 3 Szenen wieder achten? Das ist eine weiche Steuerung, kein Ersatz für Scene Cards.

- `Story Architecture`  
  Welche strukturellen Regeln gelten für das größere Ganze?

Gut:

- konkret
- spannungsfähig
- marktfähig
- nicht abstrakt-literarisch

Schlecht:

- „Es geht um Menschen und ihre Abgründe“
- „Ein atmosphärischer Roman über Schuld“

Zu weich. Das steuert Modelle kaum.

### Market Brief

Hier definierst du nicht Werbung, sondern Marktspur und Verpackungslogik.

- `Amazon Goal`
- `Category Lane`
- `Hook`
- `Series Potential`
- `Cover Direction`
- `Publishing Guardrails`

Der wichtigste Hebel hier ist meist:

- `Hook`
- `Category Lane`

Wenn die beiden unscharf sind, wird auch der Szenenoutput oft unscharf.

### Writer Constitution

Das ist deine eigentliche Schreibverfassung. Diese Regeln laufen später als harter Stil- und Qualitätsrahmen mit.

Gute Regeln sind:

- kurz
- prüfbar
- szenennah
- handlungsbezogen

Beispiele:

- „Szenen starten spät und verlassen sie früh.“
- „Dialog muss Macht verschieben oder Information unter Druck tragen.“
- „Emotion wird über Handlung, Blick, Körper und Entscheidung sichtbar, nicht erklärt.“
- „Jede Szene endet mit Reibung, Drohung oder Erkenntnis, nicht weich.“

Schwache Regeln sind:

- „schön schreiben“
- „literarisch“
- „mehr Tiefe“

## 5. Manuscript Explorer: Akte, Kapitel, Szenen

Links im Writer navigierst du durch:

- Akte
- Kapitel
- Szenen

EMBER arbeitet im Book-Bereich szenenbasiert. Eine Szene ist die eigentliche operative Einheit für Draft-Jobs.

Für jede Szene sind besonders wichtig:

- `Title`
- `Summary`
- strukturierte Scene-Card-Regie
- vorhandene Textblöcke

Die Summary ist der wichtigste direkte Arbeitsanker für die KI.

Zusätzlich wichtig seit dem aktuellen Regie-Sync:

- `book_scene_cards` tragen nicht mehr nur freie `outline`-Zeilen, sondern auch strukturierte Szenenintention
- hart sind nur `pov`, `location`, `timeAnchor`, Locked Facts, Canon-Namen und explizite Kontinuitaetsanker wie `object_anchor`, `prop_anchor`, `locked_object` oder bevorzugt `locked_material`
- weich, aber wichtig, sind `situation`, `want`, `pressure`, `material`, `turn`, `irreversible_change`, `thread`, `avoid`, `aftertaste` sowie alte Felder wie `objective`, `coreAction`, `proof_object`, `false_friend_signal`, `dramaticBeat`, `ending` und `closingLine`
- `ending_type` ist wichtig für den Kapitelrhythmus: nicht jede Szene darf mit demselben Proof-, Objekt- oder Schockmechanismus schließen
- `proof_object` ist heute eher `material`: ein konkreter Szenenanker, nicht automatisch ein harter Beweisauftrag
- `required_material` ist kein Runtime-Key mehr; der Regie-Import mappt es nur fuer echte Kontinuitaetsfaelle auf `locked_material`

Praktisch heißt das:

- Regie bleibt die Quelle
- die DB hält daraus eine normalisierte Runtime-Fassung
- wenn Scene Card und Summary sich widersprechen, schützen harte Constraints Kanon; weiche Scene Guidance führt die Absicht, ohne die Prosa mechanisch zu diktieren

Eine gute Szenen-Summary sollte enthalten:

- was die Figur will
- was im Weg steht
- was kippt
- womit die Szene endet

Eine gute Scene Card sollte knapp bleiben:

```text
pov:
where_when:
situation:
want:
pressure:
material:
turn:
irreversible_change:
thread:
avoid:
aftertaste:
```

Der wichtigste Anker ist `irreversible_change`: Was kann nach dieser Szene nicht mehr so sein wie vorher? `material` sollte 1 bis 3 konkrete Dinge liefern, keine Objekt-Checkliste. `avoid` verhindert Fehlfassungen, ohne Dialog oder Schlussbild vorzuschreiben.

Beispiel:

> Jonas nimmt Adrians Vermisstenmeldung auf. Zunächst wirkt Adrian kontrolliert, fast zu kontrolliert. Im Gespräch verschiebt sich der Fokus von Elena auf ihr Notizbuch. Jonas merkt, dass Adrian nicht Hilfe sucht, sondern Deutungshoheit. Die Szene endet mit einem Objekt oder Satz, der Jonas ins Haus am Hang zwingt.

Das ist deutlich besser als:

> Jonas spricht mit Adrian über Elena.

## 6. Writer: Was in der Mitte und was rechts passiert

Im Writer arbeitest du in zwei Bereichen:

- Mitte: die aktuelle Szene
- Rechts: der AI-Bereich für Provider, Modelle, Wortziel und Jobs

### In der Szenenfläche

Hier bearbeitest du:

- Szenentitel
- Summary
- Textblöcke

Wichtig:

- Die Summary ist kein Fülltext.
- Auch wenn schon Text in der Szene steht, orientiert sich der Job stark an Summary, Blueprint und Kontext.

### Im rechten AI-Bereich

Hier steuerst du den Draft-Job.

#### Provider

Verfügbar sind in der aktuellen UI:

- `Auto`
- `OpenAI`
- `Anthropic`

Praxis:

- `OpenAI` eignet sich gut für präzise, saubere Struktur.
- `Anthropic` eignet sich gut für nuancierte, atmosphärische Prosa.
- `Auto` nimmt den besten verfügbaren Pfad auf Basis der Umgebung.

Für den ersten echten Testlauf ist besser:

- keinen `Auto`-Lauf, sondern einen bewussten Provider wählen
- nur dann bewerten, wenn der Job im Ergebnis `remote` ist
- bei fehlenden API-Keys erst die Umgebung korrigieren, nicht die Szene

#### Modell-IDs

Unterhalb des Providers kannst du pro Provider konkrete Modell-IDs setzen.

Wichtig zu verstehen:

- Die Auswahl wird lokal gespeichert.
- Du kannst für Anthropic getrennt das Hauptmodell und das Continuity-Modell setzen.
- Das Hauptmodell schreibt und überarbeitet.
- Das Continuity-Modell prüft auf Risiken und Stilabweichungen.

Voraussetzung für echte Remote-Läufe:

- `OPENAI_API_KEY` für OpenAI
- `ANTHROPIC_API_KEY` für Anthropic

Fehlt der Key für den gewählten Provider, fällt EMBER auf `local_fallback` zurück oder nutzt den Provider gar nicht.

#### Ziel-Länge

Die Felder `Min` und `Max` steuern die gewünschte Szenenlänge des direkten Prosa-Laufs.

Praxiswerte:

- kurze Spannungsszene: `900–1300`
- normale Romanszene: `1200–1800`
- langsamere, dichter gebaute Szene: `1600–2400`

Wichtig:

- Das System normalisiert technisch unsinnige Eingaben.
- Hohe Werte kosten mehr und dauern länger.
- Mehr Wörter bedeuten nicht automatisch bessere Szene.

#### Director Note

Das ist dein stärkster direkter Hebel im Writer.

Nutze sie nicht für Weltbau, sondern für operative Steuerung der konkreten Szene.

Gut:

- „Adrian soll kontrolliert bedrohlich wirken, nie offen aggressiv.“
- „Mehr sozialer Druck, weniger Erklärung.“
- „Die Szene braucht einen stärkeren Kapitelhaken.“
- „Jonas darf nicht analysieren, sondern nur beobachten und reagieren.“

Schlecht:

- „Mach besser.“
- „Schreib wie ein Bestseller.“
- „Mehr Spannung.“

Zu unspezifisch.

## 7. Was ein Draft-Job intern macht

Ein einzelner Job durchläuft diese Stufen:

1. `Context`  
   Das System baut den Szenenkontext aus Blueprint, Szenenstruktur, Kanon, Figurenstatus und benachbarten Beats.

2. `Draft`  
   Das Modell schreibt direkt die Szene.

3. `Length Control`  
   Wenn die Szene deutlich unter oder über dem Ziel liegt, greift ein eigener `expand`- oder `compress`-Pass.

4. `Extract`  
   Das System extrahiert neue Fakten, Figurenveränderungen, offene Fäden und Foreshadowing aus dem finalen Text.

5. `Continuity`  
   Der Text wird gegen Kanon, Stil und laufende Logik geprüft.

6. `Quality Eval`  
   Die fertige Szene bekommt Wortmetriken, Scores und konkrete Issues.

Das bedeutet:

- Du bekommst nicht nur einen Text.
- Du bekommst auch verwertbare Produktionsdaten für Folgearbeit.
- Die Prosa läuft bewusst schlanker als früher: kein separater Beat-Plan-Call, kein automatischer Rewrite-Pass, weniger Mikrosteuerung.
- Die technischen Stages `beat_plan` und `rewrite` bleiben aus Kompatibilitätsgründen sichtbar, sind im Remote-Pfad aber normalerweise `skipped`: Der Draft entsteht direkt aus Scene Intention, Kontext, Human Edit Memory und Director Note.
- Wortziele sind bevorzugte Rahmen. Wenn die Szene organisch früher schließt oder mehr Raum braucht, soll der Szenendruck Vorrang haben.
- `length_control` ist nur noch eine Notfallprüfung gegen extreme Ausreißer, nicht das Qualitätsmaß der Szene.
- Zusätzliche Qualitäts-Audits warnen vor zu glatten KI-Mustern, zu vielen abstrakten Deutungswörtern, zu perfekt getakteten Druckfiguren und monotonen `ending_type`-Folgen. Das sind Warnungen, keine automatischen Textänderungen und keine neuen Acceptance-Blocker.

## 8. Wie du Job-Ergebnisse richtig liest

Nach einem Run zeigt der Writer:

- Provider
- Ausführungsmodus
- Modellname
- Stage-Status
- Draft
- Length-Control-Status
- Rewrite Notes
- Extract-Karten
- Continuity-Karten
- Quality-Hinweise

### Provider und Modus

Hier ist besonders wichtig:

- `remote`  
  Der echte Modellpfad wurde erfolgreich genutzt.

- `local_fallback`  
  Der Remote-Pfad ist ausgefallen oder nicht verfügbar. Dann stammt der Text aus dem lokalen Fallback und ist nicht als echtes Qualitätsurteil über das Modell zu lesen.

Wenn du Modellqualität beurteilen willst, muss der Job `remote` sein.

Für den ersten Testlauf gilt deshalb:

- `remote` = echter Modelllauf, auswertbar
- `local_fallback` = Sicherheitsnetz, nicht als Qualitätsurteil lesen

### Generate, Accept, Save

Der wichtigste UI-Punkt:

- `Generate` startet nur den Draft-Job
- der erzeugte Text liegt danach zunächst im Job
- erst `Accept` / `Übernehmen` schreibt den finalen Job-Text in die eigentliche Szene
- erst nach erfolgreichem Speichern ist der Text sicher in Supabase und damit stabil in der UI

Das bedeutet konkret:

1. `Generate`
2. Ergebnis prüfen
3. `Accept`
4. auf den Save-Status achten oder manuell `Speichern` klicken

Wenn du nur `Generate` drückst, aber nicht `Accept`, entsteht noch kein sichtbarer Szenentext in den Scene Blocks.

Wenn du `Accept` gedrückt hast, aber der Save fehlschlägt, ist der Text nur lokal im Browser-Draft und nicht garantiert in Supabase.

### Human Edit Memory

Wenn du einen Job übernimmst und den Szenentext danach beim Speichern weiterbearbeitest, erfasst EMBER die Differenz als Human Edit Memory.

Das ist kein alter Plot-Speicher, sondern ein Stil- und Präferenzsignal:

- Welche Art von Kürzung, Verdichtung oder Erweiterung nimmst du nach KI-Drafts vor?
- Welche Edit-Tags wiederholen sich?
- Welche Beispiele sind für zukünftige Jobs `included`, `excluded` oder `needs_review`?

Aktive Beispiele laufen in spätere Draft-Prompts ein. Sie sollen Muster übertragen, aber keine alten Sätze, Namen oder Ereignisse kopieren.

### Quality Warnings richtig lesen

Quality-Warnungen sind Produktionshinweise, keine roten Stoppschilder.

Typische Warnungen bedeuten:

- **KI-glatte Marker**: Der Text deutet zu elegant. Prüfe, ob Handlung, Objekt und Körper stärker tragen können.
- **abstrakte Deutungswörter**: Die Szene klingt nach Regie. Ersetze Konzepte durch sichtbare Dinge, Gesten, Dokumente, Routinen.
- **zu perfekte Druckfigur**: Der Antagonist oder die Druckfigur wirkt zu exakt getaktet. Ein falscher Ton, kleiner Fehler oder unvollständiger Zugriff macht die Szene glaubwürdiger.
- **monotone Enden**: Mehrere Scene Cards schließen mit ähnlichem `ending_type`. Variiere über Entscheidung, Schweigen, soziale Folge, scheinbare Entlastung, Kindmoment oder Zugriffverlust.

Diese Warnungen gehören in die nächste Director Note, in eine Scene-Card-Schärfung oder in einen Human Edit. Sie sollen nicht blind wegoptimiert werden.

### Rewrite Notes

Diese zeigen sichtbare Stärken, Schärfungen oder auffällige Punkte des finalen Textes.

Gut:

- konkret
- sichtbar im Text
- knapp

Wenn die Notes generisch wirken, ist oft die Szene oder Director Note noch zu weich.

### Length Control

Diese Stage ist neu wichtig.

- `accept` bedeutet: Die Szene lag schon im brauchbaren Korridor.
- `expand` bedeutet: Der Draft war zu kurz und wurde gezielt vertieft.
- `compress` bedeutet: Der Draft war zu lang und wurde verdichtet.

Für den ersten Lauf ist `accept` oder ein sauberer einzelner `expand`-/`compress`-Pass ein gutes Zeichen. Wiederholt harte Längenprobleme deuten meist auf eine zu schwache Summary oder eine unklare Director Note hin.

### Extract State

Hier landet strukturierter Erkenntnisgewinn:

- neue Kanonfakten
- Figurenstatus-Updates
- neue offene Threads
- aufgelöste Threads
- Foreshadowing
- Kontinuitätsrisiken
- Stilabweichungen

Wichtig:

- Nicht jede Modellbehauptung wird blind übernommen.
- EMBER bereinigt unsichere Extractor-Einträge konservativ gegen den Packet-Kontext.

## 9. Codex und Memory: Was automatisch mitwächst

Der Book-Bereich hat ein internes Gedächtnis. Dazu gehören:

- Canon Ledger
- Character Ledger
- Open Threads
- Scene Cards
- Context Packs

Das Ziel:

- spätere Szenen bekommen mehr belastbaren Kontext
- Kontinuitätsfehler werden sichtbarer
- Figurenzustände bleiben nachvollziehbar

Praktisch heißt das:

- saubere Szenenarbeit verbessert spätere Szenen
- schlampige oder vage Szenen verschmutzen die Memory-Basis

## 10. Review: Wann und wofür nutzen

Review ist nicht nur „einmal am Ende draufschauen“.

Nutze Review:

- nach wichtigen Plot-Wendungen
- nach jeder Szene mit neuem Fakt oder Objekt
- wenn sich Figurenwissen verschiebt
- vor längeren Generierungsserien

Besonders wichtig sind:

- Kontinuitätswarnungen
- unklare Besitz- oder Wissensstände
- neue, noch nicht eingelöste offene Fäden
- Review Queue Items aus Quality, Market und Propagation Debt
- Propagation Debt, wenn ein Job nach Änderungen an Summary, Context Pack, Memory, Blueprint oder Writer Rules neu bewertet werden sollte

## 10a. Export

Im Amazon-Ops-Bereich kannst du zusätzlich zum Launch-Paket einen einfachen Markdown-Export des aktuellen Manuskripts erzeugen.

Wichtig:

- Der Export ist ein Arbeitsstand aus den aktuellen Scene Blocks.
- Er ersetzt keinen KDP-EPUB- oder DOCX-Workflow.
- Er ist bewusst schlicht, damit Manuskriptprüfung, externe Lektoratsdurchläufe oder spätere Formatierung nicht an der Studio-UI hängen.

## 11. Empfohlene Arbeitsweisen

### Workflow für neue Projekte

1. Titel, Grundstoff, Hook und Reader Promise sauber machen.
2. Writer Constitution auf 5 bis 12 gute Regeln bringen.
3. Akte und Kapitel grob anlegen.
4. Pro Szene eine starke Summary schreiben.
5. Erst danach mit KI-Drafts beginnen.

### Workflow für einzelne Szenen

1. Szene auswählen.
2. Summary schärfen.
3. Wortziel setzen, für den ersten Lauf am besten `1200–1600`.
4. Provider und Modell bewusst wählen, nicht `Auto`.
5. Director Note nur für die aktuelle Szene schreiben.
6. Job starten.
7. Prüfen, ob der Lauf `remote` ist.
8. Draft, Length Control, Notes und Continuity lesen.
9. Gute Fassung nur dann `Accept` / `Übernehmen`, wenn sie wirklich in die Szene soll.
10. danach den Save-Status abwarten oder explizit `Speichern` drücken.
11. erst dann die Szene in der UI oder DB als wirklich übernommen betrachten.
12. Quality-Hinweise prüfen oder mit neuer Director Note neu ansetzen.

### Workflow für mehrere Iterationen

Nutze nicht zehn vage Wiederholungen. Nutze drei saubere Iterationen:

1. erster Lauf für Grundzug
2. zweiter Lauf für Ton, Spannung, Ending
3. dritter Lauf nur für gezielte Korrektur

## 12. Was gute Ergebnisse zuverlässig verbessert

- präzise Premise
- harte Reader Promise
- marktfähiger Hook
- kurze, gute Writer Constitution
- konkrete Szenen-Summary
- klare Director Note
- realistische Wortziele
- regelmäßige Review-Kontrolle

## 12a. Erster Testlauf

Wenn du deinen ersten echten Run machen willst, nimm diesen Minimalpfad:

1. `npm run dev`
2. `/studio` öffnen
3. eine Szene mit klarer Summary wählen
4. Provider bewusst auf `OpenAI` oder `Anthropic` setzen
5. Wortziel auf `1200–1600`
6. eine kurze operative Director Note schreiben
7. Job starten
8. nur auswerten, wenn `mode = remote`
9. gute Fassung immer zusätzlich `Accept` und danach `Speichern`

Danach prüfst du in dieser Reihenfolge:

1. Trägt der Draft die Szene bis zum Endhaken?
2. Musste `length_control` eingreifen?
3. Gibt es echte Continuity-Risiken?
4. Meldet `quality_eval` grobe Issues?

## 13. Was regelmäßig schlechte Ergebnisse erzeugt

- leere oder dünne Summary
- unklare Hook/Category Lane
- zu abstrakte Writer Constitution
- Director Note voller Allgemeinplätze
- zu viele Ziele in einer Szene gleichzeitig
- zu viele harte Pflichtfelder in Scene Cards
- jedes `proof_object` als zwingendes Beweisobjekt statt als weiches Material behandeln
- fehlende `irreversible_change`
- Modellqualität auf Basis von `local_fallback` beurteilen
- Kontinuitätswarnungen ignorieren
- einen ersten Lauf mit zu hohem Wortziel aufblasen
- `Auto` benutzen und danach nicht wissen, welcher echte Pfad lief
- `Generate` mit „Text ist jetzt schon in der Szene“ verwechseln
- nach `Accept` nicht auf den Save-Status achten

## 14. Hinweise zu Kosten und Laufzeit

Nicht alle Provider verhalten sich gleich.

- stärkere Modelle kosten mehr
- längere bevorzugte Zielrahmen können mehr kosten
- zusätzliche Notfall-Length-Control- oder Continuity-Pässe kosten mehr
- `length_control` und `quality_eval` sind zusätzliche Stufen und können Laufzeit erhöhen
- bessere Qualität ist oft teurer, aber billiger als zehn unbrauchbare Billigläufe

Praxis:

- Für wichtige Kernszenen lohnt sich ein stärkeres Modell.
- Für Routine- oder Strukturarbeit reicht oft ein günstigerer Provider.
- Nutze das teure Modell dort, wo Voice, Spannung und Schlusshaken wirklich tragen müssen.

## 15. Kurzfassung für neue Nutzer

Wenn du nur die wichtigste Arbeitsregel mitnehmen willst, dann diese:

- Erst Blueprint scharf machen.
- Dann pro Szene eine gute Summary schreiben.
- Dann mit klarer Director Note und bewusstem Provider generieren.
- Danach Draft, Length Control und Continuity lesen, nicht nur den ersten Textblock.

EMBER belohnt saubere Führung. Wer das Tool wie einen Chat benutzt, bekommt mittelmäßige Ergebnisse. Wer es wie ein Produktionssystem führt, bekommt deutlich bessere.

---

Stand: 20. April 2026  
Gilt für den aktuellen Book-Workflow in EMBER Studio.
