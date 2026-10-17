// Laufzeit-Konfiguration der App (kein Build-Schritt – diese Datei wird direkt importiert).
//
// apiBase: Adresse des Cloudflare Workers (s2ground-api). Die App selbst liegt auf GitHub Pages
// (s2ground.wicki.aero); alle /api/*-Aufrufe und der Live-Kanal (/live/…) gehen an diese Adresse.
// Ändern: auf GitHub diese Datei öffnen → Stift «Edit» → Wert anpassen → Commit. Nach dem ersten
// Worker-Deploy steht die genaue Adresse im Cloudflare-Dashboard unter Workers & Pages → s2ground-api.
// WHY: GitHub Pages kann keine Server-Logik ausführen, deshalb sind App und API getrennt gehostet –
// genau wie bei ops.wicki.aero (briefing-api).
export const config = {
  apiBase: 'https://s2ground-api.balthasar.workers.dev',
};
