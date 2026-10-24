import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diff, trackChanges } from '../lib/changes.js';

const ev = (matchId, o = {}) => ({
  id: `${matchId}-2026-10-24`, matchId, type: 'game', title: 'A vs B', date: '2026-10-24',
  start: '2026-10-24T09:00', end: '2026-10-24T11:00', allDay: false,
  home: { id: '1', name: 'A' }, away: { id: '2', name: 'B' }, teams: [],
  location: 'Chilcott Stadium', field: 'Chilcott', notes: '', status: '', ...o,
});
const rowsOf = (events, rev = 0) => new Map(events.map((e) => [e.matchId, {
  matchId: e.matchId, data: e, firstSeen: null, lastChanged: null, removedAt: null, rev,
}]));
const many = (n) => Array.from({ length: n }, (_, i) => ev(i + 1));
const T = '2026-10-22T15:00:00.000Z';

test('the first run seeds a baseline without reporting anything as new', () => {
  const r = diff(new Map(), many(3), T);
  assert.equal(r.seeding, true);
  assert.equal(r.changes.length, 0);
  assert.equal(r.upserts.length, 3);
  assert.equal(r.upserts[0].firstSeen, null);
});

test('time and field changes are recorded field by field', () => {
  const r = diff(rowsOf([ev(1)]), [ev(1, { start: '2026-10-24T10:00', end: '2026-10-24T12:00', field: 'Field 2' })], T);
  assert.deepEqual(r.changes.map((c) => [c.kind, c.field, c.from, c.to]), [
    ['changed', 'when', '2026-10-24T09:00/2026-10-24T11:00', '2026-10-24T10:00/2026-10-24T12:00'],
    ['changed', 'where', 'Chilcott Stadium · Chilcott', 'Chilcott Stadium · Field 2'],
  ]);
  assert.equal(r.upserts[0].rev, 1);
  assert.equal(r.upserts[0].lastChanged, T);
});

test('new and removed games are detected', () => {
  const base = many(30);
  const next = [...base.slice(1), ev(99)];
  const r = diff(rowsOf(base), next, T);
  assert.deepEqual(r.changes.map((c) => [c.kind, c.matchId]), [['added', 99], ['removed', 1]]);
  assert.equal(r.upserts.find((u) => u.matchId === 99).firstSeen, T);
  assert.equal(r.upserts.find((u) => u.matchId === 1).removedAt, T);
});

test('a suspiciously large drop is treated as a partial fetch, not mass cancellation', () => {
  const r = diff(rowsOf(many(200)), many(100), T);
  assert.equal(r.skippedRemovals, 100);
  assert.equal(r.changes.length, 0);
});

test('a removed game coming back is marked restored', () => {
  const rows = rowsOf([ev(1)]);
  rows.get(1).removedAt = '2026-10-20T00:00:00.000Z';
  const r = diff(rows, [ev(1)], T);
  assert.deepEqual(r.changes.map((c) => c.kind), ['restored']);
  assert.equal(r.upserts[0].removedAt, null);
});

test('untracked details update the baseline silently', () => {
  const r = diff(rowsOf([ev(1)]), [ev(1, { division: 'AAA – Minors' })], T);
  assert.equal(r.changes.length, 0);
  assert.equal(r.upserts.length, 1);
  assert.equal(r.upserts[0].rev, 0);
});

test('change ids are deterministic, so overlapping refreshes dedupe', () => {
  const next = [ev(1, { notes: 'Moved due to rain' })];
  const a = diff(rowsOf([ev(1)], 4), next, T);
  const b = diff(rowsOf([ev(1)], 4), next, '2026-10-22T15:00:05.000Z');
  assert.equal(a.changes[0].id, '1.5.notes');
  assert.equal(a.changes[0].id, b.changes[0].id);
});

test('trackChanges annotates events and attaches snapshots of removed games', async () => {
  const memory = { rows: new Map(), changes: [], since: null, checked: null };
  const store = {
    loadBaseline: async () => ({ rows: new Map(memory.rows), trackingSince: memory.since, lastChecked: memory.checked }),
    save: async ({ upserts, changes, trackingSince, lastChecked }) => {
      for (const u of upserts) memory.rows.set(u.matchId, u);
      memory.changes.push(...changes);
      memory.since ||= trackingSince;
      memory.checked = lastChecked;
    },
    recentChanges: async (since) => memory.changes.filter((c) => c.at >= since).reverse(),
  };
  await trackChanges(store, { events: many(30) }, T);
  // Next fetch: game 1 gone, game 5 edited, game 31 new.
  const events = many(30).slice(1).map((e) => (e.matchId === 5 ? ev(5, { notes: 'Field closed' }) : e));
  const data = { events: [...events, ev(31)] };
  await trackChanges(store, data, '2026-10-22T15:15:00.000Z');

  assert.equal(data.trackingSince, T);
  const five = data.events.find((e) => e.matchId === 5);
  assert.equal(five.rev, 1);
  const removed = data.changes.find((c) => c.kind === 'removed');
  assert.equal(removed.matchId, 1);
  assert.equal(removed.event.removed, true);
  assert.equal(removed.event.location, 'Chilcott Stadium');
  assert.ok(data.changes.some((c) => c.kind === 'added' && c.matchId === 31 && !c.event));
  // Each change knows the window it happened in: after the previous check.
  assert.ok(data.changes.every((c) => c.prevChecked === T && c.at === '2026-10-22T15:15:00.000Z'));
  assert.equal(memory.checked, '2026-10-22T15:15:00.000Z');
});
