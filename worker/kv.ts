// Schlüssel-Wert-Speicher mit Ablaufzeit (früher Cloudflare KV, jetzt eine Tabelle in Postgres).
// Die Schnittstelle entspricht dem Teil von KV, den die App nutzt, damit der übrige Code gleich bleibt.
import postgres from 'postgres';

export interface Kv {
  get(key: string): Promise<string | null>;
  get<T>(key: string, type: 'json'): Promise<T | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export async function pgKv(url: string): Promise<Kv & { cleanup(): Promise<number>; close(): Promise<void> }> {
  const sql = postgres(url, { max: 10, idle_timeout: 30, onnotice: () => undefined });
  await sql`
    create table if not exists kv (
      key text primary key,
      value text not null,
      expires_at timestamptz
    )`;
  await sql`create index if not exists kv_expires_at on kv (expires_at) where expires_at is not null`;

  async function get(key: string, type?: 'json'): Promise<any> {
    const [row] = await sql<{ value: string }[]>`
      select value from kv where key = ${key} and (expires_at is null or expires_at > now())`;
    if (!row) return null;
    if (type !== 'json') return row.value;
    try {
      return JSON.parse(row.value);
    } catch {
      return null;
    }
  }

  return {
    get,
    async put(key, value, opts) {
      const ttl = opts?.expirationTtl;
      const expires = ttl ? new Date(Date.now() + Math.max(60, ttl) * 1000) : null;
      await sql`
        insert into kv (key, value, expires_at) values (${key}, ${value}, ${expires})
        on conflict (key) do update set value = excluded.value, expires_at = excluded.expires_at`;
    },
    async delete(key) {
      await sql`delete from kv where key = ${key}`;
    },
    async cleanup() {
      const res = await sql`delete from kv where expires_at is not null and expires_at <= now()`;
      return res.count;
    },
    close: () => sql.end({ timeout: 5 }),
  };
}

/** Nur für Tests und lokales Entwickeln ohne Datenbank */
export function memoryKv(): Kv {
  const m = new Map<string, { v: string; exp?: number }>();
  const read = (key: string) => {
    const e = m.get(key);
    if (!e) return null;
    if (e.exp && e.exp <= Date.now()) {
      m.delete(key);
      return null;
    }
    return e.v;
  };
  return {
    async get(key: string, type?: 'json'): Promise<any> {
      const v = read(key);
      if (v == null || type !== 'json') return v;
      try {
        return JSON.parse(v);
      } catch {
        return null;
      }
    },
    async put(key, value, opts) {
      m.set(key, { v: value, exp: opts?.expirationTtl ? Date.now() + Math.max(60, opts.expirationTtl) * 1000 : undefined });
    },
    async delete(key) {
      m.delete(key);
    },
  };
}
