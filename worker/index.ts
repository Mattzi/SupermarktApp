// API unter /api/* (und /relay/* für das EDEKA-Relay). Die statischen Dateien und der Zeitplan kommen aus server.ts.
import { fetchBestLeaflet, fetchRawOffers, leafletPage } from './marktguru';
import { normalizeAll } from './normalize';
import { generateRecipes } from './recipes';
import { ALDI_NORD, fetchAldiNord } from './aldi';
import {
  extractProspekt,
  fetchMarketOffers,
  catalogPath,
  findProspekte,
  marketChainInfo,
  parseMarkets,
  probeProspekte,
  prospektPage,
  withCurrentImages,
  proxyImage,
  searchMarkets,
  type EdekaMarket,
  type Prospekt,
} from './edeka';
import { addCost, dayCost, monthCost, type Tracker } from './costs';
import type { Kv } from './kv';
import { currentUser, syncKeyFor, type User } from './auth';
import type { AiConfig } from './ai';
import { fetchMobileOffers, type MobileResult } from './edeka-mobile';
import { completeJob, getGln, katKey, leaseJobs, relayStatus, requestMarketData } from './relay';
import { geocode, km, nearestStores } from './stores';
import { sendPush, vapidKeys, type PushSub } from './push';
import { mergeDocs, type SyncDoc } from './sync';
import { matchWatch } from '../shared/watch';
import { computeDealsFrom, snapshot, isoWeek, type WeekSnapshot } from './deals';
import type { ChainInfo, Leaflet, LeafletsResponse, Offer, OffersResponse, RecipeRequest } from '../shared/types';

export interface Env {
  CACHE?: Kv;
  /** Öffentliche Adresse der App, z. B. https://app.mattis-kraemer.de */
  APP_URL?: string;
  OPENROUTER_API_KEY?: string;
  /** Modell für Rezepte, z. B. deepseek/deepseek-v4.1-flash */
  RECIPE_MODEL?: string;
  /** Modell für den Schnell-Modus der Rezepte (leer = RECIPE_MODEL) */
  RECIPE_MODEL_FAST?: string;
  /** Modell, das die Prospektseiten liest (muss Bilder verstehen) */
  EXTRACT_MODEL?: string;
  MONTHLY_BUDGET_USD?: string;
  /** KI-Budget pro Konto und Tag, falls in Authentik nichts hinterlegt ist */
  DAILY_USER_BUDGET_USD?: string;
  /** Höchstens so viele automatische Prospekt-Einlesungen pro Woche (alle Märkte zusammen) */
  EXTRACT_PER_WEEK?: string;
  AUTH_MODE?: string;
  DEV_USER_EMAIL?: string;
  RELAY_TOKEN?: string;
  EDEKA_APP_CLIENT_ID?: string;
  EDEKA_APP_CLIENT_SECRET?: string;
}

const aiConfig = (env: Env): AiConfig => ({ apiKey: env.OPENROUTER_API_KEY ?? '', appUrl: env.APP_URL });
const tracker = (env: Env, user?: User): Tracker => (usd) => addCost(env.CACHE, usd, user?.id);
const budget = (env: Env) => Number(env.MONTHLY_BUDGET_USD ?? 8);
const userBudget = (env: Env, user: User) => user.dailyBudgetUsd ?? Number(env.DAILY_USER_BUDGET_USD ?? 0.1);
async function userOverBudget(env: Env, user: User): Promise<boolean> {
  return (await dayCost(env.CACHE, user.id)) >= userBudget(env, user);
}
async function overBudget(env: Env): Promise<boolean> {
  return (await monthCost(env.CACHE)) >= budget(env);
}

const HOUR = 3600_000;

// ---------- kleine Cache-Helfer (Speicher + optional KV) ----------

const memo = new Map<string, { at: number; data: unknown }>();

async function cached<T>(env: Env, key: string, ttlMs: number, load: () => Promise<T>, force = false): Promise<T> {
  const hit = memo.get(key);
  if (!force && hit && Date.now() - hit.at < ttlMs) return hit.data as T;
  if (!force && env.CACHE) {
    const kv = await env.CACHE.get<{ at: number; data: T }>(key, 'json');
    if (kv && Date.now() - kv.at < ttlMs) {
      memo.set(key, kv);
      return kv.data;
    }
  }
  const data = await load();
  const entry = { at: Date.now(), data };
  memo.set(key, entry);
  if (env.CACHE) await env.CACHE.put(key, JSON.stringify(entry), { expirationTtl: Math.max(60, Math.ceil(ttlMs / 1000) * 2) });
  return data;
}

async function kvGet<T>(env: Env, key: string): Promise<T | null> {
  return env.CACHE ? env.CACHE.get<T>(key, 'json') : null;
}
async function kvPut(env: Env, key: string, value: unknown, ttlSec?: number) {
  if (env.CACHE) await env.CACHE.put(key, JSON.stringify(value), ttlSec ? { expirationTtl: Math.max(60, ttlSec) } : undefined);
}

// ---------- Angebote zusammenführen ----------

interface ProspektMeta {
  extractedAt?: string;
  seconds?: number;
  costUsd?: number;
}
interface ProspektIndex {
  prospekte: (Pick<Prospekt, 'key' | 'validFrom' | 'validTo' | 'preview'> & { count: number } & ProspektMeta)[];
}

/** Angebote der EDEKA-App-Schnittstelle (null = GLN noch unbekannt oder Markt ohne GLN) */
async function mobileOffers(env: Env, m: EdekaMarket, force = false): Promise<MobileResult | null> {
  if (!env.CACHE) return null;
  const gln = await getGln(env.CACHE, m.marketNo);
  if (!gln || gln === 'none') return null;
  return cached(env, `edeka:mob:${gln}`, 3 * HOUR, () => fetchMobileOffers(env, m, gln), force);
}

async function prospektOffers(env: Env, m: EdekaMarket): Promise<Offer[]> {
  const now = Date.now();
  const idx = await kvGet<ProspektIndex>(env, `edeka:idx:${m.marketNo}`);
  const valid = (idx?.prospekte ?? []).filter((p) => Date.parse(p.validTo) >= now);
  const lists = await Promise.all(
    valid.map(async (p) => {
      const l = (await kvGet<Offer[]>(env, pdfKey(p.key))) ?? (await kvGet<Offer[]>(env, `edeka:pdf:${p.key}`));
      return l ? withCurrentImages(l, p, m.marketNo) : null;
    }),
  );
  return lists.flatMap((l) => l ?? []);
}

/**
 * EDEKA-Markt: zuerst die App-Schnittstelle. Liefert sie den eigenen Prospekt des Markts, reicht das.
 * Kennt sie nur die bundesweiten Angebote, kommen die Angebote aus dem von der KI gelesenen Prospekt.
 */
async function edekaOffers(env: Env, m: EdekaMarket, force = false): Promise<{ offers: Offer[]; note?: string }> {
  // Fällt die App-Schnittstelle aus, bleibt der Prospekt-Weg
  const mobile = await mobileOffers(env, m, force).catch((e) => {
    console.error(`${m.name}: App-Schnittstelle`, e);
    return null;
  });
  if (mobile && !mobile.national && mobile.offers.length) return { offers: mobile.offers };
  const prospekt = await prospektOffers(env, m);
  if (prospekt.length) return { offers: prospekt };
  if (mobile) return { offers: mobile.offers, note: 'Prospekt wird eingelesen – bis dahin nur die bundesweiten Angebote' };
  const gln = env.CACHE ? await getGln(env.CACHE, m.marketNo) : null;
  return { offers: [], note: gln ? 'Prospekt wird eingelesen' : 'Markt wird eingerichtet – die Angebote kommen in Kürze' };
}

// Märkte, deren Prospekt eingelesen wird. Nur Märkte, die jemand in der App ausgewählt hat;
// wer 14 Tage nicht mehr abgefragt wurde, fliegt wieder raus.
type Watched = EdekaMarket & { lastSeen: number };
const WATCH_DAYS = 14;

async function watchMarket(env: Env, m: EdekaMarket) {
  const list = (await kvGet<Watched[]>(env, 'edeka:watch')) ?? [];
  const hit = list.find((x) => x.id === m.id);
  if (hit && Date.now() - (hit.lastSeen ?? 0) < 86400_000) return; // höchstens einmal am Tag schreiben
  const next = [...list.filter((x) => x.id !== m.id), { ...m, lastSeen: Date.now() }];
  await kvPut(env, 'edeka:watch', next);
  // GLN und Blätterkatalog-Adresse fehlen noch? Dann beim Relay anfragen
  if (env.CACHE) await requestMarketData(env.CACHE, m.marketNo);
}

const centerOf = (env: Env, plz: string) => cached(env, `geo:${plz}`, 90 * 24 * HOUR, () => geocode(plz));

/** Nur Märkte im Umkreis von 15 km, nächste zuerst */
async function nearestFirst(env: Env, plz: string, found: EdekaMarket[]): Promise<EdekaMarket[]> {
  const c = await centerOf(env, plz).catch(() => null);
  if (!c) return found.slice(0, 6);
  return found
    .map((m) => ({ ...m, distanceKm: m.lat && m.lon ? Math.round(km(c.lat, c.lon, m.lat, m.lon) * 10) / 10 : undefined }))
    .filter((m) => m.distanceKm == null || m.distanceKm <= 15)
    .sort((a, b) => (a.distanceKm ?? 99) - (b.distanceKm ?? 99));
}

/** Märkte merken, damit sie später über die ID gefunden werden – und als letzte gute Liste für die PLZ */
async function rememberMarkets(env: Env, plz: string, list: EdekaMarket[]) {
  if (!list.length) return;
  await Promise.all([
    ...list.map((m) => kvPut(env, `edeka:m:${m.id}`, m, 90 * 86400)),
    kvPut(env, `edeka:nearlast:${plz}`, list),
  ]);
  for (const m of list) memo.set(`edeka:m:${m.id}`, { at: Date.now(), data: m });
}

async function nearbyMarkets(env: Env, plz: string): Promise<EdekaMarket[]> {
  try {
    const list = await cached(env, `edeka:near2:${plz}`, 24 * HOUR, async () => {
      const found = await nearestFirst(env, plz, await searchMarkets(plz));
      // Leere Antwort nicht für 24 Stunden festschreiben
      if (!found.length) throw new Error('EDEKA-Marktsuche lieferte keine Märkte');
      return found;
    });
    await rememberMarkets(env, plz, list);
    return list;
  } catch (e) {
    // EDEKA blockt oder ist down: letzte funktionierende Liste nehmen
    const last = await kvGet<EdekaMarket[]>(env, `edeka:nearlast:${plz}`);
    if (last?.length) return last;
    throw e;
  }
}

async function marketById(env: Env, id: number): Promise<EdekaMarket | null> {
  const hit = memo.get(`edeka:m:${id}`);
  if (hit) return hit.data as EdekaMarket;
  return kvGet<EdekaMarket>(env, `edeka:m:${id}`);
}

/** Liegt die PLZ im Gebiet von ALDI Nord oder ALDI SÜD? (nach den nächsten Filialen laut OpenStreetMap) */
async function aldiRegion(env: Env, plz: string): Promise<'nord' | 'sued' | 'unbekannt'> {
  // Auch "unbekannt" einen Tag merken, damit eine gestörte Filialsuche nicht jede Anfrage bremst
  return cached(env, `aldireg:${plz}`, 24 * HOUR, async () => {
    try {
      const c = await centerOf(env, plz).catch(() => null);
      const stores = await cached(env, `stores:${plz}`, 7 * 24 * HOUR, () => nearestStores(plz, c));
      const nord = stores.find((s) => s.chain === 'ALDI Nord')?.distanceKm ?? Infinity;
      const sued = stores.find((s) => s.chain === 'ALDI SÜD')?.distanceKm ?? Infinity;
      if (nord === Infinity && sued === Infinity) return 'unbekannt' as const;
      return nord <= sued ? ('nord' as const) : ('sued' as const);
    } catch {
      return 'unbekannt' as const;
    }
  });
}

export async function getOffers(env: Env, plz: string, marketIds: number[] = [], force = false): Promise<OffersResponse> {
  const notes: string[] = [];
  const errors: string[] = [];
  const settle = async <T,>(label: string, p: Promise<T>, fallback: T): Promise<T> => {
    try {
      return await p;
    } catch (e) {
      console.error(label, e);
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
      return fallback;
    }
  };

  // ALDI Nord nur dort, wo es ALDI Nord gibt (im Süden stehen nur ALDI-SÜD-Filialen)
  const region = await aldiRegion(env, plz);
  const [mg, aldi, nearby] = await Promise.all([
    settle('marktguru', cached(env, `mg:${plz}`, 6 * HOUR, async () => normalizeAll(await fetchRawOffers(plz)), force), {
      offers: [] as Offer[],
      chains: [] as ChainInfo[],
    }),
    region === 'sued' ? ([] as Offer[]) : settle('ALDI Nord', cached(env, 'aldi:nord', 6 * HOUR, fetchAldiNord, force), [] as Offer[]),
    settle('EDEKA-Marktsuche', nearbyMarkets(env, plz), [] as EdekaMarket[]),
  ]);

  const markets = (await Promise.all(marketIds.map((id) => marketById(env, id)))).filter((m): m is EdekaMarket => !!m);
  const edeka = await Promise.all(
    markets.map(async (m) => {
      await watchMarket(env, m);
      const r = await settle(m.name, edekaOffers(env, m, force), { offers: [] as Offer[] });
      return { m, ...r };
    }),
  );

  const offers = [...mg.offers, ...aldi, ...edeka.flatMap((e) => e.offers)];
  const chains: ChainInfo[] = [
    ...mg.chains.map((c) => ({ ...c, kind: 'kette' as const })),
    ...(aldi.length ? [{ name: ALDI_NORD, count: aldi.length, kind: 'kette' as const }] : []),
    ...edeka.map((e) => marketChainInfo(e.m, e.offers.length, e.note)),
  ];
  for (const e of edeka) if (e.note) notes.push(`${e.m.name}: ${e.note}`);
  return {
    plz,
    fetchedAt: new Date().toISOString(),
    chains,
    // Gewählte Märkte immer mit anbieten, auch wenn die Suche sie gerade nicht liefert
    nearby: [...nearby, ...markets.filter((m) => !nearby.some((n) => n.id === m.id))].map((m) => marketChainInfo(m)),
    offers,
    notes,
    errors,
  };
}

// ---------- Benachrichtigungen (Merkliste) ----------

const shortName = (c: string) => c.replace('Netto Marken-Discount', 'Netto').replace('PENNY', 'Penny').replace(/^nah\s*(&|und)\s*gut.*/i, 'nah & gut');

async function pushMessage(env: Env, sub: PushSub): Promise<{ title: string; body: string }> {
  const data = await getOffers(env, sub.plz, sub.markets);
  const now = Date.now();
  const offers = data.offers.filter(
    (o) => (!sub.chains.length || sub.chains.includes(o.chain)) && Date.parse(o.validFrom) <= now + 12 * HOUR && Date.parse(o.validTo) >= now,
  );
  if (!sub.watch.length) return { title: 'Neue Angebote der Woche', body: 'Die Prospekte der Woche sind da – schau mal rein.' };
  const hits = sub.watch
    .map((t) => ({ t, chains: [...new Set(matchWatch(t, offers).map((o) => shortName(o.chain)))] }))
    .filter((h) => h.chains.length);
  if (!hits.length) return { title: 'Merkliste', body: 'Von deiner Merkliste ist diese Woche nichts im Angebot.' };
  return {
    title: `Merkliste: ${hits.length} von ${sub.watch.length} im Angebot`,
    body: hits.map((h) => `${h.t}: ${h.chains.join(', ')}`).join(' · '),
  };
}

const subsOf = async (env: Env) => (await kvGet<PushSub[]>(env, 'push:subs')) ?? [];

async function weeklyPush(env: Env): Promise<string> {
  if (!env.CACHE) return 'kein KV';
  // Montags ab 7 Uhr (deutsche Zeit), einmal pro Woche
  const berlin = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
  if (berlin.getDay() !== 1 || berlin.getHours() < 7) return 'nicht Montagmorgen';
  const key = `push:sent:${isoWeek(berlin)}`;
  if (await env.CACHE.get(key)) return 'diese Woche schon gesendet';
  await env.CACHE.put(key, new Date().toISOString(), { expirationTtl: 14 * 86400 });
  const subs = await subsOf(env);
  const keep: PushSub[] = [];
  for (const sub of subs) {
    const status = await sendPush(env.CACHE, sub.endpoint).catch(() => 0);
    if (status !== 404 && status !== 410) keep.push(sub);
  }
  if (keep.length !== subs.length) await kvPut(env, 'push:subs', keep);
  return `an ${subs.length} Gerät(e) gesendet`;
}

// ---------- Kaufempfehlungen ----------

/** Einmal pro Woche einen Schnappschuss der Preise ablegen (Grundlage für "selten" / "günstiger als sonst") */
async function ensureSnapshot(env: Env, plz: string, offers: Offer[]) {
  const key = `hist:${plz}:${isoWeek(new Date())}`;
  if (memo.has(key) || !env.CACHE || !offers.length) return;
  if (!(await env.CACHE.get(key))) await kvPut(env, key, snapshot(offers), 200 * 86400);
  memo.set(key, { at: Date.now(), data: true });
}

async function computeDeals(env: Env, scope: string, offers: Offer[]) {
  const now = new Date();
  await ensureSnapshot(env, scope, offers);
  const weeks: WeekSnapshot[] = [];
  for (let i = 1; i <= 12; i++) {
    const w = isoWeek(new Date(now.getTime() - i * 7 * 86400_000));
    const snap = await kvGet<WeekSnapshot>(env, `hist:${scope}:${w}`);
    if (snap) weeks.push(snap);
  }
  return computeDealsFrom(offers, weeks);
}

// ---------- Prospekte zum Blättern ----------

async function getLeaflets(env: Env, plz: string, marketIds: number[]): Promise<LeafletsResponse> {
  const errors: string[] = [];
  const data = await getOffers(env, plz, marketIds);
  const leaflets: Leaflet[] = [];

  // marktguru: die Prospekt-Ausgaben, aus denen die Angebote stammen
  const flights = new Map<number, number>();
  for (const o of data.offers) if (o.flight) flights.set(o.flight, (flights.get(o.flight) ?? 0) + 1);
  const relevant = [...flights.entries()].filter(([, n]) => n >= 5).map(([f]) => f);
  const mg = await Promise.all(
    relevant.map((f) => cached(env, `mg:leaflet:${f}:${plz}`, 6 * HOUR, () => fetchBestLeaflet(f, plz)).catch(() => null)),
  );
  const seen = new Set<number>();
  for (const l of mg) {
    if (!l || !l.pageImages?.count || seen.has(l.id) || Date.parse(l.validTo) < Date.now()) continue;
    seen.add(l.id);
    const n = l.pageImages.count;
    leaflets.push({
      id: `mg-${l.id}`,
      chain: l.advertiser?.name ?? '',
      validFrom: l.validFrom,
      validTo: l.validTo,
      pages: Array.from({ length: n }, (_, i) => leafletPage(l.id, i, 'medium')),
      pagesLarge: Array.from({ length: n }, (_, i) => leafletPage(l.id, i, 'large')),
    });
  }

  // EDEKA-Märkte: Blätterkatalog
  for (const id of marketIds) {
    const m = await marketById(env, id);
    if (!m) continue;
    try {
      const ps = await cached(env, `edeka:prosp2:${m.marketNo}`, HOUR, () => prospekteOf(env, m));
      for (const p of ps) {
        if (!p.pageCount || Date.parse(p.validTo) < Date.now()) continue;
        leaflets.push({
          id: `ed-${p.key}`,
          chain: m.name,
          validFrom: p.validFrom,
          validTo: p.validTo,
          pages: Array.from({ length: p.pageCount }, (_, i) => prospektPage(p, i + 1, 'normal')),
          pagesLarge: Array.from({ length: p.pageCount }, (_, i) => prospektPage(p, i + 1, 'large')),
        });
      }
    } catch (e) {
      errors.push(`${m.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  leaflets.sort((a, b) => a.chain.localeCompare(b.chain) || Date.parse(a.validFrom) - Date.parse(b.validFrom));
  return { leaflets, errors };
}

// ---------- Prospekte einlesen (Cron + manuell) ----------

// Versionskennung des Einlese-Formats. Wird sie erhöht, liest der Cron alle aktuellen Prospekte neu ein
// (v2: mit Bildausschnitten). Bis dahin bleiben die alten Daten sichtbar.
const EXTRACT_VERSION = 'v2';
const pdfKey = (k: string) => `edeka:pdf:${EXTRACT_VERSION}:${k}`;
const errKey = (k: string) => `edeka:err:${EXTRACT_VERSION}:${k}`;
const metaKey = (k: string) => `edeka:meta:${EXTRACT_VERSION}:${k}`;

/**
 * Prospekte eines Markts finden: über die bekannte Blätterkatalog-Adresse (kommt vom Relay),
 * sonst direkt über edeka.de (klappt nur, wenn edeka.de den Server gerade nicht blockt).
 */
async function prospekteOf(env: Env, m: EdekaMarket): Promise<Prospekt[]> {
  const known =
    (await kvGet<string[]>(env, katKey(m.marketNo))) ??
    ((await kvGet<ProspektIndex>(env, `edeka:idx:${m.marketNo}`))?.prospekte ?? []).map((p) => catalogPath(p.key));
  if (known.length) return probeProspekte([...new Set(known)]);
  try {
    const ps = await findProspekte(m);
    if (ps.length) await kvPut(env, katKey(m.marketNo), [...new Set(ps.map((p) => catalogPath(p.key)))]);
    return ps;
  } catch {
    if (env.CACHE) await requestMarketData(env.CACHE, m.marketNo);
    throw new Error('Prospekt-Adresse wird über das Relay ermittelt');
  }
}

async function processMarket(env: Env, m: EdekaMarket, maxExtract = 1, user?: User): Promise<string[]> {
  const log: string[] = [];
  if (!env.OPENROUTER_API_KEY || !env.EXTRACT_MODEL || !env.CACHE) return ['OpenRouter-Schlüssel, Modell (EXTRACT_MODEL) oder Datenbank fehlt'];
  // Erst klären, ob die App-Schnittstelle den Markt schon vollständig kennt – dann braucht es keine KI
  const gln = await getGln(env.CACHE, m.marketNo);
  if (!gln) {
    await requestMarketData(env.CACHE, m.marketNo);
    return [`${m.name}: GLN noch unbekannt, wartet auf das Relay`];
  }
  if (gln !== 'none') {
    const mobile = await mobileOffers(env, m).catch(() => null);
    if (mobile && !mobile.national) return [`${m.name}: App-Schnittstelle liefert den eigenen Prospekt (${mobile.offers.length} Angebote) – kein Einlesen nötig`];
  }
  const prospekte = await prospekteOf(env, m);
  log.push(`${m.name}: ${prospekte.length} Prospekt(e) gefunden`);
  // Nichts gefunden (z. B. Quelle gestört): bisherigen Stand behalten statt leeren
  if (!prospekte.length) return log;
  const idx: ProspektIndex = { prospekte: [] };
  let extracted = 0;
  for (const p of prospekte) {
    const key = pdfKey(p.key);
    let offers = await kvGet<Offer[]>(env, key);
    if (!offers && extracted < maxExtract) {
      const err = await kvGet<{ at: number; tries?: number }>(env, errKey(p.key));
      if (err && (err.tries ?? 1) >= 2) {
        log.push(`${p.key}: zweimal fehlgeschlagen – kein weiterer automatischer Versuch`);
      } else if (err && Date.now() - err.at < 3 * HOUR) {
        log.push(`${p.key}: letzter Versuch fehlgeschlagen, warte`);
      } else {
        extracted++;
        // Harte Obergrenze: höchstens EXTRACT_PER_WEEK KI-Einlesungen pro Woche, egal was passiert
        const capKey = `extract:count:${isoWeek(new Date())}`;
        const done = Number((await env.CACHE.get(capKey)) ?? 0);
        if (done >= Number(env.EXTRACT_PER_WEEK ?? 4)) {
          log.push(`${p.key}: Wochenlimit für das Einlesen erreicht (${done})`);
          break;
        }
        await env.CACHE.put(capKey, String(done + 1), { expirationTtl: 14 * 86400 });
        try {
          const t0 = Date.now();
          if (await overBudget(env)) {
            log.push('Monatsbudget erreicht – Prospekt wird nicht eingelesen');
            break;
          }
          let cost = 0;
          const track: Tracker = async (usd) => {
            cost += usd;
            await tracker(env, user)(usd);
          };
          offers = await extractProspekt(m, p, aiConfig(env), env.EXTRACT_MODEL, track);
          const ttl = Math.ceil((Date.parse(p.validTo) - Date.now()) / 1000) + 86400;
          await kvPut(env, key, offers, ttl);
          await kvPut(env, metaKey(p.key), { extractedAt: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), costUsd: Math.round(cost * 100) / 100 }, ttl);
          log.push(`${p.key}: ${offers.length} Angebote eingelesen (${Math.round((Date.now() - t0) / 1000)} s)`);
        } catch (e) {
          await kvPut(env, errKey(p.key), { at: Date.now(), tries: (err?.tries ?? 0) + 1, msg: String(e) }, 8 * 86400);
          log.push(`${p.key}: Fehler ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    // Solange die neue Fassung fehlt, die alte weiter anzeigen
    if (!offers) offers = await kvGet<Offer[]>(env, `edeka:pdf:${p.key}`);
    if (offers) {
      const meta = (await kvGet<ProspektMeta>(env, metaKey(p.key))) ?? (await kvGet<ProspektMeta>(env, `edeka:meta:${p.key}`));
      idx.prospekte.push({ key: p.key, validFrom: p.validFrom, validTo: p.validTo, preview: p.preview, count: offers.length, ...meta });
    }
  }
  await kvPut(env, `edeka:idx:${m.marketNo}`, idx, 14 * 86400);
  return log;
}

export async function runCron(env: Env): Promise<string[]> {
  const all = (await kvGet<Watched[]>(env, 'edeka:watch')) ?? [];
  const list = all.filter((m) => Date.now() - (m.lastSeen ?? Date.now()) < WATCH_DAYS * 86400_000);
  if (list.length !== all.length) await kvPut(env, 'edeka:watch', list);
  const log: string[] = [];
  await kvPut(env, 'cron:last', { at: new Date().toISOString(), markets: list.length });
  log.push(`Push: ${await weeklyPush(env).catch((e) => String(e))}`);
  for (const m of list) {
    try {
      log.push(...(await processMarket(env, m)));
    } catch (e) {
      log.push(`${m.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return log;
}

// ---------- Tageslimit für Rezepte ----------

async function checkLimit(env: Env, name: string, max: number): Promise<boolean> {
  if (!env.CACHE) return true;
  const day = new Date().toISOString().slice(0, 10);
  const key = `rl:${name}:${day}`;
  const n = Number((await env.CACHE.get(key)) ?? 0);
  if (n >= max) return false;
  await env.CACHE.put(key, String(n + 1), { expirationTtl: 2 * 86400 });
  return true;
}

// ---------- HTTP ----------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
const error = (message: string, status = 500) => json({ error: message }, status);
const validPlz = (p: string | null | undefined): p is string => !!p && /^\d{5}$/.test(p);
const parseIds = (s: string | null) => [...new Set((s ?? '').split(',').map(Number).filter((n) => Number.isFinite(n) && n > 0))].slice(0, 6);

/** Vergleich, der nicht verrät, wie viele Zeichen stimmen */
function sameSecret(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Aufträge für das EDEKA-Relay (nicht hinter Authentik, dafür mit eigenem Schlüssel) */
async function handleRelay(request: Request, env: Env, url: URL): Promise<Response> {
  const auth = request.headers.get('authorization') ?? '';
  if (!env.RELAY_TOKEN || !sameSecret(auth.replace(/^Bearer\s+/i, ''), env.RELAY_TOKEN)) return error('nicht erlaubt', 401);
  if (!env.CACHE) return error('Keine Datenbank verbunden', 500);
  if (url.pathname === '/relay/jobs' && request.method === 'GET') return json({ jobs: await leaseJobs(env.CACHE) });
  if (url.pathname === '/relay/result' && request.method === 'POST') {
    const b = (await request.json().catch(() => null)) as { id?: string; status?: number; body?: string } | null;
    if (!b?.id || typeof b.status !== 'number') return error('Ergebnis unvollständig', 400);
    const note = await completeJob(env.CACHE, b.id, b.status, String(b.body ?? '').slice(0, 3_000_000));
    console.log(`Relay ${b.id}: ${note}`);
    return json({ ok: true, note });
  }
  return error('Unbekannter Pfad', 404);
}

export async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/relay/')) return handleRelay(request, env, url);
  if (!url.pathname.startsWith('/api/')) return error('Unbekannter Pfad', 404);

  try {
    const who = await currentUser(request, env);
    if (!('email' in who)) return error(`Nicht angemeldet (${who.reason})`, 401);
    const user = who;

    if (url.pathname === '/api/push/key' && env.CACHE) {
      return json({ publicKey: (await vapidKeys(env.CACHE)).publicKey });
    }
    if (url.pathname === '/api/push/subscribe' && request.method === 'POST') {
      const b = (await request.json()) as Partial<PushSub>;
      if (!b.endpoint || !validPlz(b.plz)) return error('Abo unvollständig', 400);
      const sub: PushSub = {
        endpoint: b.endpoint,
        plz: b.plz,
        markets: (b.markets ?? []).slice(0, 6),
        chains: (b.chains ?? []).slice(0, 12),
        watch: (b.watch ?? []).map((w) => String(w).slice(0, 40)).slice(0, 30),
        updatedAt: new Date().toISOString(),
      };
      const subs = (await subsOf(env)).filter((x) => x.endpoint !== sub.endpoint);
      await kvPut(env, 'push:subs', [...subs, sub].slice(-1000));
      return json({ ok: true });
    }
    if (url.pathname === '/api/push/unsubscribe' && request.method === 'POST') {
      const b = (await request.json()) as { endpoint?: string };
      await kvPut(env, 'push:subs', (await subsOf(env)).filter((x) => x.endpoint !== b.endpoint));
      return json({ ok: true });
    }
    if (url.pathname === '/api/push/latest') {
      const subs = await subsOf(env);
      const sub = subs.find((x) => x.endpoint === url.searchParams.get('endpoint')) ?? subs[subs.length - 1];
      return json(sub ? await pushMessage(env, sub) : { title: 'Angebotsküche', body: 'Neue Angebote der Woche sind da.' });
    }
    if (url.pathname === '/api/push/test' && request.method === 'POST' && env.CACHE) {
      const b = (await request.json()) as { endpoint?: string };
      if (!b.endpoint || !(await subsOf(env)).some((x) => x.endpoint === b.endpoint)) return error('Gerät nicht angemeldet', 404);
      if (!(await checkLimit(env, 'pushtest', 10))) return error('Heute genug getestet', 429);
      return json({ status: await sendPush(env.CACHE, b.endpoint) });
    }

    // Löscht Cookies und Speicher dieser Website im Browser (andere Websites bleiben unberührt)
    if (url.pathname === '/api/clear') {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'clear-site-data': '"cookies", "storage"' },
      });
    }

    // Nach der Anmeldung zurück in die App
    if (url.pathname === '/api/login') return Response.redirect(new URL('/', url).toString(), 302);

    if (url.pathname === '/api/img') {
      const u = url.searchParams.get('u');
      return u ? proxyImage(u) : error('Bild fehlt', 400);
    }

    // Welche Prospekte liegen eingelesen vor, und wann hat die KI sie gelesen?
    if (url.pathname === '/api/status') {
      const ids = parseIds(url.searchParams.get('markets'));
      const markets = (await Promise.all(ids.map((id) => marketById(env, id)))).filter((m): m is EdekaMarket => !!m);
      const prospekte = await Promise.all(
        markets.map(async (m) => {
          const idx = await kvGet<ProspektIndex>(env, `edeka:idx:${m.marketNo}`);
          const watch = (await kvGet<Watched[]>(env, 'edeka:watch'))?.find((w) => w.id === m.id);
          return {
            market: m.name,
            watched: !!watch,
            prospekte: (idx?.prospekte ?? []).map(({ key, ...rest }) => rest),
          };
        }),
      );
      const cron = await kvGet<{ at: string }>(env, 'cron:last');
      return json({ markets: prospekte, lastCheck: cron?.at ?? null, monthCostUsd: Math.round((await monthCost(env.CACHE)) * 100) / 100 });
    }

    if (url.pathname === '/api/deals') {
      const plz = url.searchParams.get('plz');
      if (!validPlz(plz)) return error('Bitte eine 5-stellige PLZ angeben.', 400);
      const markets = parseIds(url.searchParams.get('markets'));
      const data = await getOffers(env, plz, markets);
      return json(await computeDeals(env, plz, data.offers));
    }

    if (url.pathname === '/api/stores') {
      const plz = url.searchParams.get('plz');
      if (!validPlz(plz)) return error('Bitte eine 5-stellige PLZ angeben.', 400);
      const c = await centerOf(env, plz).catch(() => null);
      return json({ stores: await cached(env, `stores:${plz}`, 7 * 24 * HOUR, () => nearestStores(plz, c)) });
    }

    if (url.pathname === '/api/leaflets') {
      const plz = url.searchParams.get('plz');
      if (!validPlz(plz)) return error('Bitte eine 5-stellige PLZ angeben.', 400);
      return json(await getLeaflets(env, plz, parseIds(url.searchParams.get('markets'))));
    }

    // Stand des Prospekt-Einlesens für einen EDEKA-Markt
    if (url.pathname === '/api/debug/edeka') {
      const m = await marketById(env, Number(url.searchParams.get('market')));
      if (!m) return error('Markt unbekannt', 404);
      const idx = await kvGet<ProspektIndex>(env, `edeka:idx:${m.marketNo}`);
      const ps = await prospekteOf(env, m).catch((e) => String(e));
      const errs = Array.isArray(ps) ? await Promise.all(ps.map((p) => kvGet(env, errKey(p.key)))) : [];
      const watch = (await kvGet<Watched[]>(env, 'edeka:watch'))?.map((x) => `${x.name} (zuletzt ${new Date(x.lastSeen ?? 0).toISOString()})`);
      const first = idx?.prospekte[0] ? ((await kvGet<Offer[]>(env, pdfKey(idx.prospekte[0].key))) ?? []).slice(0, 15) : [];
      const week = await env.CACHE?.get(`extract:count:${isoWeek(new Date())}`);
      const gln = env.CACHE ? await getGln(env.CACHE, m.marketNo) : null;
      const mobile = await mobileOffers(env, m).catch((e) => String(e));
      return json({
        market: m,
        gln,
        mobile:
          mobile && typeof mobile === 'object'
            ? { national: mobile.national, count: mobile.offers.length, categories: mobile.categories, sample: mobile.offers.slice(0, 10).map((o) => `${o.name} | ${o.price} | ${o.group}`) }
            : mobile,
        relay: env.CACHE ? await relayStatus(env.CACHE) : null,
        watch,
        extractsThisWeek: Number(week ?? 0),
        idx,
        prospekte: ps,
        errors: errs,
        withCrop: first.filter((o) => o.crop).length,
        sample: first.map((o) => `${o.name} | ${o.price} | S.${o.page ?? '?'} | crop ${o.crop ? `${o.crop.x},${o.crop.y},${o.crop.w},${o.crop.h}` : 'KEIN'}`),
      });
    }

    // Prüft, welche Quellen vom Server aus erreichbar sind
    if (url.pathname === '/api/debug/sources') {
      const urls = [
        'https://www.edeka.de/api/marketsearch/markets?searchstring=38536',
        'https://www.edeka.de/eh/service/eh/offers?marketId=10007022',
        'https://www.edeka.de/maerkte/801116/prospekte/',
        'https://blaetterkatalog.edeka.de/MINDEN/8011165/blaetterkatalog/xml/catalog.xml',
        'https://blaetterkatalog.edeka.de/MINDEN/8011165/blaetterkatalog/normal/bk_1.jpg',
        'https://www.marktguru.de/',
        'https://www.aldi-nord.de/angebote.html',
        'https://www.aldi-sued.de/de/angebote.html',
        'https://overpass-api.de/api/status',
      ];
      const variants: Record<string, Record<string, string>> = {
        mobil: { 'user-agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36', 'accept-language': 'de-DE,de;q=0.9' },
        desktop: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
          accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
          'accept-language': 'de-DE,de;q=0.9,en;q=0.8',
          referer: 'https://www.edeka.de/',
        },
        ohne: {},
      };
      const out: Record<string, string> = {};
      for (const [name, headers] of Object.entries(variants)) {
        for (const u of urls) {
          try {
            const r = await fetch(u, { headers });
            out[`${name} ${u}`] = `${r.status} ${r.headers.get('content-type') ?? ''} ${r.headers.get('server') ?? ''}`;
          } catch (e) {
            out[`${name} ${u}`] = String(e);
          }
        }
      }
      return json(out);
    }

    // Abgleich zwischen Geräten (je angemeldetem Konto)
    if (url.pathname === '/api/sync') {
      if (!env.CACHE) return error('Keine Datenbank verbunden', 500);
      const key = syncKeyFor(user);
      const doc = (await kvGet<SyncDoc>(env, key)) ?? {};
      if (request.method === 'GET') return json({ email: user.email, doc });
      if (request.method === 'PUT') {
        const body = (await request.json().catch(() => null)) as { changes?: SyncDoc } | null;
        if (!body?.changes || typeof body.changes !== 'object') return error('Keine Änderungen', 400);
        const merged = mergeDocs(doc, body.changes);
        const size = JSON.stringify(merged).length;
        if (size > 5_000_000) return error('Zu viele Daten für den Abgleich', 413);
        await kvPut(env, key, merged);
        return json({ email: user.email, doc: merged });
      }
      return error('Methode nicht erlaubt', 405);
    }

    if (url.pathname === '/api/health') {
      return json({
        ok: true,
        hasKey: !!env.OPENROUTER_API_KEY,
        hasCache: !!env.CACHE,
        model: env.RECIPE_MODEL ?? null,
        extractModel: env.EXTRACT_MODEL ?? null,
        monthCostUsd: Math.round((await monthCost(env.CACHE)) * 100) / 100,
        budgetUsd: budget(env),
        userCostToday: Math.round((await dayCost(env.CACHE, user.id)) * 1000) / 1000,
        userBudgetUsd: userBudget(env, user),
      });
    }

    // EDEKA blockt die Cloud: Das Handy holt die Marktliste selbst und meldet sie hier an
    if (url.pathname === '/api/edeka/markets' && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as { plz?: string; markets?: unknown } | null;
      const plz = body?.plz ?? null;
      if (!validPlz(plz)) return error('Bitte eine 5-stellige PLZ angeben.', 400);
      const list = await nearestFirst(env, plz, parseMarkets(body?.markets));
      await rememberMarkets(env, plz, list);
      return json({ nearby: list.map((m) => marketChainInfo(m)) });
    }

    if (url.pathname === '/api/offers' && request.method === 'GET') {
      const plz = url.searchParams.get('plz');
      if (!validPlz(plz)) return error('Bitte eine 5-stellige PLZ angeben.', 400);
      const data = await getOffers(env, plz, parseIds(url.searchParams.get('markets')), url.searchParams.get('refresh') === '1');
      await ensureSnapshot(env, plz, data.offers).catch(() => undefined);
      return json(data);
    }

    if (url.pathname === '/api/recipes' && request.method === 'POST') {
      if (!env.OPENROUTER_API_KEY || !env.RECIPE_MODEL) {
        return error('OpenRouter ist nicht eingerichtet (OPENROUTER_API_KEY und RECIPE_MODEL in der .env).', 500);
      }
      const body = (await request.json()) as RecipeRequest;
      if (!validPlz(body.plz)) return error('Bitte eine 5-stellige PLZ angeben.', 400);
      if (await overBudget(env)) {
        return error(`Das KI-Budget von ${budget(env)} $ für diesen Monat ist aufgebraucht. Ab dem 1. geht es weiter.`, 429);
      }
      if (await userOverBudget(env, user)) {
        return error(`Dein KI-Budget von ${userBudget(env, user).toFixed(2)} $ für heute ist aufgebraucht. Morgen geht es weiter.`, 429);
      }
      const data = await getOffers(env, body.plz, (body.markets ?? []).slice(0, 6));
      return json(await generateRecipes(body, data.offers, env, tracker(env, user)));
    }

    // Prospekt eines Markts sofort einlesen (sonst macht das der Cron alle 30 Minuten)
    if (url.pathname === '/api/admin/extract') {
      const id = Number(url.searchParams.get('market'));
      const m = await marketById(env, id);
      if (!m) return error('Markt unbekannt – erst über die PLZ suchen.', 404);
      if (!(await checkLimit(env, 'extract', 6))) return error('Heute schon oft genug eingelesen.', 429);
      if (await overBudget(env)) return error('Das KI-Budget für diesen Monat ist aufgebraucht.', 429);
      if (await userOverBudget(env, user)) return error('Dein KI-Budget für heute ist aufgebraucht.', 429);
      // Antwort streamen, damit die Verbindung während des Einlesens offen bleibt
      const { readable, writable } = new TransformStream();
      const w = writable.getWriter();
      const enc = new TextEncoder();
      const tick = setInterval(() => void w.write(enc.encode('.')), 10_000);
      (async () => {
        try {
          await watchMarket(env, m);
          const log = await processMarket(env, m, 2, user);
          await w.write(enc.encode('\n' + JSON.stringify({ log })));
        } catch (e) {
          await w.write(enc.encode('\n' + JSON.stringify({ error: String(e) })));
        } finally {
          clearInterval(tick);
          await w.close();
        }
      })();
      return new Response(readable, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
    }

    return error('Unbekannter Pfad', 404);
  } catch (e) {
    console.error(e);
    return error(e instanceof Error ? e.message : String(e), 502);
  }
}
