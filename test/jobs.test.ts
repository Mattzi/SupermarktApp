import { memoryJobs } from '../worker/jobs';
import { startWorkers } from '../worker/queue';
import type { RecipeRequest, RecipesResponse } from '../shared/types';
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) { console.error('FAIL', m, a, b); process.exitCode = 1; } else console.log('ok', m); };
const req = { plz: '32423' } as RecipeRequest;
const res = (n: number) => ({ recipes: Array.from({ length: n }, () => ({})) }) as unknown as RecipesResponse;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const jobs = memoryJobs();
  for (let i = 0; i < 6; i++) await jobs.enqueue('u1', req);
  await jobs.enqueue('u2', req, 'rid');
  eq(await jobs.openCount('u1'), 6, 'offene Aufträge u1');

  let active = 0, peak = 0;
  const w = startWorkers(
    jobs,
    async (j) => {
      active++; peak = Math.max(peak, active);
      await sleep(30);
      if (j.userId === 'u2') await jobs.fail(j.id, 'kaputt'); else await jobs.finish(j.id, res(3));
      active--;
    },
    3,
    () => undefined,
  );
  await sleep(400);
  w.stop();
  eq(peak, 3, 'höchstens 3 gleichzeitig');
  eq(await jobs.openCount('u1'), 0, 'alle fertig');
  const list = await jobs.list('u1');
  eq([list.length, list[0].status, list[0].recipeCount], [6, 'done', 3], 'Liste mit Rezeptanzahl');
  eq((await jobs.list('u2'))[0].status, 'failed', 'Fehler gespeichert');
  eq(await jobs.get('u2', list[0].id), null, 'fremder Auftrag nicht abrufbar');
  const got = await jobs.get('u1', list[0].id);
  eq(got?.result?.recipes.length, 3, 'Ergebnis abholbar');
  await jobs.remove('u1', list[0].id);
  eq((await jobs.list('u1')).length, 5, 'abgeholt = gelöscht');

  // hängender Auftrag wird neu eingereiht
  const j = await jobs.enqueue('u3', req);
  await jobs.claim();
  eq(await jobs.requeueStale(0, 2), 1, 'hängender Auftrag neu eingereiht');
  eq((await jobs.claim())?.id, j.id, 'wieder vergeben');
  eq(await jobs.requeueStale(0, 2), 0, 'nach 2 Versuchen nicht mehr (wird verworfen)');
  eq((await jobs.list('u3'))[0].status, 'failed', 'verworfen = fehlgeschlagen');
})();
