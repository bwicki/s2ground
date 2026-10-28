# Konzept «Sonde sofort hier starten» (Schnellstart)

Stand 17.10.2026 · Entwurf im Design-Canvas: Boards «Schnellstart · vor dem Start» und «Schnellstart · Aufstieg läuft / nach der Landung», Knopf auf dem Anmelde-Board.

## 1. Zweck

Ein Laie kann die Sonde ohne Planung, ohne Phasen und ohne Fachbegriffe starten. Die App fragt nur ab, was sie nicht selbst
wissen kann, meldet nur, was der Laie jetzt braucht, und sagt bei jedem Problem in einem Satz, was zu tun ist. Alles Übrige
(Funk-Einstellungen, Protokoll, Dateien, Live-Übertragung an s2stueve, Beobachter) läuft unverändert im Hintergrund.

## 2. Einstieg

* Die Anmeldung ist immer der erste Schritt – auch für den Schnellstart (Cutdown ist eine Hardware-Aktion; jeder Schritt
  wird dem Benutzer zugeordnet und protokolliert). Die Anmeldeseite bietet deshalb keine Abkürzung (Entscheid 28.10.2026;
  der ursprünglich vorgesehene zweite Knopf auf der Anmeldeseite ist entfallen).
* Nach der Anmeldung steht oben in Phase 1 «Aufstieg planen» der blaue Knopf **«Sonde sofort hier starten»**.
* Von der Schnellstart-Seite führt jederzeit ein Link «Stattdessen vollständig planen →» in den normalen Ablauf; nach dem Start
  «Vollständige Ansicht →» (Karte, Vertikalsicht, Stüve, Chat).

## 3. Eine Seite, drei Schritte (vor dem Start)

| Schritt | Was die App abfragt | Was die App meldet | Wenn nicht OK |
|---|---|---|---|
| 1 Verbinden | nichts (USB-Port wird gemerkt; beim ersten Mal ein Klick «Verbinden») | ✓ Empfänger RR4 verbunden · ✓ Sonde erkannt, Nr., Batterie | roter Punkt + Anweisung: «USB-Kabel am RR4 einstecken und *Verbinden* drücken» / «Schwarzes Kabel an RR4 und Sonde stecken, 5 s warten» / «Batterie zu schwach – Sonde laden» |
| 2 Einstellen | **nur die Cutdown-Höhe über Grund** – grosser Wert, Vorgabe aus den Einstellungen (3'000 m AGL), Knöpfe −500/+500 | Startort = hier (GPS des Empfängers, ICAO-Koordinaten, Höhe AMSL) · Luftraum automatisch geprüft | GPS fehlt: «Empfänger ins Freie stellen» · Luftraumkonflikt: gelbe Zeile «Luftraum X ab Y m – Cutdown auf Z m senken?» mit Knopf · openAIP nicht erreichbar: «Luftraum nicht geprüft – DABS/NOTAM selbst prüfen» |
| 3 Starten | ein Knopf **«SONDE PROGRAMMIEREN & FREIGEBEN»** | danach ein einziges Statusfeld: gelb «WARTEN – Sonde sucht GPS, ins Freie halten, nicht loslassen» → grün **«BEREIT – JETZT LOSLASSEN»** | jeder fehlgeschlagene Check erscheint im Statusfeld rot mit der Anweisung (z. B. «Cutdown-Draht nicht erkannt – Sonde zurückschicken/anderen Draht») |

Hinter dem Knopf laufen automatisch: Frequenz/Zeitschlitze von den Einstellungen übernehmen, Cutdown-Höhe schreiben und
zurücklesen, Bodendruck/Bodenhöhe setzen, GPS-Fix abwarten, Batterie- und Sensorplausibilität, Drahttest (`wires`), Beobachter
benachrichtigen (WhatsApp-Knopf unten, optional). Der Start wird von der App selbst erkannt (Höhe > 35 m über Grund); die Seite
wechselt dann ohne Zutun in die Live-Ansicht.

## 4. Dieselbe Seite nach dem Start

* Ein grüner Balken «OK – Sonde steigt, alles läuft automatisch · Cutdown bei … in ≈ … min · Du musst nichts tun».
* Drei grosse Kacheln: **Höhe über Grund**, **Steigrate**, **Bis Cutdown** (mit Funk-Status als Soll-Ist-Zeile).
* Ein grosser roter Knopf **CUTDOWN JETZT** (mit Rückfrage, Quittung per Funk, Protokoll) – sonst keine Bedienelemente.
* Nach der Landung derselbe Balken mit Entfernung, Richtung, Position (ICAO), **In Google Maps navigieren**, QR-Code fürs Handy,
  Hinweis «Empfänger mitnehmen» und «Aufstieg abschliessen & archivieren».
* Warnfälle in einfachen Worten: «Funk weg seit 2 min – Empfänger höher halten / näher hin», «Sonde steigt nicht – loslassen?»,
  «Position möglicherweise ungenau – Funksignal im Abstieg verloren».

## 5. Bewusst weggelassen

Trajektorienkarte, Vertikalsicht, Stüve, Chat, Ballondaten, Startzeit, Betriebsart/Dropsonde, Expertenwerte. Alles ist einen Klick
entfernt («Vollständige Ansicht»), aber nicht auf der Schnellstart-Seite. Beobachter sehen in s2stueve denselben Aufstieg wie sonst.

## 6. Umsetzung in der App (nach Deiner Freigabe des Entwurfs)

* Neue Route `#quick` mit einem Modul `src/ui/quick.js`; nutzt die vorhandenen Bausteine (Verbindung, Programmieren, Checks,
  Telemetrie-Verarbeitung, Planung für die Luftraumprüfung, Dateien, Relay, Bergen) – keine neue Logik für Hardware oder Daten.
* Der Schnellstart erzeugt intern denselben Aufstieg wie der Phasenablauf (Startort aus RR4-GPS, Startzeit = jetzt, Cutdown aus dem
  Feld); ein Wechsel in die vollständige Ansicht ist deshalb jederzeit ohne Verlust möglich.
* Protokolleintrag «Schnellstart» mit den gesetzten Werten; alles Übrige wie im Phasenablauf.

## 7. Offene Punkte

1. Soll die Cutdown-Höhe im Schnellstart überhaupt änderbar sein, oder reicht die Vorgabe (3'000 m AGL) mit Hinweis? – änderbar / fest
2. Soll der Drahttest (`wires`) im Schnellstart automatisch laufen (dauert ca. 10 s, Sonde in der Hand halten) oder entfallen? – automatisch / entfällt
3. Beobachter-Benachrichtigung im Schnellstart: automatisch nach dem Freigeben (Stufe 2) oder nur über den Link unten (Stufe 1)? – automatisch / Link
