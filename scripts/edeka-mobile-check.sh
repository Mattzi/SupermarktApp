#!/usr/bin/env bash
# Prüft, ob die EDEKA-Schnittstellen von diesem Rechner aus erreichbar sind:
#   1. Website-Marktsuche (www.edeka.de) – die blockt Cloudflare
#   2. App-Schnittstelle (b2b-login.api.edeka + b2c-gw.api.edeka), wie in edekompile
#
# Aufruf: ./edeka-mobile-check.sh [PLZ] [GLN]
#   PLZ  für die Marktsuche (Standard 38536)
#   GLN  13-stellige Marktnummer; ohne Angabe wird der erste Markt aus der Marktsuche genommen
# Braucht: curl, jq
set -uo pipefail

PLZ="${1:-38536}"
GLN="${2:-}"
UA_BROWSER='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36'
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for bin in curl jq; do
  command -v "$bin" >/dev/null || { echo "Fehlt: $bin (apt install $bin)"; exit 1; }
done

echo "Öffentliche IP: $(curl -s --max-time 5 https://api.ipify.org || echo unbekannt)"
echo

echo "== 1. Website-Marktsuche (www.edeka.de) =="
code=$(curl -s -o "$TMP/markets.json" -w '%{http_code}' --max-time 15 \
  -H "user-agent: $UA_BROWSER" -H 'accept: application/json' -H 'accept-language: de-DE,de;q=0.9' \
  -H 'referer: https://www.edeka.de/' \
  "https://www.edeka.de/api/marketsearch/markets?searchstring=$PLZ")
if [ "$code" = 200 ] && jq -e '.markets' "$TMP/markets.json" >/dev/null 2>&1; then
  echo "OK ($code), $(jq '.markets | length' "$TMP/markets.json") Märkte"
  jq -r '.markets[:5][] | "  id=\(.id)  \(.name), \(.contact.address.city.name // "")"' "$TMP/markets.json"
  if [ -z "$GLN" ]; then
    GLN=$(jq -r '.markets[0].id' "$TMP/markets.json")
    echo "  → teste mit id=$GLN als GLN (prüft nebenbei, ob die id der Marktsuche die GLN ist)"
  fi
else
  echo "GEBLOCKT oder Fehler (HTTP $code): $(head -c 200 "$TMP/markets.json" | tr '\n' ' ')"
fi
echo

GLN="${GLN:-4314021182307}" # Beispielmarkt aus der edekompile-README

echo "== 2. App-Schnittstelle: ohne Token (erwartet 401 = erreichbar) =="
code=$(curl -s -o "$TMP/noauth.txt" -w '%{http_code}' --max-time 15 \
  "https://b2c-gw.api.edeka/v2/offers/mobile?marketGln=$GLN&page=0&size=1&sortedByCategory=true")
echo "HTTP $code $( [ "$code" = 401 ] && echo '(gut: erreichbar, will nur Anmeldung)' )"
echo

echo "== 3. App-Schnittstelle: Token holen =="
# Zugangsdaten der App aus dem edekompile-Quelltext lesen
src=$(curl -s --max-time 15 https://raw.githubusercontent.com/ByteSizedMarius/edekompile/main/pkg/offers.go)
CID=$(grep -oP 'offersClientID\s*=\s*"\K[^"]+' <<<"$src")
CSECRET=$(grep -oP 'offersClientSecret\s*=\s*"\K[^"]+' <<<"$src")
[ -n "$CID" ] && [ -n "$CSECRET" ] || { echo "Zugangsdaten nicht in edekompile gefunden"; exit 1; }
code=$(curl -s -o "$TMP/token.json" -w '%{http_code}' --max-time 15 -u "$CID:$CSECRET" \
  -H 'content-type: application/x-www-form-urlencoded' -d 'grant_type=client_credentials' \
  https://b2b-login.api.edeka/auth/realms/b2b/protocol/openid-connect/token)
TOKEN=$(jq -r '.access_token // empty' "$TMP/token.json" 2>/dev/null)
if [ -z "$TOKEN" ]; then
  echo "FEHLER (HTTP $code): $(head -c 200 "$TMP/token.json" | tr '\n' ' ')"
  exit 1
fi
echo "OK ($code), Token gültig für $(jq -r .expires_in "$TMP/token.json") s"
echo

echo "== 4. App-Schnittstelle: Angebote für GLN $GLN =="
code=$(curl -s -o "$TMP/offers.json" -w '%{http_code}' --max-time 20 \
  -H "authorization: Bearer $TOKEN" -H 'user-agent: okhttp/5.3.2' \
  "https://b2c-gw.api.edeka/v2/offers/mobile?marketGln=$GLN&page=0&size=200&sortedByCategory=true")
if [ "$code" != 200 ]; then
  echo "FEHLER (HTTP $code): $(head -c 300 "$TMP/offers.json" | tr '\n' ' ')"
  exit 1
fi
jq -r '"OK, \(.offers | length) Angebote geladen, totalCount=\(.totalCount)",
       "national=\(.national)  (false = eigener Marktprospekt, true = nur bundesweite Angebote)",
       "gültig: \(.validFrom) bis \(.validTill)",
       "Beispiele:",
       (.offers[:8][] | "  \(.price.value) €  \(.title)  [\(.category.name // "-")]")' "$TMP/offers.json"
