// Kosten der KI-Aufrufe mitzählen: gesamt pro Monat (Notbremse) und je Konto pro Tag.
// Die Kosten liefert OpenRouter bei jeder Antwort mit (usage.cost, in US-Dollar).
import type { Kv } from './kv';

const monthKey = () => `cost:${new Date().toISOString().slice(0, 7)}`;
const dayKey = (user: string) => `cost:u:${user}:${new Date().toISOString().slice(0, 10)}`;

export async function monthCost(kv: Kv | undefined): Promise<number> {
  if (!kv) return 0;
  return Number((await kv.get(monthKey())) ?? 0);
}

/** Heutige Kosten eines Kontos (user = gehashte Kennung, siehe auth.ts) */
export async function dayCost(kv: Kv | undefined, user: string): Promise<number> {
  if (!kv) return 0;
  return Number((await kv.get(dayKey(user))) ?? 0);
}

export async function addCost(kv: Kv | undefined, usd: number, user?: string): Promise<void> {
  if (!kv || !usd) return;
  await kv.put(monthKey(), ((await monthCost(kv)) + usd).toFixed(5), { expirationTtl: 70 * 86400 });
  if (user) await kv.put(dayKey(user), ((await dayCost(kv, user)) + usd).toFixed(5), { expirationTtl: 3 * 86400 });
}

export type Tracker = (usd: number) => Promise<void>;
