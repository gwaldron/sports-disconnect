// Pairs Assignr games with SportsConnect events. The two systems name things
// differently ("Team Bailey" vs "Bailey", "Providence Elementary" vs
// "Providence ES"), so this scores candidates on several signals instead of
// requiring exact equality. Shared by the browser and the tests.

// Words too common in venue/team names to say anything about a match.
const STOP = new Set(['the', 'park', 'field', 'fields', 'es', 'elementary', 'school', 'middle', 'high', 'ms', 'hs',
  'stadium', 'complex', 'of', 'at', 'and', 'team', 'vs', 'v', 'little', 'league', 'll']);

export function tokens(s) {
  return new Set(String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w && !STOP.has(w)));
}

/** Share of the smaller set found in the larger one (0..1). */
function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / Math.min(a.size, b.size);
}

const minutes = (s) => Number(s.slice(11, 13)) * 60 + Number(s.slice(14, 16));

function score(g, ev, maxMinutes) {
  if (g.externalId != null && String(g.externalId) === String(ev.matchId)) return 100; // linked at the source
  const dt = Math.abs(minutes(g.start) - minutes(ev.start));
  if (dt > maxMinutes) return 0;
  let s = dt === 0 ? 3 : 1;
  const venue = overlap(tokens(`${g.venue} ${g.subvenue}`), tokens(`${ev.location} ${ev.field}`));
  s += venue >= 0.5 ? 3 : venue > 0 ? 1 : 0;
  const teams = overlap(tokens(`${g.home} ${g.away}`), tokens(ev.teams.map((t) => t.name).join(' ')));
  s += teams >= 0.5 ? 4 : teams > 0 ? 2 : 0;
  if (g.ageGroup && overlap(tokens(g.ageGroup), tokens(ev.division)) > 0) s += 1;
  return s;
}

const MIN_SCORE = 4; // the time alone (3) is never enough: several games share a start time

/**
 * @returns {{ byEvent: Map<string, object>, unmatched: object[] }} Assignr game
 * for each matched event id, and the (uncancelled) Assignr games left over.
 */
export function matchAssignr(events, games, { maxMinutes = 20 } = {}) {
  const byDate = new Map();
  for (const ev of events) {
    if (ev.allDay || ev.removed) continue;
    if (!byDate.has(ev.date)) byDate.set(ev.date, []);
    byDate.get(ev.date).push(ev);
  }

  const pairs = [];
  for (const g of games) {
    if (!g.start || g.cancelled) continue;
    const scored = (byDate.get(g.date) || []).map((ev) => ({ g, ev, score: score(g, ev, maxMinutes) }))
      .filter((p) => p.score >= MIN_SCORE).sort((a, b) => b.score - a.score);
    // Two equally good candidates: we can't tell which, so don't guess.
    if (scored.length > 1 && scored[0].score === scored[1].score && scored[0].score < 100) continue;
    pairs.push(...scored);
  }

  // Best pairs first; each event and each Assignr game is used once.
  pairs.sort((a, b) => b.score - a.score);
  const byEvent = new Map();
  const used = new Set();
  for (const p of pairs) {
    if (byEvent.has(p.ev.id) || used.has(p.g.id)) continue;
    byEvent.set(p.ev.id, p.g);
    used.add(p.g.id);
  }
  return { byEvent, unmatched: games.filter((g) => !used.has(g.id) && !g.cancelled) };
}
