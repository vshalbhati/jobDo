// Upstash Redis over its REST API. It is plain HTTPS, so it works from
// serverless functions with no connection to hold open, and needs no client
// library. Optional: whatever uses it keeps an in-memory fallback.
import { config } from './config.js';

export const redisConfigured = () => !!(config.redisUrl && config.redisToken);

// Sends every command in one round trip and resolves to one result per
// command. Throws if Redis is unreachable, slow, or rejects any command.
export async function pipeline(commands) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.redisTimeoutMs);
  try {
    const res = await fetch(config.redisUrl + '/pipeline', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + config.redisToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(commands.map((c) => c.map(String))),
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error('Redis answered ' + res.status);
    const out = await res.json();
    const bad = Array.isArray(out) ? out.find((r) => r && r.error) : { error: 'unexpected reply' };
    if (bad) throw new Error('Redis: ' + bad.error);
    return out.map((r) => r.result);
  } catch (e) {
    throw e.name === 'AbortError' ? new Error('Redis did not answer in time') : e;
  } finally {
    clearTimeout(timer);
  }
}
