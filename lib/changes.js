// Change tracking. SportsConnect has no "last modified" data, so we keep our
// own baseline (the last version of every match we've seen) and diff each fresh
// fetch against it. Match ids are stable across reschedules, so a moved game
// shows up as a change rather than a delete + add.
//
// Runtime-neutral: storage is behind a small interface implemented by
// change-store-d1.js (Cloudflare) and change-store-file.js (Node).
//
//   store.loadBaseline() -> { rows: Map<matchId, Row>, trackingSince: string|null }
//   store.save({ upserts: Row[], changes: Change[], trackingSince })
//   store.recentChanges(sinceIso) -> Change[]   (newest first)
//
//   Row    = { matchId, data: event, firstSeen, lastChanged, removedAt, rev }
//   Change = { id, at, matchId, kind: 'added'|'changed'|'removed'|'restored', field, from, to }

// The fields families care about, as comparable strings.
export const TRACKED = {
  when: (e) => (e.allDay ? e.date : `${e.start}/${e.end}`),
  where: (e) => [e.location, e.field].filter(Boolean).join(' · '),
  home: (e) => e.home?.name || '',
  away: (e) => e.away?.name || '',
  type: (e) => e.type,
  status: (e) => e.status || '',
  notes: (e) => e.notes || '',
};

export const RECENT_DAYS = 30; // how much change history ships to the browser

// If a fetch suddenly lacks this many games, assume the upstream response was
// partial (or broken) rather than that half the season was cancelled.
const MAX_REMOVALS = (active) => Math.max(25, Math.ceil(active * 0.2));

function stripped(ev) {
  const { _hay, firstSeen, lastChanged, rev, ...rest } = ev;
  return rest;
}

/** Pure diff of a fresh event list against the stored baseline. */
export function diff(rows, events, now) {
  const seeding = rows.size === 0;
  const upserts = [];
  const changes = [];
  const seen = new Set();
  const change = (row, kind, field = null, from = null, to = null) => {
    // Deterministic id: two overlapping refreshes that diff against the same
    // baseline produce the same ids, so the second insert is ignored.
    changes.push({ id: `${row.matchId}.${row.rev + 1}.${field || kind}`, at: now, matchId: row.matchId, kind, field, from, to });
  };

  for (const raw of events) {
    const ev = stripped(raw);
    seen.add(ev.matchId);
    const row = rows.get(ev.matchId);
    if (!row) {
      // While seeding we don't know when these appeared, so they aren't "new".
      const fresh = { matchId: ev.matchId, data: ev, firstSeen: seeding ? null : now, lastChanged: null, removedAt: null, rev: 0 };
      if (!seeding) change({ ...fresh, rev: -1 }, 'added');
      upserts.push(fresh);
      continue;
    }
    const before = changes.length;
    if (row.removedAt) change(row, 'restored');
    for (const [field, get] of Object.entries(TRACKED)) {
      const from = get(row.data);
      const to = get(ev);
      if (from !== to) change(row, 'changed', field, from, to);
    }
    if (changes.length > before) {
      upserts.push({ ...row, data: ev, lastChanged: now, removedAt: null, rev: row.rev + 1 });
    } else if (JSON.stringify(row.data) !== JSON.stringify(ev)) {
      upserts.push({ ...row, data: ev }); // untracked detail changed (e.g. a division label)
    }
  }

  const gone = [...rows.values()].filter((r) => !r.removedAt && !seen.has(r.matchId));
  const active = [...rows.values()].filter((r) => !r.removedAt).length;
  let skippedRemovals = 0;
  if (gone.length > MAX_REMOVALS(active)) {
    skippedRemovals = gone.length;
  } else {
    for (const row of gone) {
      change(row, 'removed');
      upserts.push({ ...row, lastChanged: now, removedAt: now, rev: row.rev + 1 });
    }
  }
  return { upserts, changes, seeding, skippedRemovals };
}

/**
 * Diff `data` against the store, persist the result, and annotate `data` with
 * per-event change info plus a recent-changes list for the browser.
 */
export async function trackChanges(store, data, now = new Date().toISOString()) {
  const { rows, trackingSince } = await store.loadBaseline();
  const result = diff(rows, data.events, now);
  const since = trackingSince || now;
  await store.save({ upserts: result.upserts, changes: result.changes, trackingSince: since });

  for (const row of result.upserts) rows.set(row.matchId, row);
  for (const ev of data.events) {
    const row = rows.get(ev.matchId);
    ev.firstSeen = row.firstSeen;
    ev.lastChanged = row.lastChanged;
    ev.rev = row.rev;
  }

  const cutoff = new Date(Date.parse(now) - RECENT_DAYS * 86400_000).toISOString();
  const current = new Set(data.events.map((e) => e.matchId));
  data.changes = (await store.recentChanges(cutoff)).map((c) => (
    // Games that are no longer listed ride along so the browser can still show them.
    current.has(c.matchId) ? c : { ...c, event: { ...rows.get(c.matchId)?.data, removed: true } }
  ));
  data.trackingSince = since;
  return result;
}
