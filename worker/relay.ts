// Relay für www.edeka.de: Die Website blockt Rechenzentren (auch Hetzner). Ein kleines Programm an einem
// privaten Anschluss (relay/relay.mjs) holt sich hier Aufträge ab, lädt die Seiten und schickt sie zurück.
// Gebraucht wird das nur einmal pro Markt: für die GLN (App-Schnittstelle) und die Blätterkatalog-Adresse.
import type { Kv } from './kv';
import { catalogPathsFromHtml, glnFromHtml } from './edeka';

export type JobKind = 'markt' | 'prospekte';
export interface RelayJob {
  id: string;
  kind: JobKind;
  marketNo: string;
  url: string;
  tries: number;
  leasedAt?: number;
}

const JOBS = 'relay:jobs';
const LEASE_MS = 10 * 60_000;
const MAX_TRIES = 5;

export const glnKey = (marketNo: string) => `edeka:gln:${marketNo}`;
export const katKey = (marketNo: string) => `edeka:kat:${marketNo}`;
/** Gespeicherte GLN, "none" (Seite ohne GLN) oder null (noch unbekannt) */
export const getGln = (kv: Kv, marketNo: string) => kv.get(glnKey(marketNo));

const urlFor = (kind: JobKind, marketNo: string) =>
  kind === 'markt' ? `https://www.edeka.de/maerkte/${marketNo}/` : `https://www.edeka.de/maerkte/${marketNo}/prospekte/`;

async function jobs(kv: Kv): Promise<RelayJob[]> {
  return (await kv.get<RelayJob[]>(JOBS, 'json')) ?? [];
}

/** Fehlende Daten eines Markts beim Relay anfragen (doppelte Aufträge werden ignoriert) */
export async function requestMarketData(kv: Kv, marketNo: string): Promise<void> {
  if (!/^\d+$/.test(marketNo)) return;
  const [gln, kat] = await Promise.all([kv.get(glnKey(marketNo)), kv.get(katKey(marketNo))]);
  const need: JobKind[] = [...(gln ? [] : ['markt' as const]), ...(kat ? [] : ['prospekte' as const])];
  if (!need.length) return;
  const list = await jobs(kv);
  const add = need.filter((k) => !list.some((j) => j.kind === k && j.marketNo === marketNo));
  if (!add.length) return;
  await kv.put(
    JOBS,
    JSON.stringify([...list, ...add.map((kind) => ({ id: `${kind}-${marketNo}`, kind, marketNo, url: urlFor(kind, marketNo), tries: 0 }))].slice(-200)),
  );
}

/** Aufträge für das Relay (werden 10 Minuten reserviert, damit sie nicht doppelt laufen) */
export async function leaseJobs(kv: Kv, max = 5): Promise<RelayJob[]> {
  await kv.put('relay:lastSeen', new Date().toISOString());
  const list = await jobs(kv);
  const now = Date.now();
  const free = list.filter((j) => !j.leasedAt || now - j.leasedAt > LEASE_MS).slice(0, max);
  if (!free.length) return [];
  const ids = new Set(free.map((j) => j.id));
  await kv.put(JOBS, JSON.stringify(list.map((j) => (ids.has(j.id) ? { ...j, leasedAt: now } : j))));
  return free.map(({ id, url }) => ({ id, url }) as RelayJob);
}

/** Ergebnis eines Auftrags auswerten und speichern */
export async function completeJob(kv: Kv, id: string, status: number, body: string): Promise<string> {
  const list = await jobs(kv);
  const job = list.find((j) => j.id === id);
  if (!job) return 'Auftrag unbekannt';
  const rest = list.filter((j) => j.id !== id);
  let note: string;
  if (status === 200) {
    if (job.kind === 'markt') {
      const gln = glnFromHtml(body);
      // Seite geladen, aber keine GLN darin: merken, damit der Prospekt-Weg nicht ewig wartet
      await kv.put(glnKey(job.marketNo), gln ?? 'none', { expirationTtl: (gln ? 180 : 14) * 86400 });
      note = gln ? `GLN ${gln}` : 'keine GLN auf der Seite';
    } else {
      const paths = catalogPathsFromHtml(body);
      if (paths.length) await kv.put(katKey(job.marketNo), JSON.stringify(paths));
      note = paths.length ? `Blätterkatalog ${paths.join(', ')}` : 'kein Blätterkatalog auf der Seite';
    }
    await kv.put(JOBS, JSON.stringify(rest));
    return note;
  }
  // Fehlgeschlagen: später nochmal, nach einigen Versuchen aufgeben
  const tries = job.tries + 1;
  await kv.put(JOBS, JSON.stringify(tries >= MAX_TRIES ? rest : [...rest, { ...job, tries, leasedAt: Date.now() }]));
  return tries >= MAX_TRIES ? `aufgegeben nach ${tries} Versuchen (HTTP ${status})` : `HTTP ${status}, neuer Versuch später`;
}

export async function relayStatus(kv: Kv) {
  return { lastSeen: await kv.get('relay:lastSeen'), jobs: (await jobs(kv)).map(({ kind, marketNo, tries, leasedAt }) => ({ kind, marketNo, tries, leasedAt })) };
}
