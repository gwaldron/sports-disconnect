// Filter logic shared by the browser UI and the server's .ics export, so an
// exported calendar always contains exactly what the screen shows.

export const TYPES = ['game', 'practice', 'other'];
export const RANGES = ['upcoming', 'today', 'next7', 'week', 'month', 'past', 'all', 'custom'];

export function defaultFilters() {
  return { q: '', types: [], divs: [], teams: [], locs: [], range: 'upcoming', from: '', to: '' };
}

const LIST_KEYS = { types: 'type', divs: 'div', teams: 'team', locs: 'loc' };

export function parseFilters(params) {
  const f = defaultFilters();
  f.q = params.get('q') || '';
  for (const [key, param] of Object.entries(LIST_KEYS)) {
    const raw = params.get(param);
    f[key] = raw ? raw.split(',').filter(Boolean) : [];
  }
  f.types = f.types.filter((t) => TYPES.includes(t));
  const range = params.get('range');
  if (RANGES.includes(range)) f.range = range;
  f.from = params.get('from') || '';
  f.to = params.get('to') || '';
  return f;
}

export function serializeFilters(f) {
  const p = new URLSearchParams();
  if (f.q) p.set('q', f.q);
  for (const [key, param] of Object.entries(LIST_KEYS)) {
    if (f[key].length) p.set(param, f[key].join(','));
  }
  if (f.range !== 'upcoming') p.set('range', f.range);
  if (f.range === 'custom') {
    if (f.from) p.set('from', f.from);
    if (f.to) p.set('to', f.to);
  }
  return p;
}

// --- dates (all plain 'YYYY-MM-DD' strings, compared lexicographically) ---

export function isoDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return isoDate(new Date(y, m - 1, d + n));
}

export function weekStart(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  return addDays(dateStr, -dow);
}

export function monthBounds(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  return [isoDate(new Date(y, m - 1, 1)), isoDate(new Date(y, m, 0))];
}

/** Returns [from, to] (inclusive, either may be '') for a filter's date range. */
export function rangeBounds(f, today) {
  switch (f.range) {
    case 'today': return [today, today];
    case 'next7': return [today, addDays(today, 6)];
    case 'week': { const s = weekStart(today); return [s, addDays(s, 6)]; }
    case 'month': return monthBounds(today);
    case 'past': return ['', addDays(today, -1)];
    case 'all': return ['', ''];
    case 'custom': return [f.from, f.to];
    default: return [today, ''];
  }
}

// --- matching ---

export function haystack(ev) {
  return [ev.title, ev.division, ev.eventName, ev.location, ev.field, ev.notes,
    ...ev.teams.map((t) => t.name)].join(' ').toLowerCase();
}

/**
 * Everything except the date range. Divisions and teams combine as a union
 * ("my kid's team OR my other kid's whole division"); the other filters narrow.
 */
export function matchesNonDate(ev, f) {
  if (f.types.length && !f.types.includes(ev.type)) return false;
  if (f.divs.length || f.teams.length) {
    const inDiv = f.divs.includes(ev.divisionId);
    const hasTeam = ev.teams.some((t) => t.id && f.teams.includes(t.id));
    if (!inDiv && !hasTeam) return false;
  }
  if (f.locs.length && !f.locs.includes(ev.locationId)) return false;
  if (f.q) {
    const hay = ev._hay ?? haystack(ev);
    for (const word of f.q.toLowerCase().split(/\s+/).filter(Boolean)) {
      if (!hay.includes(word)) return false;
    }
  }
  return true;
}

export function applyFilters(events, f, today, { ignoreDate = false } = {}) {
  const [from, to] = ignoreDate ? ['', ''] : rangeBounds(f, today);
  const out = events.filter((ev) =>
    (!from || ev.date >= from) && (!to || ev.date <= to) && matchesNonDate(ev, f));
  if (!ignoreDate && f.range === 'past') out.reverse();
  return out;
}
