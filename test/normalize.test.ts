import { parseDeal, cleanDesc, detectDiet } from '../worker/normalize';
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) { console.error('FAIL', m, a, b); process.exitCode = 1; } else console.log('ok', m); };
eq(parseDeal('HINWEIS: MIT PENNY APP 4.79 € Zum Braten, je 500-g-Packung', 4.99), { appPrice: 4.79, note: 'Mit Penny App 4,79 €' }, 'penny');
eq(parseDeal('HINWEIS: MIT APP 0,10 € REWE BONUS je 200-g-Becher', 0.99), { note: '0,10 € REWE Bonus mit App' }, 'rewe bonus');
eq(parseDeal('HINWEIS: MIT KAUFLAND CARD XTRA 1.39€ halbfester Schnittkäse', 1.79), { appPrice: 1.39, note: 'Mit Kaufland Card Xtra 1,39 €' }, 'kaufland card');
eq(parseDeal('HINWEIS: MIT KAUFLAND CARD XTRA Kichererbsen je 400-g-Dose Normalpreis = 2.29', 0.99), { note: 'Preis nur mit Kaufland Card Xtra', oldPrice: 2.29 }, 'kaufland plain');
eq(parseDeal('HINWEIS: MIT LIDL PLUS APP 1.99 € Versch. Sorten', 2.19), { appPrice: 1.99, note: 'Mit Lidl Plus App 1,99 €' }, 'lidl plus');
eq(parseDeal('Je 3 Stück. Normalpreis: 1.35', 0.9), { oldPrice: 1.35 }, 'normalpreis');
eq(cleanDesc('HINWEIS: MIT PENNY APP 4.79 € Zum Braten, je 500-g-Packung'), 'Zum Braten, je 500-g-Packung', 'clean penny');
eq(cleanDesc('HINWEIS: MIT APP 0,10 € REWE BONUS je 200-g-Becher'), 'je 200-g-Becher', 'clean rewe');
eq(cleanDesc('HINWEIS: MIT KAUFLAND CARD XTRA 750 g Wonder Zimties Normalpreis = 2.79'), '750 g Wonder Zimties', 'clean kaufland');
eq(detectDiet('Heringsdoppelfilet', 'Heringsdoppelfilet mariniertes Fleisch', [313], [103]), 'fisch', 'hering');
eq(detectDiet('Kasseler Lachs', 'Kasseler Lachs Schinken', [219], [104]), 'fleisch', 'kasseler');
eq(detectDiet('Fertiggericht', 'Fertiggericht Frosta Tiefkühlgerichte Rahm-Geschnetzeltes, Paprika-Sahne- Hähnchen', [354], [120]), 'fleisch', 'frosta');
eq(detectDiet('Hühnereier', 'Hühnereier Eier', [324], [107]), 'vegetarisch', 'eier');
eq(detectDiet('Pasta', 'Pasta Delverde Nudeln', [118], [16]), 'vegan', 'pasta');
eq(detectDiet('Feinschmecker Sauce', 'Feinschmecker Sauce Knorr Soßen', [334], [112]), 'vegetarisch', 'sauce');
eq(detectDiet('Broccoli', 'Broccoli Brokkoli und Kohl', [433], [147]), 'vegan', 'broccoli');

// Preisberechnung: ungültige Angebots-ID wird über den Namen zugeordnet
import { priceRecipe } from '../worker/recipes';
import type { Offer } from '../shared/types';
const offer = { id: 7, chain: 'Lidl', name: 'Bio Rote Linsen', price: 1.29, pack: '500 g' } as Offer;
const rec = priceRecipe(
  { title: 't', description: '', minutes: 10, diet: 'vegan', steps: [], storage: '', ingredients: [
    { name: 'Bio Rote Linsen (Golden Sun)', quantity: '200 g', offerId: 999, packs: 1, estimatedPrice: null, usedFraction: 0.4, pantry: false },
    { name: 'Salz', quantity: '', offerId: null, packs: null, estimatedPrice: null, usedFraction: null, pantry: true },
  ] },
  new Map([[7, offer]]), 2, 0);
eq([rec.totalCost, rec.usedCost, rec.perPortion, rec.chains], [1.29, 0.52, 0.26, ['Lidl']], 'name fallback');

// Gruppen/Ernährung für Märkte ohne Kategorien
import { dietFor, guessGroup } from '../worker/aldi';
eq(dietFor(guessGroup('Hähnchenbrustfilet-Teilstücke XXL Frisch; zum Braten', 'vorrat'), 'Hähnchenbrustfilet-Teilstücke XXL', 'x'), 'fleisch', 'aldi haehnchen');
eq(guessGroup('Superberliner', 'vorrat'), 'vorrat', 'berliner group');
eq(guessGroup('Home Barista Forte', 'vorrat'), 'getraenke', 'barista');
eq(guessGroup('Lachsfiletportionen Frisch; aus Norwegen', 'vorrat'), 'fisch', 'lachs');
eq(guessGroup('Weihenstephan Tafelbutter oder Die Streichzarte versch. Sorten, 250g', 'vorrat'), 'milch', 'butter');

// Kaufempfehlungen
import { computeDealsFrom, productKey, isoWeek } from '../worker/deals';
const mk = (id: number, name: string, price: number, ref: number, extra: Partial<Offer> = {}) =>
  ({ id, chain: 'REWE', name, price, refPrice: ref, refUnit: 'kg', category: 'Hackfleisch', group: 'fleisch', cooking: true, validFrom: '2020-01-01T00:00:00Z', validTo: '2099-01-01T00:00:00Z', desc: '', diet: 'fleisch', multi: false, image: '', ...extra }) as Offer;
const cur = [mk(1, 'Hack A', 2.99, 5.98, { oldPrice: 6.49 }), mk(2, 'Hack B', 4.99, 9.98), mk(3, 'Hack C', 5.49, 10.98), mk(4, 'Hack D', 5.99, 11.98)];
const d0 = computeDealsFrom(cur, []);
eq(d0.deals.map((d) => d.offerId), [1], 'deals ohne verlauf');
eq(d0.deals[0].reasons, ['−54 % reduziert', 'günstigster Hackfleisch-Preis diese Woche'], 'deal gruende');
const hist = [1, 2, 3, 4].map((i) => ({ week: `w${i}`, items: { [productKey(cur[1])]: 12.5 } }));
const d1 = computeDealsFrom(cur, hist);
eq(d1.deals.find((d) => d.offerId === 2)?.reasons, ['20 % günstiger als sonst'], 'guenstiger als sonst');
eq(d1.deals.find((d) => d.offerId === 3)?.reasons, ['seit 4 Wochen nicht im Angebot'], 'selten');
eq(isoWeek(new Date('2026-10-16T12:00:00Z')), '2026-W42', 'kw');

// EDEKA: GLN und Blätterkatalog aus den Seiten von edeka.de, Relay, App-Schnittstelle
import { glnFromHtml, catalogPathsFromHtml } from '../worker/edeka';
import { berlin, fetchMobileOffers } from '../worker/edeka-mobile';
import { completeJob, leaseJobs, requestMarketData, getGln, katKey } from '../worker/relay';
import { memoryKv } from '../worker/kv';
const marktSeite = 'data-tracking-event="[&quot;select_market&quot;,{&quot;market_name&quot;:&quot;nah &amp; gut von EDEKA Durasin&quot;,&quot;market_gln&quot;:&quot;4313590115808&quot;}]"';
eq(glnFromHtml(marktSeite), '4313590115808', 'gln aus marktseite');
eq(glnFromHtml('{"market_gln":"4314021182307"}'), '4314021182307', 'gln aus json');
eq(glnFromHtml('<html>nichts</html>'), null, 'keine gln');
eq(
  catalogPathsFromHtml('<a href="https://blaetterkatalog.edeka.de/MINDEN/8011165/index.html"> <a href="https://blaetterkatalog.edeka.de/preview/MINDEN/8011165/index.html">'),
  ['MINDEN/8011165'],
  'blaetterkatalog pfade',
);
eq(berlin('2026-11-07', '23:59:59'), '2026-11-07T23:59:59+01:00', 'winterzeit');
eq(berlin('2026-07-01', '00:00:00'), '2026-07-01T00:00:00+02:00', 'sommerzeit');

void (async () => {
  const kv = memoryKv();
  await requestMarketData(kv, '801116');
  await requestMarketData(kv, '801116');
  const jobs = await leaseJobs(kv);
  eq(jobs.map((j) => j.url), ['https://www.edeka.de/maerkte/801116/', 'https://www.edeka.de/maerkte/801116/prospekte/'], 'relay auftraege');
  eq((await leaseJobs(kv)).length, 0, 'relay reserviert');
  await completeJob(kv, 'markt-801116', 200, marktSeite);
  await completeJob(kv, 'prospekte-801116', 200, 'https://blaetterkatalog.edeka.de/MINDEN/8011165/index.html');
  eq([await getGln(kv, '801116'), await kv.get(katKey('801116'), 'json')], ['4313590115808', ['MINDEN/8011165']], 'relay ergebnisse');
  await requestMarketData(kv, '801116');
  eq((await leaseJobs(kv)).length, 0, 'relay nichts mehr offen');

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (u: string) => {
    const url = String(u);
    if (url.includes('openid-connect/token')) return new Response(JSON.stringify({ access_token: 't', expires_in: 360 }));
    return new Response(
      JSON.stringify({
        national: false,
        totalCount: 3,
        validFrom: '2026-11-02',
        validTill: '2026-11-07',
        offers: [
          { id: 1, title: 'Ab Donnerstag erhältlich: Blumenkohl', descriptions: ['aus Deutschland', 'Stück'], price: { value: '1,99' }, category: { name: 'Obst & Gemüse' } },
          { id: 2, title: 'Rinder-Hackfleisch', descriptions: ['500 g (1 kg = 9,98)'], price: { value: '4,99' }, category: { name: 'Fleisch & Wurst' } },
          { id: 3, title: 'Spülmittel', descriptions: [], price: { value: '0,99' }, category: { name: 'Drogerie' } },
        ],
      }),
    );
  }) as typeof fetch;
  const m = { id: 1, marketNo: '801116', name: 'nah & gut Durasin', street: '', city: '', channel: 'EDEKA' };
  const r = await fetchMobileOffers({ EDEKA_APP_CLIENT_ID: 'a', EDEKA_APP_CLIENT_SECRET: 'b' }, m, '4313590115808', Date.parse('2026-11-03T12:00:00Z'));
  globalThis.fetch = realFetch;
  eq(r.national, false, 'mobil national');
  eq(r.offers.map((o) => [o.name, o.price, o.group, o.pack ?? null, o.refPrice ?? null]), [['Blumenkohl', 1.99, 'gemuese', '1 Stück', null], ['Rinder-Hackfleisch', 4.99, 'fleisch', '500 g', 9.98]], 'mobil angebote');
  eq(r.offers[0].desc, 'Ab Donnerstag erhältlich · aus Deutschland · Stück', 'mobil verfuegbarkeit');
  eq(r.offers[0].validTo, '2026-11-07T23:59:59+01:00', 'mobil gueltig bis');
})();
