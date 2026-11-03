// Vergleicht KI-Modelle beim Lesen eines EDEKA-Prospekts: Anzahl Angebote, Kosten, Dauer und Bildausschnitte.
// Aufruf (im Container):
//   docker compose run --rm app node dist-server/compare.mjs MINDEN/8011165 deepseek/deepseek-v4.1-flash google/gemini-… > vergleich.html
// Braucht OPENROUTER_API_KEY. Ergebnis: eine HTML-Datei zum Öffnen im Browser.
import { extractProspekt, probeProspekte, type EdekaMarket } from './edeka';
import type { Offer } from '../shared/types';

const [path, ...models] = process.argv.slice(2);
if (!path || !models.length) {
  console.error('Aufruf: node dist-server/compare.mjs REGION/ID modell1 [modell2 …] > vergleich.html');
  process.exit(1);
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

async function main() {
  const [p] = await probeProspekte([path]);
  if (!p) throw new Error(`Kein aktueller Prospekt unter ${path}`);
  console.error(`Prospekt ${p.key}: ${p.pageCount} Seiten`);
  const m: EdekaMarket = { id: 0, marketNo: path.split('/')[1], name: 'EDEKA-Markt', street: '', city: '', channel: 'EDEKA' };

  const pages: string[] = [];
  for (let n = 1; n <= p.pageCount; n++) {
    const res = await fetch(`${p.base}/large/bk_${n}.jpg`, { headers: { referer: 'https://blaetterkatalog.edeka.de/' } });
    pages.push(res.ok ? `data:image/jpeg;base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}` : '');
  }

  const results: { model: string; offers: Offer[]; cost: number; seconds: number; error?: string }[] = [];
  for (const model of models) {
    console.error(`${model} …`);
    const t0 = Date.now();
    let cost = 0;
    try {
      const offers = await extractProspekt(m, p, { apiKey: process.env.OPENROUTER_API_KEY ?? '' }, model, async (usd) => {
        cost += usd;
      });
      results.push({ model, offers, cost, seconds: (Date.now() - t0) / 1000 });
    } catch (e) {
      results.push({ model, offers: [], cost, seconds: (Date.now() - t0) / 1000, error: String(e) });
    }
    const r = results[results.length - 1];
    console.error(`  ${r.offers.length} Angebote, ${r.cost.toFixed(4)} $, ${r.seconds.toFixed(0)} s${r.error ? `, Fehler: ${r.error}` : ''}`);
  }

  const W = 150;
  const thumb = (o: Offer) => {
    const c = o.crop;
    if (!c || !o.page || !pages[o.page - 1]) return '<div class="none">kein Ausschnitt</div>';
    const h = Math.round((W * c.h) / (c.w * c.ratio));
    const bw = W / c.w;
    return `<div class="crop" style="width:${W}px;height:${h}px;background-image:var(--p${o.page});background-size:${bw.toFixed(1)}px auto;background-position:${(-bw * c.x).toFixed(1)}px ${((-bw * c.y) / c.ratio).toFixed(1)}px"></div>`;
  };
  const vars = pages.map((d, i) => (d ? `--p${i + 1}:url(${d});` : '')).join('');
  const summary = results
    .map((r) => `<tr><td>${esc(r.model)}</td><td>${r.offers.length}</td><td>${r.offers.filter((o) => o.crop).length}</td><td>${r.cost.toFixed(4)} $</td><td>${r.seconds.toFixed(0)} s</td><td>${esc(r.error ?? '')}</td></tr>`)
    .join('');
  const sections = results
    .map(
      (r) => `<section><h2>${esc(r.model)}</h2><div class="grid">${r.offers
        .map((o) => `<figure>${thumb(o)}<figcaption><b>${o.price.toFixed(2)} €</b> ${esc(o.name)}${o.brand ? ` (${esc(o.brand)})` : ''}<br><small>S. ${o.page ?? '?'} · ${esc(o.pack ?? '')} · ${esc(o.group)}</small></figcaption></figure>`)
        .join('')}</div></section>`,
    )
    .join('');
  process.stdout.write(`<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Modellvergleich ${esc(p.key)}</title>
<style>:root{${vars}}body{font:14px system-ui,sans-serif;margin:16px;background:#f6f6f3;color:#222}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px;text-align:left}
.grid{display:flex;flex-wrap:wrap;gap:12px}figure{margin:0;width:${W}px;background:#fff;padding:6px;border-radius:6px}.crop{background-repeat:no-repeat;border:1px solid #ddd}.none{height:60px;display:grid;place-items:center;color:#999;border:1px dashed #ccc}figcaption{margin-top:4px}</style></head>
<body><h1>Prospekt ${esc(p.key)} (${p.pageCount} Seiten)</h1><table><tr><th>Modell</th><th>Angebote</th><th>mit Ausschnitt</th><th>Kosten</th><th>Dauer</th><th>Fehler</th></tr>${summary}</table>${sections}</body></html>`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
