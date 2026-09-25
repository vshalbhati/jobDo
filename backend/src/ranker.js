// Client for the Python ranking service (ranker/). The service has no notion
// of users: this server authenticates the caller, attaches their resume and
// threshold, and signs the request with the shared secret.
import { config } from './config.js';

export const rankerConfigured = () => !!config.rankerUrl;

// An error whose message is safe to hand to the client, unlike most 500s.
const unavailable = (message) => Object.assign(new Error(message), { status: 502, expose: true });

export async function rankJobs({ jobs, resumeText, profile, threshold }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.rankerTimeoutMs);
  let res;
  try {
    res = await fetch(config.rankerUrl + '/rank', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ranker-Secret': config.rankerSecret },
      body: JSON.stringify({ threshold, candidate: { resume_text: resumeText, profile }, jobs }),
      signal: ctrl.signal
    });
  } catch (e) {
    throw unavailable(e.name === 'AbortError'
      ? 'The ranking service took too long to answer.'
      : 'Could not reach the ranking service.');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('ranker answered ' + res.status + ': ' + body.slice(0, 300));
    throw unavailable(res.status === 401 || res.status === 503
      ? 'The ranking service rejected this server (check RANKER_SECRET on both).'
      : 'The ranking service returned an error (' + res.status + ').');
  }
  return res.json();
}
