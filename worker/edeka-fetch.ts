// www.edeka.de blockt Rechenzentren (auch Hetzner und OVH, geprüft 2026-11-18). Im Cluster läuft deshalb neben der App
// ein Tailscale-Container, der einen HTTP-Proxy anbietet und über einen Exit Node an einem privaten Anschluss rausgeht
// (EDEKA_PROXY, z. B. http://127.0.0.1:1055). Nur Anfragen an www.edeka.de laufen darüber, alles andere direkt.
import { ProxyAgent, fetch as proxyFetch } from 'undici';

const proxyUrl = typeof process !== 'undefined' ? process.env.EDEKA_PROXY : undefined;
const agent = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

export const edekaProxy = proxyUrl ?? null;

/** fetch für www.edeka.de – über den Proxy, falls EDEKA_PROXY gesetzt ist */
export async function edekaFetch(url: string, init: { headers?: Record<string, string> } = {}): Promise<Response> {
  if (!agent) return fetch(url, init);
  return (await proxyFetch(url, { ...init, dispatcher: agent, signal: AbortSignal.timeout(30_000) })) as unknown as Response;
}
