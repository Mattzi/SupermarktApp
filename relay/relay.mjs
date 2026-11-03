// EDEKA-Relay für einen privaten Internetanschluss.
// www.edeka.de blockt Rechenzentren. Dieses Programm holt sich beim Server Aufträge ab (nur ausgehende
// Verbindungen, keine Portfreigabe nötig), lädt die Seiten von www.edeka.de und schickt sie zurück.
// Es lädt ausschließlich Seiten unter https://www.edeka.de/maerkte/ – andere Adressen werden abgelehnt.
//
// Einstellungen (Umgebungsvariablen):
//   SERVER_URL   z. B. https://app.mattis-kraemer.de
//   RELAY_TOKEN  derselbe geheime Schlüssel wie in der .env des Servers
//   INTERVAL_S   Abstand zwischen zwei Abfragen in Sekunden (Standard 60)

const SERVER = (process.env.SERVER_URL ?? '').replace(/\/$/, '');
const TOKEN = process.env.RELAY_TOKEN ?? '';
const INTERVAL = Math.max(15, Number(process.env.INTERVAL_S ?? 60)) * 1000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

if (!SERVER || !TOKEN) {
  console.error('SERVER_URL und RELAY_TOKEN müssen gesetzt sein.');
  process.exit(1);
}

const allowed = (u) => {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && url.hostname === 'www.edeka.de' && url.pathname.startsWith('/maerkte/');
  } catch {
    return false;
  }
};

async function server(path, init = {}) {
  const res = await fetch(`${SERVER}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`Server antwortet mit ${res.status} für ${path}`);
  return res.json();
}

async function runJob(job) {
  if (!allowed(job.url)) return { id: job.id, status: 400, body: '' };
  try {
    const res = await fetch(job.url, {
      headers: { 'user-agent': UA, accept: 'text/html,*/*;q=0.8', 'accept-language': 'de-DE,de;q=0.9', referer: 'https://www.edeka.de/' },
      signal: AbortSignal.timeout(30_000),
    });
    const body = res.ok ? (await res.text()).slice(0, 3_000_000) : '';
    return { id: job.id, status: res.status, body };
  } catch (e) {
    console.error(`${job.url}: ${e.message}`);
    return { id: job.id, status: 599, body: '' };
  }
}

async function round() {
  const { jobs } = await server('/relay/jobs');
  for (const job of jobs ?? []) {
    const result = await runJob(job);
    const r = await server('/relay/result', { method: 'POST', body: JSON.stringify(result) });
    console.log(`${new Date().toISOString()} ${job.url} → ${result.status}: ${r.note ?? ''}`);
    await new Promise((ok) => setTimeout(ok, 2000)); // edeka.de nicht bombardieren
  }
}

console.log(`EDEKA-Relay läuft, fragt ${SERVER} alle ${INTERVAL / 1000} s`);
for (;;) {
  await round().catch((e) => console.error(`${new Date().toISOString()} ${e.message}`));
  await new Promise((ok) => setTimeout(ok, INTERVAL));
}
