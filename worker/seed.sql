-- Optional seed: default app settings. The first MASTER USER is NOT seeded here (no password
-- hashes in the repo): the login page shows "Ersteinrichtung" while the users table is empty
-- and creates the master user through POST /api/setup (see README). Observer codes are created
-- by the master in the admin page (POST /api/observers), never seeded.
INSERT OR IGNORE INTO settings (key, value) VALUES ('app', '{"relayUrl":"","frequencyHz":433900000,"riseRate":2.5,"descentRate":5,"cloudRh":92,"defaultFolder":"…\\\\Dropbox\\\\S2 Ground\\\\Aufstiege\\\\","autoLogoutH":2,"rr4Usb":"","sondeTypes":"S2H3-R-B20 · S2H3-S-C1-B9","quickRepliesGround":["Verstanden","Ausgelöst ✓","Funk schwach","Gelandet"],"quickRepliesObserver":["Bitte jetzt auslösen","Weiter steigen lassen","Daten reichen"],"windFallbackDir":240,"windFallbackSpd":6}');
