// Nächste Filialen der Ketten über OpenStreetMap (Nominatim + Overpass)
import type { StoreInfo } from '../shared/types';

const UA = 'Angebotskueche/1.0 (private Einkaufs-App)';

// OSM-Marke → Kettenname in der App
const BRANDS: [RegExp, string][] = [
  [/^aldi nord$/i, 'ALDI Nord'],
  [/^aldi s(ü|ue)d$/i, 'ALDI SÜD'],
  [/^rewe$/i, 'REWE'],
  [/^lidl$/i, 'Lidl'],
  [/^penny$/i, 'PENNY'],
  [/^netto marken-discount$/i, 'Netto Marken-Discount'],
  [/^kaufland$/i, 'Kaufland'],
];

/** Ketten, für die die Filialsuche die nächste Filiale kennt */
export const STORE_CHAINS = BRANDS.map(([, chain]) => chain);

export function km(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(bLat - aLat) / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(r(bLon - aLon) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

/** Mittelpunkt einer Postleitzahl */
export async function geocode(plz: string): Promise<{ lat: number; lon: number } | null> {
  const geo = await fetch(`https://nominatim.openstreetmap.org/search?postalcode=${plz}&country=de&format=json&limit=1`, {
    headers: { 'user-agent': UA, 'accept-language': 'de' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!geo.ok) throw new Error(`Ortssuche antwortet mit ${geo.status}`);
  const [place] = (await geo.json()) as { lat: string; lon: string }[];
  return place ? { lat: Number(place.lat), lon: Number(place.lon) } : null;
}

type Place = { lat: number; lon: number; tags: Record<string, string> };

export async function nearestStores(plz: string, center?: { lat: number; lon: number } | null): Promise<StoreInfo[]> {
  const c = center ?? (await geocode(plz));
  if (!c) return [];
  let places: Place[];
  try {
    places = await overpassPlaces(c);
  } catch (e) {
    // Overpass ist oft überlastet ("at capacity") → Filialen einzeln über Nominatim suchen
    console.warn(`${e instanceof Error ? e.message : String(e)} – nehme Nominatim`);
    places = await nominatimPlaces(c);
  }
  return pickNearest(c, places);
}

/** Supermärkte im Umkreis von 12 km über Overpass (nur der FOSSGIS-Hauptserver und kumi.systems) */
async function overpassPlaces({ lat, lon }: { lat: number; lon: number }): Promise<Place[]> {
  const q = `[out:json][timeout:15];nwr["shop"="supermarket"](around:12000,${lat},${lon});out center tags;`;
  const servers = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  // Beide gleichzeitig, die erste brauchbare Antwort gewinnt, höchstens 12 Sekunden
  const tried: string[] = [];
  const stop = new AbortController();
  const ask = async (url: string): Promise<Response> => {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: `data=${encodeURIComponent(q)}`,
        signal: AbortSignal.any([stop.signal, AbortSignal.timeout(12_000)]),
      });
      if (r.ok && (r.headers.get('content-type') ?? '').includes('json')) return r;
      tried.push(`${new URL(url).hostname}: ${r.status}`);
    } catch (e) {
      tried.push(`${new URL(url).hostname}: ${e instanceof Error ? e.name : String(e)}`);
    }
    throw new Error(url);
  };
  const res = await Promise.any(servers.map(ask)).catch(() => {
    throw new Error(`Overpass nicht erreichbar (${tried.join(', ')})`);
  });
  const d = (await res.json()) as { elements: { lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }[] };
  stop.abort(); // den langsameren Server nicht weiter warten lassen
  return d.elements.flatMap((e) => {
    const eLat = e.lat ?? e.center?.lat;
    const eLon = e.lon ?? e.center?.lon;
    return eLat == null || eLon == null ? [] : [{ lat: eLat, lon: eLon, tags: e.tags ?? {} }];
  });
}

/** Ersatzweg: je Kette eine Suche bei Nominatim im Umkreis (~12 km). Nominatim erlaubt 1 Anfrage pro Sekunde. */
async function nominatimPlaces({ lat, lon }: { lat: number; lon: number }): Promise<Place[]> {
  const dLat = 0.11;
  const dLon = 0.18;
  const viewbox = [lon - dLon, lat + dLat, lon + dLon, lat - dLat].map((n) => n.toFixed(4)).join(',');
  const out: Place[] = [];
  for (const q of ['REWE', 'Lidl', 'Aldi', 'Netto Marken-Discount', 'Penny', 'Kaufland']) {
    if (out.length) await new Promise((r) => setTimeout(r, 1100));
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&viewbox=${viewbox}&bounded=1&format=jsonv2&limit=40&addressdetails=1&extratags=1`;
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'de' }, signal: AbortSignal.timeout(15_000) });
      if (!r.ok) continue;
      const list = (await r.json()) as { lat: string; lon: string; category: string; type: string; name: string; address?: Record<string, string>; extratags?: Record<string, string> }[];
      for (const e of list) {
        if (e.category !== 'shop') continue;
        const a = e.address ?? {};
        out.push({
          lat: Number(e.lat),
          lon: Number(e.lon),
          tags: {
            name: e.name,
            ...(e.extratags?.brand ? { brand: e.extratags.brand } : {}),
            ...(a.road ? { 'addr:street': a.road } : {}),
            ...(a.house_number ? { 'addr:housenumber': a.house_number } : {}),
            ...(a.postcode ? { 'addr:postcode': a.postcode } : {}),
            ...((a.city ?? a.town ?? a.village) ? { 'addr:city': a.city ?? a.town ?? a.village } : {}),
          },
        });
      }
    } catch {
      // eine Kette fehlt dann eben
    }
  }
  if (!out.length) throw new Error('Filialsuche nicht erreichbar (Overpass und Nominatim)');
  return out;
}

/** Je Kette die nächste Filiale (mit Adresse bevorzugt), nächste zuerst */
function pickNearest({ lat, lon }: { lat: number; lon: number }, places: Place[]): StoreInfo[] {
  const best = new Map<string, StoreInfo>();
  for (const { lat: eLat, lon: eLon, tags: t } of places) {
    const brand = t.brand ?? t.name ?? '';
    const chain = BRANDS.find(([re]) => re.test(brand.trim()))?.[1];
    if (!chain) continue;
    const dist = Math.round(km(lat, lon, eLat, eLon) * 10) / 10;
    if (dist > 12) continue;
    const street = [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' ');
    const city = [t['addr:postcode'], t['addr:city']].filter(Boolean).join(' ');
    const address = [street, city].filter(Boolean).join(', ');
    const prev = best.get(chain);
    // Filialen ohne Adresse nur nehmen, wenn es keine mit Adresse gibt
    if (!prev || (address && !prev.address) || (!!address === !!prev.address && dist < prev.distanceKm)) {
      best.set(chain, { chain, name: t.name ?? chain, address, distanceKm: dist });
    }
  }
  return [...best.values()].sort((a, b) => a.distanceKm - b.distanceKm);
}
