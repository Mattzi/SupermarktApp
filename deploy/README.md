# Betrieb der Angebotsküche

Die App läuft im k3s-Cluster auf dem eigenen Server (OVH). Die Konfiguration steht im Repo
**Mattzi/infra** (`components/supermarktapp`, Doku `docs/13-supermarktapp.md`). Dort ist auch
beschrieben, welche Tresor-Einträge gebraucht werden.

```
Browser ──HTTPS──▶ Traefik ──Forward Auth──▶ Authentik (auth.mattis-kraemer.de, Gruppe „Angebotsküche“)
                     │
                     └──▶ App (Node, dieses Repo) ──▶ Postgres (gemeinsame CloudNativePG-Instanz)
                            │  ├──▶ EDEKA-App-Schnittstelle, Blätterkatalog, marktguru, ALDI, OpenStreetMap
                            │  └──▶ OpenRouter (KI)
                            ▲
Relay zu Hause ──/relay/*──┘   (holt Seiten von www.edeka.de: GLN und Prospekt-Adresse je Markt)
```

## Neue Version ausrollen

1. Push auf `hetzner` (oder `main`) → die GitHub Action `publish` baut `ghcr.io/mattzi/supermarktapp:<commit>`.
2. Im infra-Repo in `components/supermarktapp/kustomization.yaml` unter `images:` den neuen Commit eintragen, pushen.
   ArgoCD rollt die neue Version innerhalb von ~3 Minuten aus.

## Relay zu Hause

www.edeka.de blockt Rechenzentren, auch den OVH-Server (geprüft 2026-11-18: 403 über beide IPv4-Adressen
und IPv6). Das Relay holt diese Seiten über deinen Heimanschluss. Es baut nur ausgehende Verbindungen auf,
du musst also keine Ports freigeben, und es lädt nur Seiten unter `https://www.edeka.de/maerkte/`.

Auf dem Gerät zu Hause (Pi, NAS, PC mit Docker), im Ordner `relay/`:
```bash
RELAY_TOKEN=<Passwort aus dem Tresor-Eintrag "supermarktapp"> docker compose up -d --build
```
Kontrolle: `https://app.mattis-kraemer.de/api/debug/edeka?market=<Markt-ID>` zeigt unter `relay.lastSeen`,
wann sich das Relay zuletzt gemeldet hat, und unter `gln` das Ergebnis.

### Ablauf je Markt

1. Jemand wählt den Markt in der App aus → der Server legt Relay-Aufträge an (GLN, Prospekt-Adresse).
2. Das Relay liefert die Seiten → GLN und Blätterkatalog-Adresse werden gespeichert.
3. Der Zeitplan (alle 30 Minuten) prüft die App-Schnittstelle:
   - **eigener Prospekt** (`national=false`) → fertig, keine KI.
   - **nur bundesweit** → der Prospekt wird einmal pro Woche per KI aus den Seitenbildern gelesen
     (höchstens `EXTRACT_PER_WEEK` pro Woche für alle Märkte zusammen).

## EDEKA-App-Schnittstelle

Die Zugangsdaten der EDEKA-App (`client_credentials`) stehen öffentlich im Quelltext von
[edekompile](https://github.com/ByteSizedMarius/edekompile) (`pkg/offers.go`: `offersClientID`, `offersClientSecret`).
Sie gehören in den Tresor-Eintrag `supermarktapp` (Felder `edeka-client-id`, `edeka-client-secret`).
Das ist ein nachgebauter App-Zugang: EDEKA kann ihn jederzeit ändern. Dann fällt die App automatisch
auf den Prospekt-Weg (KI) zurück.

## KI-Budget pro Konto

In Authentik am Nutzer oder an der Gruppe „Angebotsküche“ das Attribut setzen (US-Dollar pro Tag):
```yaml
ki_budget_tag_usd: 0.10
```
Authentik schickt es als Kopfzeile `X-Ki-Budget-Tag` mit (Scope-Mapping per Blueprint im infra-Repo).
Ohne Attribut gilt `DAILY_USER_BUDGET_USD`. Prüfen: In der App unter Märkte → „KI-Kosten“.

## KI-Modelle vergleichen

```bash
kubectl -n supermarktapp exec deploy/supermarktapp -- \
  node dist-server/compare.mjs MINDEN/8011165 deepseek/deepseek-v4.1-flash <gemini-flash-modell> > vergleich.html
```
`MINDEN/8011165` ist die Blätterkatalog-Adresse eines Markts (steht nach dem Relay unter `/api/debug/edeka`).
Das bessere Modell dann im infra-Repo als `EXTRACT_MODEL` eintragen (`components/supermarktapp/deployment.yaml`).

## Prüfen, was vom Server aus erreichbar ist

`https://app.mattis-kraemer.de/api/debug/sources` fragt EDEKA, marktguru, ALDI Nord/SÜD und OpenStreetMap ab.

## Lokal entwickeln

Siehe [README](../README.md). Für die Compose-Variante (Caddy, eigenes Authentik/Postgres) siehe die Git-Historie
vor dem Umzug in den Cluster.
