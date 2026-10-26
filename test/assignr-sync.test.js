import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncStatus, previousVersion, pairMismatches } from '../public/js/assignr-sync.js';
import { matchAssignr } from '../public/js/assignr-match.js';

// A league game after its changes, and Assignr games in various states.
const ev = (o = {}) => ({
  id: '1-2026-10-28', matchId: 1, type: 'game', date: '2026-10-28', start: '2026-10-28T18:30', end: '2026-10-28T20:30',
  allDay: false, location: 'Providence ES', field: 'Field 3', division: 'AA – Minors',
  teams: [{ name: 'Team Dennis' }, { name: 'Team Custis' }], ...o,
});
const ag = (id, o = {}) => ({
  id, date: '2026-10-28', start: '2026-10-28T18:30', venue: 'Providence Elementary', subvenue: 'Field 3',
  home: 'Dennis', away: 'Custis', ageGroup: 'AA', cancelled: false, externalId: null, officials: [], ...o,
});
const moved = { field: 'when', from: '2026-10-21T17:00/2026-10-21T19:00', to: '2026-10-28T18:30/2026-10-28T20:30' };
const refield = { field: 'where', from: 'Providence ES · Field 2', to: 'Providence ES · Field 3' };

function check(event, kind, diffs, games) {
  const { byEvent } = matchAssignr([event], games);
  return syncStatus({ ev: event, kind, diffs }, { games, byEvent });
}

test('rescheduled game: in sync once Assignr has the new date', () => {
  assert.equal(check(ev(), 'moved', [moved], [ag(7)]).state, 'synced');
});

test('rescheduled game: stale while Assignr still has the old date', () => {
  const r = check(ev(), 'moved', [moved], [ag(7, { date: '2026-10-21', start: '2026-10-21T17:00' })]);
  assert.equal(r.state, 'stale');
  assert.equal(r.game.id, 7);
  assert.deepEqual(r.fields, ['when']);
});

test('small time shift: matched game with the old time is stale', () => {
  const shift = { field: 'when', from: '2026-10-28T18:15/2026-10-28T20:15', to: '2026-10-28T18:30/2026-10-28T20:30' };
  assert.equal(check(ev(), 'moved', [shift], [ag(7, { start: '2026-10-28T18:15' })]).state, 'stale');
});

test('field change: stale on the old field, synced on the new, unsure without field info', () => {
  assert.equal(check(ev(), 'moved', [refield], [ag(7, { subvenue: 'Field 2' })]).state, 'stale');
  assert.equal(check(ev(), 'moved', [refield], [ag(7)]).state, 'synced');
  assert.equal(check(ev(), 'moved', [refield], [ag(7, { subvenue: '' })]).state, 'unknown');
});

test('new game: synced when Assignr has it, missing otherwise', () => {
  assert.equal(check(ev(), 'new', [], [ag(7)]).state, 'synced');
  assert.equal(check(ev(), 'new', [], []).state, 'missing');
});

test('removed game: stale while still active in Assignr, synced once cancelled', () => {
  const gone = ev({ removed: true });
  const active = check(gone, 'removed', [], [ag(7)]);
  assert.equal(active.state, 'stale');
  assert.equal(active.reason, 'active');
  assert.equal(check(gone, 'removed', [], [ag(7, { cancelled: true })]).state, 'synced');
});

test('not found anywhere is unknown; practices and note-only changes are ignored', () => {
  assert.equal(check(ev(), 'moved', [moved], []).state, 'unknown');
  assert.equal(check(ev({ type: 'practice' }), 'moved', [moved], []), null);
  assert.equal(check(ev(), 'updated', [{ field: 'notes', from: '', to: 'Bring water' }], [ag(7)]), null);
});

test('previousVersion puts the old values back', () => {
  const before = previousVersion(ev(), [moved, refield, { field: 'away', from: 'Team Frank', to: 'Team Custis' }]);
  assert.equal(before.start, '2026-10-21T17:00');
  assert.equal(before.date, '2026-10-21');
  assert.equal(before.field, 'Field 2');
  assert.deepEqual(before.teams.map((t) => t.name), ['Team Dennis', 'Team Frank']);
});

test('pairMismatches: start time and field must line up', () => {
  // Real case, linked by Game ID: league 12:30, Assignr 11:30, same field.
  const league = ev({ start: '2026-10-31T12:30', date: '2026-10-31', field: 'Field 2 (AA/AAA)' });
  const assignr = ag(1, { start: '2026-10-31T11:30', date: '2026-10-31', venue: 'Providence ES', subvenue: 'Field 2 (AA/AAA)', home: 'GW1', away: 'GW2' });
  assert.deepEqual(pairMismatches(league, assignr), ['when']);
  assert.deepEqual(pairMismatches(ev(), ag(1)), []); // same time, "Providence Elementary" ~ "Providence ES"
  assert.deepEqual(pairMismatches(ev(), ag(1, { subvenue: 'Field 2' })), ['where']); // field 2 vs 3
  assert.deepEqual(pairMismatches(ev(), ag(1, { venue: 'Wakefield Park', subvenue: '' })), ['where']);
  assert.deepEqual(pairMismatches(ev(), ag(1, { subvenue: '' })), []); // no field info in Assignr: fine
  assert.deepEqual(pairMismatches(ev(), ag(1, { start: '2026-10-29T18:30', venue: 'Wakefield Park' })), ['when', 'where']);
});
