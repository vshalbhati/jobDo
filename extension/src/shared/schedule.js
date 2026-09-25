// The daily run: when it is due, and when the next one is. Shared by the
// service worker (which starts it) and the popup and Settings (which show it).

export function parseTime(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return [14, 0];
  return [Math.min(23, Number(m[1])), Math.min(59, Number(m[2]))];
}

// The given day's scheduled moment, in local time.
export function scheduledAt(cfg, day = new Date()) {
  const [h, m] = parseTime(cfg.schedule && cfg.schedule.time);
  const d = new Date(day);
  d.setHours(h, m, 0, 0);
  return d;
}

// Due from the scheduled time until midnight, once per day. That window is
// what makes a missed run catch up when Chrome opens later the same day.
export function isDue(cfg, now = new Date()) {
  const s = cfg.schedule || {};
  return !!s.enabled && s.lastRunDay !== now.toDateString() && now >= scheduledAt(cfg, now);
}

export function nextRun(cfg, now = new Date()) {
  const s = cfg.schedule || {};
  if (!s.enabled) return null;
  if (isDue(cfg, now)) return now;
  const today = scheduledAt(cfg, now);
  if (s.lastRunDay !== now.toDateString() && now < today) return today;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  return scheduledAt(cfg, tomorrow);
}

export function describeNextRun(cfg, now = new Date()) {
  const at = nextRun(cfg, now);
  if (!at) return 'daily run is off';
  if (at === now) return 'daily run due now';
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return 'next daily run ' + (at.toDateString() === now.toDateString() ? 'today' : 'tomorrow') + ' at ' + time;
}
