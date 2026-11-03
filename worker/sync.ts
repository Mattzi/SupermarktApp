// Geräteübergreifender Abgleich je angemeldetem Konto (wer angemeldet ist, steht in auth.ts).

export interface SyncEntry {
  /** gespeicherter Wert (null = gelöscht) */
  v: unknown;
  /** Zeitpunkt der letzten Änderung (ms) */
  t: number;
}
export type SyncDoc = Record<string, SyncEntry>;

/** Bereiche, die abgeglichen werden dürfen */
export const isSyncKey = (k: string) =>
  ['settings', 'trip', 'cart', 'shopping', 'saved', 'lastRecipes', 'watch'].includes(k) || /^savings:\d{4}-\d{2}$/.test(k);

/** Neuere Änderung gewinnt, je Bereich */
export function mergeDocs(base: SyncDoc, changes: SyncDoc): SyncDoc {
  const out: SyncDoc = { ...base };
  for (const [k, e] of Object.entries(changes)) {
    if (!isSyncKey(k) || !e || typeof e.t !== 'number') continue;
    if (!out[k] || e.t > out[k].t) out[k] = { v: e.v ?? null, t: Math.min(e.t, Date.now() + 60_000) };
  }
  return out;
}
