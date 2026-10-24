import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../lib/sportsconnect.js';
import { applyFilters, parseFilters, serializeFilters, defaultFilters } from '../public/js/filter.js';
import { toIcs } from '../lib/ics.js';

const cfg = { site: 'https://example.org', calendarUrl: '', timeZone: 'America/New_York', mapHint: 'Fairfax, VA' };

// Trimmed-down records in the shape SportsConnect's GetMatches returns.
const raw = (o) => ({
  MatchID: 1, Start: '2026-10-22T17:00:01', End: '2026-10-22T19:00:01', IsAllDay: false, IsDeleted: false,
  EventType: 'Games', EventTypeID: 1, EventName: 'Baseball AAA Games',
  ProgramName: '2026 Fall Baseball Little League - AAA - Minors<br/> 2026 Fall Baseball Little League - AAA - Minors',
  Team1: 'Team Bailey', Team1Type: 0, HomeTeamID: 11, Team2: 'Team Frank', Team2Type: 0, AwayTeamID: 12,
  LocationName: 'Chilcott Stadium', FieldName: 'Chilcott', Notes: null, StatusName: null,
  HomeTeamScore: 0, AwayTeamScore: 0, WinningTeamId: 0, ...o,
});

const programs = [{
  Name: '2026 Fall Baseball Little League',
  ChildItems: [
    { Name: 'AAA - Minors', ChildItems: [{ Id: 11, Name: 'Team Bailey' }, { Id: 12, Name: 'Team Frank' }] },
    { Name: 'Majors', ChildItems: [{ Id: 21, Name: 'Team McCarthy' }] },
  ],
}];

const matches = [
  raw({}),
  raw({ MatchID: 2, Start: '2026-10-23T17:30:02', End: '2026-10-23T19:30:02', EventType: 'Practice', EventTypeID: 2,
    EventName: 'Baseball Majors Practices', ProgramName: '', Team1: 'Team McCarthy', HomeTeamID: 21,
    Team2: 'Practice', Team2Type: 3, AwayTeamID: 823, LocationName: 'Providence ES', FieldName: 'Field 1' }),
  raw({ MatchID: 3, Start: '2026-10-24T09:00:01', End: '2026-10-24T11:00:01', EventType: '', EventTypeID: 3,
    Team1: 'G1 Win', Team1Type: 5, HomeTeamID: 0, Team2: 'G2 Win', Team2Type: 5, AwayTeamID: 0, Notes: 'Semifinal' }),
  raw({ MatchID: 4, Start: '2026-09-01T10:00:01', End: '2026-09-01T12:00:01', EventType: 'Other', EventTypeID: 5,
    EventName: 'Equipment Exchange', ProgramName: '', Team1: 'PortalTeam', Team1Type: 6, Team2: 'PortalTeam', Team2Type: 6 }),
];

const data = normalize({ matches, programs, locations: [] }, cfg);
const byMatch = (id) => data.events.find((e) => e.matchId === id);

test('games get home/away teams, a clean division and trimmed times', () => {
  const ev = byMatch(1);
  assert.equal(ev.type, 'game');
  assert.equal(ev.title, 'Team Bailey vs Team Frank');
  assert.equal(ev.division, 'AAA – Minors');
  assert.equal(ev.start, '2026-10-22T17:00');
  assert.deepEqual(ev.teams.map((t) => t.id), ['11', '12']);
  assert.match(ev.mapUrl, /Chilcott%20Stadium%2C%20Fairfax%2C%20VA/);
});

test('practices drop the "Practice" placeholder and find their division via the team', () => {
  const ev = byMatch(2);
  assert.equal(ev.type, 'practice');
  assert.equal(ev.title, 'Team McCarthy practice');
  assert.equal(ev.away, null);
  assert.equal(ev.division, 'Majors');
});

test('playoff placeholders and custom events are handled', () => {
  assert.equal(byMatch(3).postseason, true);
  assert.equal(byMatch(3).title, 'G1 Win vs G2 Win');
  assert.equal(byMatch(4).type, 'other');
  assert.equal(byMatch(4).title, 'Equipment Exchange');
  assert.deepEqual(byMatch(4).teams, []);
});

test('events are sorted and divisions are listed youngest-first', () => {
  assert.deepEqual(data.events.map((e) => e.matchId), [4, 1, 2, 3]);
  assert.deepEqual(data.divisions.map((d) => d.label), ['AAA – Minors', 'Majors']);
  // The Day view sorts age-group columns by this rank.
  assert.deepEqual(data.divisions.map((d) => d.level), [5, 6]);
});

test('team and division filters combine as a union; types narrow', () => {
  const today = '2026-10-01';
  const f = { ...defaultFilters(), divs: [byMatch(2).divisionId], teams: ['12'] };
  assert.deepEqual(applyFilters(data.events, f, today).map((e) => e.matchId), [1, 2]);
  f.types = ['practice'];
  assert.deepEqual(applyFilters(data.events, f, today).map((e) => e.matchId), [2]);
});

test('date ranges and search', () => {
  const f = { ...defaultFilters(), range: 'today' };
  assert.deepEqual(applyFilters(data.events, f, '2026-10-23').map((e) => e.matchId), [2]);
  f.range = 'past';
  assert.deepEqual(applyFilters(data.events, f, '2026-10-23').map((e) => e.matchId), [1, 4]);
  const s = { ...defaultFilters(), range: 'all', q: 'semi chilcott' };
  assert.deepEqual(applyFilters(data.events, s, '2026-10-23').map((e) => e.matchId), [3]);
});

test('filters round-trip through the URL', () => {
  const f = { ...defaultFilters(), q: 'bailey', types: ['game'], teams: ['11', '12'], range: 'custom', from: '2026-10-01', to: '2026-10-31' };
  assert.deepEqual(parseFilters(serializeFilters(f)), f);
});

test('ics output is well-formed', () => {
  const ics = toIcs(data.events, { timeZone: 'America/New_York', calName: 'Test' });
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 4);
  assert.match(ics, /DTSTART;TZID=America\/New_York:20261022T170000/);
  assert.ok(ics.split('\r\n').every((line) => Buffer.byteLength(line) <= 75));
});
