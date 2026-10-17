# S2 Ground – s2ground.wicki.aero

Bodenstations-App für den Sondenstart mit Windsond S2 / Empfänger RR4 (Wicki Partners Ballonteam).
Fünf Phasen: **Aufstieg planen · Sonde vorbereiten · Start-Checks · Aufstieg · Sonde bergen**.
Läuft komplett im Browser (Chrome oder Edge), die Daten gehen über einen Cloudflare Worker live an
s2stueve.wicki.aero (Command Center) – und zusätzlich als Dateien in einen Dropbox-Ordner.

Es ist **kein Entwicklerwerkzeug nötig**: Alles wird über die GitHub-Website und das Cloudflare-Dashboard
eingerichtet. Jede Änderung, die auf GitHub im Zweig `main` landet, wird automatisch veröffentlicht.

---

## 1. Was ist wo?

| Ordner / Datei | Inhalt |
|---|---|
| `web/` | Die App selbst (eine Seite, `index.html`), Sprachen in `web/i18n/de.json` und `en.json` |
| `web/src/sim/sim-link.js` | Simulierte Sonde (Rümlang, Aufstieg → Cutdown → Landung) für Übung und Tests |
| `web/src/protocol/` | Anbindung an RR4/S2 über USB (Web Serial); ohne angeschlossenen RR4 läuft die Simulation |
| `worker/` | Cloudflare Worker: Anmeldung, Benutzer, Protokoll, Live-Daten/Chat, liefert auch `web/` aus |
| `worker/schema.sql` | Datenbankstruktur (D1) – einmalig einspielen, siehe Schritt 5 |
| `.github/workflows/deploy.yml` | Automatische Veröffentlichung bei jedem Push auf `main` |
| `tests/` | Automatische Tests (laufen bei jeder Veröffentlichung mit) |
| `docs/` | Protokollspezifikation, Schnittstellenvertrag, Logo |
| `design/` | Die freigegebenen Design-Boards |

---

## 2. GitHub-Repository anlegen (nur Browser)

1. Auf https://github.com anmelden → oben rechts **+** → **New repository**.
2. Name `s2ground`, **Private**, *ohne* README/Lizenz anklicken → **Create repository**.
3. Auf der leeren Repo-Seite den Link **uploading an existing file** anklicken.
4. Den **Inhalt** des Ordners `s2ground` (also `web`, `worker`, `tests`, `docs`, `design`, `.github`, `README.md`)
   per Drag & Drop ins Browserfenster ziehen – ganze Ordner sind erlaubt. Falls der versteckte Ordner
   `.github` nicht mitkommt: im Explorer «Ausgeblendete Elemente» einschalten und nochmals ziehen.
5. Unten **Commit changes** (Zweig `main`).

> Hinweis: Der erste Push löst bereits eine Veröffentlichung aus – die schlägt fehl, solange die Secrets
> aus Schritt 4 fehlen. Das ist normal.

---

## 3. Cloudflare vorbereiten

Alles im Cloudflare-Dashboard https://dash.cloudflare.com (Konto, in dem `wicki.aero` liegt).

**a) Account-ID**
Links **Workers & Pages** → rechts steht «Account ID» → kopieren (brauchst Du in Schritt 4).

**b) D1-Datenbank**
**Workers & Pages → D1 SQL Database → Create database** → Name `s2ground` → Create.
Auf der Datenbank-Seite die **Database ID** kopieren.
Dann auf GitHub die Datei `worker/wrangler.toml` öffnen (Stift-Symbol «Edit»), die Zeile
`database_id = "REPLACE-WITH-YOUR-D1-DATABASE-ID"` durch die kopierte ID ersetzen → **Commit changes**.

**c) API-Token**
Oben rechts Profil → **My Profile → API Tokens → Create Token** → Vorlage **Edit Cloudflare Workers** →
*Use template*. Unter «Permissions» zusätzlich **Account · D1 · Edit** hinzufügen (+ Add more).
Account Resources: das eigene Konto; Zone Resources: `wicki.aero`. → **Continue to summary → Create Token**.
Den Token **sofort kopieren** (wird nur einmal angezeigt).

---

## 4. Die zwei Secrets auf GitHub eintragen

Im Repo: **Settings → Secrets and variables → Actions → New repository secret**

| Name | Wert |
|---|---|
| `CLOUDFLARE_API_TOKEN` | der Token aus 3c |
| `CLOUDFLARE_ACCOUNT_ID` | die Account-ID aus 3a |

Sonst nichts – es liegen keine Passwörter im Repository.

---

## 5. Erste Veröffentlichung inkl. Datenbank

1. Im Repo auf **Actions** → links **Deploy** → rechts **Run workflow** → Haken bei
   **«Apply worker/schema.sql …»** setzen → **Run workflow**.
2. Nach ca. 1–2 Minuten ist der Lauf grün. Der Worker heisst `s2ground` und ist unter
   **https://s2ground.wicki.aero** erreichbar (die Domain wird beim Deploy automatisch angelegt, weil
   `wicki.aero` im selben Cloudflare-Konto liegt). Falls die Adresse nicht funktioniert:
   Workers & Pages → `s2ground` → **Settings → Domains & Routes → Add → Custom domain** → `s2ground.wicki.aero`.
3. Ab jetzt genügt bei jeder Änderung (z. B. Text in `web/i18n/de.json`): Datei auf GitHub bearbeiten →
   Commit → nach 1–2 Minuten ist sie live. Den Haken «migrate» braucht es nur, wenn sich `schema.sql` ändert.

---

## 6. Erste Anmeldung (Masteruser)

https://s2ground.wicki.aero öffnen. Solange noch kein Benutzer existiert, zeigt die Anmeldeseite
**«Ersteinrichtung»**: Anmeldename (z. B. `bwicki`), Name, Passwort (mind. 6 Zeichen) → **Masteruser anlegen & anmelden**.
Danach ist diese Funktion abgeschaltet. Weitere Benutzer (Rollen *Bodenstation*, *Command Center*,
*Beobachter*, *Gast*) legst Du im Menü ☰ → **Masteruser · Benutzer & App-Einstellungen** an.
Dort auch: Standard-Frequenz, Steigrate, Cutdown-Vorgabe (3'000 m AGL), Wolken-Schwelle, Ablageordner, automatische Abmeldung, Schnellantworten.

### 6a. Lufträume (openAIP) freischalten – einmalig

Die Planung holt die Lufträume selbständig von openAIP. Dazu braucht der Worker einen API-Schlüssel:

1. https://www.openaip.net → anmelden → Konto → **API Keys** → Schlüssel kopieren (derselbe Schlüssel, der in
   s2planning hinterlegt ist, kann wiederverwendet werden).
2. In S2 Ground: Menü ☰ → **Masteruser · App-Einstellungen** → Feld **openAIP API-Schlüssel** → einfügen → Speichern.

Der Schlüssel bleibt auf dem Server (Cloudflare D1) und wird nie an den Browser geschickt. Die Antworten werden
pro Kartenausschnitt 24 h zwischengespeichert. Welche Kategorien als Konflikt zählen, steht im Feld
**Luftraum-Kategorien** (Vorgabe `P,R,D,CTR,TMA`; möglich zusätzlich `CTA,TMZ,ATZ,GLD`).
Fehlt der Schlüssel oder ist openAIP nicht erreichbar, bleibt Schritt 1 gelb mit dem Hinweis, DABS/NOTAM manuell zu prüfen.

### 6b. Zusammenspiel mit s2stueve

Beide Apps bleiben unabhängig (eigener Worker, eigene Daten). Einzige Verbindung: Der Knopf **«Follow sonde ascent»**
in s2stueve meldet sich mit einem S2-Ground-Login (Rolle *Command Center* oder *Beobachter*) beim S2-Ground-Worker an
(`POST /api/login`), holt die laufenden Aufstiege (`GET /api/ascents?active=1`) und verbindet sich mit dem Live-Kanal
(`/live/<id>`) – Telemetrie und Chat laufen dann direkt zwischen Bodenstation und s2stueve. Gäste ohne Login kommen mit
dem Follow-Code aus dem Menü ☰ hinein und dürfen im Chat schreiben. Die Anpassung von s2stueve (Follow-Modus) ist ein
eigener Schritt im Repo `bwicki/s2_stueve`.

---

## 7. Simulation (ohne Sonde üben)

* `https://s2ground.wicki.aero/?sim=1` → simulierte Sonde **und** eingebaute Mini-Datenbank
  (Anmeldung `bwicki` / `demo`); es wird nichts auf dem Server gespeichert.
* `https://s2ground.wicki.aero/?sim=1&api=1` → simulierte Sonde, aber echte Anmeldung/Live-Daten über den
  Worker – so sieht s2stueve den simulierten Aufstieg.
* Optionen anhängen: `&speed=20` (20× schneller; auch über die Knöpfe im schwarzen Balken), `&fast=1`
  (GPS-Fix nach 3 s statt 25 s), `&lost=1` (Funk geht im Abstieg verloren → Variante «Position geschätzt»),
  `&seed=7` (anderer Zufall).
* Ohne RR4-Unterstützung des Browsers (z. B. Firefox, Safari, Android) startet die App ebenfalls in der Simulation.

---

## 8. Browser und Hardware

| | Web Serial (RR4 am USB) | Bemerkung |
|---|---|---|
| Chrome / Edge, Windows-Laptop | **ja** | Empfohlen. Beim ersten «Verbinden» den COM-Port des RR4 wählen. |
| Chrome, Android-Pad | nein | Web Serial fehlt auf Android. Möglich wäre später ein WebUSB-Polyfill (USB-Seriell-Treiber in JavaScript) – **nur als Hinweis, nicht gebaut.** Bis dahin: Pad für Planung, Beobachtung und Bergung (QR-Code, Google Maps). |
| Firefox / Safari | nein | Nur Simulation. |

---

## 9. Dropbox-Ordner (Dateien je Aufstieg)

Die App schreibt pro Aufstieg drei Dateien, benannt `JJJJ-MM-TT_HHMM_<Sondennummer>`:
`.raw_flight_history.csv` (für s2stueve, exakt im Windsond-Format), `.sounding` (Rohprotokoll, replaybar),
`.kml` (Google Earth).

* **Chrome/Edge am Laptop:** Menü ☰ in Phase 2 → **Ordner wählen** → den Dropbox-Ordner
  (z. B. `Dropbox\S2 Ground\Aufstiege`) wählen und den Zugriff erlauben. Die Wahl wird im Browser gemerkt;
  beim nächsten Mal fragt Chrome nur noch kurz «Zugriff erlauben?». Die Dateien werden alle 5 s
  nachgeführt, Dropbox synchronisiert sie von allein. Der KML entsteht beim «Aufstieg abschliessen».
* **Android / andere Browser:** kein Ordnerzugriff möglich → **Dateien herunterladen** (Download-Ordner)
  bzw. beim Abschliessen automatisch als Downloads.
* Unabhängig davon gehen alle Daten live an den Worker; s2stueve kann den ganzen Aufstieg auch nachträglich holen.

---

## 10. Tests (für Entwickler)

```
node --test tests/*.test.js          # Dateiformate, Planung, Koordinaten, Simulation
node tests/smoke.mjs                 # Playwright: ganzer Ablauf in der Simulation, Screenshots in tests/shots/
```

---

## 11. Bekannte Lücken / TODO

* **Luftraumdaten** kommen live von openAIP (Abschnitt 6a); Untergrenzen «GND» werden mit der Startplatzhöhe angenähert,
  Lufträume sind nicht tagesaktuell aktiviert/deaktiviert – deshalb immer DABS/NOTAM prüfen. Ohne Schlüssel (und in der
  Simulation) werden Beispiel-Lufträume aus `web/src/data/airspaces.json` gezeigt.
* **Trajektorie** ist ein einfaches Modell (Open-Meteo-Windprofil, konstante Steig-/Sinkrate, flaches Gelände am Landepunkt).
* **Protokollmodul** (`web/src/protocol/`) ist aus der Windsond-Software abgeleitet, aber noch **nicht an echter Hardware geprüft** – die offenen Punkte stehen in `docs/protocol/ssp-windsond-protocol.md`, Abschnitt 8. Erster Test mit RR4 am Laptop: Menü ☰ → Protokoll anzeigen, Rohzeilen mitschneiden.
* **Dropsonde/Abwurf** ist vorbereitet, aber nicht getestet.
* Karten (OpenStreetMap, Esri) und QR-Code-Bibliothek werden von cdnjs/OSM geladen – im Feld braucht es Internet.
