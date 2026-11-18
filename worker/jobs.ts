// Warteschlange für Rezept-Aufträge. Die App legt einen Auftrag an und holt das Ergebnis später ab;
// die Worker (queue.ts) arbeiten die Aufträge im Hintergrund ab, auch wenn die App längst zu ist.
// Postgres: Tabelle recipe_jobs, Aufträge werden mit "for update skip locked" vergeben (auch mit mehreren Pods sicher).
import postgres from 'postgres';
import type { JobInfo, JobStatus, RecipeRequest, RecipesResponse } from '../shared/types';

export interface Job extends JobInfo {
  userId: string;
  request: RecipeRequest;
  result?: RecipesResponse;
}

export interface JobStore {
  enqueue(userId: string, request: RecipeRequest, replaceId?: string): Promise<Job>;
  /** Nächsten wartenden Auftrag übernehmen (Status → running) */
  claim(): Promise<Job | null>;
  finish(id: string, result: RecipesResponse): Promise<void>;
  fail(id: string, message: string): Promise<void>;
  get(userId: string, id: string): Promise<Job | null>;
  /** Aufträge eines Nutzers, neueste zuerst (ohne Ergebnis) */
  list(userId: string): Promise<JobInfo[]>;
  remove(userId: string, id: string): Promise<void>;
  /** Wartende + laufende Aufträge eines Nutzers */
  openCount(userId: string): Promise<number>;
  /** Hängengebliebene Aufträge (z. B. nach Neustart) wieder einreihen bzw. nach zu vielen Versuchen verwerfen */
  requeueStale(minutes: number, maxAttempts: number): Promise<number>;
  /** Alte Aufträge löschen (Tage nach Fertigstellung) */
  cleanup(days: number): Promise<number>;
}

type Row = {
  id: string;
  user_id: string;
  status: JobStatus;
  request: RecipeRequest;
  replace_id: string | null;
  result: RecipesResponse | null;
  error: string | null;
  created_at: Date;
  finished_at: Date | null;
  recipe_count?: number | null;
};

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : undefined);
const info = (r: Row): JobInfo => ({
  id: r.id,
  status: r.status,
  createdAt: iso(r.created_at)!,
  finishedAt: iso(r.finished_at),
  error: r.error ?? undefined,
  replaceId: r.replace_id ?? undefined,
  recipeCount: r.recipe_count ?? r.result?.recipes?.length ?? undefined,
});
const full = (r: Row): Job => ({ ...info(r), userId: r.user_id, request: r.request, result: r.result ?? undefined });

export async function pgJobs(url: string): Promise<JobStore & { close(): Promise<void> }> {
  const sql = postgres(url, { max: 4, idle_timeout: 30, onnotice: () => undefined });
  await sql`
    create table if not exists recipe_jobs (
      id uuid primary key default gen_random_uuid(),
      user_id text not null,
      status text not null default 'queued',
      request jsonb not null,
      replace_id text,
      result jsonb,
      error text,
      attempts int not null default 0,
      created_at timestamptz not null default now(),
      started_at timestamptz,
      finished_at timestamptz
    )`;
  await sql`create index if not exists recipe_jobs_user on recipe_jobs (user_id, created_at desc)`;
  await sql`create index if not exists recipe_jobs_status on recipe_jobs (status, created_at)`;

  return {
    async enqueue(userId, request, replaceId) {
      const [r] = await sql<Row[]>`
        insert into recipe_jobs (user_id, request, replace_id) values (${userId}, ${sql.json(request as never)}, ${replaceId ?? null})
        returning *`;
      return full(r);
    },
    async claim() {
      const [r] = await sql<Row[]>`
        update recipe_jobs set status = 'running', started_at = now(), attempts = attempts + 1
        where id = (select id from recipe_jobs where status = 'queued' order by created_at for update skip locked limit 1)
        returning *`;
      return r ? full(r) : null;
    },
    async finish(id, result) {
      await sql`update recipe_jobs set status = 'done', result = ${sql.json(result as never)}, error = null, finished_at = now() where id = ${id}`;
    },
    async fail(id, message) {
      await sql`update recipe_jobs set status = 'failed', error = ${message.slice(0, 500)}, finished_at = now() where id = ${id}`;
    },
    async get(userId, id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
      const [r] = await sql<Row[]>`select * from recipe_jobs where id = ${id} and user_id = ${userId}`;
      return r ? full(r) : null;
    },
    async list(userId) {
      const rows = await sql<Row[]>`
        select id, user_id, status, request, replace_id, null::jsonb as result, error, created_at, finished_at,
               jsonb_array_length(coalesce(result->'recipes', '[]'::jsonb)) as recipe_count
        from recipe_jobs where user_id = ${userId} order by created_at desc limit 20`;
      return rows.map(info);
    },
    async remove(userId, id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return;
      await sql`delete from recipe_jobs where id = ${id} and user_id = ${userId}`;
    },
    async openCount(userId) {
      const [r] = await sql<{ n: number }[]>`select count(*)::int as n from recipe_jobs where user_id = ${userId} and status in ('queued', 'running')`;
      return r?.n ?? 0;
    },
    async requeueStale(minutes, maxAttempts) {
      const cutoff = new Date(Date.now() - minutes * 60_000);
      await sql`update recipe_jobs set status = 'failed', error = 'Der Server wurde währenddessen neu gestartet. Bitte nochmal versuchen.', finished_at = now()
        where status = 'running' and started_at < ${cutoff} and attempts >= ${maxAttempts}`;
      const res = await sql`update recipe_jobs set status = 'queued' where status = 'running' and started_at < ${cutoff} and attempts < ${maxAttempts}`;
      return res.count;
    },
    async cleanup(days) {
      const cutoff = new Date(Date.now() - days * 86400_000);
      const res = await sql`delete from recipe_jobs where status in ('done', 'failed') and finished_at < ${cutoff}`;
      return res.count;
    },
    close: () => sql.end({ timeout: 5 }),
  };
}

/** Nur für Tests und lokales Entwickeln ohne Datenbank */
export function memoryJobs(): JobStore {
  const rows: (Job & { attempts: number; startedAt?: number })[] = [];
  let n = 0;
  const strip = ({ userId, request, result, attempts, startedAt, ...i }: Job & { attempts: number; startedAt?: number }): JobInfo => ({
    ...i,
    recipeCount: result?.recipes?.length,
  });
  return {
    async enqueue(userId, request, replaceId) {
      const j = { id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, status: 'queued' as const, createdAt: new Date().toISOString(), userId, request, replaceId, attempts: 0 };
      rows.push(j);
      return j;
    },
    async claim() {
      const j = rows.find((x) => x.status === 'queued');
      if (!j) return null;
      j.status = 'running';
      j.startedAt = Date.now();
      j.attempts++;
      return { ...j };
    },
    async finish(id, result) {
      const j = rows.find((x) => x.id === id);
      if (j) Object.assign(j, { status: 'done', result, error: undefined, finishedAt: new Date().toISOString() });
    },
    async fail(id, message) {
      const j = rows.find((x) => x.id === id);
      if (j) Object.assign(j, { status: 'failed', error: message, finishedAt: new Date().toISOString() });
    },
    async get(userId, id) {
      const j = rows.find((x) => x.id === id && x.userId === userId);
      return j ? { ...j } : null;
    },
    async list(userId) {
      return rows.filter((x) => x.userId === userId).reverse().map(strip);
    },
    async remove(userId, id) {
      const i = rows.findIndex((x) => x.id === id && x.userId === userId);
      if (i >= 0) rows.splice(i, 1);
    },
    async openCount(userId) {
      return rows.filter((x) => x.userId === userId && (x.status === 'queued' || x.status === 'running')).length;
    },
    async requeueStale(minutes, maxAttempts) {
      let c = 0;
      for (const j of rows) {
        if (j.status !== 'running' || !j.startedAt || j.startedAt > Date.now() - minutes * 60_000) continue;
        if (j.attempts >= maxAttempts) Object.assign(j, { status: 'failed', error: 'Der Server wurde währenddessen neu gestartet. Bitte nochmal versuchen.' });
        else {
          j.status = 'queued';
          c++;
        }
      }
      return c;
    },
    async cleanup(days) {
      const cutoff = Date.now() - days * 86400_000;
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) {
        const f = rows[i].finishedAt;
        if ((rows[i].status === 'done' || rows[i].status === 'failed') && f && Date.parse(f) < cutoff) rows.splice(i, 1);
      }
      return before - rows.length;
    },
  };
}
