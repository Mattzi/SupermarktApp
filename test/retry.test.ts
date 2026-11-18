import { generateRecipes } from '../worker/recipes';
import type { Offer } from '../shared/types';
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) { console.error('FAIL', m, a, b); process.exitCode = 1; } else console.log('ok', m); };

const offers = [1, 2, 3, 4].map((id) => ({ id, chain: id < 3 ? 'REWE' : 'EDEKA Test', name: `Produkt ${id}`, price: 1.5, pack: '500 g', group: 'gemuese', diet: 'vegan', cooking: true, validFrom: '2020-01-01T00:00:00Z', validTo: '2099-01-01T00:00:00Z', desc: '' })) as unknown as Offer[];
const ing = (name: string, offerId: number | null) => ({ name, quantity: '1', offerId, packs: 1, estimatedPrice: offerId ? null : 1, pantry: false });
const recipe = (title: string, withOffers: boolean) => ({ title, description: '', minutes: 10, diet: 'vegan', steps: ['x'], storage: '', ingredients: withOffers ? [ing('Produkt 1', 1), ing('Produkt 3', 3), ing('Extra', null)] : [ing('Zeug A', null), ing('Zeug B', null), ing('Zeug C', null)] });

const req = { plz: '90478', chains: ['REWE', 'EDEKA Test'], markets: [], diet: 'alles', persons: 1, days: 1, maxMinutes: null } as never;
const env = { OPENROUTER_API_KEY: 'x', RECIPE_MODEL: 'm' } as never;
const origFetch = globalThis.fetch;
const reply = (recipes: unknown[]) => new Response(JSON.stringify({ model: 'm', usage: { cost: 0.01 }, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ recipes }) } }] }), { headers: { 'content-type': 'application/json' } });
const prompts: string[] = [];
const mock = (answers: unknown[][]) => {
  let i = 0;
  globalThis.fetch = (async (_u: unknown, init: { body: string }) => {
    prompts.push(JSON.parse(init.body).messages[1].content);
    return reply(answers[Math.min(i++, answers.length - 1)]);
  }) as never;
};
console.warn = () => undefined;

(async () => {
  // 1. Versuch: 5 Rezepte ohne Angebote, 2. Versuch: 5 gute
  mock([[1, 2, 3, 4, 5].map((n) => recipe(`schlecht ${n}`, false)), [1, 2, 3, 4, 5].map((n) => recipe(`gut ${n}`, true))]);
  const tracked: number[] = [];
  const res = await generateRecipes(req, offers, env, async (u) => { tracked.push(u); });
  eq(res.recipes.length, 5, 'Neuversuch liefert 5 gute Rezepte');
  eq(res.recipes.every((r) => r.title.startsWith('gut')), true, 'schlechte Rezepte kommen nicht durch');
  eq(tracked, [0.01, 0.01], 'Kosten beider Versuche gezählt');
  eq(res.costUsd, 0.02, 'Gesamtkosten');
  eq(prompts[1].includes('Beim letzten Versuch'), true, 'Hinweis im zweiten Versuch');

  // Mischung: 3 gute + 2 schlechte, dann 2 gute nachgefordert
  prompts.length = 0;
  mock([[...[1, 2, 3].map((n) => recipe(`gut ${n}`, true)), ...[1, 2].map((n) => recipe(`schlecht ${n}`, false))], [4, 5].map((n) => recipe(`gut ${n}`, true))]);
  const r2 = await generateRecipes(req, offers, env);
  eq(r2.recipes.length, 5, 'fehlende 2 nachgefordert');
  eq(prompts[1].includes('Erstelle 2 Rezepte'), true, 'zweiter Versuch fordert nur die fehlenden an');

  // Nie brauchbar → Fehler statt schlechte Rezepte
  mock([[1, 2].map((n) => recipe(`schlecht ${n}`, false))]);
  let msg = '';
  try { await generateRecipes(req, offers, env); } catch (e) { msg = (e as Error).message; }
  eq(msg.includes('ohne Angebote'), true, 'Fehler wenn nie brauchbar');

  // Ersatz-Rezept (replace): 1 Rezept
  mock([[recipe('gut', true)]]);
  const r3 = await generateRecipes({ ...(req as object), replace: { avoidTitles: [] } } as never, offers, env);
  eq(r3.recipes.length, 1, 'Ersatz: ein Rezept');
  globalThis.fetch = origFetch;
})();
