// EDEKA-App-Schnittstelle (dieselbe, die die EDEKA-App nutzt; Aufbau wie in github.com/ByteSizedMarius/edekompile).
// Liefert pro Markt (über die GLN) entweder den eigenen Prospekt des Markts (national=false)
// oder nur die bundesweiten Angebote (national=true). Im zweiten Fall liest die KI den PDF-Prospekt.
import type { Group, Offer } from '../shared/types';
import { dietFor, guessGroup } from './aldi';
import { packFromText, parseBasic, type EdekaMarket } from './edeka';

const TOKEN_URL = 'https://b2b-login.api.edeka/auth/realms/b2b/protocol/openid-connect/token';
const OFFERS_URL = 'https://b2c-gw.api.edeka/v2/offers/mobile';
const UA = 'okhttp/5.3.2';
/** Bilder kommen vom CDN der App und brauchen eine App-Kennung */
export const IMAGE_UA = 'Dalvik/2.1.0 (Linux; U; Android 17; Pixel 8 Pro Build/CP2A.260805.005)';
const ID_BASE = 3_000_000_000_000;
const PAGE = 100;

export interface MobileEnv {
  EDEKA_APP_CLIENT_ID?: string;
  EDEKA_APP_CLIENT_SECRET?: string;
}

export interface MobileResult {
  national: boolean;
  offers: Offer[];
  /** Kategorien, wie EDEKA sie liefert (zum Nachschärfen der Zuordnung) */
  categories: string[];
}

interface RawMobileOffer {
  id: number;
  title?: string;
  descriptions?: string[];
  image?: { imageUrl?: string };
  price?: { value?: string };
  priceType?: string;
  discount?: string;
  category?: { name?: string };
  validFrom?: string;
  validTill?: string;
}
interface RawMobileResponse {
  offers?: RawMobileOffer[];
  national?: boolean;
  totalCount?: number;
  validFrom?: string;
  validTill?: string;
}

let token: { value: string; until: number } | null = null;

async function bearer(env: MobileEnv): Promise<string> {
  if (token && token.until > Date.now() + 30_000) return token.value;
  if (!env.EDEKA_APP_CLIENT_ID || !env.EDEKA_APP_CLIENT_SECRET) throw new Error('Zugangsdaten für die EDEKA-App-Schnittstelle fehlen');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${btoa(`${env.EDEKA_APP_CLIENT_ID}:${env.EDEKA_APP_CLIENT_SECRET}`)}`,
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`EDEKA-Anmeldung antwortet mit ${res.status}`);
  const d = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!d.access_token) throw new Error('EDEKA-Anmeldung lieferte kein Token');
  token = { value: d.access_token, until: Date.now() + Math.min(Math.max(d.expires_in ?? 300, 60), 3600) * 1000 };
  return token.value;
}

async function page(env: MobileEnv, gln: string, n: number): Promise<RawMobileResponse> {
  const q = new URLSearchParams({ marketGln: gln, size: String(PAGE), page: String(n), sortedByCategory: 'true' });
  const res = await fetch(`${OFFERS_URL}?${q}`, { headers: { authorization: `Bearer ${await bearer(env)}`, 'user-agent': UA } });
  if (res.status === 401) token = null;
  if (!res.ok) throw new Error(`EDEKA-App-Schnittstelle antwortet mit ${res.status}`);
  return (await res.json()) as RawMobileResponse;
}

/** Alle Angebote eines Markts über die App-Schnittstelle */
export async function fetchMobileOffers(env: MobileEnv, m: EdekaMarket, gln: string, now = Date.now()): Promise<MobileResult> {
  const first = await page(env, gln, 0);
  const raws = [...(first.offers ?? [])];
  const total = first.totalCount ?? raws.length;
  for (let n = 1; raws.length < total && n < 20; n++) {
    const next = await page(env, gln, n);
    if (!next.offers?.length) break;
    raws.push(...next.offers);
  }
  const offers = raws.map((o) => toOffer(m, o, first, now)).filter((o): o is Offer => !!o && Date.parse(o.validTo) >= now);
  const categories = [...new Set(raws.map((o) => o.category?.name ?? '').filter(Boolean))];
  return { national: first.national !== false, offers, categories };
}

// Kategorie der App → Gruppe in der App (null = keine Lebensmittel)
function categoryGroup(cat: string): Group | null | undefined {
  const c = cat.toLowerCase();
  if (/drogerie|kosmetik|haushalt|tier|non.?food|baby.*pflege|pflege|elektro|garten|deko/.test(c)) return null;
  if (/obst|gemüse/.test(c)) return 'gemuese';
  if (/fleisch|geflügel/.test(c)) return 'fleisch';
  if (/wurst/.test(c)) return 'wurst';
  if (/fisch/.test(c)) return 'fisch';
  if (/molkerei|milch|käse|kühl/.test(c)) return 'milch';
  if (/tiefkühl/.test(c)) return 'tiefkuehl';
  if (/getränk|wein|bier|spirituos|sekt|kaffee|tee/.test(c)) return 'getraenke';
  if (/süß|snack|knabber/.test(c)) return 'snacks';
  if (/brot|back/.test(c)) return 'brot';
  if (/frühstück|müsli|aufstrich/.test(c)) return 'fruehstueck';
  return undefined;
}

const COOKING = new Set<Group>(['fleisch', 'wurst', 'fisch', 'milch', 'gemuese', 'obst', 'vorrat', 'tiefkuehl', 'feinkost', 'brot']);
// "Ab Donnerstag erhältlich:", "Donnerstag bis Samstag:", "Samstags-Knüller:" …
const AVAIL = /^\*?\s*((?:ab\s+)?(?:montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)[^:]{0,40}|[^:]{0,20}knüller):\s*/i;

function toOffer(m: EdekaMarket, o: RawMobileOffer, r: RawMobileResponse, now: number): Offer | null {
  const price = parseFloat((o.price?.value ?? '').replace(',', '.'));
  if (!o.title || !Number.isFinite(price) || price <= 0 || o.priceType === 'HIDE') return null;
  let name = o.title.replace(/\s+/g, ' ').trim();
  const avail = name.match(AVAIL);
  if (avail) name = name.slice(avail[0].length);
  const desc = (o.descriptions ?? []).join(' · ').replace(/\s+/g, ' ').trim();
  const cat = o.category?.name ?? '';
  const fromCat = categoryGroup(cat);
  if (fromCat === null) return null;
  // Kategorie nur als Rückfall: "Fleisch & Wurst" soll Hackfleisch nicht zur Wurst machen
  const text = `${name} ${desc}`;
  const group = guessGroup(text, fromCat ?? 'vorrat');
  const basic = parseBasic(desc);
  const from = o.validFrom || r.validFrom;
  const till = o.validTill || r.validTill;
  return {
    id: ID_BASE + (Number(o.id) % 1_000_000_000_000),
    chain: m.name,
    name,
    desc: [avail?.[1], desc].filter(Boolean).join(' · '),
    price,
    pack: packFromText(desc),
    refPrice: basic?.value,
    refUnit: basic?.unit,
    dealNote: o.discount || undefined,
    group,
    category: cat,
    diet: dietFor(group, name, text),
    cooking: COOKING.has(group),
    multi: /versch\.|oder /i.test(text),
    validFrom: from ? berlin(from, '00:00:00') : new Date(now).toISOString(),
    validTo: till ? berlin(till, '23:59:59') : new Date(now + 2 * 86400_000).toISOString(),
    image: o.image?.imageUrl ? `/api/img?u=${encodeURIComponent(o.image.imageUrl)}` : '',
  };
}

/** "2026-11-07" + Uhrzeit → Zeitpunkt in deutscher Zeit (Sommer-/Winterzeit beachtet) */
export function berlin(date: string, time: string): string {
  const d = date.slice(0, 10);
  const guess = new Date(`${d}T${time}Z`);
  const local = new Date(guess.toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
  const utc = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }));
  const offsetH = Math.round((local.getTime() - utc.getTime()) / 3600_000);
  return `${d}T${time}+${String(offsetH).padStart(2, '0')}:00`;
}
