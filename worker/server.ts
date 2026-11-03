// Node-Server für den eigenen Server (Hetzner): liefert die App aus dist/ aus, leitet /api/* und /relay/*
// an die API weiter und startet alle 30 Minuten den Zeitplan (Prospekte einlesen, Wochen-Push).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { handle, runCron, type Env } from './index';
import { memoryKv, pgKv, type Kv } from './kv';

const PORT = Number(process.env.PORT ?? 8080);
const DIST = resolve(process.env.STATIC_DIR ?? 'dist');
const CRON_MS = 30 * 60_000;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  let file = join(DIST, rel);
  if (file !== DIST && !file.startsWith(DIST + sep)) {
    res.writeHead(400).end();
    return;
  }
  let info = await stat(file).catch(() => null);
  if (!info?.isFile()) {
    // Einseitige App: unbekannte Pfade bekommen index.html (aber keine fehlenden Dateien mit Endung)
    if (extname(rel)) {
      res.writeHead(404).end('nicht gefunden');
      return;
    }
    file = join(DIST, 'index.html');
    info = await stat(file).catch(() => null);
    if (!info) {
      res.writeHead(500).end('App nicht gebaut (dist/ fehlt)');
      return;
    }
  }
  // Dateien mit Hash im Namen ändern sich nie; index.html, Service Worker und version.json immer frisch holen
  const immutable = rel.startsWith('assets/');
  res.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  if (req.method === 'HEAD') res.end();
  else createReadStream(file).pipe(res);
}

function toRequest(req: IncomingMessage, url: URL): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else if (v != null) headers.set(k, v);
  }
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : (Readable.toWeb(req) as ReadableStream);
  return new Request(url, { method: req.method, headers, body, duplex: 'half' } as RequestInit);
}

async function sendResponse(res: ServerResponse, r: Response) {
  const headers: Record<string, string | string[]> = {};
  r.headers.forEach((v, k) => {
    headers[k] = v;
  });
  const cookies = r.headers.getSetCookie();
  if (cookies.length) headers['set-cookie'] = cookies;
  res.writeHead(r.status, headers);
  if (!r.body) {
    res.end();
    return;
  }
  // Schrittweise weitergeben (z. B. Fortschrittspunkte beim Einlesen)
  const reader = r.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
}

async function main() {
  let kv: Kv;
  let cleanup = async () => 0;
  if (process.env.DATABASE_URL) {
    const pg = await pgKv(process.env.DATABASE_URL);
    kv = pg;
    cleanup = pg.cleanup;
  } else {
    console.warn('DATABASE_URL fehlt – Daten liegen nur im Arbeitsspeicher');
    kv = memoryKv();
  }
  const env: Env = { ...(process.env as Record<string, string>), CACHE: kv };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    try {
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/relay/')) {
        await sendResponse(res, await handle(toRequest(req, url), env));
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        await serveStatic(req, res, url.pathname);
      } else {
        res.writeHead(405).end();
      }
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Serverfehler');
    }
  });
  server.listen(PORT, () => console.log(`Angebotsküche läuft auf Port ${PORT}`));

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      console.log((await runCron(env)).join('\n'));
      const n = await cleanup();
      if (n) console.log(`${n} abgelaufene Einträge gelöscht`);
    } catch (e) {
      console.error('Zeitplan', e);
    } finally {
      running = false;
    }
  };
  setTimeout(tick, 60_000);
  setInterval(tick, CRON_MS);

  const stop = () => {
    server.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
