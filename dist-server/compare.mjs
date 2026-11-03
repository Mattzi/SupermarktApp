// worker/ai.ts
var URL2 = "https://openrouter.ai/api/v1/chat/completions";
async function askJson(cfg, model, messages, schema, maxTokens) {
  if (!cfg.apiKey) throw new Error("Der OpenRouter-Schl\xFCssel fehlt (OPENROUTER_API_KEY).");
  if (!model) throw new Error("Kein KI-Modell eingestellt.");
  const res = await fetch(URL2, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.apiKey}`,
      ...cfg.appUrl ? { "http-referer": cfg.appUrl } : {},
      "x-title": "Angebotsk\xFCche"
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      response_format: { type: "json_schema", json_schema: { name: "antwort", strict: true, schema } },
      // Nur Anbieter nehmen, die das JSON-Schema auch wirklich einhalten
      provider: { require_parameters: true },
      usage: { include: true }
    })
  });
  if (!res.ok) throw new Error(`OpenRouter-Fehler ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const d = await res.json();
  if (d.error) throw new Error(`OpenRouter-Fehler: ${d.error.message ?? "unbekannt"}`);
  const costUsd = d.usage?.cost ?? 0;
  const choice = d.choices?.[0];
  if (choice?.finish_reason === "length") {
    throw Object.assign(new Error("Die Antwort der KI war zu lang und wurde abgeschnitten. Bitte nochmal versuchen."), { costUsd });
  }
  const text = (choice?.message?.content ?? "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try {
    return { data: JSON.parse(text), costUsd, model: d.model ?? model };
  } catch {
    throw Object.assign(new Error("Die Antwort der KI war kein g\xFCltiges JSON. Bitte nochmal versuchen."), { costUsd });
  }
}
var costOf = (e) => e && typeof e === "object" && "costUsd" in e ? Number(e.costUsd) || 0 : 0;

// worker/edeka.ts
var H = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36",
  accept: "text/html,application/json;q=0.9,*/*;q=0.8",
  "accept-language": "de-DE,de;q=0.9,en;q=0.8",
  referer: "https://www.edeka.de/"
};
var ID_BASE = 2e12;
async function catalogAt(region, id, preview) {
  const base = `https://blaetterkatalog.edeka.de/${preview ? "preview/" : ""}${region}/${id}/blaetterkatalog`;
  const xml = await fetch(`${base}/xml/catalog.xml`, { headers: H }).then((r) => r.ok ? r.text() : "");
  const validFrom = xml.match(/<from>([\d-]+)<\/from>/)?.[1];
  const validTo = xml.match(/<to>([\d-]+)<\/to>/)?.[1];
  if (!validFrom || !validTo) return null;
  return {
    key: `${region}/${id}/${validFrom}`,
    pdfUrl: `${base}/pdf/complete.pdf`,
    base,
    pageCount: Number(xml.match(/pages="(\d+)"/)?.[1] ?? 0),
    ratio: (() => {
      const m = xml.match(/name="large"\s+width="(\d+)"\s+height="(\d+)"/);
      return m ? Number(m[1]) / Number(m[2]) : 1100 / 1633;
    })(),
    validFrom: `${validFrom}T00:00:00+02:00`,
    validTo: `${validTo}T23:59:59+02:00`,
    preview
  };
}
async function probeProspekte(paths, now = Date.now()) {
  const out = [];
  for (const path2 of paths) {
    const [region, id] = path2.split("/");
    if (!/^[A-Z_]+$/.test(region ?? "") || !/^\d+$/.test(id ?? "")) continue;
    for (const preview of [false, true]) {
      const p = await catalogAt(region, id, preview).catch(() => null);
      if (p && Date.parse(p.validTo) >= now && !out.some((x) => x.key === p.key)) out.push(p);
    }
  }
  return out;
}
var GROUPS = ["fleisch", "wurst", "fisch", "milch", "gemuese", "obst", "vorrat", "tiefkuehl", "feinkost", "brot", "fruehstueck", "snacks", "getraenke"];
var SCHEMA = {
  type: "object",
  properties: {
    offers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: 'Produktname ohne Marke, z. B. "Rinder-Hackfleisch"' },
          brand: { type: "string", description: "Marke oder leerer String" },
          price: { type: "number", description: "Angebotspreis in Euro" },
          oldPrice: { type: ["number", "null"], description: "Durchgestrichener/Statt-Preis, sonst null" },
          pack: { type: "string", description: 'Packungsgr\xF6\xDFe, z. B. "500 g", "1 kg", "6 x 1,5 l", "1 St\xFCck"; leer wenn unbekannt' },
          description: { type: "string", description: 'Kurzer Zusatz (Sorte, Herkunft, Hinweise wie "mit App", "nur an der Theke")' },
          group: { type: "string", enum: GROUPS },
          diet: { type: "string", enum: ["fleisch", "fisch", "vegetarisch", "vegan"] },
          cooking: { type: "boolean", description: "true, wenn als Kochzutat brauchbar (nicht S\xFC\xDFes, Getr\xE4nke, Fertiggerichte)" },
          page: { type: "integer", description: "Seitennummer im Prospekt, beginnend bei 1" },
          box: {
            type: "object",
            description: "Wo das Angebot auf der Seite steht (Produktfoto + Preisschild), als Anteile der Seitenbreite bzw. -h\xF6he von 0 bis 1. x,y = linke obere Ecke.",
            properties: {
              x: { type: "number" },
              y: { type: "number" },
              w: { type: "number" },
              h: { type: "number" }
            },
            required: ["x", "y", "w", "h"],
            additionalProperties: false
          }
        },
        required: ["name", "brand", "price", "oldPrice", "pack", "description", "group", "diet", "cooking", "page", "box"],
        additionalProperties: false
      }
    }
  },
  required: ["offers"],
  additionalProperties: false
};
var PAGES_PER_CALL = 4;
async function pageImage(p, page) {
  const res = await fetch(`${p.base}/large/bk_${page}.jpg`, { headers: { ...H, referer: "https://blaetterkatalog.edeka.de/" } });
  if (!res.ok) throw new Error(`Prospektseite ${page} antwortet mit ${res.status}`);
  return `data:${res.headers.get("content-type") ?? "image/jpeg"};base64,${arrayBufferToBase64(await res.arrayBuffer())}`;
}
async function extractProspekt(m, p, ai, model, track) {
  if (!p.pageCount) throw new Error("Prospekt ohne Seiten");
  const raws = [];
  for (let start = 1; start <= p.pageCount; start += PAGES_PER_CALL) {
    const pages = Array.from({ length: Math.min(PAGES_PER_CALL, p.pageCount - start + 1) }, (_, i) => start + i);
    const content = [
      {
        type: "text",
        text: [
          `Das sind Seiten ${pages[0]}\u2013${pages[pages.length - 1]} aus dem Wochenprospekt von \u201E${m.name}\u201C (${m.street}, ${m.city}).`,
          "Lies jede Seite und liste ALLE Lebensmittel- und Getr\xE4nke-Angebote mit Preis auf.",
          "Nicht aufnehmen: Haushalt, Drogerie, Tierbedarf, Deko, Gutscheine, R\xE4tsel, reine Werbung ohne Preis.",
          'Preis = der gro\xDF gedruckte Aktionspreis in Euro (z. B. "-.99" = 0.99). Pfand nicht einrechnen.',
          'Bei "versch. Sorten" das Produkt einmal aufnehmen und die Sorten kurz in description nennen.',
          "Wenn ein Preis nur mit App/Karte gilt, das in description vermerken.",
          "page = die Seitennummer, die vor dem jeweiligen Bild steht.",
          "box = Bereich auf diesem Seitenbild, in dem Produktfoto und Preisschild stehen \u2013 als Anteile von 0 bis 1 (x=0.5 hei\xDFt Bildmitte), NICHT in Prozent oder Pixeln. x,y = linke obere Ecke.",
          "Wenn auf diesen Seiten keine Lebensmittel-Angebote stehen, gib eine leere Liste zur\xFCck."
        ].join("\n")
      }
    ];
    for (const n of pages) content.push({ type: "text", text: `Seite ${n}:` }, { type: "image_url", image_url: { url: await pageImage(p, n) } });
    let cost = 0;
    try {
      const res = await askJson(ai, model, [{ role: "user", content }], SCHEMA, 16e3);
      cost = res.costUsd;
      raws.push(...(res.data.offers ?? []).filter((o) => pages.includes(o.page)));
    } catch (e) {
      cost = costOf(e);
      throw e;
    } finally {
      await track?.(cost);
    }
  }
  return raws.filter((o) => o.name && typeof o.price === "number" && o.price > 0).map((o, i) => ({
    id: prospektOfferId(m.marketNo, p.validFrom, i),
    chain: m.name,
    name: o.name,
    brand: o.brand || void 0,
    desc: o.description,
    price: o.price,
    oldPrice: o.oldPrice ?? void 0,
    pack: o.pack || void 0,
    group: GROUPS.includes(o.group) ? o.group : "vorrat",
    category: "Prospekt",
    diet: o.diet,
    cooking: o.cooking,
    multi: /versch|oder/i.test(o.description),
    validFrom: p.validFrom,
    validTo: p.validTo,
    image: "",
    page: o.page > 0 ? o.page : void 0,
    crop: cropFor(p, o)
  }));
}
var clamp = (n) => Math.min(1, Math.max(0, n));
function cropFor(p, o) {
  let b = o.box;
  if (!o.page || o.page < 1 || o.page > (p.pageCount || 99) || !b) return void 0;
  const maxV = Math.max(b.x + b.w, b.y + b.h);
  if (maxV > 1.5 && maxV <= 101) b = { x: b.x / 100, y: b.y / 100, w: b.w / 100, h: b.h / 100 };
  else if (maxV > 101) b = { x: b.x / 1100, y: b.y / 1633, w: b.w / 1100, h: b.h / 1633 };
  if (!(b.w > 0.02) || !(b.h > 0.02) || b.x >= 1 || b.y >= 1) return void 0;
  const pad = 0.03;
  const x = clamp(b.x - pad);
  const y = clamp(b.y - pad * p.ratio);
  const w = Math.min(1 - x, b.w + 2 * pad);
  const h = Math.min(1 - y, b.h + 2 * pad * p.ratio);
  const r = (n) => Math.round(n * 1e3) / 1e3;
  return { src: prospektPage(p, o.page, "large"), x: r(x), y: r(y), w: r(w), h: r(h), ratio: r(p.ratio) };
}
function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 32768) bin += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(bin);
}
var prospektPage = (p, page, size) => `/api/img?u=${encodeURIComponent(`${p.base}/${size}/bk_${page}.jpg`)}&v=${p.validFrom.slice(0, 10)}`;
var prospektOfferId = (marketNo, validFrom, i) => ID_BASE + Number(marketNo) * 1e5 + Math.round(Date.parse(validFrom) / (7 * 864e5)) % 100 * 1e3 + i;

// worker/compare.ts
var [path, ...models] = process.argv.slice(2);
if (!path || !models.length) {
  console.error("Aufruf: node dist-server/compare.mjs REGION/ID modell1 [modell2 \u2026] > vergleich.html");
  process.exit(1);
}
var esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
async function main() {
  const [p] = await probeProspekte([path]);
  if (!p) throw new Error(`Kein aktueller Prospekt unter ${path}`);
  console.error(`Prospekt ${p.key}: ${p.pageCount} Seiten`);
  const m = { id: 0, marketNo: path.split("/")[1], name: "EDEKA-Markt", street: "", city: "", channel: "EDEKA" };
  const pages = [];
  for (let n = 1; n <= p.pageCount; n++) {
    const res = await fetch(`${p.base}/large/bk_${n}.jpg`, { headers: { referer: "https://blaetterkatalog.edeka.de/" } });
    pages.push(res.ok ? `data:image/jpeg;base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}` : "");
  }
  const results = [];
  for (const model of models) {
    console.error(`${model} \u2026`);
    const t0 = Date.now();
    let cost = 0;
    try {
      const offers = await extractProspekt(m, p, { apiKey: process.env.OPENROUTER_API_KEY ?? "" }, model, async (usd) => {
        cost += usd;
      });
      results.push({ model, offers, cost, seconds: (Date.now() - t0) / 1e3 });
    } catch (e) {
      results.push({ model, offers: [], cost, seconds: (Date.now() - t0) / 1e3, error: String(e) });
    }
    const r = results[results.length - 1];
    console.error(`  ${r.offers.length} Angebote, ${r.cost.toFixed(4)} $, ${r.seconds.toFixed(0)} s${r.error ? `, Fehler: ${r.error}` : ""}`);
  }
  const W = 150;
  const thumb = (o) => {
    const c = o.crop;
    if (!c || !o.page || !pages[o.page - 1]) return '<div class="none">kein Ausschnitt</div>';
    const h = Math.round(W * c.h / (c.w * c.ratio));
    const bw = W / c.w;
    return `<div class="crop" style="width:${W}px;height:${h}px;background-image:var(--p${o.page});background-size:${bw.toFixed(1)}px auto;background-position:${(-bw * c.x).toFixed(1)}px ${(-bw * c.y / c.ratio).toFixed(1)}px"></div>`;
  };
  const vars = pages.map((d, i) => d ? `--p${i + 1}:url(${d});` : "").join("");
  const summary = results.map((r) => `<tr><td>${esc(r.model)}</td><td>${r.offers.length}</td><td>${r.offers.filter((o) => o.crop).length}</td><td>${r.cost.toFixed(4)} $</td><td>${r.seconds.toFixed(0)} s</td><td>${esc(r.error ?? "")}</td></tr>`).join("");
  const sections = results.map(
    (r) => `<section><h2>${esc(r.model)}</h2><div class="grid">${r.offers.map((o) => `<figure>${thumb(o)}<figcaption><b>${o.price.toFixed(2)} \u20AC</b> ${esc(o.name)}${o.brand ? ` (${esc(o.brand)})` : ""}<br><small>S. ${o.page ?? "?"} \xB7 ${esc(o.pack ?? "")} \xB7 ${esc(o.group)}</small></figcaption></figure>`).join("")}</div></section>`
  ).join("");
  process.stdout.write(`<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Modellvergleich ${esc(p.key)}</title>
<style>:root{${vars}}body{font:14px system-ui,sans-serif;margin:16px;background:#f6f6f3;color:#222}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px;text-align:left}
.grid{display:flex;flex-wrap:wrap;gap:12px}figure{margin:0;width:${W}px;background:#fff;padding:6px;border-radius:6px}.crop{background-repeat:no-repeat;border:1px solid #ddd}.none{height:60px;display:grid;place-items:center;color:#999;border:1px dashed #ccc}figcaption{margin-top:4px}</style></head>
<body><h1>Prospekt ${esc(p.key)} (${p.pageCount} Seiten)</h1><table><tr><th>Modell</th><th>Angebote</th><th>mit Ausschnitt</th><th>Kosten</th><th>Dauer</th><th>Fehler</th></tr>${summary}</table>${sections}</body></html>`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
