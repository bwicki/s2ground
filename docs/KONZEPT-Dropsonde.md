# Konzept «Dropsonde S2H3-D in S2 Ground» – Entwurf v0.1

Stand 22.11.2026 · Grundlage: Datenblatt «Windsond S2-D datasheet v1» (Sparv Embedded), Protokollspezifikation
`docs/protocol/ssp-windsond-protocol.md` (§5.3 Parameter `role`, §6.2 Phasenlogik), Stand der App 0.4.

## 1. Was die Dropsonde anders macht

Aus dem Datenblatt und der Protokollspezifikation:

* **Gleiche Funk- und Protokollbasis wie die S2**: RR4-Empfänger, LoRa 400–406 / 433–436 MHz, Zeitschlitze, 3 Sonden je
  Frequenz (bis 126), gleiche Telemetrie (Temperatur/Feuchte/Wind 1 Hz, Position und Druck ⅓ Hz, Höhe als geopotentielle
  Höhe aus Druck und GNSS). Für die App ist sie **eine S2 mit `role = 3` (Dropsonde)** – Parameter 1109, per SSP lesbar
  und setzbar; unsere Protokollschicht kennt `setRole()` bereits.
* **Ablauf physisch**: Sonde im Korb per Taste einschalten → GNSS-Fix (< 2 min) → Abwurf → der Streamer bremst auf
  10–11 m/s (Meereshöhe; in der Höhe schneller, dünnere Luft: aus 5 km ≈ 13 m/s) → Daten kommen **von oben nach
  unten**. Dauer: 13 min aus 10 km, aus 3000 m über Grund ≈ 5 min.
* **Sendeleistung**: vor dem Abwurf bis −10 dBm (Batterie schonen), nach dem Abwurf bis +20 dBm. Die Sonde erkennt den
  Abwurf selbst (Schwellen `dropSpeedHMax` / `dropSpeedVMin`, Parameter 1112/1113) und wechselt ihren Modus:
  `md = 1` «Ready for drop» → `3` «Falling» → `4` «Resting».
* **Batterie**: 1.3 h wie geliefert, 3.5 h voll geladen (Laden über den SSP-Port vor der Fahrt). Folge: Die Sonde wird
  **nicht beim Ballonstart** eingeschaltet, sondern im Korb einige Minuten vor dem Abwurf; der GNSS-Fix kommt im offenen
  Korb in unter 2 Minuten.
* **Reichweite > 100 km Sichtlinie**: Der Empfänger am Boden sieht die Sonde, sobald sie eingeschaltet ist und der
  Ballon in Sichtlinie steht – der Funkkontakt steht also **schon vor dem Abwurf** («bereit im Korb»).
* **Höhe**: Unsicherheit 13 m mit Bodendruck-Kalibration («with calibration from ground station») – der RR4-Fix und
  der Bodendruck am Boden bleiben wichtig, genau wie beim Aufstieg.
* **Sensorik**: H3-Fühler mit T63 = 6 s → bei 10 m/s Fallgeschwindigkeit hinkt die Temperatur ≈ 60 m nach (beim Aufstieg
  mit 3 m/s ≈ 18 m). Das Stüve bleibt brauchbar; die Verzögerung sollte im Diagramm vermerkt sein.

## 2. Ablauf in der App – was entfällt, bleibt, neu ist

Zu Beginn (Schritt 1) eine **Betriebsart**: «Sondenaufstieg» (wie heute) oder «Dropsonde». Die Wahl gilt für die ganze
Aufzeichnung, steht in den Dateien (Meta `role`) und bestimmt die Phasenleiste:

| Heute: Sondenaufstieg (5 Schritte) | Dropsonde (3 Schritte) |
|---|---|
| **1 Planen** – Startort, Startzeit, Cutdown-Höhe, Trajektorie, Luftraum | **1 Vorbereiten** – Sonde per USB am RR4: Batterie (voll?), Frequenz/Zeitschlitze, `role = 3` prüfen und nötigenfalls setzen, Sendeleistung vor/nach Abwurf, Streamer-Hinweis, Bodendruck/-höhe vom RR4-Fix. Optional: voraussichtliche Abwurfhöhe und -gegend (für Funk-Erwartung und Landeschätzung). **Keine** Ballon-Trajektorie, **kein** Cutdown, **keine** Luftraumprüfung (Sache des Ballonpiloten). |
| **2 Vorbereiten** – Ballon, Cutdown programmieren und zurücklesen | entfällt |
| **3 Checks** – GPS-Fix, Drahttest, Loslassen | entfällt – an seiner Stelle eine Kontakt-Anzeige in Schritt 2 |
| **4 Aufstieg** – Karte, Vertikalsicht, Stüve, Chat | **2 Abwurf & Aufzeichnung** – Zustände: «Warten auf Kontakt» (Sonde noch aus oder nicht in Sichtlinie) → «Bereit im Korb» (`md = 1`, Höhe = Ballonhöhe, Batterie, GNSS-Fix) → «Fällt» (`md = 3` oder Sinkrate ≤ −6 m/s) → «Gelandet». Kacheln: Höhe, Sinkrate (Soll ≈ −10 m/s), Zeit bis Boden, Funk. Karte: Fallbahn und geschätzter Landepunkt (bestehende Abstiegs-Trajektorie ab Abwurfpunkt, Wind von Open-Meteo, 10–13 m/s). Stüve wächst von oben nach unten. Chat und Beobachter unverändert. |
| **5 Bergen** | **3 Bergen** – unverändert (Entfernung/Richtung, Google-Maps-Link, QR, «Empfänger mitnehmen») |

**Schnellstart**: eine Variante «Dropsonde sofort empfangen» – nur Verbinden und Warten auf Kontakt, dann dieselbe
Live-Seite. **Cutdown-Knopf** entfällt in der Dropsonde-Ansicht vollständig (kein Draht).

## 3. Datenverarbeitung

* **Phasenlogik** (`src/app.js`, heute: Start = erster Datensatz > 35 m über Grund, Peak = Maximum, Landung = 100 m unter
  Peak oder `md` 4/5/6): Für die Dropsonde wird der **Abwurf** erkannt – erster Datensatz mit `md = 3` oder Sinkrate
  ≤ −6 m/s; Abwurf-Datensatz = der letzte davor (Position und Höhe = Abwurfpunkt); «Peak» = Abwurfhöhe; Landung wie
  heute (`md` 4/5/6, oder |Sinkrate| < 1 m/s während 30 s); «Signal im Abstieg verloren – Position geschätzt» gleich.
* **Dateien**: gleiche CSV-Spalten; Name «Abwurf <Datum> · <LL-Ort>» (Ort = Abwurfpunkt, sobald bekannt, vorher Standort
  des Empfängers); Meta `role = dropsonde`, Abwurfpunkt, Empfängerstandort. Aufstiegsdateien bleiben unverändert.
* **s2stueve** schneidet heute «bis zur Maximalhöhe» (Aufstieg) und entfernt die Bodenphase – bei einer Dropsonde bliebe
  genau ein Datensatz. Anpassung: Richtung erkennen (erster Datensatz ist der höchste) → Segment Abwurf → Boden nehmen,
  für das Stüve nach Höhe ordnen, Kopfzeile «Dropsonde / Abwurf», Zeit des Abwurfs statt Startzeit; Follow-Modus
  «Follow sonde ascent» → «Follow sounding». Alles Übrige (Parser, Diagramm, Karte) bleibt.
* **Höhenauflösung**: 10 m/s × 1 Hz ≈ 10 m je Messwert (Aufstieg ≈ 3 m) – ausreichend.
* **Wind**: aus GNSS; ob die Sonde am Streamer pendelt und wie Windsond glättet, ist nicht dokumentiert (Hardwaretest).

## 4. Protokollschicht

* Vorhanden: `setRole(3)`, Modustexte, `role` in der S2-Subscription, Leistung vor/nach Abwurf (`powerBeforeLaunch_dBm`,
  `power_dBm`), Drop-Schwellen in der Ontologie, Cutdown über `mode=7` (für die Dropsonde gesperrt).
* Neu: Prüfschritt «Sonde ist Dropsonde (`role = 3`)» mit Setzen; Anzeige/Setzen der Sendeleistung; Abwurf-Erkennung aus
  `md`; Texte «Bereit zum Abwurf».
* **Bis zum Hardwaretest offen**: Liefert die S2H3-D `role = 3` ab Werk? Sendet sie vor dem Abwurf Telemetrie
  (Sendekriterium) und wie oft? Standardwerte der Drop-Schwellen? Bleiben `relBal`/`mode=7` ohne Wirkung (kein Draht)?
  Zeitschlitz-Belegung mit zwei Sonden; Verhalten nach der Landung (`findme`).

## 5. Vorgehen und Aufwand

1. **Konzeptfreigabe** (dieses Papier, Fragen in Abschnitt 6).
2. **App** (≈ 1 Arbeitstag, eine Session): Betriebsart-Schalter, Dropsonde-Ablauf (3 Schritte), Phasenlogik, Dateien und
   Meta, Texte DE/EN, Simulator «Dropsonde» (Fall aus wählbarer Abwurfhöhe mit 10–13 m/s und Planwind), Tests, Smoke.
3. **s2stueve** (≈ 2–3 h): Richtungs-Erkennung, Segmentwahl, Beschriftungen, Follow-Modus.
4. **Hardwaretest** mit den beiden Sonden: zuerst am Tisch (USB/SSP: `role`, Batterie, Leistung, Firmware), dann Empfang
   im Freien (Sonde eingeschaltet in Sichtlinie, Modus «Ready for drop»), erster Abwurf bei einer Ballonfahrt. Ein
   Abwurf aus geringer Höhe taugt nicht als Test (aus 20 m ist die Sonde in 2 s unten).

## 6. Offene Fragen

1. Betriebsart-Wahl: Umschalter oben in Schritt 1 (Vorschlag) oder eigener Einstieg direkt nach der Anmeldung? – Schritt 1 / Einstieg
2. Soll die App den **Landepunkt der Dropsonde vorausberechnen** (Abstiegs-Trajektorie ab Abwurfpunkt), damit die Bergung schneller ist? – ja / nein
3. Wird die Sonde **geborgen** (wiederverwendbar) oder ist sie Einweg? – bergen / Einweg
4. **Aktivierung im Korb** kurz vor dem Abwurf (wegen Batterie) – einverstanden? Wer bedient sie (Pilot)? Soll ich eine A4-Korbkarte «Dropsonde: Einschalten – Fix abwarten – Abwerfen» entwerfen? – ja / nein
5. **Zwei Sonden**: nacheinander (zwei Aufzeichnungen) oder gleichzeitig in der Luft (zwei Zeitschlitze, zwei Live-Ansichten)? – nacheinander / gleichzeitig
6. Abwurfhöhe und -gegend **vor** dem Abwurf eingeben (Funk-Erwartung, Landeschätzung) oder nur empfangen? – eingeben / nur empfangen
7. Hardwaretest-Termin für beide Sonden (Tisch, USB, RR4) – Datum
8. Umsetzung in einer neuen Session (dieses Modell, hohe Aufwandsstufe) nach Deinen Antworten? – ja / nein
