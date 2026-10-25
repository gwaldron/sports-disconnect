// For assignors: has Assignr caught up with a league schedule change?
// Compares the changed game with its Assignr counterpart, using the old and
// new values the change log records. Shared by the browser and the tests.
//
// Result: null when Assignr doesn't care (practices, note/status changes), else
//   { state: 'synced' }                        Assignr matches the league
//   { state: 'stale', game, fields | reason }  Assignr still has the old version
//   { state: 'missing' }                       a new game isn't in Assignr yet
//   { state: 'unknown' }                       can't tell; Mark done covers it

import { matchAssignr, tokens, overlap } from './assignr-match.js';

const RELEVANT = new Set(['when', 'where', 'home', 'away']);

/** The event as it looked before these changes (old values put back). */
export function previousVersion(ev, diffs) {
  const old = { ...ev, id: `${ev.id}~before`, teams: [...ev.teams] };
  for (const d of diffs) {
    if (d.field === 'when' && d.from) {
      const [start, end] = d.from.split('/');
      Object.assign(old, end ? { start, end, date: start.slice(0, 10), allDay: false } : { date: start, allDay: true });
    } else if (d.field === 'where' && d.from) {
      const [location, ...field] = d.from.split(' · ');
      Object.assign(old, { location, field: field.join(' · ') });
    } else if (d.field === 'home' || d.field === 'away') {
      old.teams = old.teams.filter((t) => t.name !== d.to);
      if (d.from) old.teams.push({ name: d.from });
    }
  }
  return old;
}

/** Does Assignr game `g` show the new value of this change? true / false / null (can't tell). */
function agrees(g, ev, d) {
  if (d.field === 'when') return g.start === ev.start;
  const side = d.field === 'where' ? `${g.venue} ${g.subvenue}` : `${g.home} ${g.away}`;
  const near = (v) => overlap(tokens(side), tokens(v));
  const toNew = near(d.to);
  const toOld = near(d.from);
  if (toNew > toOld) return true;
  if (toOld > toNew) return false;
  return null;
}

export function syncStatus({ ev, kind, diffs }, { games, byEvent }) {
  const isGame = ev.type === 'game' || diffs.some((d) => d.field === 'type' && d.to === 'game');
  if (!isGame) return null;
  const live = games.filter((g) => !g.cancelled);

  if (kind === 'removed') {
    // The matcher skips removed games, so look for this one as if it were still on.
    const g = matchAssignr([{ ...ev, removed: false }], live).byEvent.get(ev.id);
    return g ? { state: 'stale', game: g, reason: 'active' } : { state: 'synced' };
  }
  const g = byEvent.get(ev.id);
  if (kind === 'new') return g ? { state: 'synced', game: g } : { state: 'missing' };

  const relevant = diffs.filter((d) => RELEVANT.has(d.field));
  if (!relevant.length) return null;
  if (g) {
    const verdicts = relevant.map((d) => [d.field, agrees(g, ev, d)]);
    const off = verdicts.filter(([, v]) => v === false).map(([f]) => f);
    if (off.length) return { state: 'stale', game: g, fields: off };
    return verdicts.some(([, v]) => v === null) ? { state: 'unknown', game: g } : { state: 'synced', game: g };
  }
  // Not found at its new time/place: is the old version still sitting in Assignr?
  const before = previousVersion(ev, relevant);
  const old = matchAssignr([before], live).byEvent.get(before.id);
  return old ? { state: 'stale', game: old, fields: relevant.map((d) => d.field) } : { state: 'unknown' };
}
