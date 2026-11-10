# EMBER Book Pipeline Agent Notes

Diese Datei ist technische Referenz fuer Agents und Entwickler. Sie ist nicht als Prosa-Draft-Kontext gedacht. Die kreative Regie soll kurz bleiben; der Draft-Prompt bekommt nur den schlanken Blueprint, relevante Canon-Fakten, Character-State, Open Threads und die aktuelle Scene Intention.

## Grundsatz

Harte Regeln schuetzen Kanon. Scene Cards fuehren Absicht. Die irreversible Veraenderung ist verbindlich. Die Prosa gehoert dem Modell.

## Draft-Kontext

Der Prosa-Draft nutzt:
- Premise, Reader Promise, Ending Promise, Thematic Core
- Author Intent und Current Focus
- relevante Locked Facts
- kurze Writer Rules und Prose Preferences
- relevante Canon-/Character-/Thread-Ausschnitte
- Hard Constraints fuer POV, Ort, Zeit, Namen, Locked Facts und echte Objekt-/Farbkontinuitaet
- Soft Scene Guidance als Intention
- Human Edit Memory als fokussierte Before/After-Beispiele

Der Prosa-Draft soll nicht dauerhaft mit Market Brief, Amazon Ops, langer Agenten-Doku, Cost Ledgern, vollstaendigen Guardrail-Listen oder Kapitel-Schreibregie gefuettert werden.

## Hard vs Soft

Hard Constraints:
- `pov`
- `location` / `ort`
- `timeAnchor` / `uhrzeit`
- Locked Facts
- Canon-Namen
- Objekt-/Farbkontinuitaet
- `object_anchor`, `prop_anchor`, `locked_object`
- `locked_material` nur fuer konkrete Continuity-Anker

`required_material` ist kein harter Runtime-Key mehr. Der Regie-Import darf es nur dann auf `locked_material` mappen, wenn die Szene ohne genau dieses Material continuity-falsch wird. Nicht benutzen, nur weil ein Objekt dramaturgisch schoen, wichtig oder wahrscheinlich ist.

Soft Guidance:
- `objective`
- `opening`
- `coreAction`
- `dramaticBeat`
- `ending`
- `closingLine`
- `proof_object` / `beweisobjekt`
- `alltagswaffe`
- `ersetzungsmoment`
- `kindmoment` / `mila_kindmoment`
- `false_friend_signal`
- `bad_version_risk`, `revision_focus`, `avoid`

Soft heisst nicht unwichtig. Soft heisst: Das Modell darf organisch loesen, solange die Szene dieselbe Funktion und irreversible Veraenderung erfuellt.

`proof_object`, `alltagswaffe`, `kindmoment` und aehnliche Materialsignale duerfen nicht zu einer Objektliste anschwellen. Die Prosa-Intention sollte fuer Concrete material auf 1-3 natuerliche Details begrenzt bleiben.

Audit Metadata:
- `ending_type` gehoert in Rhythmus- und Qualitaetsauswertung, nicht in den Prosa-Prompt.

## Scene Intention

Die Runtime baut aus alten und neuen Scene-Card-Feldern eine Scene Intention:
- Situation
- Want
- Pressure
- Concrete material
- Intended turn
- Irreversible change
- Aftertaste
- Avoid

Prompt-Regel:

```text
Use soft guidance as intention, not as a checklist. Do not mechanically include every listed object, phrase, or beat. Preserve the scene's irreversible change; find the most natural path there.
```

## Empfohlene Scene-Card-Struktur

```text
id:
title:
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

Optional:
- `word_target_min`
- `word_target_max`
- `ending_type` nur fuer Rhythmus-Audit, nicht als Schreibauftrag
- `object_anchor` / `prop_anchor` / `locked_material` nur fuer echte Kontinuitaetsanker
- Legacy `required_material` wird beim Import auf `locked_material` kanonisiert, nicht als eigener Runtime-Key weitergetragen.

## Mapping Alter Felder

- `objective` -> `want`
- `opening` -> `situation`
- `szenenantrieb` -> `pressure`
- `coreAction` -> `situation` / action
- `proof_object` / `beweisobjekt` -> `material`
- `alltagswaffe` -> `pressure` / `material`
- `dramaticBeat` / `reversal` -> `turn`
- `konkrete_folge` / `cost` / `status_shift` -> `irreversible_change`
- `ending` -> `aftertaste`
- `closingLine` -> hoechstens optionales Schlussbild, kein automatischer Aftertaste und kein Schlusssatz-Diktat
- `bad_version_risk` / `revision_focus` -> `avoid`
- `main_question` / `information_gap` -> `thread`

## Audits

Quality- und Continuity-Audits warnen. Sie sollen Prosa nicht automatisch formen. Continuity-Blocker bleiben fuer echte Drift relevant; Smoothness, Abstract-Nouns, Overprecision und Rhythmus sind Quality Warnings.

## Human Edit Memory

Human Edit Memory soll Opus nicht ganze Szenen kopieren lassen. Es liefert fokussierte Before/After-Fenster um die echte Aenderung herum. Gute Beispiele zeigen:
- Deutung zu Objekt/Körper/Handlung
- Proof-Kommentar zu materiellem Detail
- glatte Innensicht zu beobachtbarer Handlung
- zu perfekte Druckfigur zu kleinem falschen Ton oder unvollstaendigem Zugriff
