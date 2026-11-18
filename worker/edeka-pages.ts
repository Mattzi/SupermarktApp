// Seiten von www.edeka.de, die einmal pro Markt gebraucht werden: GLN (für die App-Schnittstelle) und Blätterkatalog-Adresse.
// Die Abrufe stehen in einer Warteschlange und laufen über den Tailscale-Proxy (edeka-fetch.ts). Schlägt einer fehl
// (Exit Node aus, EDEKA zickt), wird er beim nächsten Durchlauf erneut versucht.
import type { Kv } from './kv';
import { catalogPathsFromHtml, glnFromHtml, H } from './edeka';
import { edekaFetch } from './edeka-fetch';

export type JobKind = 'markt' | 'prospekte';
export interface PageJob {
  id: string;
  kind: JobKind;
  marketNo: string;
  url: string;
  tries: number;
  leasedAt?: number;
}

const JOBS = 'relay:jobs';
const LEASE_MS = 10 * 60_000;
const RETRY_MS = 5 * 60_000;
const MAX_TRIES = 5;

export const glnKey = (marketNo: string) => `edeka:gln:${marketNo}`;
export const katKey = (marketNo: string) => `edeka:kat:${marketNo}`;
/** Gespeicherte GLN, "none" (Seite ohne GLN) oder null (noch unbekannt) */
export const getGln = (kv: Kv, marketNo: string) => kv.get(glnKey(marketNo));

const urlFor = (kind: JobKind, marketNo: string) =>
  kind === 'markt' ? `https://www.edeka.de/maerkte/${marketNo}/` : `https://www.edeka.de/maerkte/${marketNo}/prospekte/`;

async function jobs(kv: Kv): Promise<PageJob[]> {
  return (await kv.get<PageJob[]>(JOBS, 'json')) ?? [];
}

/** Fehlende Daten eines Markts in die Warteschlange legen (doppelte Aufträge werden ignoriert) */
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

/** Offene Aufträge reservieren (10 Minuten, damit sie nicht doppelt laufen) */
export async function leaseJobs(kv: Kv, max = 5): Promise<PageJob[]> {
  const list = await jobs(kv);
  const now = Date.now();
  const free = list.filter((j) => !j.leasedAt || now - j.leasedAt > LEASE_MS).slice(0, max);
  if (!free.length) return [];
  const ids = new Set(free.map((j) => j.id));
  await kv.put(JOBS, JSON.stringify(list.map((j) => (ids.has(j.id) ? { ...j, leasedAt: now } : j))));
  return free.map(({ id, url }) => ({ id, url }) as PageJob);
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
  // leasedAt so setzen, dass der Auftrag nach RETRY_MS wieder frei ist
  const leasedAt = Date.now() - LEASE_MS + RETRY_MS;
  await kv.put(JOBS, JSON.stringify(tries >= MAX_TRIES ? rest : [...rest, { ...job, tries, leasedAt }]));
  return tries >= MAX_TRIES ? `aufgegeben nach ${tries} Versuchen (HTTP ${status})` : `HTTP ${status}, neuer Versuch später`;
}

/** Offene Aufträge abarbeiten: Seiten über den Proxy laden und auswerten */
export async function runJobs(kv: Kv, max = 5): Promise<string[]> {
  const log: string[] = [];
  for (const job of await leaseJobs(kv, max)) {
    let status: number;
    let body = '';
    try {
      const res = await edekaFetch(job.url, { headers: H });
      status = res.status;
      body = (await res.text()).slice(0, 3_000_000);
    } catch (e) {
      status = 0;
      log.push(`${job.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
    log.push(`${job.id}: ${await completeJob(kv, job.id, status, body)}`);
  }
  if (log.length) await kv.put('relay:lastRun', JSON.stringify({ at: new Date().toISOString(), log }));
  return log;
}

export async function queueStatus(kv: Kv) {
  return { lastRun: await kv.get('relay:lastRun', 'json'), jobs: (await jobs(kv)).map(({ kind, marketNo, tries, leasedAt }) => ({ kind, marketNo, tries, leasedAt })) };
}
