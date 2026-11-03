// Wer angemeldet ist, sagt Authentik: Caddy fragt vor jeder Anfrage per Forward-Auth bei Authentik nach
// und reicht die Nutzerdaten als Kopfzeilen weiter (X-Authentik-*). Die App selbst ist nur über Caddy
// erreichbar, und Caddy entfernt diese Kopfzeilen aus Anfragen von außen (siehe deploy/Caddyfile).

export interface User {
  email: string;
  /** Kurze, gehashte Kennung für Speicherschlüssel (keine E-Mail im Klartext) */
  id: string;
  name: string;
  groups: string[];
  /** KI-Budget pro Tag in US-Dollar aus Authentik (Attribut am Nutzer oder an der Gruppe), sonst undefined */
  dailyBudgetUsd?: number;
}

async function hash(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface AuthEnv {
  /** "authentik" (Standard) oder "dev" für lokales Entwickeln ohne Anmeldung */
  AUTH_MODE?: string;
  DEV_USER_EMAIL?: string;
}

/** Angemeldeter Nutzer – oder ein Grund, warum es keinen gibt */
export async function currentUser(req: Request, env: AuthEnv): Promise<User | { reason: string }> {
  let email: string | null;
  let name = '';
  let groups: string[] = [];
  let budget: string | null = null;
  if (env.AUTH_MODE === 'dev') {
    email = env.DEV_USER_EMAIL || 'dev@localhost';
  } else {
    email = req.headers.get('x-authentik-email');
    name = req.headers.get('x-authentik-name') ?? '';
    groups = (req.headers.get('x-authentik-groups') ?? '').split('|').map((g) => g.trim()).filter(Boolean);
    budget = req.headers.get('x-ki-budget-tag');
  }
  if (!email) return { reason: 'nicht angemeldet' };
  email = email.toLowerCase();
  const b = budget != null && budget !== '' ? Number(budget.replace(',', '.')) : NaN;
  return { email, id: await hash(email), name, groups, dailyBudgetUsd: Number.isFinite(b) && b >= 0 ? b : undefined };
}

/** Speicherort für den Abgleich je Nutzer (wie früher: E-Mail nur als Hash im Schlüssel) */
export const syncKeyFor = (u: User) => `sync:${u.id}`;
