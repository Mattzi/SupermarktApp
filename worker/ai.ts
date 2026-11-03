// KI-Aufrufe über OpenRouter (OpenAI-kompatible Schnittstelle).
// Welches Modell genutzt wird, steht in den Einstellungen (RECIPE_MODEL, RECIPE_MODEL_FAST, EXTRACT_MODEL).
const URL = 'https://openrouter.ai/api/v1/chat/completions';

export type Part = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
export interface Message {
  role: 'system' | 'user';
  content: string | Part[];
}

export interface AiResult<T> {
  data: T;
  /** Kosten in US-Dollar laut OpenRouter */
  costUsd: number;
  /** Modell, das tatsächlich geantwortet hat */
  model: string;
}

export interface AiConfig {
  apiKey: string;
  /** Adresse der App, erscheint bei OpenRouter in der Statistik */
  appUrl?: string;
}

/** Fragt ein Modell und erzwingt eine Antwort im JSON-Schema */
export async function askJson<T>(
  cfg: AiConfig,
  model: string,
  messages: Message[],
  schema: Record<string, unknown>,
  maxTokens: number,
): Promise<AiResult<T>> {
  if (!cfg.apiKey) throw new Error('Der OpenRouter-Schlüssel fehlt (OPENROUTER_API_KEY).');
  if (!model) throw new Error('Kein KI-Modell eingestellt.');
  const res = await fetch(URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.apiKey}`,
      ...(cfg.appUrl ? { 'http-referer': cfg.appUrl } : {}),
      'x-title': 'Angebotsküche',
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      response_format: { type: 'json_schema', json_schema: { name: 'antwort', strict: true, schema } },
      // Nur Anbieter nehmen, die das JSON-Schema auch wirklich einhalten
      provider: { require_parameters: true },
      usage: { include: true },
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter-Fehler ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const d = (await res.json()) as {
    model?: string;
    error?: { message?: string };
    usage?: { cost?: number };
    choices?: { finish_reason?: string; message?: { content?: string | null } }[];
  };
  if (d.error) throw new Error(`OpenRouter-Fehler: ${d.error.message ?? 'unbekannt'}`);
  const costUsd = d.usage?.cost ?? 0;
  const choice = d.choices?.[0];
  if (choice?.finish_reason === 'length') {
    throw Object.assign(new Error('Die Antwort der KI war zu lang und wurde abgeschnitten. Bitte nochmal versuchen.'), { costUsd });
  }
  const text = (choice?.message?.content ?? '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    return { data: JSON.parse(text) as T, costUsd, model: d.model ?? model };
  } catch {
    throw Object.assign(new Error('Die Antwort der KI war kein gültiges JSON. Bitte nochmal versuchen.'), { costUsd });
  }
}

/** Kosten eines fehlgeschlagenen Aufrufs (falls OpenRouter schon abgerechnet hat) */
export const costOf = (e: unknown) => (e && typeof e === 'object' && 'costUsd' in e ? Number((e as { costUsd: unknown }).costUsd) || 0 : 0);
