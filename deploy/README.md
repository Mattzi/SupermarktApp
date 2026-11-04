# Angebotsküche auf dem eigenen Server

Alles läuft in einer Docker Compose: **Caddy** (HTTPS), **Authentik** (Anmeldung, nur freigegebene Nutzer), **Postgres** (Daten von Authentik und App) und die **App**.
Davor sitzt **Cloudflare** als DNS-Proxy (orange Wolke): Die Besucher sehen nur Cloudflare, die Hetzner-IP bleibt verborgen.
Dazu kommt ein kleines **Relay** an einem privaten Internetanschluss, weil www.edeka.de Rechenzentren blockt.

```
Browser ──HTTPS──▶ Cloudflare ──HTTPS (Origin-Zertifikat)──▶ Caddy ──forward_auth──▶ Authentik
                     │
                     └──▶ App (Node) ──▶ Postgres
                            │  ├──▶ EDEKA-App-Schnittstelle, Blätterkatalog, marktguru, ALDI, OpenStreetMap
                            │  └──▶ OpenRouter (KI)
                            ▲
Relay zu Hause ──/relay/*──┘   (holt Seiten von www.edeka.de: GLN und Prospekt-Adresse je Markt)
```

## 1. Cloudflare einrichten

1. **DNS** (Zone `mattis-kraemer.de`): `app` und `auth` als A-Eintrag (und AAAA, falls der Server IPv6 hat) auf die Hetzner-IP, beide **mit oranger Wolke** (Proxied).
2. **SSL/TLS → Overview:** Modus **Full (strict)**.
3. **SSL/TLS → Edge Certificates:** „Always Use HTTPS“ an. „Minimum TLS Version“ 1.2.
4. **SSL/TLS → Origin Server → Create Certificate:**
   - Hostnamen: `mattis-kraemer.de` und `*.mattis-kraemer.de`, Gültigkeit 15 Jahre, Format PEM.
   - Das Zertifikat auf dem Server als `deploy/certs/origin.pem` speichern, den privaten Schlüssel als `deploy/certs/origin.key`. Der Schlüssel wird nur einmal angezeigt.
   - Dieses Zertifikat gilt nur zwischen Cloudflare und dem Server, Browser kennen es nicht. Deshalb funktioniert die Seite nur mit oranger Wolke.
   - `chmod 644 certs/origin.pem certs/origin.key` (Caddy läuft im Container und muss beide lesen können). Den Ordner `certs/` sonst niemandem zugänglich machen.
5. **Relay nicht ausbremsen:** Das Relay ist ein Programm, kein Browser. Cloudflares Bot-Schutz könnte es mit einer Prüfseite aufhalten.
   - **Security → Bots:** „Bot Fight Mode“ **aus**. Im Gratis-Tarif lässt er sich nicht auf einzelne Pfade beschränken.
   - **Security → WAF → Custom rules → Create rule:** Name `Relay`, Bedingung *URI Path* *starts with* `/relay/`, Aktion **Skip** → alle übrigen Custom Rules, Rate Limiting, „Browser Integrity Check“. Den Schutz übernimmt der `RELAY_TOKEN`.
6. **Caching → Cache Rules → Create rule:** Name `Kein Cache für API`, Bedingung *URI Path* *starts with* `/api/` **oder** *starts with* `/relay/` **oder** *starts with* `/outpost.goauthentik.io/`, Aktion **Bypass cache**.
   Die App schickt passende `cache-control`-Kopfzeilen mit, die Regel ist eine zusätzliche Sicherung. Dateien unter `/assets/` darf Cloudflare ruhig zwischenspeichern, sie haben einen Hash im Namen.

**Zeitlimit:** Cloudflare bricht Anfragen nach 100 Sekunden ab (Fehler 524, im Gratis-Tarif nicht änderbar). Normale Rezeptanfragen dauern 30–70 Sekunden.
Wenn ein langsames Modell öfter darüber liegt, für `RECIPE_MODEL` ein schnelleres Modell nehmen. Das Einlesen von Prospekten von Hand ist nicht betroffen, weil die App dabei laufend Fortschrittspunkte schickt.

**Nicht verwechseln:** Cloudflare schützt nur den Weg **zum** Server. Anfragen **vom** Server, z. B. an EDEKA oder ALDI, kommen weiterhin von der Hetzner-IP. Das Relay bleibt also nötig.

## 2. Server einrichten

1. **Hetzner-Firewall** (Cloud Console → Firewalls, dem Server zuweisen):
   - Eingehend **TCP 443 nur von den Cloudflare-Adressen** (Liste: https://www.cloudflare.com/ips/, IPv4 und IPv6).
   - Dazu SSH (TCP 22), am besten nur von deiner IP.
   - Port 80 braucht es nicht: Die Umleitung auf HTTPS macht Cloudflare.
   - So kann niemand Cloudflare umgehen und den Server direkt ansprechen. Die gleiche Adressliste steht auch im `Caddyfile` (`trusted_proxies`). Ändert Cloudflare sie, beides anpassen.
2. Im Ordner `deploy/`:
   ```bash
   cp .env.example .env
   ```
   Ausfüllen. Geheime Werte erzeugen mit:
   ```bash
   openssl rand -base64 36 | tr -d '\n'
   ```
   Pflicht: `AUTHENTIK_DB_PASSWORD`, `APP_DB_PASSWORD`, `AUTHENTIK_SECRET_KEY`, `RELAY_TOKEN`, `OPENROUTER_API_KEY`, `RECIPE_MODEL`, SMTP-Daten.
3. Origin-Zertifikat liegt in `certs/` (siehe Abschnitt 1, Schritt 4).
4. Starten:
   ```bash
   docker compose up -d --build
   ```
   Beim allerersten Start legt Postgres zusätzlich die Datenbank `angebotskueche` an (`initdb/10-app-db.sh`).
   **Wichtig:** Das passiert nur, wenn `deploy/postgres/` noch leer ist.
5. Prüfen: `https://auth.mattis-kraemer.de` zeigt Authentik, `https://app.mattis-kraemer.de` leitet zur Anmeldung um.
   Bei Fehler **526** passt das Zertifikat nicht (Datei, Hostname). Bei **521/522** ist Caddy nicht erreichbar (Firewall, Container läuft nicht: `docker compose logs caddy`).

Updates der App: `git pull`, dann `docker compose up -d --build app`.

## 3. Authentik einrichten

1. `https://auth.mattis-kraemer.de/if/flow/initial-setup/` öffnen und das Admin-Konto anlegen.
2. **Provider** → *Create* → **Proxy Provider**
   - Name: `Angebotsküche`
   - Authorization flow: `default-provider-authorization-implicit-consent`
   - Modus: **Forward auth (single application)**
   - External host: `https://app.mattis-kraemer.de`
   - Token validity: z. B. `days=30` (so bleibt man auf dem Handy angemeldet)
3. **Application** → *Create*: Name `Angebotsküche`, Slug `angebotskueche`, Provider `Angebotsküche`.
4. **Outposts** → *authentik Embedded Outpost* → bearbeiten → die Application `Angebotsküche` hinzufügen.
5. **Nur freigegebene Leute:**
   - Gruppe `angebotskueche` anlegen.
   - Bei der Application unter *Policy / Group / User Bindings* die Gruppe `angebotskueche` binden. Dann kommt nur rein, wer in der Gruppe ist.
   - Neue Leute: unter *Directory → Users* anlegen und in die Gruppe stecken. Oder per **Einladung**: einen Enrollment-Flow mit Invitation-Stage anlegen (Authentik-Doku „Invitations“) und den Einladungslink verschicken. Der Flow sollte die Nutzer am Ende in die Gruppe `angebotskueche` aufnehmen.
   - Die offene Selbstregistrierung **nicht** aktivieren.
6. **KI-Budget pro Konto** (US-Dollar pro Tag):
   - Attribut an der Gruppe (gilt für alle Mitglieder) oder am Nutzer (überschreibt die Gruppe), z. B.:
     ```yaml
     ki_budget_tag_usd: 0.10
     ```
   - *Customization → Property Mappings* → *Create* → **Scope Mapping**, Name `Angebotsküche: KI-Budget`, Scope name `ak_proxy`, Ausdruck:
     ```python
     budget = request.user.group_attributes().get("ki_budget_tag_usd", "")
     return {
         "ak_proxy": {
             "user_attributes": {
                 "additionalHeaders": {
                     "X-Ki-Budget-Tag": str(budget),
                 }
             }
         }
     }
     ```
   - Im Proxy Provider unter *Advanced protocol settings → Scopes* dieses Mapping zusätzlich auswählen.
   - Ohne Attribut gilt `DAILY_USER_BUDGET_USD` aus der `.env`.
   - Prüfen: In der App unter Märkte → „KI-Kosten“ steht „Dein Budget heute: … von …“.

## 4. EDEKA

### App-Schnittstelle

Die App fragt zuerst die Schnittstelle der EDEKA-App ab. Liefert sie für einen Markt den eigenen Prospekt (`national=false`), braucht es keine KI.
Für die Anmeldung braucht sie die Zugangsdaten der App (`client_credentials`). Die stehen öffentlich im Quelltext von
[edekompile](https://github.com/ByteSizedMarius/edekompile) (`pkg/offers.go`: `offersClientID`, `offersClientSecret`).
Trag sie als `EDEKA_APP_CLIENT_ID` und `EDEKA_APP_CLIENT_SECRET` in die `.env` ein. Das ist ein nachgebauter App-Zugang: EDEKA kann ihn jederzeit ändern.
Dann fällt die App automatisch auf den Prospekt-Weg (KI) zurück.

### Relay zu Hause

Für jeden neu gewählten Markt braucht der Server einmal die **GLN** (für die App-Schnittstelle) und die **Blätterkatalog-Adresse** (für den Prospekt).
Beides steht nur auf www.edeka.de. Das Relay holt diese Seiten über deinen Heimanschluss. Es baut nur ausgehende Verbindungen auf, du musst also keine Ports freigeben, und es lädt nur Seiten unter `https://www.edeka.de/maerkte/`.

Auf dem Gerät zu Hause (Pi, NAS, PC mit Docker), im Ordner `relay/`:
```bash
RELAY_TOKEN=<gleicher Wert wie in deploy/.env> docker compose up -d --build
```
Kontrolle: `https://app.mattis-kraemer.de/api/debug/edeka?market=<Markt-ID>` zeigt unter `relay.lastSeen`, wann sich das Relay zuletzt gemeldet hat, und unter `gln` das Ergebnis.

### Ablauf je Markt

1. Jemand wählt den Markt in der App aus → der Server legt Relay-Aufträge an (GLN, Prospekt-Adresse).
2. Das Relay liefert die Seiten → GLN und Blätterkatalog-Adresse werden gespeichert.
3. Der Zeitplan (alle 30 Minuten) prüft die App-Schnittstelle:
   - **eigener Prospekt** (`national=false`) → fertig, keine KI.
   - **nur bundesweit** → der Prospekt wird einmal pro Woche per KI aus den Seitenbildern gelesen (höchstens `EXTRACT_PER_WEEK` pro Woche für alle Märkte zusammen).

## 5. KI-Modelle vergleichen

Für die Prospekte muss das Modell Bilder lesen und Koordinaten für die Bildausschnitte liefern. Vergleich an einem echten Prospekt:

```bash
docker compose run --rm app node dist-server/compare.mjs MINDEN/8011165 deepseek/deepseek-v4.1-flash <gemini-flash-modell> > vergleich.html
```

`MINDEN/8011165` ist die Blätterkatalog-Adresse eines Markts (steht nach dem Relay unter `/api/debug/edeka`, Feld `idx` bzw. `prospekte`).
Die genauen Modellnamen stehen auf https://openrouter.ai/models. Die `vergleich.html` zeigt je Modell Anzahl, Kosten, Dauer und die Bildausschnitte.
Das bessere Modell dann als `EXTRACT_MODEL` in die `.env` eintragen und `docker compose up -d app` ausführen.

## 6. Prüfen, was vom Server aus erreichbar ist

`https://app.mattis-kraemer.de/api/debug/sources` fragt EDEKA, marktguru, ALDI Nord/SÜD und OpenStreetMap ab und zeigt die Statuscodes.

## Daten sichern

Alles Wichtige liegt in `deploy/postgres/` (Authentik und App) und `deploy/authentik/`. Ein Dump der App-Daten:
```bash
docker compose exec postgresql pg_dump -U authentik angebotskueche > angebotskueche.sql
```
