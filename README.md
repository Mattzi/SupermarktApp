# Angebotsküche

Rezepte aus den aktuellen Supermarkt-Angeboten, sortiert nach Preis pro Portion.

- **App:** React + Vite als PWA (`src/`)
- **Server:** Node (`worker/server.ts`) mit der API unter `/api/*`, Daten in Postgres, Anmeldung über Authentik
  - `GET /api/offers?plz=38536&markets=…` – Lebensmittel-Angebote (marktguru, ALDI, EDEKA-App-Schnittstelle bzw. EDEKA-Prospekt per KI)
  - `POST /api/recipes` – Rezepte über OpenRouter
  - `GET /api/health` – Einstellungen und KI-Kosten
- **www.edeka.de** blockt Rechenzentren: diese Abrufe laufen über einen Tailscale-Proxy (`EDEKA_PROXY`, `worker/edeka-fetch.ts`)
- **Gemeinsame Typen:** `shared/types.ts`
- **Betrieb:** im k3s-Cluster (Repo `Mattzi/infra`, Ordner `components/supermarktapp`), Image baut die GitHub Action, siehe [`deploy/README.md`](deploy/README.md)

## Entwickeln

```bash
npm install
MOCK_API=1 npm run dev     # App mit Beispieldaten, ohne Backend
npm test                   # Tests für die Angebots-Aufbereitung
npm run typecheck
```

Mit echtem Backend lokal (ohne Anmeldung, Daten nur im Arbeitsspeicher, ohne `DATABASE_URL`):

```bash
OPENROUTER_API_KEY=… RECIPE_MODEL=deepseek/deepseek-v4.1-flash npm run dev:api
npm run dev                # zweites Terminal, leitet /api an Port 8080 weiter
```
