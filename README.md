# S2 Ground – s2ground.wicki.aero

Bodenstations-App für den Sondenstart mit Windsond S2 / Empfänger RR4 (Wicki Partners Ballonteam).
Fünf Phasen: **Aufstieg planen · Sonde vorbereiten · Start-Checks · Aufstieg · Sonde bergen**.
Läuft komplett im Browser (Chrome oder Edge), die Daten gehen über einen Cloudflare Worker live an
s2stueve.wicki.aero (Beobachter, z. B. Command Center) – und zusätzlich als Dateien in einen Dropbox-Ordner.

Es ist **kein Entwicklerwerkzeug nötig**: Alles wird über die GitHub-Website und das Cloudflare-Dashboard
eingerichtet. Jede Änderung, die auf GitHub im Zweig `main` landet, wird automatisch veröffentlicht
(App über GitHub Pages, Worker über GitHub Actions).

---

## 1. Was ist wo?

| Ordner / Datei | Inhalt |
|---|---|
| `index.html`, `css/`, `i18n/`, `img/`, `src/` | Die App selbst (eine Seite) – liegt direkt im Hauptverzeichnis, weil GitHub Pages genau dieses Verzeichnis veröffentlicht. Sprachen in `i18n/de.json` und `en.json` |
| `src/config.js` | **Adresse des Workers (`apiBase`)** – die einzige Stelle, die nach dem Worker-Deploy stimmen muss |
| `src/sim/sim-link.js` | Simulierte Sonde (Rümlang, Aufstieg → Cutdown → Landung) für Übung und Tests |
| `src/protocol/` | Anbindung an RR4/S2 über USB (Web Serial); ohne angeschlossenen RR4 läuft die Simulation |
| `CNAME` | Die Domain für GitHub Pages (`s2ground.wicki.aero`) |
| `worker/` | Cloudflare Worker `s2ground-api`: Anmeldung, Benutzer, Beobachter-Codes, Protokoll, Live-Daten/Chat, WhatsApp-Nachricht |
| `worker/schema.sql` | Datenbankstruktur (D1) – einmalig einspielen, siehe Schritt 5 |
| `.github/workflows/deploy.yml` | Veröffentlicht den Worker, sobald sich etwas unter `worker/` ändert |
| `.github/workflows/tests.yml` | Automatische Tests bei jeder Änderung |
| `tests/` | Automatische Tests |
| `docs/` | Protokollspezifikation, Schnittstellenvertrag, Logo |
| `design/` | Die freigegebenen Design-Boards |

**Hosting – gleiches Muster wie ops.wicki.aero:** Die App ist eine statische Seite auf **GitHub Pages**
(aus dem Hauptverzeichnis des Zweigs `main`), der Worker läuft auf **workers.dev**
(`https://s2ground-api.balthasar.workers.dev`). Die App findet den Worker über `src/config.js`;
der Worker lässt nur die in `worker/wrangler.toml` (`APP_ORIGINS`) eingetragenen Adressen zu.

---

## 2. GitHub-Repository anlegen (nur Browser)

1. Auf https://github.com anmelden → oben rechts **+** → **New repository**.
2. Name `s2ground`, **Private**, *ohne* README/Lizenz anklicken → **Create repository**.
3. Auf der leeren Repo-Seite den Link **uploading an existing file** anklicken.
4. Den **Inhalt** des Ordners `s2ground` (alles, inkl. `.github` und `CNAME`) per Drag & Drop ins
   Browserfenster ziehen – ganze Ordner sind erlaubt. Falls der versteckte Ordner `.github` nicht
   mitkommt: im Explorer «Ausgeblendete Elemente» einschalten und nochmals ziehen.
5. Unten **Commit changes** (Zweig `main`).

> Hinweis: GitHub Pages funktioniert bei privaten Repos nur mit GitHub Pro/Team – sonst das Repo auf
> **Public** stellen (es liegen keine Passwörter oder Schlüssel darin).

---

## 2a. GitHub Pages einschalten (App veröffentlichen)

1. Im Repo **Settings → Pages**.
2. Unter «Build and deployment»: **Source = Deploy from a branch**, Branch **`main`**, Ordner **`/ (root)`** → **Save**.
3. Unter «Custom domain» steht nach kurzer Zeit `s2ground.wicki.aero` (kommt aus der Datei `CNAME`).
   Falls das Feld leer ist: `s2ground.wicki.aero` eintragen → **Save**. Bei Cloudflare (DNS von `wicki.aero`)
   braucht es einen **CNAME-Eintrag** `s2ground` → `bwicki.github.io` (Proxy-Status «DNS only», grau).
4. Warten, bis der «DNS check» grün ist, dann **Enforce HTTPS** anhaken.
5. Ab jetzt ist jede Änderung an `main` nach 1–2 Minuten unter **https://s2ground.wicki.aero** live
   (Ersatzadresse: `https://bwicki.github.io/s2ground/`).

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
Account Resources: das eigene Konto. → **Continue to summary → Create Token**.
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

## 5. Worker veröffentlichen inkl. Datenbank

1. Im Repo auf **Actions** → links **Deploy worker** → rechts **Run workflow** → Haken bei
   **«Apply worker/schema.sql …»** setzen → **Run workflow**.
2. Nach ca. 1–2 Minuten ist der Lauf grün. Der Worker heisst `s2ground-api` und ist unter
   **https://s2ground-api.balthasar.workers.dev** erreichbar (Kontrolle: Workers & Pages → `s2ground-api`
   → dort steht die Adresse; `/api/health` muss `{"ok":true}` liefern).
3. Stimmt die Adresse nicht mit `src/config.js` überein (anderer Konto-Name als `balthasar`): die Datei
   auf GitHub bearbeiten, `apiBase` anpassen → Commit. GitHub Pages übernimmt es automatisch.
4. Ab jetzt wird der Worker nur noch neu veröffentlicht, wenn sich etwas unter `worker/` ändert.
   Den Haken «migrate» braucht es nur, wenn sich `schema.sql` ändert.

**Datenbank / Migration:** Vor dieser Version war nichts veröffentlicht – `schema.sql` ist deshalb das
frische Schema (Benutzer mit Masteruser-Flag statt Rollen, neue Tabellen `observers` und `observer_logins`).
Eine bestehende Datenbank mit der alten `users.role`-Spalte müsste gelöscht und neu angelegt werden
(D1 → Datenbank → Delete, dann Schritt 3b und 5 wiederholen).

---

## 6. Erste Anmeldung (Masteruser) und Zugänge

https://s2ground.wicki.aero öffnen. Solange noch kein Benutzer existiert, zeigt die Anmeldeseite
**«Ersteinrichtung»**: Anmeldename (z. B. `bwicki`), Name, Passwort (mind. 6 Zeichen) → **Masteruser anlegen & anmelden**.
Danach ist diese Funktion abgeschaltet.

Es gibt nur **zwei Arten von Personen**:

| | Anmeldung | darf |
|---|---|---|
| **Bodenstation (Ground-Benutzer)** | Anmeldename + Passwort in S2 Ground | alles bedienen: Aufstieg, Sonde, Cutdown, Chat, Beobachter entfernen. Mit Schalter **Masteruser** zusätzlich: Benutzer, Beobachter-Codes, App-Einstellungen, Protokoll |
| **Beobachter** | kein Passwort – persönlicher **8-stelliger Zugangscode** (z. B. `7K2M4QX9`) in s2stueve → «Follow sonde ascent», dazu wählt er einen **Klarnamen**, der im Chat erscheint | alles sehen, im Chat schreiben und Anweisungen geben («Bitte jetzt auslösen»). Keine Hardware-Aktionen. |

Beides verwaltest Du im Menü ☰ → **Masteruser · Benutzer & App-Einstellungen**:
* **Benutzer**: Anmeldename, Name, Passwort, Schalter *Masteruser* und *Aktiv*, letzte Anmeldung.
* **Beobachter · Zugangscodes**: Bezeichnung (z. B. «Command Center»), Mobile-Nummer, WhatsApp-Haken →
  **Code erzeugen**. Der Code erscheint einmal gross im Dialog (Kopieren / «Code per WhatsApp senden») und
  bleibt auch in der Tabelle sichtbar. Codes sind unbegrenzt viele möglich, jederzeit **widerrufbar** (der
  Beobachter fliegt sofort raus) und **reaktivierbar**; **Verlauf** zeigt jede Anmeldung mit Zeit, Klarname, IP und Gerät.
* Während eines Aufstiegs zeigt Phase 2 die verbundenen Beobachter mit Klarnamen; mit **✕** entfernt die
  Bodenstation einen Beobachter (Verbindung getrennt, für diesen Aufstieg gesperrt – der Code bleibt gültig).
* Ausserdem: Standard-Frequenz, Steigrate, Cutdown-Vorgabe (3'000 m AGL), Wolken-Schwelle, Ablageordner, automatische Abmeldung, Schnellantworten.

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
in s2stueve fragt Zugangscode und Klarnamen ab (`POST /api/observer/login`), holt die laufenden Aufstiege
(`GET /api/ascents?active=1`) und verbindet sich mit dem Live-Kanal (`/live/<id>`) – Telemetrie und Chat laufen
dann direkt zwischen Bodenstation und s2stueve. Beobachter dürfen im Chat schreiben; Telemetrie oder
Hardware-Befehle aus s2stueve weist der Worker ab. Die Anpassung von s2stueve (Follow-Modus mit Code + Klarname)
ist ein eigener Schritt im Repo `bwicki/s2_stueve` – die Schnittstelle steht in `docs/INTERFACE.md` §4.

### 6c. WhatsApp-Benachrichtigung der Beobachter

Beim Anlegen eines Beobachters kannst Du eine Mobile-Nummer (international, z. B. `+41 79 123 45 67`) eintragen und
den Haken **«per WhatsApp über neue Aufstiege informieren»** setzen. Sobald in Phase 2 die Live-Sitzung entsteht,
baut der Worker für jeden solchen Beobachter die Standardnachricht:

```
Sondenaufstieg geplant (S2 Ground)
Start: 17.10.2026 14:30 LT
Startort: Rümlang · 4727N00834E
Cutdown: 3'000 m AGL
Frequenz: 433.900 MHz
Sonde: 12345
Folgen: https://s2stueve.wicki.aero → Follow sonde ascent · Dein Code: 7K2M4QX9
```

* **Stufe 1 (funktioniert sofort, keine Konten nötig):** Phase 2 zeigt die Karte **«Beobachter benachrichtigen
  (WhatsApp)»** mit einem Knopf je Beobachter. Der Knopf öffnet WhatsApp (Desktop/Web/Handy) mit der fertigen
  Nachricht an die Nummer – Du drückst nur noch «Senden». Jeder Klick wird im Protokoll vermerkt.
* **Stufe 2 (vorbereitet, noch nicht freigegeben):** automatischer Versand über die **Meta WhatsApp Cloud API**.
  Dafür braucht es ein **Meta-Business-Konto** mit WhatsApp-Business-Plattform, die **Phone Number ID** der
  Absendernummer und einen **permanenten Zugriffstoken** (System-User-Token). Beides in den App-Einstellungen
  eintragen (werden nur auf dem Server gespeichert, wie der openAIP-Schlüssel). Dann schickt der Worker die
  Nachricht beim Anlegen der Live-Sitzung selbst und die Karte zeigt «automatisch gesendet».
  **Wichtig:** Ausserhalb eines 24-h-Gesprächsfensters (der Beobachter hat Dir nicht in den letzten 24 h
  geschrieben) akzeptiert Meta nur **vorab genehmigte Vorlagen (Templates)**. Freitext wird abgelehnt – dann
  bleibt die Karte bei Stufe 1 («bitte manuell»). Die Vorlage muss im Meta-Business-Manager eingereicht und
  in `worker/src/whatsapp.js` als Template-Nachricht hinterlegt werden; das ist der noch offene Schritt.

---

## 7. Simulation (ohne Sonde üben)

* `https://s2ground.wicki.aero/?sim=1` → simulierte Sonde **und** eingebaute Mini-Datenbank
  (Anmeldung `bwicki` / `demo` als Masteruser, `crew1` / `demo` als Bodenstation; Beobachter-Codes `7K2M4QX9`
  «Command Center» und `B8R4TZ6W` «Crew Bergung»); es wird nichts auf dem Server gespeichert.
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
node --test tests/*.test.js tests/protocol/*.test.js   # Dateiformate, Planung, Koordinaten, Simulation, Protokoll, Worker-Helfer
node tests/smoke.mjs                                   # Playwright: ganzer Ablauf in der Simulation, Screenshots in tests/shots/
```
Lokal ausprobieren: irgendein statischer Webserver im Hauptverzeichnis (z. B. `npx serve -l 8080 .`) und
`http://localhost:8080/?sim=1` öffnen – `localhost:8080` steht in der CORS-Liste des Workers.

---

## 11. Bekannte Lücken / TODO

* **Luftraumdaten** kommen live von openAIP (Abschnitt 6a); Untergrenzen «GND» werden mit der Startplatzhöhe angenähert,
  Lufträume sind nicht tagesaktuell aktiviert/deaktiviert – deshalb immer DABS/NOTAM prüfen. Ohne Schlüssel (und in der
  Simulation) werden Beispiel-Lufträume aus `src/data/airspaces.json` gezeigt.
* **Trajektorie** ist ein einfaches Modell (Open-Meteo-Windprofil, konstante Steig-/Sinkrate, flaches Gelände am Landepunkt).
* **Protokollmodul** (`src/protocol/`) ist aus der Windsond-Software abgeleitet, aber noch **nicht an echter Hardware geprüft** – die offenen Punkte stehen in `docs/protocol/ssp-windsond-protocol.md`, Abschnitt 8. Erster Test mit RR4 am Laptop: Menü ☰ → Protokoll anzeigen, Rohzeilen mitschneiden.
* **Dropsonde/Abwurf** ist vorbereitet, aber nicht getestet.
* Karten (OpenStreetMap, Esri) und QR-Code-Bibliothek werden von cdnjs/OSM geladen – im Feld braucht es Internet.
* **WhatsApp Stufe 2** (automatischer Versand) wartet auf Meta-Business-Konto und genehmigte Vorlage (Abschnitt 6c).
* **s2stueve Follow-Modus** muss auf Code + Klarname umgestellt werden (eigenes Repo).
