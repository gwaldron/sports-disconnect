import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleAssignr, normalizeGame, localDateTime } from '../lib/assignr.js';
import { matchAssignr } from '../public/js/assignr-match.js';

const A = {
  clientId: 'cid', clientSecret: 'shh', authBase: 'https://auth.test', apiBase: 'https://api.test/v2',
  gameUrl: 'https://auth.test/games/{id}',
};
const cfg = { assignr: A, timeZone: 'America/New_York' };

// --- matching ---

const ev = (id, o = {}) => ({
  id: `${id}-2026-10-24`, matchId: id, date: '2026-10-24', start: '2026-10-24T09:00', allDay: false,
  location: 'Providence ES', field: 'Field 2 (AA/AAA)', division: 'AA – Minors',
  teams: [{ name: 'Team Dennis' }, { name: 'Team Custis' }], ...o,
});
const ag = (id, o = {}) => ({
  id, date: '2026-10-24', start: '2026-10-24T09:00', venue: 'Providence Elementary', subvenue: 'Field 2',
  home: 'Dennis', away: 'Custis', ageGroup: 'AA', cancelled: false, externalId: null, officials: [], ...o,
});

test('matches despite different naming of teams and venues', () => {
  const { byEvent, unmatched } = matchAssignr([ev(1)], [ag(500)]);
  assert.equal(byEvent.get('1-2026-10-24').id, 500);
  assert.equal(unmatched.length, 0);
});

test('picks the right game among simultaneous games by teams', () => {
  const events = [ev(1), ev(2, { teams: [{ name: 'Team Bailey' }, { name: 'Team Frank' }], field: 'Field 3' })];
  const { byEvent } = matchAssignr(events, [ag(500, { home: 'Bailey', away: 'Frank', subvenue: 'Field 3' }), ag(501)]);
  assert.equal(byEvent.get('2-2026-10-24').id, 500);
  assert.equal(byEvent.get('1-2026-10-24').id, 501);
});

test('time alone is not enough, and ties are left unmatched', () => {
  assert.equal(matchAssignr([ev(1)], [ag(500, { venue: 'Elsewhere', subvenue: '', home: 'X', away: 'Y', ageGroup: '' })]).byEvent.size, 0);
  const twins = [ev(1, { teams: [] }), ev(2, { teams: [] })];
  assert.equal(matchAssignr(twins, [ag(500, { home: '', away: '' })]).byEvent.size, 0);
});

test('external id links exactly; far-off times and cancelled games never match', () => {
  assert.equal(matchAssignr([ev(1)], [ag(500, { externalId: 1, venue: 'Nowhere', home: '', away: '' })]).byEvent.size, 1);
  assert.equal(matchAssignr([ev(1)], [ag(500, { start: '2026-10-24T11:00' })]).byEvent.size, 0);
  const r = matchAssignr([ev(1)], [ag(500, { cancelled: true })]);
  assert.equal(r.byEvent.size, 0);
  assert.equal(r.unmatched.length, 0);
});

// --- normalization ---

test('normalizes a game to names and positions only, in league time', () => {
  const g = normalizeGame({
    id: 77, start_time: '2026-10-24T13:00:00.000Z', subvenue: 'Field 2', home_team: 'Dennis', away_team: 'Custis',
    age_group: { name: 'AA' }, cancelled: false, external_id: null,
    _embedded: {
      venue: { name: 'Providence Elementary' },
      assignments: [
        { sort_order: 2, position: 'Base Umpire', position_abbreviation: 'BU', accepted: false, _embedded: {} },
        { sort_order: 1, position: 'Plate Umpire', position_abbreviation: 'PU', accepted: true,
          _embedded: { official: { first_name: 'Pat', last_name: 'Smith', email: 'pat@example.com', phone: '555' } } },
      ],
    },
  }, 'America/New_York', A);
  assert.equal(g.start, '2026-10-24T09:00');
  assert.equal(g.ageGroup, 'AA');
  assert.equal(g.url, 'https://auth.test/games/77');
  assert.deepEqual(g.officials.map((o) => [o.abbr, o.name, o.accepted]), [['PU', 'Pat Smith', true], ['BU', '', false]]);
  assert.ok(!JSON.stringify(g).includes('pat@example.com'), 'no contact details');
});

test('localDateTime handles DST and bad input', () => {
  assert.equal(localDateTime('2026-11-07T15:00:00Z', 'America/New_York'), '2026-11-07T10:00');
  assert.equal(localDateTime('nope', 'America/New_York'), null);
});

// --- OAuth + session flow, against a fake Assignr ---

function fakeAssignr() {
  const calls = [];
  let issued = 0;
  const fetchImpl = async (url, init = {}) => {
    calls.push(url);
    const u = new URL(url);
    const ok = (body) => new Response(JSON.stringify(body), { status: 200 });
    if (u.pathname === '/oauth/token') {
      const p = new URLSearchParams(init.body);
      if (p.get('client_secret') !== 'shh') return new Response('{}', { status: 401 });
      if (p.get('grant_type') === 'authorization_code' && p.get('code') !== 'good') return new Response('{}', { status: 400 });
      issued++;
      return ok({ access_token: `at${issued}`, refresh_token: `rt${issued}`, expires_in: p.get('grant_type') === 'refresh_token' ? 7200 : 30 });
    }
    if (u.pathname === '/oauth/revoke') return ok({});
    const auth = new Headers(init.headers).get('authorization');
    if (!auth?.startsWith('Bearer at')) return new Response('{}', { status: 401 });
    if (u.pathname === '/v2/current_account') return ok({ first_name: 'Pat', last_name: 'Ump' });
    if (u.pathname === '/v2/current_account/sites') return ok({ _embedded: { sites: [{ id: 9 }] } });
    if (u.pathname === '/v2/sites/9/games') {
      return ok({ page: { pages: '1' }, _embedded: { games: [{ id: 1, start_time: '2026-10-24T13:00:00Z', _embedded: { assignments: [] } }] } });
    }
    return new Response('{}', { status: 404 });
  };
  return { fetchImpl, calls };
}

function memorySessions() {
  const m = new Map();
  return { m, get: async (k) => m.get(k) || null, put: async (s) => { m.set(s.idHash, structuredClone(s)); }, delete: async (k) => { m.delete(k); } };
}

const req = (path, { cookie, method = 'GET' } = {}) =>
  new Request(`https://sd.test${path}`, { method, headers: cookie ? { cookie } : {} });
const setCookies = (res) => Object.fromEntries(res.headers.getSetCookie().map((c) => c.split(';')[0].split('=')));

test('disabled without credentials, and unrelated paths pass through', async () => {
  const off = { ...cfg, assignr: { ...A, clientSecret: '' } };
  const res = await handleAssignr(req('/api/assignr'), { cfg: off, sessions: memorySessions() });
  assert.deepEqual(await res.json(), { enabled: false, connected: false });
  assert.equal(await handleAssignr(req('/api/schedule'), { cfg, sessions: memorySessions() }), null);
});

test('sign in, see games, refresh an expiring token, and sign out', async () => {
  const sessions = memorySessions();
  const { fetchImpl, calls } = fakeAssignr();
  const deps = { cfg, sessions, fetchImpl };

  const login = await handleAssignr(req('/assignr/login'), deps);
  assert.equal(login.status, 302);
  const auth = new URL(login.headers.get('location'));
  assert.equal(auth.origin + auth.pathname, 'https://auth.test/oauth/authorize');
  assert.equal(auth.searchParams.get('redirect_uri'), 'https://sd.test/assignr/callback');
  const state = auth.searchParams.get('state');
  assert.equal(setCookies(login).sd_as_state, state);

  // A forged callback (state not from our cookie) is rejected.
  const forged = await handleAssignr(req(`/assignr/callback?code=good&state=${state}`, { cookie: 'sd_as_state=other' }), deps);
  assert.match(forged.headers.get('location'), /assignr_error=/);
  assert.equal(sessions.m.size, 0);

  const cb = await handleAssignr(req(`/assignr/callback?code=good&state=${state}`, { cookie: `sd_as_state=${state}` }), deps);
  assert.equal(cb.headers.get('location'), '/');
  const sid = setCookies(cb).sd_as;
  assert.match(sid, /^[0-9a-f]{64}$/);
  assert.ok(cb.headers.getSetCookie().find((c) => c.startsWith('sd_as=')).includes('HttpOnly'));
  assert.equal(sessions.m.size, 1);
  assert.ok(!sessions.m.has(sid), 'only a hash of the session id is stored');

  // The first token expires in 30s, so status refreshes it before fetching games.
  const st = await handleAssignr(req('/api/assignr', { cookie: `sd_as=${sid}` }), deps);
  assert.equal(st.headers.get('cache-control'), 'private, no-store');
  const body = await st.json();
  assert.equal(body.connected, true);
  assert.equal(body.account, 'Pat Ump');
  assert.equal(body.games.length, 1);
  assert.equal([...sessions.m.values()][0].refreshToken, 'rt2');

  // No cookie: nothing about umpires.
  assert.deepEqual(await (await handleAssignr(req('/api/assignr'), deps)).json(), { enabled: true, connected: false });

  const out = await handleAssignr(req('/assignr/logout', { cookie: `sd_as=${sid}`, method: 'POST' }), deps);
  assert.equal(setCookies(out).sd_as, '');
  assert.equal(sessions.m.size, 0);
  assert.ok(calls.some((u) => u.endsWith('/oauth/revoke')));
});

test('day links use Assignr\'s own filter format', async () => {
  const { assignrDayUrl } = await import('../public/js/assignr-links.js');
  const t = 'https://fairfaxll.assignr.com/games?filter%5Bend_date%5D={text}&filter%5Bstart_date%5D={text}';
  // The example URL copied from Assignr for Oct 6, 2026.
  assert.equal(assignrDayUrl(t, '2026-10-06'),
    'https://fairfaxll.assignr.com/games?filter%5Bend_date%5D=Oct+6+2026&filter%5Bstart_date%5D=Oct+6+2026');
  assert.equal(assignrDayUrl('{date} {mdy} {text}', '2026-09-30'), '2026-09-30 9/30/2026 Sep+30+2026');
});
