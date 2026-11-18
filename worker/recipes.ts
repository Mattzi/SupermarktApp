// Erzeugt Rezepte aus den aktuellen Angeboten mit einem KI-Modell über OpenRouter.
import { stripBio } from '../shared/bio';
import type { Diet, Offer, Recipe, RecipeIngredient, RecipeRequest, RecipesResponse } from '../shared/types';
import type { Env } from './index';
import type { Tracker } from './costs';
import { askJson, costOf } from './ai';

const MAX_OFFERS = 650;

const DIET_TEXT: Record<string, string> = {
  alles: 'egal – Fleisch, Fisch oder vegetarisch, gerne gemischt',
  fleisch: 'mit Fleisch (Fleisch ist die Hauptzutat)',
  fisch: 'mit Fisch oder Meeresfrüchten als Hauptzutat, kein Fleisch',
  vegetarisch: 'vegetarisch (kein Fleisch, kein Fisch)',
  vegan: 'vegan (keine tierischen Produkte, auch keine Milch, Eier, Honig)',
};

function dietAllows(choice: RecipeRequest['diet'], d: Diet): boolean {
  switch (choice) {
    case 'vegan':
      return d === 'vegan';
    case 'vegetarisch':
      return d === 'vegan' || d === 'vegetarisch';
    case 'fisch':
      return d !== 'fleisch';
    default:
      return true;
  }
}

const GROUP_PRIORITY: Record<string, number> = {
  fleisch: 0,
  fisch: 0,
  gemuese: 1,
  milch: 2,
  vorrat: 3,
  tiefkuehl: 4,
  wurst: 5,
  feinkost: 6,
  obst: 7,
  brot: 8,
};

const fold = (t: string) => t.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');

export function dislikedBy(req: RecipeRequest) {
  const words = (req.dislikes ?? []).map((d) => fold(stripBio(d))).filter((d) => d.length >= 3);
  return (o: Offer) => words.some((w) => fold(`${o.name} ${o.brand ?? ''}`).includes(w));
}

export function selectOffers(req: RecipeRequest, offers: Offer[], now = Date.now()): Offer[] {
  const chains = new Set(req.chains);
  const disliked = dislikedBy(req);
  const soon = now + 3 * 86400_000;
  const list = offers.filter(
    (o) =>
      o.cooking &&
      (chains.size === 0 || chains.has(o.chain)) &&
      Date.parse(o.validFrom) <= soon &&
      dietAllows(req.diet, o.diet) &&
      !disliked(o),
  );
  list.sort((a, b) => (GROUP_PRIORITY[a.group] ?? 9) - (GROUP_PRIORITY[b.group] ?? 9));
  const picked = list.slice(0, MAX_OFFERS);
  // Korb-Angebote immer mitschicken, auch wenn sie sonst herausgefiltert würden
  for (const id of cartIds(req).reverse()) {
    const f = offers.find((o) => o.id === id);
    if (f && !picked.includes(f)) picked.unshift(f);
  }
  return picked;
}

const eur = (n: number) => n.toFixed(2);

export function cartIds(req: RecipeRequest): number[] {
  const ids = [...(req.cart ?? []), ...(req.focusOfferId ? [req.focusOfferId] : [])];
  return [...new Set(ids)].slice(0, 12);
}

function offerLine(o: Offer): string {
  const parts = [
    o.id,
    o.chain,
    o.brand ? `${o.name} (${o.brand})` : o.name,
    o.pack ?? '?',
    `${eur(o.price)} €`,
    o.group,
    o.diet,
  ];
  if (o.multi || o.desc) parts.push(o.desc.slice(0, 80));
  return parts.join(' | ');
}

const TOOL = {
  name: 'rezepte_ausgeben',
  description: 'Gibt die fertigen Rezepte strukturiert aus.',
  input_schema: {
    type: 'object',
    properties: {
      recipes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            description: { type: 'string', description: 'Ein Satz, was das Gericht ausmacht' },
            minutes: { type: 'integer', description: 'Gesamtzeit inkl. Vorbereitung' },
            diet: { type: 'string', enum: ['fleisch', 'fisch', 'vegetarisch', 'vegan'] },
            ingredients: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  quantity: { type: 'string', description: 'Menge für alle Portionen, z. B. "500 g" oder "2 Stück"' },
                  offerId: {
                    type: ['integer', 'null'],
                    description: 'ID aus der Angebotsliste, wenn die Zutat ein Angebot ist, sonst null',
                  },
                  packs: {
                    type: ['integer', 'null'],
                    description: 'Anzahl Packungen des Angebots, die man kaufen muss',
                  },
                  estimatedPrice: {
                    type: ['number', 'null'],
                    description:
                      'Geschätzter Discounter-Preis in Euro für die nötige Packung, nur wenn kein Angebot und nicht Grundvorrat',
                  },
                  usedFraction: {
                    type: ['number', 'null'],
                    description:
                      'Anteil der gekauften Menge, der im Rezept verbraucht wird (0.1 bis 1). Beispiel: 250 g von einer 500-g-Packung = 0.5',
                  },
                  pantry: {
                    type: 'boolean',
                    description: 'true für Grundvorrat (Salz, Pfeffer, Öl, Zucker, Mehl, gängige Gewürze, Brühe)',
                  },
                },
                required: ['name', 'quantity', 'offerId', 'packs', 'estimatedPrice', 'usedFraction', 'pantry'],
                additionalProperties: false,
              },
            },
            steps: { type: 'array', items: { type: 'string' } },
            storage: {
              type: 'string',
              description: 'Hinweis zu Aufbewahrung/Einfrieren beim Vorkochen, sonst kurzer Resteverwertungs-Hinweis',
            },
            tip: { type: 'string', description: 'Optionaler Tipp, sonst leerer String' },
          },
          required: ['title', 'description', 'minutes', 'diet', 'ingredients', 'steps', 'storage', 'tip'],
          additionalProperties: false,
        },
      },
    },
    required: ['recipes'],
    additionalProperties: false,
  },
} as const;

function buildPrompt(req: RecipeRequest, offers: Offer[], cart: Offer[]): { system: string; user: string } {
  const servings = req.persons * req.days;
  const system = [
    'Du bist ein kreativer, praktischer Hobbykoch-Assistent für eine Spar-Rezepte-App in Deutschland.',
    'Du baust alltagstaugliche Rezepte aus aktuellen Supermarkt-Angeboten. Ziel: lecker und möglichst günstig pro Portion.',
    'Regeln:',
    '- Nutze für die Hauptzutaten Angebote aus der Liste und gib deren ID als offerId an. Erfinde keine IDs. Wenn du ein Produkt aus der Liste nennst, MUSS seine offerId gesetzt sein.',
    '- Jede Zutat ohne Angebot und ohne Grundvorrat braucht einen estimatedPrice größer 0.',
    '- packs = wie viele Packungen man kaufen muss, damit die Menge reicht (Packungsgröße beachten).',
    '- Zutaten, die nicht im Angebot sind, mit realistischem Discounter-Preis für die kleinste übliche Packung schätzen (estimatedPrice).',
    '- usedFraction = welcher Anteil der gekauften Menge im Rezept verbraucht wird (für den Preis pro Portion).',
    '- Grundvorrat (Salz, Pfeffer, Öl, Zucker, Mehl, Brühe, gängige Gewürze, Essig, Senf) mit pantry=true, ohne Preis.',
    '- Abwechslung: unterschiedliche Küchen und Hauptzutaten über die Rezepte hinweg.',
    '- Schritte kurz und klar, auf Deutsch, Mengen in den Schritten nennen.',
    '- Mengen in den Zutaten immer für die Gesamtzahl der Portionen.',
  ].join('\n');

  const lines: string[] = [];
  const stores = [...new Set(offers.map((o) => o.chain))];
  if (stores.length > 1 && req.singleStore) {
    lines.push(`Der Nutzer will pro Rezept nur in EINEN Laden: Jedes Rezept nutzt Angebote aus genau einem dieser Märkte (${stores.join(', ')}); die Rezepte dürfen auf verschiedene Märkte verteilt sein.`);
  } else if (stores.length > 1) {
    lines.push(
      `Der Nutzer kauft bewusst in diesen Märkten ein und kombiniert sie: ${stores.join(', ')}. Hole pro Rezept die besten Angebote aus ALLEN diesen Märkten und mische sie frei – ein Rezept soll, wo es passt, Angebote aus mindestens zwei Märkten nutzen. Wichtigstes Ziel: möglichst viele Zutaten kommen aus Angeboten. Nur bei gleichwertigen Angeboten nimm denselben Markt.`,
    );
  } else {
    lines.push('Alle Angebote stammen aus einem Markt. Nutze möglichst viele davon.');
  }

  if (!req.replace) lines.push(`Erstelle 5 Rezepte.`);
  lines.push(`Ernährung: ${DIET_TEXT[req.diet] ?? DIET_TEXT.alles}`);
  lines.push(
    req.days > 1
      ? `Portionen: ${servings} (${req.persons} Person${req.persons > 1 ? 'en' : ''} × ${req.days} Tage). Die Gerichte sollen sich zum Vorkochen eignen und ${req.days} Tage im Kühlschrank halten oder sich einfrieren lassen.`
      : `Portionen: ${servings}.`,
  );
  if (req.maxMinutes) lines.push(`Maximale Gesamtzeit: ${req.maxMinutes} Minuten.`);
  if (cart.length) {
    lines.push('');
    lines.push('EINKAUFSKORB – diese Angebote hat der Nutzer ausgewählt (ID | Markt | Produkt | Packung | Preis):');
    for (const o of cart) lines.push(`${o.id} | ${o.chain} | ${o.brand ? `${o.name} (${o.brand})` : o.name} | ${o.pack ?? '?'} | ${eur(o.price)} €`);
    if (cart.length === 1 || req.cartMode !== 'verteilen') {
      lines.push(
        cart.length === 1
          ? 'WICHTIG: Jedes der 5 Rezepte baut auf diesem Korb-Angebot als Hauptzutat auf.'
          : 'WICHTIG: Jedes der 5 Rezepte verwendet ALLE Korb-Angebote zusammen (5 verschiedene Gerichte). Passt ein Angebot gar nicht dazu, darfst du es in einem Rezept weglassen und sagst das kurz in der description.',
      );
    } else {
      lines.push(
        'WICHTIG: Verteile den Korb auf die 5 Rezepte. Jedes Rezept baut auf mindestens einem Korb-Angebot als Hauptzutat auf, zusammen kommen ALLE Korb-Angebote mindestens einmal vor. Weitere Korb-Angebote dürfen als Beilage dazu.',
      );
    }
    lines.push('Ergänze günstige, passende Angebote aus der Liste – bevorzugt aus denselben Märkten wie der Korb.');
  }
  if (req.wishes?.trim()) lines.push(`WICHTIG – Wunsch, der für jedes Rezept gilt: ${req.wishes.trim().slice(0, 300)}`);
  const dislikes = (req.dislikes ?? []).map((d) => d.trim()).filter(Boolean).slice(0, 40);
  if (dislikes.length) lines.push(`Der Nutzer mag NICHT – diese Zutaten niemals verwenden, auch nicht als Beilage und auch nicht als Bio-Variante: ${dislikes.join(', ')}.`);
  if (req.replace) {
    lines.push(`Erstelle nur 1 Rezept als Ersatz. Es soll sich deutlich von diesen unterscheiden: ${req.replace.avoidTitles.slice(0, 10).join('; ')}.`);
  }
  lines.push('Jedes Angebot steht nur EINMAL in der Zutatenliste. Braucht das Rezept mehr als eine Packung, setze packs (z. B. packs = 2) und gib die Gesamtmenge in quantity an – keine zweite Zeile mit derselben offerId.');
  lines.push('');
  lines.push('Aktuelle Angebote (ID | Markt | Produkt | Packung | Preis | Gruppe | Ernährung | Hinweis):');
  for (const o of offers) lines.push(offerLine(o));
  return { system, user: lines.join('\n') };
}

interface RawIngredient {
  name: string;
  quantity: string;
  offerId: number | null;
  packs: number | null;
  estimatedPrice: number | null;
  usedFraction?: number | null;
  pantry: boolean;
}
interface RawRecipe {
  title: string;
  description: string;
  minutes: number;
  diet: Diet;
  ingredients: RawIngredient[];
  steps: string[];
  storage: string;
  tip?: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

const norm = (t: string) => t.toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-zäöüß0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Findet ein Angebot über den Namen, falls die KI keine gültige ID geliefert hat */
function matchByName(name: string, offers: Offer[]): Offer | undefined {
  const n = norm(name);
  if (n.length < 4) return undefined;
  return offers.find((o) => {
    const on = norm(o.name);
    return on.length >= 4 && (n.includes(on) || on.includes(n));
  });
}

/** "500 g" + "250 g" = "750 g"; passt das nicht zusammen, werden die Mengen mit " + " verbunden */
export function addQuantities(a: string, b: string): string {
  const m = (t: string) => t.trim().match(/^(\d+(?:[.,]\d+)?)\s*(.*)$/);
  const x = m(a), y = m(b);
  if (x && y && x[2].toLowerCase() === y[2].toLowerCase()) {
    const sum = Number(x[1].replace(',', '.')) + Number(y[1].replace(',', '.'));
    return `${String(Math.round(sum * 100) / 100).replace('.', ',')}${x[2] ? ' ' + x[2] : ''}`;
  }
  return a.trim() === b.trim() ? a : `${a} + ${b}`;
}

/** Dasselbe Angebot nur einmal aufführen (die KI nennt es manchmal in zwei Zeilen statt packs = 2) */
function mergeSameOffer(list: RecipeIngredient[]): RecipeIngredient[] {
  const out: RecipeIngredient[] = [];
  for (const i of list) {
    const prev = i.offer ? out.find((x) => x.offer?.id === i.offer!.id) : undefined;
    if (!prev || !prev.offer || !i.offer) {
      out.push(i);
      continue;
    }
    const packs = prev.offer.packs + i.offer.packs;
    prev.offer = { ...prev.offer, packs };
    prev.quantity = addQuantities(prev.quantity, i.quantity);
    prev.cost = r2(packs * prev.offer.price);
    prev.usedCost = r2(prev.usedCost + i.usedCost);
  }
  return out;
}

export function priceRecipe(raw: RawRecipe, byId: Map<number, Offer>, servings: number, idx: number, cart: number[] = []): Recipe {
  const all = [...byId.values()];
  const ingredients: RecipeIngredient[] = mergeSameOffer(raw.ingredients.map((i) => {
    let o = i.offerId != null ? byId.get(i.offerId) : undefined;
    if (!o && !i.pantry && !(typeof i.estimatedPrice === 'number' && i.estimatedPrice > 0)) o = matchByName(i.name, all);
    const frac = typeof i.usedFraction === 'number' && i.usedFraction > 0 ? Math.min(1, i.usedFraction) : 1;
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
          image: o.image || undefined,
          page: o.page,
          crop: o.crop,
          validFrom: o.validFrom,
          validTo: o.validTo,
        },
        cost: r2(packs * o.price),
        usedCost: r2(packs * o.price * frac),
      };
    }
    if (i.pantry) return { name: i.name, quantity: i.quantity, pantry: true, cost: 0, usedCost: 0 };
    const est = typeof i.estimatedPrice === 'number' && i.estimatedPrice > 0 ? i.estimatedPrice : 0;
    return { name: i.name, quantity: i.quantity, pantry: false, estimatedPrice: est, cost: r2(est), usedCost: r2(est * frac) };
  }));
  const offerCost = r2(ingredients.filter((i) => i.offer).reduce((s, i) => s + i.cost, 0));
  const estimatedCost = r2(ingredients.filter((i) => !i.offer).reduce((s, i) => s + i.cost, 0));
  const totalCost = r2(offerCost + estimatedCost);
  const usedCost = r2(ingredients.reduce((s, i) => s + i.usedCost, 0));
  const chains = [...new Set(ingredients.flatMap((i) => (i.offer ? [i.offer.chain] : [])))];
  const offerIds = ingredients.flatMap((i) => (i.offer ? [i.offer.id] : []));
  const ends = ingredients.flatMap((i) => (i.offer?.validTo ? [Date.parse(i.offer.validTo)] : []));
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
    tip: raw.tip?.trim() || undefined,
    chains,
    offerCost,
    estimatedCost,
    totalCost,
    usedCost,
    perPortion: r2(usedCost / Math.max(1, servings)),
    usesCart: cart.filter((id) => offerIds.includes(id)),
    validTo: ends.length ? new Date(Math.min(...ends)).toISOString() : undefined,
  };
}

export async function generateRecipes(req: RecipeRequest, allOffers: Offer[], env: Env, track?: Tracker): Promise<RecipesResponse> {
  const persons = Math.min(Math.max(1, Math.round(req.persons || 1)), 6);
  const days = Math.min(Math.max(1, Math.round(req.days || 1)), 7);
  const r: RecipeRequest = { ...req, persons, days };
  const offers = selectOffers(r, allOffers);
  if (!offers.length) throw new Error('Für diese Auswahl gibt es gerade keine passenden Angebote.');
  const ids = cartIds(r);
  const cart = ids.map((id) => allOffers.find((o) => o.id === id)).filter((o): o is Offer => !!o);
  const { system, user } = buildPrompt(r, offers, cart);
  // Schnell-Modus nur, wenn ein eigenes Modell dafür gesetzt ist (sonst wäre es dasselbe Modell)
  const fast = !!r.fast && !!env.RECIPE_MODEL_FAST;
  const model = (fast ? env.RECIPE_MODEL_FAST : '') || env.RECIPE_MODEL || '';

  let raws: RawRecipe[] = [];
  let costUsd = 0;
  try {
    const res = await askJson<{ recipes: RawRecipe[] }>(
      { apiKey: env.OPENROUTER_API_KEY ?? '', appUrl: env.APP_URL },
      model,
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      TOOL.input_schema,
      100000,
      'low',
    );
    costUsd = res.costUsd;
    raws = res.data.recipes ?? [];
  } catch (e) {
    costUsd = costOf(e);
    throw e;
  } finally {
    await track?.(costUsd);
  }
  costUsd = Math.round(costUsd * 1000) / 1000;
  if (!raws.length) throw new Error('Die KI hat keine Rezepte geliefert. Bitte nochmal versuchen.');

  const byId = new Map(allOffers.map((o) => [o.id, o]));
  const servings = persons * days;
  const cartFound = cart.map((o) => o.id);
  const recipes = raws.map((x, i) => priceRecipe(x, byId, servings, i, cartFound)).sort((a, b) => a.perPortion - b.perPortion);
  const used = new Set(recipes.flatMap((x) => x.usesCart ?? []));
  return {
    recipes,
    model,
    fast,
    offerCount: offers.length,
    createdAt: new Date().toISOString(),
    costUsd,
    unusedCart: cartFound.filter((id) => !used.has(id)),
  };
}
