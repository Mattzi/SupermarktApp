// worker/server.ts
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { Readable } from "node:stream";

// worker/marktguru.ts
var API = "https://api.marktguru.de/api/v1";
var HOME = "https://www.marktguru.de/";
var INDUSTRIES = [1009, 1023];
var PAGE = 500;
var UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36";
var keyCache = null;
async function getKeys(force = false) {
  if (!force && keyCache && Date.now() - keyCache.at < 12 * 36e5) return keyCache;
  const res = await fetch(HOME, { headers: { "user-agent": UA, "accept-language": "de-DE,de;q=0.9" } });
  if (!res.ok) throw new Error(`marktguru.de antwortet mit ${res.status}`);
  const html = await res.text();
  const re = /<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while (m = re.exec(html)) {
    try {
      const j = JSON.parse(m[1]);
      if (j?.config?.apiKey && j?.config?.clientKey) {
        keyCache = { apiKey: j.config.apiKey, clientKey: j.config.clientKey, at: Date.now() };
        return keyCache;
      }
    } catch {
    }
  }
  throw new Error("Schl\xFCssel auf marktguru.de nicht gefunden \u2013 die Seite hat sich vermutlich ge\xE4ndert");
}
async function apiGet(path, retry = true) {
  const keys = await getKeys();
  const res = await fetch(`${API}/${path}`, {
    headers: { "x-apikey": keys.apiKey, "x-clientkey": keys.clientKey, "user-agent": UA }
  });
  if ((res.status === 401 || res.status === 403) && retry) {
    await getKeys(true);
    return apiGet(path, false);
  }
  if (!res.ok) throw new Error(`marktguru-API antwortet mit ${res.status} f\xFCr ${path.split("?")[0]}`);
  return res.json();
}
async function fetchRawOffers(plz) {
  const all = [];
  await Promise.all(
    INDUSTRIES.map(async (industry) => {
      let offset = 0;
      let total = Infinity;
      while (offset < total && offset < 5e3) {
        const d = await apiGet(
          `offers?as=web&zipCode=${encodeURIComponent(plz)}&industryId=${industry}&limit=${PAGE}&offset=${offset}`
        );
        total = d.totalResults ?? 0;
        const results = d.results ?? [];
        all.push(...results);
        if (!results.length) break;
        offset += results.length;
      }
    })
  );
  return all;
}
async function fetchBestLeaflet(flightId, plz) {
  try {
    return await apiGet(`leafletflights/${flightId}/bestleaflet?as=mobiledetailed&zipCode=${encodeURIComponent(plz)}`);
  } catch {
    return null;
  }
}
var leafletPage = (id, page2, size) => `https://cdn.marktguru.de/api/v1/leaflets/${id}/images/pages/${page2}/${size}.webp`;

// worker/normalize.ts
var PARENT_GROUP = {
  103: "fleisch",
  104: "wurst",
  106: "fisch",
  107: "milch",
  147: "gemuese",
  101: "gemuese",
  // Pilze, Kräuter
  149: "obst",
  16: "vorrat",
  // Nudeln, Internationales, Veganes
  116: "vorrat",
  // Reis, Hülsenfrüchte
  113: "vorrat",
  // Konserven
  108: "vorrat",
  // Öle, Dips, Pesto
  110: "vorrat",
  // Backen
  174: "vorrat",
  // Gewürze
  112: "vorrat",
  // Soßen, Fertiges
  120: "tiefkuehl",
  115: "feinkost",
  191: "brot",
  187: "fruehstueck",
  473: "fruehstueck",
  119: "fruehstueck",
  20: "snacks",
  102: "snacks",
  23: "snacks",
  69: "getraenke",
  70: "getraenke",
  193: "getraenke",
  363: "getraenke",
  364: "getraenke",
  454: "getraenke",
  497: "getraenke"
};
var NOT_COOKING = /* @__PURE__ */ new Set([
  188,
  // Eis
  355,
  // TK-Pizza
  356,
  // TK-Backwaren
  179,
  // Tortendeko
  181,
  // Desserts
  336,
  // Instantgerichte
  338,
  // Snacks und Imbiss
  246,
  // Warme Speisen
  244,
  // Fingerfood
  343,
  // Dosengerichte
  354,
  // Tiefkühlgerichte
  121,
  // Nahrungsergänzung
  52
  // Internationale Spezialitäten (oft Süßes/Snacks)
]);
var EXCLUDE = /* @__PURE__ */ new Set([121]);
var COOKING_GROUPS = /* @__PURE__ */ new Set([
  "fleisch",
  "wurst",
  "fisch",
  "milch",
  "gemuese",
  "obst",
  "vorrat",
  "tiefkuehl",
  "feinkost",
  "brot"
]);
var MEAT_CATS = /* @__PURE__ */ new Set([340, 358, 183]);
var FISH_CATS = /* @__PURE__ */ new Set([339, 357, 220, 323]);
var VEGAN_CAT = 132;
var RE_VEGAN = /\b(vegan\w*|pflanzlich\w*)\b/i;
var RE_VEGGIE = /\b(veggie|vegetarisch\w*)\b/i;
var RE_MEAT = /(hähnchen|haehnchen|huhn|hühner|chicken|pute|puten|truthahn|schwein|rind|kalb|lamm|hack|wurst|würst|schinken|speck|salami|bacon|gulasch|döner|frikadell|leberkäse|mett|schnitzel|nacken|kotelett|bratwurst|wiener|\bente|entenbrust|gans|wildfleisch|hirsch|reh)/i;
var RE_FISH = /(lachs|thunfisch|fisch|garnele|shrimp|hering|forelle|kabeljau|seelachs|matjes|scampi|muschel|tintenfisch|calamar|sardine|makrele|krabbe|surimi|scholle|pangasius|dorsch)/i;
var RE_VEGETARIAN = /(käse|kaese|milch|joghurt|sahne|butter|\beier?\b|quark|mozzarella|feta|honig|schmand|crème|creme|frischkäse|parmesan|gouda|ei-|eier-)/i;
var NO_BRAND = /^thisisnobrand/i;
var VEGAN_STAPLES = /* @__PURE__ */ new Set([118, 345, 347, 431, 167, 170, 178, 341, 447]);
var RE_MEAT_EXCEPTION = /(kasseler|lachsschinken|schinken)/i;
function detectDiet(productName, text, catIds, parentIds) {
  if (catIds.includes(VEGAN_CAT) || RE_VEGAN.test(productName)) return "vegan";
  if (RE_VEGGIE.test(productName)) return "vegetarisch";
  if (RE_FISH.test(productName) && !RE_MEAT_EXCEPTION.test(productName)) return "fisch";
  const name = text;
  if (parentIds.some((p) => p === 103 || p === 104) || catIds.some((c) => MEAT_CATS.has(c))) return "fleisch";
  if (parentIds.includes(106) || catIds.some((c) => FISH_CATS.has(c))) return "fisch";
  if (parentIds.some((p) => p === 147 || p === 149 || p === 101)) return "vegan";
  if (parentIds.includes(107) || catIds.includes(337) || catIds.includes(626)) return "vegetarisch";
  if (RE_FISH.test(name)) return "fisch";
  if (RE_MEAT.test(name)) return "fleisch";
  if (RE_VEGETARIAN.test(name)) return "vegetarisch";
  if (catIds.some((c) => VEGAN_STAPLES.has(c))) return "vegan";
  if (parentIds.includes(191)) return "vegan";
  return "vegetarisch";
}
function formatPack(volume, unit) {
  if (!volume || !unit) return void 0;
  const u = unit.toLowerCase();
  if (u === "kg" && volume < 1) return `${round(volume * 1e3)} g`;
  if (u === "l" && volume < 1) return `${round(volume * 1e3)} ml`;
  if (u === "kg" || u === "l") return `${String(round(volume, 3)).replace(".", ",")} ${u}`;
  if (u === "st\xFCck" || u === "stk" || u === "st") return `${round(volume)} St\xFCck`;
  return `${String(round(volume, 3)).replace(".", ",")} ${unit}`;
}
function round(n, digits = 0) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
var num = (s) => parseFloat(s.replace(",", "."));
function parseDeal(desc, price) {
  const out = {};
  const bonus = desc.match(/mit\s+app\s+(\d+[.,]\d{2})\s*€?\s*rewe\s+bonus/i);
  if (bonus) out.note = `${bonus[1].replace(".", ",")} \u20AC REWE Bonus mit App`;
  const app = desc.match(/mit\s+((?:[a-zäöü]+\s+){0,2}(?:app|card(?:\s+xtra)?))\s*(\d+[.,]\d{2})\s*€?(?!\s*rewe\s+bonus)/i);
  if (app && !bonus) {
    const v = num(app[2]);
    if (v < price && v > price * 0.4) {
      out.appPrice = v;
      const who = app[1].toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
      out.note = `Mit ${who} ${v.toFixed(2).replace(".", ",")} \u20AC`;
    }
  } else if (!bonus) {
    const plain = desc.match(/mit\s+((?:[a-zäöü]+\s+){0,2}(?:app|card(?:\s+xtra)?))\b/i);
    if (plain) out.note = `Preis nur mit ${plain[1].toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())}`;
  }
  const normal = desc.match(/normalpreis:?\s*=?\s*(\d+[.,]\d{2})/i);
  if (normal) {
    const v = num(normal[1]);
    if (v > price) out.oldPrice = v;
  }
  return out;
}
function cleanDesc(desc) {
  return desc.replace(/hinweis:\s*(mit\s+(?:app\s+\d+[.,]\d{2}\s*€?\s*rewe\s+bonus|(?:[a-zäöü]+\s+){0,2}(?:app|card(?:\s+xtra)?)(?:\s*\d+[.,]\d{2}\s*€?)?)|nur online verfügbar)/i, "").replace(/normalpreis:?\s*=?\s*\d+[.,]\d{2}/i, "").replace(/\s+/g, " ").trim();
}
function normalizeOffer(raw, now = Date.now()) {
  const cats = raw.categories ?? [];
  if (!cats.length || !raw.advertisers?.length) return null;
  const catIds = cats.map((c) => c.id);
  const parentIds = cats.map((c) => c.parentId).filter((p) => p != null);
  if (catIds.some((c) => EXCLUDE.has(c))) return null;
  let group;
  for (const c of cats) {
    group = c.parentId != null && PARENT_GROUP[c.parentId] || PARENT_GROUP[c.id];
    if (group) break;
  }
  if (!group) return null;
  const validity = raw.validityDates?.[0];
  if (!validity) return null;
  if (Date.parse(validity.to) < now) return null;
  const name = (raw.product?.name ?? "").trim();
  if (!name) return null;
  const brandName = raw.brand?.name?.trim();
  const rawDesc = (raw.description ?? "").replace(/\s+/g, " ").trim();
  if (/nur online verfügbar/i.test(rawDesc)) return null;
  const desc = cleanDesc(rawDesc);
  const deal = parseDeal(rawDesc, raw.price);
  const unit = raw.unit?.shortName ?? void 0;
  const diet = detectDiet(name, `${name} ${brandName ?? ""} ${cats.map((c) => c.name).join(" ")} ${desc}`, catIds, parentIds);
  return {
    id: raw.id,
    chain: raw.advertisers[0].name,
    name,
    brand: brandName && !NO_BRAND.test(brandName) ? brandName : void 0,
    desc,
    price: raw.price,
    oldPrice: raw.oldPrice ?? deal.oldPrice,
    appPrice: deal.appPrice,
    dealNote: deal.note,
    pack: formatPack(raw.volume, unit),
    refPrice: raw.referencePrice ?? void 0,
    refUnit: unit ?? void 0,
    group,
    category: cats[0].name,
    diet,
    cooking: COOKING_GROUPS.has(group) && !catIds.some((c) => NOT_COOKING.has(c)),
    multi: !!raw.isMultiProduct,
    validFrom: validity.from,
    validTo: validity.to,
    image: `https://mg2de.b-cdn.net/api/v1/offers/${raw.id}/images/default/0/small.jpg`,
    flight: raw.leafletFlightId ?? void 0
  };
}
function normalizeAll(raws, now = Date.now()) {
  const seen = /* @__PURE__ */ new Set();
  const offers = [];
  for (const r of raws) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const o = normalizeOffer(r, now);
    if (o) offers.push(o);
  }
  const counts = /* @__PURE__ */ new Map();
  for (const o of offers) counts.set(o.chain, (counts.get(o.chain) ?? 0) + 1);
  const chains = [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  return { offers, chains };
}

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

// worker/recipes.ts
var MAX_OFFERS = 650;
var DIET_TEXT = {
  alles: "egal \u2013 Fleisch, Fisch oder vegetarisch, gerne gemischt",
  fleisch: "mit Fleisch (Fleisch ist die Hauptzutat)",
  fisch: "mit Fisch oder Meeresfr\xFCchten als Hauptzutat, kein Fleisch",
  vegetarisch: "vegetarisch (kein Fleisch, kein Fisch)",
  vegan: "vegan (keine tierischen Produkte, auch keine Milch, Eier, Honig)"
};
function dietAllows(choice, d) {
  switch (choice) {
    case "vegan":
      return d === "vegan";
    case "vegetarisch":
      return d === "vegan" || d === "vegetarisch";
    case "fisch":
      return d !== "fleisch";
    default:
      return true;
  }
}
var GROUP_PRIORITY = {
  fleisch: 0,
  fisch: 0,
  gemuese: 1,
  milch: 2,
  vorrat: 3,
  tiefkuehl: 4,
  wurst: 5,
  feinkost: 6,
  obst: 7,
  brot: 8
};
var fold = (t) => t.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss");
function dislikedBy(req) {
  const words = (req.dislikes ?? []).map((d) => fold(d.trim())).filter((d) => d.length >= 3);
  return (o) => words.some((w) => fold(`${o.name} ${o.brand ?? ""}`).includes(w));
}
function selectOffers(req, offers, now = Date.now()) {
  const chains = new Set(req.chains);
  const disliked = dislikedBy(req);
  const soon = now + 3 * 864e5;
  const list = offers.filter(
    (o) => o.cooking && (chains.size === 0 || chains.has(o.chain)) && Date.parse(o.validFrom) <= soon && dietAllows(req.diet, o.diet) && !disliked(o)
  );
  list.sort((a, b) => (GROUP_PRIORITY[a.group] ?? 9) - (GROUP_PRIORITY[b.group] ?? 9));
  const picked = list.slice(0, MAX_OFFERS);
  for (const id of cartIds(req).reverse()) {
    const f = offers.find((o) => o.id === id);
    if (f && !picked.includes(f)) picked.unshift(f);
  }
  return picked;
}
var eur = (n) => n.toFixed(2);
function cartIds(req) {
  const ids = [...req.cart ?? [], ...req.focusOfferId ? [req.focusOfferId] : []];
  return [...new Set(ids)].slice(0, 12);
}
function offerLine(o) {
  const parts = [
    o.id,
    o.chain,
    o.brand ? `${o.name} (${o.brand})` : o.name,
    o.pack ?? "?",
    `${eur(o.price)} \u20AC`,
    o.group,
    o.diet
  ];
  if (o.multi || o.desc) parts.push(o.desc.slice(0, 80));
  return parts.join(" | ");
}
var TOOL = {
  name: "rezepte_ausgeben",
  description: "Gibt die fertigen Rezepte strukturiert aus.",
  input_schema: {
    type: "object",
    properties: {
      recipes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            description: { type: "string", description: "Ein Satz, was das Gericht ausmacht" },
            minutes: { type: "integer", description: "Gesamtzeit inkl. Vorbereitung" },
            diet: { type: "string", enum: ["fleisch", "fisch", "vegetarisch", "vegan"] },
            ingredients: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  quantity: { type: "string", description: 'Menge f\xFCr alle Portionen, z. B. "500 g" oder "2 St\xFCck"' },
                  offerId: {
                    type: ["integer", "null"],
                    description: "ID aus der Angebotsliste, wenn die Zutat ein Angebot ist, sonst null"
                  },
                  packs: {
                    type: ["integer", "null"],
                    description: "Anzahl Packungen des Angebots, die man kaufen muss"
                  },
                  estimatedPrice: {
                    type: ["number", "null"],
                    description: "Gesch\xE4tzter Discounter-Preis in Euro f\xFCr die n\xF6tige Packung, nur wenn kein Angebot und nicht Grundvorrat"
                  },
                  usedFraction: {
                    type: ["number", "null"],
                    description: "Anteil der gekauften Menge, der im Rezept verbraucht wird (0.1 bis 1). Beispiel: 250 g von einer 500-g-Packung = 0.5"
                  },
                  pantry: {
                    type: "boolean",
                    description: "true f\xFCr Grundvorrat (Salz, Pfeffer, \xD6l, Zucker, Mehl, g\xE4ngige Gew\xFCrze, Br\xFChe)"
                  }
                },
                required: ["name", "quantity", "offerId", "packs", "estimatedPrice", "usedFraction", "pantry"],
                additionalProperties: false
              }
            },
            steps: { type: "array", items: { type: "string" } },
            storage: {
              type: "string",
              description: "Hinweis zu Aufbewahrung/Einfrieren beim Vorkochen, sonst kurzer Resteverwertungs-Hinweis"
            },
            tip: { type: "string", description: "Optionaler Tipp, sonst leerer String" }
          },
          required: ["title", "description", "minutes", "diet", "ingredients", "steps", "storage", "tip"],
          additionalProperties: false
        }
      }
    },
    required: ["recipes"],
    additionalProperties: false
  }
};
function buildPrompt(req, offers, cart) {
  const servings = req.persons * req.days;
  const system = [
    "Du bist ein kreativer, praktischer Hobbykoch-Assistent f\xFCr eine Spar-Rezepte-App in Deutschland.",
    "Du baust alltagstaugliche Rezepte aus aktuellen Supermarkt-Angeboten. Ziel: lecker und m\xF6glichst g\xFCnstig pro Portion.",
    "Regeln:",
    "- Nutze f\xFCr die Hauptzutaten Angebote aus der Liste und gib deren ID als offerId an. Erfinde keine IDs. Wenn du ein Produkt aus der Liste nennst, MUSS seine offerId gesetzt sein.",
    "- Jede Zutat ohne Angebot und ohne Grundvorrat braucht einen estimatedPrice gr\xF6\xDFer 0.",
    "- packs = wie viele Packungen man kaufen muss, damit die Menge reicht (Packungsgr\xF6\xDFe beachten).",
    "- Zutaten, die nicht im Angebot sind, mit realistischem Discounter-Preis f\xFCr die kleinste \xFCbliche Packung sch\xE4tzen (estimatedPrice).",
    "- usedFraction = welcher Anteil der gekauften Menge im Rezept verbraucht wird (f\xFCr den Preis pro Portion).",
    "- Grundvorrat (Salz, Pfeffer, \xD6l, Zucker, Mehl, Br\xFChe, g\xE4ngige Gew\xFCrze, Essig, Senf) mit pantry=true, ohne Preis.",
    "- Bevorzuge pro Rezept Angebote aus m\xF6glichst einem Markt, damit man nur in einen Laden muss.",
    "- Abwechslung: unterschiedliche K\xFCchen und Hauptzutaten \xFCber die Rezepte hinweg.",
    "- Schritte kurz und klar, auf Deutsch, Mengen in den Schritten nennen.",
    "- Mengen in den Zutaten immer f\xFCr die Gesamtzahl der Portionen."
  ].join("\n");
  const lines = [];
  if (!req.replace) lines.push(`Erstelle 5 Rezepte.`);
  lines.push(`Ern\xE4hrung: ${DIET_TEXT[req.diet] ?? DIET_TEXT.alles}`);
  lines.push(
    req.days > 1 ? `Portionen: ${servings} (${req.persons} Person${req.persons > 1 ? "en" : ""} \xD7 ${req.days} Tage). Die Gerichte sollen sich zum Vorkochen eignen und ${req.days} Tage im K\xFChlschrank halten oder sich einfrieren lassen.` : `Portionen: ${servings}.`
  );
  if (req.maxMinutes) lines.push(`Maximale Gesamtzeit: ${req.maxMinutes} Minuten.`);
  if (cart.length) {
    lines.push("");
    lines.push("EINKAUFSKORB \u2013 diese Angebote hat der Nutzer ausgew\xE4hlt (ID | Markt | Produkt | Packung | Preis):");
    for (const o of cart) lines.push(`${o.id} | ${o.chain} | ${o.brand ? `${o.name} (${o.brand})` : o.name} | ${o.pack ?? "?"} | ${eur(o.price)} \u20AC`);
    if (cart.length === 1 || req.cartMode !== "verteilen") {
      lines.push(
        cart.length === 1 ? "WICHTIG: Jedes der 5 Rezepte baut auf diesem Korb-Angebot als Hauptzutat auf." : "WICHTIG: Jedes der 5 Rezepte verwendet ALLE Korb-Angebote zusammen (5 verschiedene Gerichte). Passt ein Angebot gar nicht dazu, darfst du es in einem Rezept weglassen und sagst das kurz in der description."
      );
    } else {
      lines.push(
        "WICHTIG: Verteile den Korb auf die 5 Rezepte. Jedes Rezept baut auf mindestens einem Korb-Angebot als Hauptzutat auf, zusammen kommen ALLE Korb-Angebote mindestens einmal vor. Weitere Korb-Angebote d\xFCrfen als Beilage dazu."
      );
    }
    lines.push("Erg\xE4nze g\xFCnstige, passende Angebote aus der Liste \u2013 bevorzugt aus denselben M\xE4rkten wie der Korb.");
  }
  if (req.wishes?.trim()) lines.push(`WICHTIG \u2013 Wunsch, der f\xFCr jedes Rezept gilt: ${req.wishes.trim().slice(0, 300)}`);
  const dislikes = (req.dislikes ?? []).map((d) => d.trim()).filter(Boolean).slice(0, 40);
  if (dislikes.length) lines.push(`Der Nutzer mag NICHT \u2013 diese Zutaten niemals verwenden, auch nicht als Beilage: ${dislikes.join(", ")}.`);
  if (req.replace) {
    lines.push(`Erstelle nur 1 Rezept als Ersatz. Es soll sich deutlich von diesen unterscheiden: ${req.replace.avoidTitles.slice(0, 10).join("; ")}.`);
  }
  lines.push("");
  lines.push("Aktuelle Angebote (ID | Markt | Produkt | Packung | Preis | Gruppe | Ern\xE4hrung | Hinweis):");
  for (const o of offers) lines.push(offerLine(o));
  return { system, user: lines.join("\n") };
}
var r2 = (n) => Math.round(n * 100) / 100;
var norm = (t) => t.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-zäöüß0-9 ]/g, " ").replace(/\s+/g, " ").trim();
function matchByName(name, offers) {
  const n = norm(name);
  if (n.length < 4) return void 0;
  return offers.find((o) => {
    const on = norm(o.name);
    return on.length >= 4 && (n.includes(on) || on.includes(n));
  });
}
function priceRecipe(raw, byId, servings, idx, cart = []) {
  const all = [...byId.values()];
  const ingredients = raw.ingredients.map((i) => {
    let o = i.offerId != null ? byId.get(i.offerId) : void 0;
    if (!o && !i.pantry && !(typeof i.estimatedPrice === "number" && i.estimatedPrice > 0)) o = matchByName(i.name, all);
    const frac = typeof i.usedFraction === "number" && i.usedFraction > 0 ? Math.min(1, i.usedFraction) : 1;
    if (o) {
      const packs = Math.max(1, Math.round(i.packs ?? 1));
      return {
        name: i.name,
        quantity: i.quantity,
        pantry: false,
        offer: {
          id: o.id,
          chain: o.chain,
          name: o.name,
          brand: o.brand,
          pack: o.pack,
          price: o.price,
          oldPrice: o.oldPrice,
          appPrice: o.appPrice,
          packs,
          image: o.image || void 0,
          page: o.page,
          crop: o.crop,
          validFrom: o.validFrom,
          validTo: o.validTo
        },
        cost: r2(packs * o.price),
        usedCost: r2(packs * o.price * frac)
      };
    }
    if (i.pantry) return { name: i.name, quantity: i.quantity, pantry: true, cost: 0, usedCost: 0 };
    const est = typeof i.estimatedPrice === "number" && i.estimatedPrice > 0 ? i.estimatedPrice : 0;
    return { name: i.name, quantity: i.quantity, pantry: false, estimatedPrice: est, cost: r2(est), usedCost: r2(est * frac) };
  });
  const offerCost = r2(ingredients.filter((i) => i.offer).reduce((s, i) => s + i.cost, 0));
  const estimatedCost = r2(ingredients.filter((i) => !i.offer).reduce((s, i) => s + i.cost, 0));
  const totalCost = r2(offerCost + estimatedCost);
  const usedCost = r2(ingredients.reduce((s, i) => s + i.usedCost, 0));
  const chains = [...new Set(ingredients.flatMap((i) => i.offer ? [i.offer.chain] : []))];
  const offerIds = ingredients.flatMap((i) => i.offer ? [i.offer.id] : []);
  const ends = ingredients.flatMap((i) => i.offer?.validTo ? [Date.parse(i.offer.validTo)] : []);
  return {
    id: `${Date.now().toString(36)}-${idx}`,
    title: raw.title,
    description: raw.description,
    minutes: raw.minutes,
    diet: raw.diet,
    servings,
    ingredients,
    steps: raw.steps,
    storage: raw.storage,
    tip: raw.tip?.trim() || void 0,
    chains,
    offerCost,
    estimatedCost,
    totalCost,
    usedCost,
    perPortion: r2(usedCost / Math.max(1, servings)),
    usesCart: cart.filter((id) => offerIds.includes(id)),
    validTo: ends.length ? new Date(Math.min(...ends)).toISOString() : void 0
  };
}
async function generateRecipes(req, allOffers, env, track) {
  const persons = Math.min(Math.max(1, Math.round(req.persons || 1)), 6);
  const days = Math.min(Math.max(1, Math.round(req.days || 1)), 7);
  const r = { ...req, persons, days };
  const offers = selectOffers(r, allOffers);
  if (!offers.length) throw new Error("F\xFCr diese Auswahl gibt es gerade keine passenden Angebote.");
  const ids = cartIds(r);
  const cart = ids.map((id) => allOffers.find((o) => o.id === id)).filter((o) => !!o);
  const { system, user } = buildPrompt(r, offers, cart);
  const model = (r.fast ? env.RECIPE_MODEL_FAST : "") || env.RECIPE_MODEL || "";
  let raws = [];
  let costUsd = 0;
  try {
    const res = await askJson(
      { apiKey: env.OPENROUTER_API_KEY ?? "", appUrl: env.APP_URL },
      model,
      [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      TOOL.input_schema,
      16e3
    );
    costUsd = res.costUsd;
    raws = res.data.recipes ?? [];
  } catch (e) {
    costUsd = costOf(e);
    throw e;
  } finally {
    await track?.(costUsd);
  }
  costUsd = Math.round(costUsd * 1e3) / 1e3;
  if (!raws.length) throw new Error("Die KI hat keine Rezepte geliefert. Bitte nochmal versuchen.");
  const byId = new Map(allOffers.map((o) => [o.id, o]));
  const servings = persons * days;
  const cartFound = cart.map((o) => o.id);
  const recipes = raws.map((x, i) => priceRecipe(x, byId, servings, i, cartFound)).sort((a, b) => a.perPortion - b.perPortion);
  const used = new Set(recipes.flatMap((x) => x.usesCart ?? []));
  return {
    recipes,
    model,
    fast: !!r.fast,
    offerCount: offers.length,
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    costUsd,
    unusedCart: cartFound.filter((id) => !used.has(id))
  };
}

// worker/aldi.ts
var URL_CURRENT = "https://www.aldi-nord.de/angebote.html";
var ALDI_NORD = "ALDI Nord";
var ID_BASE = 1e12;
function sectionGroup(title) {
  const t = title.toLowerCase();
  if (/obst|gemüse/.test(t)) return "gemuese";
  if (/fleisch|fisch/.test(t)) return "mixed";
  if (/snacks|süßes/.test(t)) return "snacks";
  if (/getränke|tassimo|kaffee/.test(t)) return "getraenke";
  if (/wochen|gekühlt|tiefgekühlt|haltbar|streetfood|frühstück|grill|aktion/.test(t) && !/halloween|weihnacht|oster/.test(t)) return "mixed";
  return null;
}
var RE_OBST = /(apfel|äpfel|birne|banane|traube|orange|mandarine|clementine|zitrone|limette|mango|ananas|kiwi|beere|melone|pfirsich|nektarine|pflaume|kirsche|avocado|granatapfel|feige|grapefruit)/i;
var RE_FISCH = /(lachs|fisch|garnele|shrimp|hering|forelle|kabeljau|seelachs|matjes|thunfisch|scampi|muschel)/i;
var RE_FLEISCH = /(hack|hähnchen|huhn|pute|schwein|rind|kalb|lamm|steak|schnitzel|gulasch|braten|filet|keule|nacken|kotelett|geschnetzelt|bratwurst|frikadell|chicken|pulled|bacon|würstchen|wurst|schinken|salami)/i;
var RE_MILCH = /(käse|milch|joghurt|quark|sahne|butter|mozzarella|feta|hirtenkäse|frischkäse|skyr|eier\b|schmand|crème fraîche)/i;
var RE_BROT = /(brot|brötchen|baguette|buns|bagel|toast|croissant|brezel)/i;
var RE_SUESS = /(schoko|pudding|mousse|keks|(?<!flamm)kuchen|muffin|gummi|jelly|bonbon|eis\b|soft-eis|riegel|flips|chips|praline|waffel|donut|pancake|sirup)/i;
var RE_DRINK = /(drink|spezi|schorle|energy|sprudel|kaffee|barista|espresso|cappuccino|latte|cola|saft|limo|bier|wein|whisk|wodka|likör|wasser|mocha|tee\b|eiskaffee)/i;
var RE_TK = /(tiefgefroren|tk-|pizza|fritten|pommes|nuggets)/i;
function dietFor(group, name, text) {
  if (group === "gemuese" || group === "obst") return "vegan";
  if (group === "fleisch" || group === "wurst") return "fleisch";
  if (group === "fisch") return "fisch";
  return detectDiet(name, text, [], []);
}
function guessGroup(text, fallback) {
  if (RE_DRINK.test(text)) return "getraenke";
  if (RE_SUESS.test(text)) return "snacks";
  if (RE_FISCH.test(text)) return "fisch";
  if (/(schinken|salami|aufschnitt|wurst(?!chen)|mortadella|leberwurst)/i.test(text)) return "wurst";
  if (RE_FLEISCH.test(text)) return "fleisch";
  if (RE_MILCH.test(text)) return "milch";
  if (RE_BROT.test(text)) return "brot";
  if (RE_TK.test(text)) return "tiefkuehl";
  if (RE_OBST.test(text)) return "obst";
  return fallback;
}
var NOT_COOKING2 = /(pizza|lasagne|eintopf|chili con carne|nuggets|donut|fertig|snack|dessert)/i;
function formatPack2(unit) {
  if (!unit) return void 0;
  const m = unit.match(/^([\d,.x\s]+)\s*-?\s*(kg|g|ml|l)\b/i);
  if (m) return `${m[1].replace(/\s+/g, "")} ${m[2]}`;
  if (/kg-preis/i.test(unit)) return "1 kg";
  if (/stück/i.test(unit)) return "1 St\xFCck";
  return unit.replace(/-(packung|schale|beutel|netz|becher|dose|glas|flasche)/i, " $1");
}
function extractApiData(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error("ALDI Nord: Seitenformat hat sich ge\xE4ndert (__NEXT_DATA__ fehlt)");
  const nd = JSON.parse(m[1]);
  const api = nd?.props?.pageProps?.apiData;
  return typeof api === "string" ? JSON.parse(api) : api;
}
function parseAldiPage(html, now = Date.now()) {
  const api = extractApiData(html);
  const entry = api.find((e) => e[0] === "OFFER_GET");
  const res = entry?.[1]?.res;
  if (!res?.algoliaDataMap) throw new Error("ALDI Nord: keine Angebotsdaten gefunden");
  const map = res.algoliaDataMap;
  const offers = [];
  const seen = /* @__PURE__ */ new Set();
  for (const day of res.categories ?? []) {
    for (const sec of day.content ?? []) {
      const sg = sectionGroup(sec.title ?? "");
      if (!sg) continue;
      for (const pid of sec.productIds ?? []) {
        const p = map[pid];
        if (!p?.currentPrice || seen.has(pid)) continue;
        seen.add(pid);
        const promo = p.promotionPrices?.[0];
        const validFrom = promo?.validFromLocalDate ? `${promo.validFromLocalDate}T00:00:00+02:00` : new Date(now).toISOString();
        const validTo = promo?.validUntilLocalDate ? `${promo.validUntilLocalDate}T23:59:59+02:00` : new Date(now + 6 * 864e5).toISOString();
        if (Date.parse(validTo) < now) continue;
        const text = `${p.name} ${p.shortDescription ?? ""}`;
        let group = sg === "mixed" ? guessGroup(text, "vorrat") : sg;
        if (sg === "gemuese" && RE_OBST.test(p.name)) group = "obst";
        const base = p.currentPrice.basePrice?.[0];
        const desc = [p.shortDescription, p.salesUnit].filter(Boolean).join(" \xB7 ");
        const cookingGroups = ["fleisch", "wurst", "fisch", "milch", "gemuese", "obst", "vorrat", "tiefkuehl", "feinkost", "brot"];
        offers.push({
          id: ID_BASE + parseInt(pid.replace(/\D/g, ""), 10) % ID_BASE,
          chain: ALDI_NORD,
          name: p.name,
          brand: p.brandName || void 0,
          desc,
          price: p.currentPrice.priceValue,
          oldPrice: p.currentPrice.strikePrice?.strikePriceValue,
          pack: formatPack2(p.salesUnit),
          refPrice: base?.basePriceValue,
          refUnit: base?.basePriceScale,
          group,
          category: sec.title ?? "",
          diet: dietFor(group, p.name, text),
          cooking: cookingGroups.includes(group) && !NOT_COOKING2.test(text),
          multi: /\//.test(p.name),
          validFrom,
          validTo,
          image: p.assets?.find((a) => a.type === "primary")?.url ? `${p.assets.find((a) => a.type === "primary").url}?wid=160&hei=160` : ""
        });
      }
    }
  }
  return offers;
}
async function fetchAldiNord() {
  const res = await fetch(URL_CURRENT, {
    headers: {
      "user-agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36",
      "accept-language": "de-DE,de;q=0.9",
      accept: "text/html"
    }
  });
  if (!res.ok) throw new Error(`ALDI Nord antwortet mit ${res.status}`);
  return parseAldiPage(await res.text());
}

// worker/edeka-mobile.ts
var TOKEN_URL = "https://b2b-login.api.edeka/auth/realms/b2b/protocol/openid-connect/token";
var OFFERS_URL = "https://b2c-gw.api.edeka/v2/offers/mobile";
var UA2 = "okhttp/5.3.2";
var IMAGE_UA = "Dalvik/2.1.0 (Linux; U; Android 17; Pixel 8 Pro Build/CP2A.260805.005)";
var ID_BASE2 = 3e12;
var PAGE2 = 100;
var token = null;
async function bearer(env) {
  if (token && token.until > Date.now() + 3e4) return token.value;
  if (!env.EDEKA_APP_CLIENT_ID || !env.EDEKA_APP_CLIENT_SECRET) throw new Error("Zugangsdaten f\xFCr die EDEKA-App-Schnittstelle fehlen");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${btoa(`${env.EDEKA_APP_CLIENT_ID}:${env.EDEKA_APP_CLIENT_SECRET}`)}`
    },
    body: "grant_type=client_credentials"
  });
  if (!res.ok) throw new Error(`EDEKA-Anmeldung antwortet mit ${res.status}`);
  const d = await res.json();
  if (!d.access_token) throw new Error("EDEKA-Anmeldung lieferte kein Token");
  token = { value: d.access_token, until: Date.now() + Math.min(Math.max(d.expires_in ?? 300, 60), 3600) * 1e3 };
  return token.value;
}
async function page(env, gln, n) {
  const q = new URLSearchParams({ marketGln: gln, size: String(PAGE2), page: String(n), sortedByCategory: "true" });
  const res = await fetch(`${OFFERS_URL}?${q}`, { headers: { authorization: `Bearer ${await bearer(env)}`, "user-agent": UA2 } });
  if (res.status === 401) token = null;
  if (!res.ok) throw new Error(`EDEKA-App-Schnittstelle antwortet mit ${res.status}`);
  return await res.json();
}
async function fetchMobileOffers(env, m, gln, now = Date.now()) {
  const first = await page(env, gln, 0);
  const raws = [...first.offers ?? []];
  const total = first.totalCount ?? raws.length;
  for (let n = 1; raws.length < total && n < 20; n++) {
    const next = await page(env, gln, n);
    if (!next.offers?.length) break;
    raws.push(...next.offers);
  }
  const offers = raws.map((o) => toOffer(m, o, first, now)).filter((o) => !!o && Date.parse(o.validTo) >= now);
  const categories = [...new Set(raws.map((o) => o.category?.name ?? "").filter(Boolean))];
  return { national: first.national !== false, offers, categories };
}
function categoryGroup(cat) {
  const c = cat.toLowerCase();
  if (/drogerie|kosmetik|haushalt|tier|non.?food|baby.*pflege|pflege|elektro|garten|deko/.test(c)) return null;
  if (/obst|gemüse/.test(c)) return "gemuese";
  if (/fleisch|geflügel/.test(c)) return "fleisch";
  if (/wurst/.test(c)) return "wurst";
  if (/fisch/.test(c)) return "fisch";
  if (/molkerei|milch|käse|kühl/.test(c)) return "milch";
  if (/tiefkühl/.test(c)) return "tiefkuehl";
  if (/getränk|wein|bier|spirituos|sekt|kaffee|tee/.test(c)) return "getraenke";
  if (/süß|snack|knabber/.test(c)) return "snacks";
  if (/brot|back/.test(c)) return "brot";
  if (/frühstück|müsli|aufstrich/.test(c)) return "fruehstueck";
  return void 0;
}
var COOKING = /* @__PURE__ */ new Set(["fleisch", "wurst", "fisch", "milch", "gemuese", "obst", "vorrat", "tiefkuehl", "feinkost", "brot"]);
var AVAIL = /^\*?\s*((?:ab\s+)?(?:montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)[^:]{0,40}|[^:]{0,20}knüller):\s*/i;
function toOffer(m, o, r, now) {
  const price = parseFloat((o.price?.value ?? "").replace(",", "."));
  if (!o.title || !Number.isFinite(price) || price <= 0 || o.priceType === "HIDE") return null;
  let name = o.title.replace(/\s+/g, " ").trim();
  const avail = name.match(AVAIL);
  if (avail) name = name.slice(avail[0].length);
  const desc = (o.descriptions ?? []).join(" \xB7 ").replace(/\s+/g, " ").trim();
  const cat = o.category?.name ?? "";
  const fromCat = categoryGroup(cat);
  if (fromCat === null) return null;
  const text = `${name} ${desc}`;
  const group = guessGroup(text, fromCat ?? "vorrat");
  const basic = parseBasic(desc);
  const from = o.validFrom || r.validFrom;
  const till = o.validTill || r.validTill;
  return {
    id: ID_BASE2 + Number(o.id) % 1e12,
    chain: m.name,
    name,
    desc: [avail?.[1], desc].filter(Boolean).join(" \xB7 "),
    price,
    pack: packFromText(desc),
    refPrice: basic?.value,
    refUnit: basic?.unit,
    dealNote: o.discount || void 0,
    group,
    category: cat,
    diet: dietFor(group, name, text),
    cooking: COOKING.has(group),
    multi: /versch\.|oder /i.test(text),
    validFrom: from ? berlin(from, "00:00:00") : new Date(now).toISOString(),
    validTo: till ? berlin(till, "23:59:59") : new Date(now + 2 * 864e5).toISOString(),
    image: o.image?.imageUrl ? `/api/img?u=${encodeURIComponent(o.image.imageUrl)}` : ""
  };
}
function berlin(date, time) {
  const d = date.slice(0, 10);
  const guess = /* @__PURE__ */ new Date(`${d}T${time}Z`);
  const local = new Date(guess.toLocaleString("en-US", { timeZone: "Europe/Berlin" }));
  const utc = new Date(guess.toLocaleString("en-US", { timeZone: "UTC" }));
  const offsetH = Math.round((local.getTime() - utc.getTime()) / 36e5);
  return `${d}T${time}+${String(offsetH).padStart(2, "0")}:00`;
}

// worker/edeka.ts
var H = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36",
  accept: "text/html,application/json;q=0.9,*/*;q=0.8",
  "accept-language": "de-DE,de;q=0.9,en;q=0.8",
  referer: "https://www.edeka.de/"
};
var ID_BASE3 = 2e12;
async function searchMarkets(plz) {
  const res = await fetch(`https://www.edeka.de/api/marketsearch/markets?searchstring=${encodeURIComponent(plz)}`, { headers: H });
  if (!res.ok) throw new Error(`EDEKA-Marktsuche antwortet mit ${res.status}`);
  const d = await res.json();
  return parseMarkets(d.markets);
}
function parseMarkets(raw) {
  if (!Array.isArray(raw)) return [];
  const str = (v, max = 120) => typeof v === "string" ? v.slice(0, max) : "";
  const num2 = (v) => v != null && Number.isFinite(Number(v)) ? Number(v) : void 0;
  return raw.slice(0, 50).map((m) => ({
    id: Number(m?.id),
    marketNo: str(m?.url, 300).match(/maerkte\/(\d+)/)?.[1] ?? "",
    name: str(m?.name),
    street: str(m?.contact?.address?.street),
    city: str(m?.contact?.address?.city?.name),
    channel: str(m?.distributionChannelName) || "EDEKA",
    lat: num2(m?.coordinates?.lat),
    lon: num2(m?.coordinates?.lon)
  })).filter((m) => Number.isSafeInteger(m.id) && m.id > 0 && m.name);
}
function marketChainInfo(m, count = 0, note) {
  const dist = m.distanceKm != null ? ` \xB7 ${m.distanceKm.toLocaleString("de-DE")} km` : "";
  return { name: m.name, count, kind: "markt", marketId: m.id, marketNo: m.marketNo, address: `${m.street}, ${m.city}${dist}`, note };
}
function packFromText(t) {
  const m = t.match(/(\d+(?:[.,]\d+)?\s?x\s?)?\d+(?:[.,]\d+)?\s?(kg|g|ml|l)\b/i);
  return m ? m[0].replace(/\s+/g, " ") : /stück/i.test(t) ? "1 St\xFCck" : void 0;
}
function parseBasic(b) {
  const m = b?.match(/1\s?(kg|l|stück)\s*=\s*€?\s*(\d+[.,]\d+)/i);
  return m ? { value: parseFloat(m[2].replace(",", ".")), unit: m[1].toLowerCase() } : void 0;
}
async function findProspekte(m) {
  const res = await fetch(`https://www.edeka.de/maerkte/${m.marketNo}/prospekte/`, { headers: H });
  if (!res.ok) throw new Error(`EDEKA-Prospektseite antwortet mit ${res.status}`);
  return probeProspekte(catalogPathsFromHtml(await res.text()));
}
function catalogPathsFromHtml(html) {
  const found = [...html.matchAll(/https:\/\/blaetterkatalog\.edeka\.de\/(?:preview\/)?([A-Z_]+)\/(\d+)\/index\.html/g)];
  return [...new Set(found.map((f) => `${f[1]}/${f[2]}`))];
}
function glnFromHtml(html) {
  return html.match(/market_gln(?:&quot;|"|\\")\s*:\s*(?:&quot;|"|\\")(\d{13})/)?.[1] ?? null;
}
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
  for (const path of paths) {
    const [region, id] = path.split("/");
    if (!/^[A-Z_]+$/.test(region ?? "") || !/^\d+$/.test(id ?? "")) continue;
    for (const preview of [false, true]) {
      const p = await catalogAt(region, id, preview).catch(() => null);
      if (p && Date.parse(p.validTo) >= now && !out.some((x) => x.key === p.key)) out.push(p);
    }
  }
  return out;
}
var catalogPath = (key) => key.split("/").slice(0, 2).join("/");
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
async function pageImage(p, page2) {
  const res = await fetch(`${p.base}/large/bk_${page2}.jpg`, { headers: { ...H, referer: "https://blaetterkatalog.edeka.de/" } });
  if (!res.ok) throw new Error(`Prospektseite ${page2} antwortet mit ${res.status}`);
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
var prospektPage = (p, page2, size) => `/api/img?u=${encodeURIComponent(`${p.base}/${size}/bk_${page2}.jpg`)}&v=${p.validFrom.slice(0, 10)}`;
var baseFor = (key, preview) => `https://blaetterkatalog.edeka.de/${preview ? "preview/" : ""}${catalogPath(key)}/blaetterkatalog`;
var prospektOfferId = (marketNo, validFrom, i) => ID_BASE3 + Number(marketNo) * 1e5 + Math.round(Date.parse(validFrom) / (7 * 864e5)) % 100 * 1e3 + i;
function withCurrentImages(offers, p, marketNo) {
  const at = { base: baseFor(p.key, p.preview), validFrom: p.validFrom };
  return offers.map((raw, i) => {
    const o = { ...raw, id: prospektOfferId(marketNo, p.validFrom, i) };
    if (!o.crop) return o;
    const page2 = Number(decodeURIComponent(o.crop.src).match(/bk_(\d+)\.jpg/)?.[1] ?? o.page);
    return page2 ? { ...o, crop: { ...o.crop, src: prospektPage(at, page2, "large") } } : o;
  });
}
async function proxyImage(u) {
  let url;
  try {
    url = new URL(u);
  } catch {
    return new Response("ung\xFCltige Adresse", { status: 400 });
  }
  const app = url.hostname.endsWith(".api.edeka");
  if (url.protocol !== "https:" || url.hostname !== "blaetterkatalog.edeka.de" && !app) {
    return new Response("nicht erlaubt", { status: 400 });
  }
  const headers = app ? { "user-agent": IMAGE_UA } : { ...H, referer: "https://blaetterkatalog.edeka.de/" };
  const res = await fetch(url.toString(), { headers, cache: "no-store" });
  if (!res.ok) return new Response("nicht gefunden", { status: res.status });
  const type = res.headers.get("content-type") ?? "image/jpeg";
  if (!type.startsWith("image/")) return new Response("kein Bild", { status: 502 });
  return new Response(res.body, {
    headers: { "content-type": type, "cache-control": "public, max-age=604800, immutable" }
  });
}

// worker/costs.ts
var monthKey = () => `cost:${(/* @__PURE__ */ new Date()).toISOString().slice(0, 7)}`;
var dayKey = (user) => `cost:u:${user}:${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}`;
async function monthCost(kv) {
  if (!kv) return 0;
  return Number(await kv.get(monthKey()) ?? 0);
}
async function dayCost(kv, user) {
  if (!kv) return 0;
  return Number(await kv.get(dayKey(user)) ?? 0);
}
async function addCost(kv, usd, user) {
  if (!kv || !usd) return;
  await kv.put(monthKey(), (await monthCost(kv) + usd).toFixed(5), { expirationTtl: 70 * 86400 });
  if (user) await kv.put(dayKey(user), (await dayCost(kv, user) + usd).toFixed(5), { expirationTtl: 3 * 86400 });
}

// worker/auth.ts
async function hash(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function currentUser(req, env) {
  let email;
  let name = "";
  let groups = [];
  let budget2 = null;
  if (env.AUTH_MODE === "dev") {
    email = env.DEV_USER_EMAIL || "dev@localhost";
  } else {
    email = req.headers.get("x-authentik-email");
    name = req.headers.get("x-authentik-name") ?? "";
    groups = (req.headers.get("x-authentik-groups") ?? "").split("|").map((g) => g.trim()).filter(Boolean);
    budget2 = req.headers.get("x-ki-budget-tag");
  }
  if (!email) return { reason: "nicht angemeldet" };
  email = email.toLowerCase();
  const b = budget2 != null && budget2 !== "" ? Number(budget2.replace(",", ".")) : NaN;
  return { email, id: await hash(email), name, groups, dailyBudgetUsd: Number.isFinite(b) && b >= 0 ? b : void 0 };
}
var syncKeyFor = (u) => `sync:${u.id}`;

// worker/relay.ts
var JOBS = "relay:jobs";
var LEASE_MS = 10 * 6e4;
var MAX_TRIES = 5;
var glnKey = (marketNo) => `edeka:gln:${marketNo}`;
var katKey = (marketNo) => `edeka:kat:${marketNo}`;
var getGln = (kv, marketNo) => kv.get(glnKey(marketNo));
var urlFor = (kind, marketNo) => kind === "markt" ? `https://www.edeka.de/maerkte/${marketNo}/` : `https://www.edeka.de/maerkte/${marketNo}/prospekte/`;
async function jobs(kv) {
  return await kv.get(JOBS, "json") ?? [];
}
async function requestMarketData(kv, marketNo) {
  if (!/^\d+$/.test(marketNo)) return;
  const [gln, kat] = await Promise.all([kv.get(glnKey(marketNo)), kv.get(katKey(marketNo))]);
  const need = [...gln ? [] : ["markt"], ...kat ? [] : ["prospekte"]];
  if (!need.length) return;
  const list = await jobs(kv);
  const add = need.filter((k) => !list.some((j) => j.kind === k && j.marketNo === marketNo));
  if (!add.length) return;
  await kv.put(
    JOBS,
    JSON.stringify([...list, ...add.map((kind) => ({ id: `${kind}-${marketNo}`, kind, marketNo, url: urlFor(kind, marketNo), tries: 0 }))].slice(-200))
  );
}
async function leaseJobs(kv, max = 5) {
  await kv.put("relay:lastSeen", (/* @__PURE__ */ new Date()).toISOString());
  const list = await jobs(kv);
  const now = Date.now();
  const free = list.filter((j) => !j.leasedAt || now - j.leasedAt > LEASE_MS).slice(0, max);
  if (!free.length) return [];
  const ids = new Set(free.map((j) => j.id));
  await kv.put(JOBS, JSON.stringify(list.map((j) => ids.has(j.id) ? { ...j, leasedAt: now } : j)));
  return free.map(({ id, url }) => ({ id, url }));
}
async function completeJob(kv, id, status, body) {
  const list = await jobs(kv);
  const job = list.find((j) => j.id === id);
  if (!job) return "Auftrag unbekannt";
  const rest = list.filter((j) => j.id !== id);
  let note;
  if (status === 200) {
    if (job.kind === "markt") {
      const gln = glnFromHtml(body);
      await kv.put(glnKey(job.marketNo), gln ?? "none", { expirationTtl: (gln ? 180 : 14) * 86400 });
      note = gln ? `GLN ${gln}` : "keine GLN auf der Seite";
    } else {
      const paths = catalogPathsFromHtml(body);
      if (paths.length) await kv.put(katKey(job.marketNo), JSON.stringify(paths));
      note = paths.length ? `Bl\xE4tterkatalog ${paths.join(", ")}` : "kein Bl\xE4tterkatalog auf der Seite";
    }
    await kv.put(JOBS, JSON.stringify(rest));
    return note;
  }
  const tries = job.tries + 1;
  await kv.put(JOBS, JSON.stringify(tries >= MAX_TRIES ? rest : [...rest, { ...job, tries, leasedAt: Date.now() }]));
  return tries >= MAX_TRIES ? `aufgegeben nach ${tries} Versuchen (HTTP ${status})` : `HTTP ${status}, neuer Versuch sp\xE4ter`;
}
async function relayStatus(kv) {
  return { lastSeen: await kv.get("relay:lastSeen"), jobs: (await jobs(kv)).map(({ kind, marketNo, tries, leasedAt }) => ({ kind, marketNo, tries, leasedAt })) };
}

// worker/stores.ts
var UA3 = "Angebotskueche/1.0 (private Einkaufs-App)";
var BRANDS = [
  [/^aldi nord$/i, "ALDI Nord"],
  [/^aldi s(ü|ue)d$/i, "ALDI S\xDCD"],
  [/^rewe$/i, "REWE"],
  [/^lidl$/i, "Lidl"],
  [/^penny$/i, "PENNY"],
  [/^netto marken-discount$/i, "Netto Marken-Discount"],
  [/^kaufland$/i, "Kaufland"]
];
function km(aLat, aLon, bLat, bLon) {
  const r = (d) => d * Math.PI / 180;
  const h = Math.sin(r(bLat - aLat) / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(r(bLon - aLon) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}
async function geocode(plz) {
  const geo = await fetch(`https://nominatim.openstreetmap.org/search?postalcode=${plz}&country=de&format=json&limit=1`, {
    headers: { "user-agent": UA3, "accept-language": "de" }
  });
  if (!geo.ok) throw new Error(`Ortssuche antwortet mit ${geo.status}`);
  const [place] = await geo.json();
  return place ? { lat: Number(place.lat), lon: Number(place.lon) } : null;
}
async function nearestStores(plz, center) {
  const c = center ?? await geocode(plz);
  if (!c) return [];
  const { lat, lon } = c;
  const q = `[out:json][timeout:15];nwr["shop"="supermarket"](around:12000,${lat},${lon});out center tags;`;
  const servers = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.private.coffee/api/interpreter"
  ];
  let res = null;
  const tried = [];
  for (const url of servers) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "user-agent": UA3, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: `data=${encodeURIComponent(q)}`
      });
      if (r.ok && (r.headers.get("content-type") ?? "").includes("json")) {
        res = r;
        break;
      }
      tried.push(`${new URL(url).hostname}: ${r.status}`);
    } catch (e) {
      tried.push(`${new URL(url).hostname}: ${String(e)}`);
    }
  }
  if (!res) throw new Error(`Filialsuche nicht erreichbar (${tried.join(", ")})`);
  const d = await res.json();
  const best = /* @__PURE__ */ new Map();
  for (const e of d.elements) {
    const t = e.tags ?? {};
    const brand = t.brand ?? t.name ?? "";
    const chain = BRANDS.find(([re]) => re.test(brand.trim()))?.[1];
    const eLat = e.lat ?? e.center?.lat;
    const eLon = e.lon ?? e.center?.lon;
    if (!chain || eLat == null || eLon == null) continue;
    const dist = Math.round(km(lat, lon, eLat, eLon) * 10) / 10;
    const street = [t["addr:street"], t["addr:housenumber"]].filter(Boolean).join(" ");
    const city = [t["addr:postcode"], t["addr:city"]].filter(Boolean).join(" ");
    const address = [street, city].filter(Boolean).join(", ");
    const prev = best.get(chain);
    if (!prev || address && !prev.address || !!address === !!prev.address && dist < prev.distanceKm) {
      best.set(chain, { chain, name: t.name ?? chain, address, distanceKm: dist });
    }
  }
  return [...best.values()].sort((a, b) => a.distanceKm - b.distanceKm);
}

// worker/push.ts
var b64url = (buf) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  bytes.forEach((b) => s += String.fromCharCode(b));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
async function vapidKeys(kv) {
  const existing = await kv.get("push:vapid", "json");
  if (existing) return existing;
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pub = await crypto.subtle.exportKey("raw", pair.publicKey);
  const priv = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const keys = { publicKey: b64url(pub), privateJwk: priv };
  await kv.put("push:vapid", JSON.stringify(keys));
  return keys;
}
async function sendPush(kv, endpoint) {
  const keys = await vapidKeys(kv);
  const key = await crypto.subtle.importKey("jwk", keys.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const aud = new URL(endpoint).origin;
  const enc = new TextEncoder();
  const header = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1e3) + 12 * 3600, sub: "mailto:angebotskueche@example.invalid" })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${header}.${claims}`));
  const jwt = `${header}.${claims}.${b64url(sig)}`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `vapid t=${jwt}, k=${keys.publicKey}`, TTL: String(24 * 3600), Urgency: "normal", "Content-Length": "0" }
  });
  return res.status;
}

// worker/sync.ts
var isSyncKey = (k) => ["settings", "trip", "cart", "shopping", "saved", "lastRecipes", "watch"].includes(k) || /^savings:\d{4}-\d{2}$/.test(k);
function mergeDocs(base, changes) {
  const out = { ...base };
  for (const [k, e] of Object.entries(changes)) {
    if (!isSyncKey(k) || !e || typeof e.t !== "number") continue;
    if (!out[k] || e.t > out[k].t) out[k] = { v: e.v ?? null, t: Math.min(e.t, Date.now() + 6e4) };
  }
  return out;
}

// shared/watch.ts
var fold2 = (t) => t.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss");
function matchWatch(term, offers) {
  const t = fold2(term.trim());
  if (t.length < 2) return [];
  return offers.filter((o) => fold2(`${o.name} ${o.brand ?? ""} ${o.category} ${o.desc}`).includes(t)).sort((a, b) => Date.parse(a.validFrom) - Date.parse(b.validFrom) || a.price - b.price);
}

// worker/deals.ts
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / 864e5 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}
var norm2 = (t) => t.toLowerCase().replace(/[„“"'()]/g, "").replace(/\s+/g, " ").trim();
var productKey = (o) => `${o.chain}|${norm2(o.name)}|${norm2(o.brand ?? "")}`;
var unitPrice = (o) => o.refPrice ?? o.price;
function snapshot(offers) {
  const items = {};
  for (const o of offers) items[productKey(o)] = Math.round(unitPrice(o) * 100) / 100;
  return { week: isoWeek(/* @__PURE__ */ new Date()), items };
}
var median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
function computeDealsFrom(offers, history) {
  const now = Date.now();
  const current = offers.filter((o) => Date.parse(o.validFrom) <= now + 3 * 864e5);
  const groups = /* @__PURE__ */ new Map();
  for (const o of current) {
    if (!o.refPrice || !o.refUnit || !o.category) continue;
    const k = `${o.category}|${o.refUnit}`;
    groups.set(k, [...groups.get(k) ?? [], o.refPrice]);
  }
  const enoughHistory = history.length >= 3;
  const deals = [];
  for (const o of current) {
    const reasons = [];
    let score = 0;
    if (o.oldPrice && o.oldPrice > o.price) {
      const pct = Math.round((1 - o.price / o.oldPrice) * 100);
      if (pct >= 30) {
        reasons.push(`\u2212${pct} % reduziert`);
        score += pct;
      }
    }
    if (o.refPrice && o.refUnit && o.category) {
      const peers = groups.get(`${o.category}|${o.refUnit}`) ?? [];
      if (peers.length >= 3 && o.refPrice <= Math.min(...peers) && o.refPrice < median(peers) * 0.8) {
        reasons.push(`g\xFCnstigster ${o.category}-Preis diese Woche`);
        score += 25;
      }
    }
    if (enoughHistory) {
      const key = productKey(o);
      const past = history.map((h) => h.items[key]).filter((x) => typeof x === "number");
      if (past.length <= Math.floor(history.length / 4)) {
        reasons.push(past.length === 0 ? `seit ${history.length} Wochen nicht im Angebot` : "selten im Angebot");
        score += 20;
      }
      if (past.length >= 2) {
        const typical = median(past);
        if (unitPrice(o) < typical * 0.85) {
          reasons.push(`${Math.round((1 - unitPrice(o) / typical) * 100)} % g\xFCnstiger als sonst`);
          score += 30;
        }
      }
    }
    if (reasons.length) deals.push({ offerId: o.id, reasons, score: o.cooking ? score + 5 : score });
  }
  deals.sort((a, b) => b.score - a.score);
  return { deals: deals.slice(0, 40), weeksOfHistory: history.length };
}

// worker/index.ts
var aiConfig = (env) => ({ apiKey: env.OPENROUTER_API_KEY ?? "", appUrl: env.APP_URL });
var tracker = (env, user) => (usd) => addCost(env.CACHE, usd, user?.id);
var budget = (env) => Number(env.MONTHLY_BUDGET_USD ?? 8);
var userBudget = (env, user) => user.dailyBudgetUsd ?? Number(env.DAILY_USER_BUDGET_USD ?? 0.1);
async function userOverBudget(env, user) {
  return await dayCost(env.CACHE, user.id) >= userBudget(env, user);
}
async function overBudget(env) {
  return await monthCost(env.CACHE) >= budget(env);
}
var HOUR = 36e5;
var memo = /* @__PURE__ */ new Map();
async function cached(env, key, ttlMs, load, force = false) {
  const hit = memo.get(key);
  if (!force && hit && Date.now() - hit.at < ttlMs) return hit.data;
  if (!force && env.CACHE) {
    const kv = await env.CACHE.get(key, "json");
    if (kv && Date.now() - kv.at < ttlMs) {
      memo.set(key, kv);
      return kv.data;
    }
  }
  const data = await load();
  const entry = { at: Date.now(), data };
  memo.set(key, entry);
  if (env.CACHE) await env.CACHE.put(key, JSON.stringify(entry), { expirationTtl: Math.max(60, Math.ceil(ttlMs / 1e3) * 2) });
  return data;
}
async function kvGet(env, key) {
  return env.CACHE ? env.CACHE.get(key, "json") : null;
}
async function kvPut(env, key, value, ttlSec) {
  if (env.CACHE) await env.CACHE.put(key, JSON.stringify(value), ttlSec ? { expirationTtl: Math.max(60, ttlSec) } : void 0);
}
async function mobileOffers(env, m, force = false) {
  if (!env.CACHE) return null;
  const gln = await getGln(env.CACHE, m.marketNo);
  if (!gln || gln === "none") return null;
  return cached(env, `edeka:mob:${gln}`, 3 * HOUR, () => fetchMobileOffers(env, m, gln), force);
}
async function prospektOffers(env, m) {
  const now = Date.now();
  const idx = await kvGet(env, `edeka:idx:${m.marketNo}`);
  const valid = (idx?.prospekte ?? []).filter((p) => Date.parse(p.validTo) >= now);
  const lists = await Promise.all(
    valid.map(async (p) => {
      const l = await kvGet(env, pdfKey(p.key)) ?? await kvGet(env, `edeka:pdf:${p.key}`);
      return l ? withCurrentImages(l, p, m.marketNo) : null;
    })
  );
  return lists.flatMap((l) => l ?? []);
}
async function edekaOffers(env, m, force = false) {
  const mobile = await mobileOffers(env, m, force);
  if (mobile && !mobile.national && mobile.offers.length) return { offers: mobile.offers };
  const prospekt = await prospektOffers(env, m);
  if (prospekt.length) return { offers: prospekt };
  if (mobile) return { offers: mobile.offers, note: "Prospekt wird eingelesen \u2013 bis dahin nur die bundesweiten Angebote" };
  const gln = env.CACHE ? await getGln(env.CACHE, m.marketNo) : null;
  return { offers: [], note: gln ? "Prospekt wird eingelesen" : "Markt wird eingerichtet \u2013 die Angebote kommen in K\xFCrze" };
}
var WATCH_DAYS = 14;
async function watchMarket(env, m) {
  const list = await kvGet(env, "edeka:watch") ?? [];
  const hit = list.find((x) => x.id === m.id);
  if (hit && Date.now() - (hit.lastSeen ?? 0) < 864e5) return;
  const next = [...list.filter((x) => x.id !== m.id), { ...m, lastSeen: Date.now() }];
  await kvPut(env, "edeka:watch", next);
  if (env.CACHE) await requestMarketData(env.CACHE, m.marketNo);
}
var centerOf = (env, plz) => cached(env, `geo:${plz}`, 90 * 24 * HOUR, () => geocode(plz));
async function nearestFirst(env, plz, found) {
  const c = await centerOf(env, plz).catch(() => null);
  if (!c) return found.slice(0, 6);
  return found.map((m) => ({ ...m, distanceKm: m.lat && m.lon ? Math.round(km(c.lat, c.lon, m.lat, m.lon) * 10) / 10 : void 0 })).filter((m) => m.distanceKm == null || m.distanceKm <= 15).sort((a, b) => (a.distanceKm ?? 99) - (b.distanceKm ?? 99));
}
async function rememberMarkets(env, plz, list) {
  if (!list.length) return;
  await Promise.all([
    ...list.map((m) => kvPut(env, `edeka:m:${m.id}`, m, 90 * 86400)),
    kvPut(env, `edeka:nearlast:${plz}`, list)
  ]);
  for (const m of list) memo.set(`edeka:m:${m.id}`, { at: Date.now(), data: m });
}
async function nearbyMarkets(env, plz) {
  try {
    const list = await cached(env, `edeka:near2:${plz}`, 24 * HOUR, async () => {
      const found = await nearestFirst(env, plz, await searchMarkets(plz));
      if (!found.length) throw new Error("EDEKA-Marktsuche lieferte keine M\xE4rkte");
      return found;
    });
    await rememberMarkets(env, plz, list);
    return list;
  } catch (e) {
    const last = await kvGet(env, `edeka:nearlast:${plz}`);
    if (last?.length) return last;
    throw e;
  }
}
async function marketById(env, id) {
  const hit = memo.get(`edeka:m:${id}`);
  if (hit) return hit.data;
  return kvGet(env, `edeka:m:${id}`);
}
async function aldiRegion(env, plz) {
  try {
    const c = await centerOf(env, plz).catch(() => null);
    const stores = await cached(env, `stores:${plz}`, 7 * 24 * HOUR, () => nearestStores(plz, c));
    const nord = stores.find((s) => s.chain === "ALDI Nord")?.distanceKm ?? Infinity;
    const sued = stores.find((s) => s.chain === "ALDI S\xDCD")?.distanceKm ?? Infinity;
    if (nord === Infinity && sued === Infinity) return "unbekannt";
    return nord <= sued ? "nord" : "sued";
  } catch {
    return "unbekannt";
  }
}
async function getOffers(env, plz, marketIds = [], force = false) {
  const notes = [];
  const errors = [];
  const settle = async (label, p, fallback) => {
    try {
      return await p;
    } catch (e) {
      console.error(label, e);
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
      return fallback;
    }
  };
  const region = await aldiRegion(env, plz);
  const [mg, aldi, nearby] = await Promise.all([
    settle("marktguru", cached(env, `mg:${plz}`, 6 * HOUR, async () => normalizeAll(await fetchRawOffers(plz)), force), {
      offers: [],
      chains: []
    }),
    region === "sued" ? [] : settle("ALDI Nord", cached(env, "aldi:nord", 6 * HOUR, fetchAldiNord, force), []),
    settle("EDEKA-Marktsuche", nearbyMarkets(env, plz), [])
  ]);
  const markets = (await Promise.all(marketIds.map((id) => marketById(env, id)))).filter((m) => !!m);
  const edeka = await Promise.all(
    markets.map(async (m) => {
      await watchMarket(env, m);
      const r = await settle(m.name, edekaOffers(env, m, force), { offers: [] });
      return { m, ...r };
    })
  );
  const offers = [...mg.offers, ...aldi, ...edeka.flatMap((e) => e.offers)];
  const chains = [
    ...mg.chains.map((c) => ({ ...c, kind: "kette" })),
    ...aldi.length ? [{ name: ALDI_NORD, count: aldi.length, kind: "kette" }] : [],
    ...edeka.map((e) => marketChainInfo(e.m, e.offers.length, e.note))
  ];
  for (const e of edeka) if (e.note) notes.push(`${e.m.name}: ${e.note}`);
  return {
    plz,
    fetchedAt: (/* @__PURE__ */ new Date()).toISOString(),
    chains,
    // Gewählte Märkte immer mit anbieten, auch wenn die Suche sie gerade nicht liefert
    nearby: [...nearby, ...markets.filter((m) => !nearby.some((n) => n.id === m.id))].map((m) => marketChainInfo(m)),
    offers,
    notes,
    errors
  };
}
var shortName = (c) => c.replace("Netto Marken-Discount", "Netto").replace("PENNY", "Penny").replace(/^nah\s*(&|und)\s*gut.*/i, "nah & gut");
async function pushMessage(env, sub) {
  const data = await getOffers(env, sub.plz, sub.markets);
  const now = Date.now();
  const offers = data.offers.filter(
    (o) => (!sub.chains.length || sub.chains.includes(o.chain)) && Date.parse(o.validFrom) <= now + 12 * HOUR && Date.parse(o.validTo) >= now
  );
  if (!sub.watch.length) return { title: "Neue Angebote der Woche", body: "Die Prospekte der Woche sind da \u2013 schau mal rein." };
  const hits = sub.watch.map((t) => ({ t, chains: [...new Set(matchWatch(t, offers).map((o) => shortName(o.chain)))] })).filter((h) => h.chains.length);
  if (!hits.length) return { title: "Merkliste", body: "Von deiner Merkliste ist diese Woche nichts im Angebot." };
  return {
    title: `Merkliste: ${hits.length} von ${sub.watch.length} im Angebot`,
    body: hits.map((h) => `${h.t}: ${h.chains.join(", ")}`).join(" \xB7 ")
  };
}
var subsOf = async (env) => await kvGet(env, "push:subs") ?? [];
async function weeklyPush(env) {
  if (!env.CACHE) return "kein KV";
  const berlin2 = new Date((/* @__PURE__ */ new Date()).toLocaleString("en-US", { timeZone: "Europe/Berlin" }));
  if (berlin2.getDay() !== 1 || berlin2.getHours() < 7) return "nicht Montagmorgen";
  const key = `push:sent:${isoWeek(berlin2)}`;
  if (await env.CACHE.get(key)) return "diese Woche schon gesendet";
  await env.CACHE.put(key, (/* @__PURE__ */ new Date()).toISOString(), { expirationTtl: 14 * 86400 });
  const subs = await subsOf(env);
  const keep = [];
  for (const sub of subs) {
    const status = await sendPush(env.CACHE, sub.endpoint).catch(() => 0);
    if (status !== 404 && status !== 410) keep.push(sub);
  }
  if (keep.length !== subs.length) await kvPut(env, "push:subs", keep);
  return `an ${subs.length} Ger\xE4t(e) gesendet`;
}
async function ensureSnapshot(env, plz, offers) {
  const key = `hist:${plz}:${isoWeek(/* @__PURE__ */ new Date())}`;
  if (memo.has(key) || !env.CACHE || !offers.length) return;
  if (!await env.CACHE.get(key)) await kvPut(env, key, snapshot(offers), 200 * 86400);
  memo.set(key, { at: Date.now(), data: true });
}
async function computeDeals(env, scope, offers) {
  const now = /* @__PURE__ */ new Date();
  await ensureSnapshot(env, scope, offers);
  const weeks = [];
  for (let i = 1; i <= 12; i++) {
    const w = isoWeek(new Date(now.getTime() - i * 7 * 864e5));
    const snap = await kvGet(env, `hist:${scope}:${w}`);
    if (snap) weeks.push(snap);
  }
  return computeDealsFrom(offers, weeks);
}
async function getLeaflets(env, plz, marketIds) {
  const errors = [];
  const data = await getOffers(env, plz, marketIds);
  const leaflets = [];
  const flights = /* @__PURE__ */ new Map();
  for (const o of data.offers) if (o.flight) flights.set(o.flight, (flights.get(o.flight) ?? 0) + 1);
  const relevant = [...flights.entries()].filter(([, n]) => n >= 5).map(([f]) => f);
  const mg = await Promise.all(
    relevant.map((f) => cached(env, `mg:leaflet:${f}:${plz}`, 6 * HOUR, () => fetchBestLeaflet(f, plz)).catch(() => null))
  );
  const seen = /* @__PURE__ */ new Set();
  for (const l of mg) {
    if (!l || !l.pageImages?.count || seen.has(l.id) || Date.parse(l.validTo) < Date.now()) continue;
    seen.add(l.id);
    const n = l.pageImages.count;
    leaflets.push({
      id: `mg-${l.id}`,
      chain: l.advertiser?.name ?? "",
      validFrom: l.validFrom,
      validTo: l.validTo,
      pages: Array.from({ length: n }, (_, i) => leafletPage(l.id, i, "medium")),
      pagesLarge: Array.from({ length: n }, (_, i) => leafletPage(l.id, i, "large"))
    });
  }
  for (const id of marketIds) {
    const m = await marketById(env, id);
    if (!m) continue;
    try {
      const ps = await cached(env, `edeka:prosp2:${m.marketNo}`, HOUR, () => prospekteOf(env, m));
      for (const p of ps) {
        if (!p.pageCount || Date.parse(p.validTo) < Date.now()) continue;
        leaflets.push({
          id: `ed-${p.key}`,
          chain: m.name,
          validFrom: p.validFrom,
          validTo: p.validTo,
          pages: Array.from({ length: p.pageCount }, (_, i) => prospektPage(p, i + 1, "normal")),
          pagesLarge: Array.from({ length: p.pageCount }, (_, i) => prospektPage(p, i + 1, "large"))
        });
      }
    } catch (e) {
      errors.push(`${m.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  leaflets.sort((a, b) => a.chain.localeCompare(b.chain) || Date.parse(a.validFrom) - Date.parse(b.validFrom));
  return { leaflets, errors };
}
var EXTRACT_VERSION = "v2";
var pdfKey = (k) => `edeka:pdf:${EXTRACT_VERSION}:${k}`;
var errKey = (k) => `edeka:err:${EXTRACT_VERSION}:${k}`;
var metaKey = (k) => `edeka:meta:${EXTRACT_VERSION}:${k}`;
async function prospekteOf(env, m) {
  const known = await kvGet(env, katKey(m.marketNo)) ?? ((await kvGet(env, `edeka:idx:${m.marketNo}`))?.prospekte ?? []).map((p) => catalogPath(p.key));
  if (known.length) return probeProspekte([...new Set(known)]);
  try {
    const ps = await findProspekte(m);
    if (ps.length) await kvPut(env, katKey(m.marketNo), [...new Set(ps.map((p) => catalogPath(p.key)))]);
    return ps;
  } catch {
    if (env.CACHE) await requestMarketData(env.CACHE, m.marketNo);
    throw new Error("Prospekt-Adresse wird \xFCber das Relay ermittelt");
  }
}
async function processMarket(env, m, maxExtract = 1, user) {
  const log = [];
  if (!env.OPENROUTER_API_KEY || !env.EXTRACT_MODEL || !env.CACHE) return ["OpenRouter-Schl\xFCssel, Modell (EXTRACT_MODEL) oder Datenbank fehlt"];
  const gln = await getGln(env.CACHE, m.marketNo);
  if (!gln) {
    await requestMarketData(env.CACHE, m.marketNo);
    return [`${m.name}: GLN noch unbekannt, wartet auf das Relay`];
  }
  if (gln !== "none") {
    const mobile = await mobileOffers(env, m);
    if (mobile && !mobile.national) return [`${m.name}: App-Schnittstelle liefert den eigenen Prospekt (${mobile.offers.length} Angebote) \u2013 kein Einlesen n\xF6tig`];
  }
  const prospekte = await prospekteOf(env, m);
  log.push(`${m.name}: ${prospekte.length} Prospekt(e) gefunden`);
  if (!prospekte.length) return log;
  const idx = { prospekte: [] };
  let extracted = 0;
  for (const p of prospekte) {
    const key = pdfKey(p.key);
    let offers = await kvGet(env, key);
    if (!offers && extracted < maxExtract) {
      const err = await kvGet(env, errKey(p.key));
      if (err && (err.tries ?? 1) >= 2) {
        log.push(`${p.key}: zweimal fehlgeschlagen \u2013 kein weiterer automatischer Versuch`);
      } else if (err && Date.now() - err.at < 3 * HOUR) {
        log.push(`${p.key}: letzter Versuch fehlgeschlagen, warte`);
      } else {
        extracted++;
        const capKey = `extract:count:${isoWeek(/* @__PURE__ */ new Date())}`;
        const done = Number(await env.CACHE.get(capKey) ?? 0);
        if (done >= Number(env.EXTRACT_PER_WEEK ?? 4)) {
          log.push(`${p.key}: Wochenlimit f\xFCr das Einlesen erreicht (${done})`);
          break;
        }
        await env.CACHE.put(capKey, String(done + 1), { expirationTtl: 14 * 86400 });
        try {
          const t0 = Date.now();
          if (await overBudget(env)) {
            log.push("Monatsbudget erreicht \u2013 Prospekt wird nicht eingelesen");
            break;
          }
          let cost = 0;
          const track = async (usd) => {
            cost += usd;
            await tracker(env, user)(usd);
          };
          offers = await extractProspekt(m, p, aiConfig(env), env.EXTRACT_MODEL, track);
          const ttl = Math.ceil((Date.parse(p.validTo) - Date.now()) / 1e3) + 86400;
          await kvPut(env, key, offers, ttl);
          await kvPut(env, metaKey(p.key), { extractedAt: (/* @__PURE__ */ new Date()).toISOString(), seconds: Math.round((Date.now() - t0) / 1e3), costUsd: Math.round(cost * 100) / 100 }, ttl);
          log.push(`${p.key}: ${offers.length} Angebote eingelesen (${Math.round((Date.now() - t0) / 1e3)} s)`);
        } catch (e) {
          await kvPut(env, errKey(p.key), { at: Date.now(), tries: (err?.tries ?? 0) + 1, msg: String(e) }, 8 * 86400);
          log.push(`${p.key}: Fehler ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    if (!offers) offers = await kvGet(env, `edeka:pdf:${p.key}`);
    if (offers) {
      const meta = await kvGet(env, metaKey(p.key)) ?? await kvGet(env, `edeka:meta:${p.key}`);
      idx.prospekte.push({ key: p.key, validFrom: p.validFrom, validTo: p.validTo, preview: p.preview, count: offers.length, ...meta });
    }
  }
  await kvPut(env, `edeka:idx:${m.marketNo}`, idx, 14 * 86400);
  return log;
}
async function runCron(env) {
  const all = await kvGet(env, "edeka:watch") ?? [];
  const list = all.filter((m) => Date.now() - (m.lastSeen ?? Date.now()) < WATCH_DAYS * 864e5);
  if (list.length !== all.length) await kvPut(env, "edeka:watch", list);
  const log = [];
  await kvPut(env, "cron:last", { at: (/* @__PURE__ */ new Date()).toISOString(), markets: list.length });
  log.push(`Push: ${await weeklyPush(env).catch((e) => String(e))}`);
  for (const m of list) {
    try {
      log.push(...await processMarket(env, m));
    } catch (e) {
      log.push(`${m.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return log;
}
async function checkLimit(env, name, max) {
  if (!env.CACHE) return true;
  const day = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const key = `rl:${name}:${day}`;
  const n = Number(await env.CACHE.get(key) ?? 0);
  if (n >= max) return false;
  await env.CACHE.put(key, String(n + 1), { expirationTtl: 2 * 86400 });
  return true;
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}
var error = (message, status = 500) => json({ error: message }, status);
var validPlz = (p) => !!p && /^\d{5}$/.test(p);
var parseIds = (s) => [...new Set((s ?? "").split(",").map(Number).filter((n) => Number.isFinite(n) && n > 0))].slice(0, 6);
function sameSecret(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function handleRelay(request, env, url) {
  const auth = request.headers.get("authorization") ?? "";
  if (!env.RELAY_TOKEN || !sameSecret(auth.replace(/^Bearer\s+/i, ""), env.RELAY_TOKEN)) return error("nicht erlaubt", 401);
  if (!env.CACHE) return error("Keine Datenbank verbunden", 500);
  if (url.pathname === "/relay/jobs" && request.method === "GET") return json({ jobs: await leaseJobs(env.CACHE) });
  if (url.pathname === "/relay/result" && request.method === "POST") {
    const b = await request.json().catch(() => null);
    if (!b?.id || typeof b.status !== "number") return error("Ergebnis unvollst\xE4ndig", 400);
    const note = await completeJob(env.CACHE, b.id, b.status, String(b.body ?? "").slice(0, 3e6));
    console.log(`Relay ${b.id}: ${note}`);
    return json({ ok: true, note });
  }
  return error("Unbekannter Pfad", 404);
}
async function handle(request, env) {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/relay/")) return handleRelay(request, env, url);
  if (!url.pathname.startsWith("/api/")) return error("Unbekannter Pfad", 404);
  try {
    const who = await currentUser(request, env);
    if (!("email" in who)) return error(`Nicht angemeldet (${who.reason})`, 401);
    const user = who;
    if (url.pathname === "/api/push/key" && env.CACHE) {
      return json({ publicKey: (await vapidKeys(env.CACHE)).publicKey });
    }
    if (url.pathname === "/api/push/subscribe" && request.method === "POST") {
      const b = await request.json();
      if (!b.endpoint || !validPlz(b.plz)) return error("Abo unvollst\xE4ndig", 400);
      const sub = {
        endpoint: b.endpoint,
        plz: b.plz,
        markets: (b.markets ?? []).slice(0, 6),
        chains: (b.chains ?? []).slice(0, 12),
        watch: (b.watch ?? []).map((w) => String(w).slice(0, 40)).slice(0, 30),
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      const subs = (await subsOf(env)).filter((x) => x.endpoint !== sub.endpoint);
      await kvPut(env, "push:subs", [...subs, sub].slice(-1e3));
      return json({ ok: true });
    }
    if (url.pathname === "/api/push/unsubscribe" && request.method === "POST") {
      const b = await request.json();
      await kvPut(env, "push:subs", (await subsOf(env)).filter((x) => x.endpoint !== b.endpoint));
      return json({ ok: true });
    }
    if (url.pathname === "/api/push/latest") {
      const subs = await subsOf(env);
      const sub = subs.find((x) => x.endpoint === url.searchParams.get("endpoint")) ?? subs[subs.length - 1];
      return json(sub ? await pushMessage(env, sub) : { title: "Angebotsk\xFCche", body: "Neue Angebote der Woche sind da." });
    }
    if (url.pathname === "/api/push/test" && request.method === "POST" && env.CACHE) {
      const b = await request.json();
      if (!b.endpoint || !(await subsOf(env)).some((x) => x.endpoint === b.endpoint)) return error("Ger\xE4t nicht angemeldet", 404);
      if (!await checkLimit(env, "pushtest", 10)) return error("Heute genug getestet", 429);
      return json({ status: await sendPush(env.CACHE, b.endpoint) });
    }
    if (url.pathname === "/api/clear") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json", "cache-control": "no-store", "clear-site-data": '"cookies", "storage"' }
      });
    }
    if (url.pathname === "/api/login") return Response.redirect(new URL("/", url).toString(), 302);
    if (url.pathname === "/api/img") {
      const u = url.searchParams.get("u");
      return u ? proxyImage(u) : error("Bild fehlt", 400);
    }
    if (url.pathname === "/api/status") {
      const ids = parseIds(url.searchParams.get("markets"));
      const markets = (await Promise.all(ids.map((id) => marketById(env, id)))).filter((m) => !!m);
      const prospekte = await Promise.all(
        markets.map(async (m) => {
          const idx = await kvGet(env, `edeka:idx:${m.marketNo}`);
          const watch = (await kvGet(env, "edeka:watch"))?.find((w) => w.id === m.id);
          return {
            market: m.name,
            watched: !!watch,
            prospekte: (idx?.prospekte ?? []).map(({ key, ...rest }) => rest)
          };
        })
      );
      const cron = await kvGet(env, "cron:last");
      return json({ markets: prospekte, lastCheck: cron?.at ?? null, monthCostUsd: Math.round(await monthCost(env.CACHE) * 100) / 100 });
    }
    if (url.pathname === "/api/deals") {
      const plz = url.searchParams.get("plz");
      if (!validPlz(plz)) return error("Bitte eine 5-stellige PLZ angeben.", 400);
      const markets = parseIds(url.searchParams.get("markets"));
      const data = await getOffers(env, plz, markets);
      return json(await computeDeals(env, plz, data.offers));
    }
    if (url.pathname === "/api/stores") {
      const plz = url.searchParams.get("plz");
      if (!validPlz(plz)) return error("Bitte eine 5-stellige PLZ angeben.", 400);
      const c = await centerOf(env, plz).catch(() => null);
      return json({ stores: await cached(env, `stores:${plz}`, 7 * 24 * HOUR, () => nearestStores(plz, c)) });
    }
    if (url.pathname === "/api/leaflets") {
      const plz = url.searchParams.get("plz");
      if (!validPlz(plz)) return error("Bitte eine 5-stellige PLZ angeben.", 400);
      return json(await getLeaflets(env, plz, parseIds(url.searchParams.get("markets"))));
    }
    if (url.pathname === "/api/debug/edeka") {
      const m = await marketById(env, Number(url.searchParams.get("market")));
      if (!m) return error("Markt unbekannt", 404);
      const idx = await kvGet(env, `edeka:idx:${m.marketNo}`);
      const ps = await prospekteOf(env, m).catch((e) => String(e));
      const errs = Array.isArray(ps) ? await Promise.all(ps.map((p) => kvGet(env, errKey(p.key)))) : [];
      const watch = (await kvGet(env, "edeka:watch"))?.map((x) => `${x.name} (zuletzt ${new Date(x.lastSeen ?? 0).toISOString()})`);
      const first = idx?.prospekte[0] ? (await kvGet(env, pdfKey(idx.prospekte[0].key)) ?? []).slice(0, 15) : [];
      const week = await env.CACHE?.get(`extract:count:${isoWeek(/* @__PURE__ */ new Date())}`);
      const gln = env.CACHE ? await getGln(env.CACHE, m.marketNo) : null;
      const mobile = await mobileOffers(env, m).catch((e) => String(e));
      return json({
        market: m,
        gln,
        mobile: mobile && typeof mobile === "object" ? { national: mobile.national, count: mobile.offers.length, categories: mobile.categories, sample: mobile.offers.slice(0, 10).map((o) => `${o.name} | ${o.price} | ${o.group}`) } : mobile,
        relay: env.CACHE ? await relayStatus(env.CACHE) : null,
        watch,
        extractsThisWeek: Number(week ?? 0),
        idx,
        prospekte: ps,
        errors: errs,
        withCrop: first.filter((o) => o.crop).length,
        sample: first.map((o) => `${o.name} | ${o.price} | S.${o.page ?? "?"} | crop ${o.crop ? `${o.crop.x},${o.crop.y},${o.crop.w},${o.crop.h}` : "KEIN"}`)
      });
    }
    if (url.pathname === "/api/debug/sources") {
      const urls = [
        "https://www.edeka.de/api/marketsearch/markets?searchstring=38536",
        "https://www.edeka.de/eh/service/eh/offers?marketId=10007022",
        "https://www.edeka.de/maerkte/801116/prospekte/",
        "https://blaetterkatalog.edeka.de/MINDEN/8011165/blaetterkatalog/xml/catalog.xml",
        "https://blaetterkatalog.edeka.de/MINDEN/8011165/blaetterkatalog/normal/bk_1.jpg",
        "https://www.marktguru.de/",
        "https://www.aldi-nord.de/angebote.html",
        "https://www.aldi-sued.de/de/angebote.html",
        "https://overpass-api.de/api/status"
      ];
      const variants = {
        mobil: { "user-agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36", "accept-language": "de-DE,de;q=0.9" },
        desktop: {
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36",
          accept: "text/html,application/json;q=0.9,*/*;q=0.8",
          "accept-language": "de-DE,de;q=0.9,en;q=0.8",
          referer: "https://www.edeka.de/"
        },
        ohne: {}
      };
      const out = {};
      for (const [name, headers] of Object.entries(variants)) {
        for (const u of urls) {
          try {
            const r = await fetch(u, { headers });
            out[`${name} ${u}`] = `${r.status} ${r.headers.get("content-type") ?? ""} ${r.headers.get("server") ?? ""}`;
          } catch (e) {
            out[`${name} ${u}`] = String(e);
          }
        }
      }
      return json(out);
    }
    if (url.pathname === "/api/sync") {
      if (!env.CACHE) return error("Keine Datenbank verbunden", 500);
      const key = syncKeyFor(user);
      const doc = await kvGet(env, key) ?? {};
      if (request.method === "GET") return json({ email: user.email, doc });
      if (request.method === "PUT") {
        const body = await request.json().catch(() => null);
        if (!body?.changes || typeof body.changes !== "object") return error("Keine \xC4nderungen", 400);
        const merged = mergeDocs(doc, body.changes);
        const size = JSON.stringify(merged).length;
        if (size > 5e6) return error("Zu viele Daten f\xFCr den Abgleich", 413);
        await kvPut(env, key, merged);
        return json({ email: user.email, doc: merged });
      }
      return error("Methode nicht erlaubt", 405);
    }
    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        hasKey: !!env.OPENROUTER_API_KEY,
        hasCache: !!env.CACHE,
        model: env.RECIPE_MODEL ?? null,
        extractModel: env.EXTRACT_MODEL ?? null,
        monthCostUsd: Math.round(await monthCost(env.CACHE) * 100) / 100,
        budgetUsd: budget(env),
        userCostToday: Math.round(await dayCost(env.CACHE, user.id) * 1e3) / 1e3,
        userBudgetUsd: userBudget(env, user)
      });
    }
    if (url.pathname === "/api/edeka/markets" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      const plz = body?.plz ?? null;
      if (!validPlz(plz)) return error("Bitte eine 5-stellige PLZ angeben.", 400);
      const list = await nearestFirst(env, plz, parseMarkets(body?.markets));
      await rememberMarkets(env, plz, list);
      return json({ nearby: list.map((m) => marketChainInfo(m)) });
    }
    if (url.pathname === "/api/offers" && request.method === "GET") {
      const plz = url.searchParams.get("plz");
      if (!validPlz(plz)) return error("Bitte eine 5-stellige PLZ angeben.", 400);
      const data = await getOffers(env, plz, parseIds(url.searchParams.get("markets")), url.searchParams.get("refresh") === "1");
      await ensureSnapshot(env, plz, data.offers).catch(() => void 0);
      return json(data);
    }
    if (url.pathname === "/api/recipes" && request.method === "POST") {
      if (!env.OPENROUTER_API_KEY || !env.RECIPE_MODEL) {
        return error("OpenRouter ist nicht eingerichtet (OPENROUTER_API_KEY und RECIPE_MODEL in der .env).", 500);
      }
      const body = await request.json();
      if (!validPlz(body.plz)) return error("Bitte eine 5-stellige PLZ angeben.", 400);
      if (await overBudget(env)) {
        return error(`Das KI-Budget von ${budget(env)} $ f\xFCr diesen Monat ist aufgebraucht. Ab dem 1. geht es weiter.`, 429);
      }
      if (await userOverBudget(env, user)) {
        return error(`Dein KI-Budget von ${userBudget(env, user).toFixed(2)} $ f\xFCr heute ist aufgebraucht. Morgen geht es weiter.`, 429);
      }
      const data = await getOffers(env, body.plz, (body.markets ?? []).slice(0, 6));
      return json(await generateRecipes(body, data.offers, env, tracker(env, user)));
    }
    if (url.pathname === "/api/admin/extract") {
      const id = Number(url.searchParams.get("market"));
      const m = await marketById(env, id);
      if (!m) return error("Markt unbekannt \u2013 erst \xFCber die PLZ suchen.", 404);
      if (!await checkLimit(env, "extract", 6)) return error("Heute schon oft genug eingelesen.", 429);
      if (await overBudget(env)) return error("Das KI-Budget f\xFCr diesen Monat ist aufgebraucht.", 429);
      if (await userOverBudget(env, user)) return error("Dein KI-Budget f\xFCr heute ist aufgebraucht.", 429);
      const { readable, writable } = new TransformStream();
      const w = writable.getWriter();
      const enc = new TextEncoder();
      const tick = setInterval(() => void w.write(enc.encode(".")), 1e4);
      (async () => {
        try {
          await watchMarket(env, m);
          const log = await processMarket(env, m, 2, user);
          await w.write(enc.encode("\n" + JSON.stringify({ log })));
        } catch (e) {
          await w.write(enc.encode("\n" + JSON.stringify({ error: String(e) })));
        } finally {
          clearInterval(tick);
          await w.close();
        }
      })();
      return new Response(readable, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    }
    return error("Unbekannter Pfad", 404);
  } catch (e) {
    console.error(e);
    return error(e instanceof Error ? e.message : String(e), 502);
  }
}

// worker/kv.ts
import postgres from "postgres";
async function pgKv(url) {
  const sql = postgres(url, { max: 10, idle_timeout: 30, onnotice: () => void 0 });
  await sql`
    create table if not exists kv (
      key text primary key,
      value text not null,
      expires_at timestamptz
    )`;
  await sql`create index if not exists kv_expires_at on kv (expires_at) where expires_at is not null`;
  async function get(key, type) {
    const [row] = await sql`
      select value from kv where key = ${key} and (expires_at is null or expires_at > now())`;
    if (!row) return null;
    if (type !== "json") return row.value;
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
      const expires = ttl ? new Date(Date.now() + Math.max(60, ttl) * 1e3) : null;
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
    close: () => sql.end({ timeout: 5 })
  };
}
function memoryKv() {
  const m = /* @__PURE__ */ new Map();
  const read = (key) => {
    const e = m.get(key);
    if (!e) return null;
    if (e.exp && e.exp <= Date.now()) {
      m.delete(key);
      return null;
    }
    return e.v;
  };
  return {
    async get(key, type) {
      const v = read(key);
      if (v == null || type !== "json") return v;
      try {
        return JSON.parse(v);
      } catch {
        return null;
      }
    },
    async put(key, value, opts) {
      m.set(key, { v: value, exp: opts?.expirationTtl ? Date.now() + Math.max(60, opts.expirationTtl) * 1e3 : void 0 });
    },
    async delete(key) {
      m.delete(key);
    }
  };
}

// worker/server.ts
var PORT = Number(process.env.PORT ?? 8080);
var DIST = resolve(process.env.STATIC_DIR ?? "dist");
var CRON_MS = 30 * 6e4;
var TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2"
};
async function serveStatic(req, res, pathname) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
  let file = join(DIST, rel);
  if (file !== DIST && !file.startsWith(DIST + sep)) {
    res.writeHead(400).end();
    return;
  }
  let info = await stat(file).catch(() => null);
  if (!info?.isFile()) {
    if (extname(rel)) {
      res.writeHead(404).end("nicht gefunden");
      return;
    }
    file = join(DIST, "index.html");
    info = await stat(file).catch(() => null);
    if (!info) {
      res.writeHead(500).end("App nicht gebaut (dist/ fehlt)");
      return;
    }
  }
  const immutable = rel.startsWith("assets/");
  res.writeHead(200, {
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    "content-length": info.size,
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache"
  });
  if (req.method === "HEAD") res.end();
  else createReadStream(file).pipe(res);
}
function toRequest(req, url) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else if (v != null) headers.set(k, v);
  }
  const body = req.method === "GET" || req.method === "HEAD" ? void 0 : Readable.toWeb(req);
  return new Request(url, { method: req.method, headers, body, duplex: "half" });
}
async function sendResponse(res, r) {
  const headers = {};
  r.headers.forEach((v, k) => {
    headers[k] = v;
  });
  const cookies = r.headers.getSetCookie();
  if (cookies.length) headers["set-cookie"] = cookies;
  res.writeHead(r.status, headers);
  if (!r.body) {
    res.end();
    return;
  }
  const reader = r.body.getReader();
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
}
async function main() {
  let kv;
  let cleanup = async () => 0;
  if (process.env.DATABASE_URL) {
    const pg = await pgKv(process.env.DATABASE_URL);
    kv = pg;
    cleanup = pg.cleanup;
  } else {
    console.warn("DATABASE_URL fehlt \u2013 Daten liegen nur im Arbeitsspeicher");
    kv = memoryKv();
  }
  const env = { ...process.env, CACHE: kv };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    try {
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/relay/")) {
        await sendResponse(res, await handle(toRequest(req, url), env));
      } else if (req.method === "GET" || req.method === "HEAD") {
        await serveStatic(req, res, url.pathname);
      } else {
        res.writeHead(405).end();
      }
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end("Serverfehler");
    }
  });
  server.listen(PORT, () => console.log(`Angebotsk\xFCche l\xE4uft auf Port ${PORT}`));
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      console.log((await runCron(env)).join("\n"));
      const n = await cleanup();
      if (n) console.log(`${n} abgelaufene Eintr\xE4ge gel\xF6scht`);
    } catch (e) {
      console.error("Zeitplan", e);
    } finally {
      running = false;
    }
  };
  setTimeout(tick, 6e4);
  setInterval(tick, CRON_MS);
  const stop = () => {
    server.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
