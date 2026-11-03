# Angebotsküche auf dem eigenen Server

Alles läuft in einer Docker Compose: **Caddy** (HTTPS), **Authentik** (Anmeldung, nur freigegebene Nutzer), **Postgres** (Daten von Authentik und App) und die **App**.
Dazu kommt ein kleines **Relay** an einem privaten Internetanschluss, weil www.edeka.de Rechenzentren blockt.

```
Browser ──HTTPS──▶ Caddy ──forward_auth──▶ Authentik
                     │
                     └──▶ App (Node) ──▶ Postgres
                            │  ├──▶ EDEKA-App-Schnittstelle, Blätterkatalog, marktguru, ALDI, OpenStreetMap
                            │  └──▶ OpenRouter (KI)
                            ▲
Relay zu Hause ──/relay/*──┘   (holt Seiten von www.edeka.de: GLN und Prospekt-Adresse je Markt)
```

## 1. Server einrichten

1. DNS: `app.mattis-kraemer.de` und `auth.mattis-kraemer.de` als A/AAAA-Eintrag auf den Server.
2. Im Ordner `deploy/`:
   ```bash
   cp .env.example .env
   ```
   Ausfüllen. Geheime Werte erzeugen mit:
   ```bash
   openssl rand -base64 36 | tr -d '\n'
   ```
   Pflicht: `ACME_EMAIL`, `AUTHENTIK_DB_PASSWORD`, `APP_DB_PASSWORD`, `AUTHENTIK_SECRET_KEY`, `RELAY_TOKEN`, `OPENROUTER_API_KEY`, `RECIPE_MODEL`, SMTP-Daten.
3. Starten:
   ```bash
   docker compose up -d --build
   ```
   Beim allerersten Start legt Postgres zusätzlich die Datenbank `angebotskueche` an (`initdb/10-app-db.sh`).
   **Wichtig:** Das passiert nur, wenn `deploy/postgres/` noch leer ist.

Updates der App: `git pull`, dann `docker compose up -d --build app`.

## 2. Authentik einrichten

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

## 3. EDEKA

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

## 4. KI-Modelle vergleichen

Für die Prospekte muss das Modell Bilder lesen und Koordinaten für die Bildausschnitte liefern. Vergleich an einem echten Prospekt:

```bash
docker compose run --rm app node dist-server/compare.mjs MINDEN/8011165 deepseek/deepseek-v4.1-flash <gemini-flash-modell> > vergleich.html
```

`MINDEN/8011165` ist die Blätterkatalog-Adresse eines Markts (steht nach dem Relay unter `/api/debug/edeka`, Feld `idx` bzw. `prospekte`).
Die genauen Modellnamen stehen auf https://openrouter.ai/models. Die `vergleich.html` zeigt je Modell Anzahl, Kosten, Dauer und die Bildausschnitte.
Das bessere Modell dann als `EXTRACT_MODEL` in die `.env` eintragen und `docker compose up -d app` ausführen.

## 5. Prüfen, was vom Server aus erreichbar ist

`https://app.mattis-kraemer.de/api/debug/sources` fragt EDEKA, marktguru, ALDI Nord/SÜD und OpenStreetMap ab und zeigt die Statuscodes.

## Daten sichern

Alles Wichtige liegt in `deploy/postgres/` (Authentik und App) und `deploy/authentik/`. Ein Dump der App-Daten:
```bash
docker compose exec postgresql pg_dump -U authentik angebotskueche > angebotskueche.sql
```
