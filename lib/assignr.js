// Assignr integration: umpire assignments for people who sign in with their
// own Assignr account. OAuth runs on the server (the client secret can't go
// to the browser); tokens are stored server-side, keyed by a random session
// id in an HttpOnly cookie. Umpire data is only ever returned to that
// session, never in the public schedule payload.
//
// Runtime-neutral (Workers + Node): takes a web Request, returns a Response.
// Sessions live behind a small store (assignr-store-d1.js / -file.js):
//   get(idHash) -> Session | null,  put(Session),  delete(idHash)
//   listDone(scope) -> [{ key, at, by }],  setDone(scope, key, { at, by } | null)
//   Session = { idHash, created, lastUsed, accessToken, refreshToken, expiresAt,
//               accountName, accountId, scope, games, gamesFetchedAt }

const SESSION_COOKIE = 'sd_as';
const STATE_COOKIE = 'sd_as_state';
const SESSION_DAYS = 90;
const GAMES_TTL_MS = 2 * 60_000; // absorbs repeat page loads; the page asks once per load
const MAX_PAGES = 20; // 50 games per page
const ACCEPT = 'application/vnd.assignr.v2.hal+json';

export const assignrEnabled = (a) => !!(a?.clientId && a?.clientSecret);

/** Handles /assignr/* and /api/assignr; returns null for anything else. */
export async function handleAssignr(request, { cfg, sessions, fetchImpl = fetch }) {
  const url = new URL(request.url);
  const a = cfg.assignr;
  const isOurs = url.pathname === '/api/assignr' || url.pathname.startsWith('/api/assignr/') || url.pathname.startsWith('/assignr/');
  if (!isOurs) return null;
  if (!assignrEnabled(a)) {
    return url.pathname === '/api/assignr' ? json({ enabled: false, connected: false }) : text(404, 'Assignr is not configured.');
  }
  const ctx = { a, sessions, fetchImpl, timeZone: cfg.timeZone, cookies: parseCookies(request) };
  try {
    switch (url.pathname) {
      case '/api/assignr': return await status(ctx);
      case '/api/assignr/done': return request.method === 'POST' ? await setDone(ctx, request, url) : text(405, 'Use POST.');
      case '/assignr/login': return login(ctx, url);
      case '/assignr/callback': return await callback(ctx, url);
      case '/assignr/logout': return request.method === 'POST' ? await logout(ctx) : text(405, 'Use POST.');
      default: return text(404, 'Not found');
    }
  } catch (err) {
    // e.g. the session store is down: degrade to "not connected", never break the page.
    if (url.pathname === '/api/assignr') return json({ enabled: true, connected: false, error: `Assignr is unavailable (${err.message}).` });
    return text(500, `Assignr is unavailable (${err.message}).`);
  }
}

// --- OAuth ---

const redirectUri = (url) => `${url.origin}/assignr/callback`;

function login({ a }, url) {
  const state = randomHex(16);
  const auth = new URL(`${a.authBase}/oauth/authorize`);
  auth.search = new URLSearchParams({
    client_id: a.clientId, redirect_uri: redirectUri(url), response_type: 'code', scope: 'read', state,
  });
  return redirect(auth.href, [cookie(STATE_COOKIE, state, 600)]);
}

async function callback(ctx, url) {
  const { a, sessions, fetchImpl, cookies } = ctx;
  const back = (message) => redirect(`/?assignr_error=${encodeURIComponent(message)}`, [cookie(STATE_COOKIE, '', 0)]);
  if (url.searchParams.get('error')) return back('Assignr sign-in was cancelled.');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  // The state must round-trip through our own cookie, or this isn't our sign-in.
  if (!code || !state || state !== cookies[STATE_COOKIE]) return back('Assignr sign-in failed. Please try again.');

  try {
    const tok = await tokenRequest(a, fetchImpl, { grant_type: 'authorization_code', code, redirect_uri: redirectUri(url) });
    const account = await api(a, fetchImpl, tok.access_token, '/current_account').catch(() => null);
    const sid = randomHex(32);
    const now = new Date().toISOString();
    await sessions.put({
      idHash: await sha256Hex(sid), created: now, lastUsed: now,
      accessToken: tok.access_token, refreshToken: tok.refresh_token,
      expiresAt: Date.now() + (tok.expires_in || 7200) * 1000,
      accountName: personName(account) || 'your Assignr account', accountId: account?.id ?? null,
      scope: null, games: null, gamesFetchedAt: 0,
    });
    return redirect('/', [cookie(SESSION_COOKIE, sid, SESSION_DAYS * 86400), cookie(STATE_COOKIE, '', 0)]);
  } catch (err) {
    return back(`Couldn't connect to Assignr (${err.message}).`);
  }
}

async function logout({ a, sessions, fetchImpl, cookies }) {
  const sid = cookies[SESSION_COOKIE];
  if (sid) {
    const idHash = await sha256Hex(sid);
    const s = await sessions.get(idHash);
    if (s) {
      // Best effort: revoke at Assignr too, then forget it here regardless.
      await fetchImpl(`${a.authBase}/oauth/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: s.refreshToken || s.accessToken, client_id: a.clientId, client_secret: a.clientSecret }),
      }).catch(() => {});
      await sessions.delete(idHash);
    }
  }
  return json({ enabled: true, connected: false }, [cookie(SESSION_COOKIE, '', 0)]);
}

async function tokenRequest(a, fetchImpl, params) {
  const res = await fetchImpl(`${a.authBase}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: a.clientId, client_secret: a.clientSecret, ...params }),
  });
  if (!res.ok) throw httpError(res.status, 'token request failed', res.status === 400 || res.status === 401);
  return res.json();
}

// --- status + data ---

async function status(ctx) {
  const { a, sessions, fetchImpl, timeZone, cookies } = ctx;
  const signedOut = { enabled: true, connected: false };
  const sid = cookies[SESSION_COOKIE];
  if (!sid) return json(signedOut);
  const s = await sessions.get(await sha256Hex(sid));
  if (!s) return json(signedOut, [cookie(SESSION_COOKIE, '', 0)]);

  const connected = { enabled: true, connected: true, account: s.accountName, assignrUrl: a.authBase, dayUrl: a.dayUrl };
  try {
    if (s.expiresAt - 60_000 < Date.now()) {
      // Refresh tokens rotate: keep the new one.
      const tok = await tokenRequest(a, fetchImpl, { grant_type: 'refresh_token', refresh_token: s.refreshToken });
      Object.assign(s, {
        accessToken: tok.access_token, refreshToken: tok.refresh_token || s.refreshToken,
        expiresAt: Date.now() + (tok.expires_in || 7200) * 1000,
      });
    }
    if (!s.games || !s.scope || Date.now() - s.gamesFetchedAt > GAMES_TTL_MS) { // older sessions lack a scope
      const { games, siteIds } = await fetchGames(a, fetchImpl, s.accessToken, timeZone);
      s.games = games;
      s.gamesFetchedAt = Date.now();
      // "Mark done" is shared by everyone connected to the same Assignr site.
      s.scope = siteIds.length ? `site:${siteIds[0]}` : `account:${s.accountId ?? s.idHash}`;
    }
    s.lastUsed = new Date().toISOString();
    await sessions.put(s);
    return json({ ...connected, games: s.games, done: await doneList(sessions, s), fetchedAt: new Date(s.gamesFetchedAt).toISOString() });
  } catch (err) {
    if (err.reauth) {
      await sessions.delete(s.idHash);
      return json({ ...signedOut, error: 'Your Assignr sign-in expired. Please connect again.' }, [cookie(SESSION_COOKIE, '', 0)]);
    }
    const done = await doneList(sessions, s).catch(() => []);
    return json({ ...connected, games: s.games || [], done, error: `Couldn't reach Assignr (${err.message}).` });
  }
}

const doneList = (sessions, s) => (s.scope ? sessions.listDone(s.scope) : []);

/** Mark a change done (or not) for everyone on this Assignr site. */
async function setDone({ sessions, cookies }, request, url) {
  // The cookie is SameSite=Lax already; refuse other sites outright too.
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) return text(403, 'Cross-site request refused.');
  const sid = cookies[SESSION_COOKIE];
  const s = sid && await sessions.get(await sha256Hex(sid));
  if (!s?.scope) return text(401, 'Connect Assignr first.');
  let body;
  try { body = await request.json(); } catch { return text(400, 'Expected JSON.'); }
  const key = String(body?.key ?? '');
  if (!/^[\w.:~-]{1,100}$/.test(key)) return text(400, 'Bad change key.');
  await sessions.setDone(s.scope, key, body.done ? { at: new Date().toISOString(), by: s.accountName } : null);
  return json({ done: await sessions.listDone(s.scope) });
}

/**
 * Games with assignments, from two weeks back to six months out. Assignors and
 * admins can read whole sites; anyone else gets their own assigned games.
 */
export async function fetchGames(a, fetchImpl, token, timeZone) {
  const day = (offset) => new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10);
  const search = { 'search[start_date]': day(-14), 'search[end_date]': day(183), 'sort[1]': 'date asc' };
  const sites = list(await api(a, fetchImpl, token, '/current_account/sites').catch(() => ({})), 'sites');
  let raw = [];
  for (const site of sites) {
    try {
      raw.push(...await allPages(a, fetchImpl, token, `/sites/${site.id}/games`, search));
    } catch (err) {
      if (err.status !== 401 && err.status !== 403) throw err; // no site-wide access: fall through
    }
  }
  if (!raw.length) raw = await allPages(a, fetchImpl, token, '/current_account/games', search);
  const seen = new Set();
  const games = raw.filter((g) => !seen.has(g.id) && seen.add(g.id)).map((g) => normalizeGame(g, timeZone, a));
  return { games, siteIds: sites.map((site) => site.id).filter((id) => id != null) };
}

async function allPages(a, fetchImpl, token, path, search) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = await api(a, fetchImpl, token, path, { ...search, page, limit: 50 });
    const games = list(body, 'games');
    out.push(...games);
    if (!games.length || page >= Number(body.page?.pages || 1)) break;
  }
  return out;
}

async function api(a, fetchImpl, token, path, params = {}) {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
  const res = await fetchImpl(`${a.apiBase}${path}${qs ? `?${qs}` : ''}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: ACCEPT },
  });
  if (!res.ok) throw httpError(res.status, `${path} returned ${res.status}`, res.status === 401);
  return res.json();
}

const list = (body, key) => body?._embedded?.[key] ?? body?.[key] ?? [];
const str = (v) => (v && typeof v === 'object' ? v.name ?? v.title ?? '' : v ?? '');

/** Just what the UI needs: names and positions, no contact details. */
export function normalizeGame(g, timeZone, a) {
  const start = localDateTime(g.start_time, timeZone);
  const assignments = [...(g._embedded?.assignments || [])].sort((x, y) => (x.sort_order ?? 0) - (y.sort_order ?? 0));
  return {
    id: g.id,
    start,
    date: start?.slice(0, 10) || null,
    end: localDateTime(g.end_time, timeZone),
    published: g.published !== false, // drafts aren't real schedule problems yet
    venue: str(g._embedded?.venue) || '',
    subvenue: g.subvenue || '',
    home: str(g.home_team),
    away: str(g.away_team),
    ageGroup: str(g.age_group),
    cancelled: !!g.cancelled,
    externalId: g.external_id ?? null,
    url: a.gameUrl.replace('{id}', encodeURIComponent(g.id)),
    officials: assignments.map((x) => ({
      position: x.position || '',
      abbr: x.position_abbreviation || x.position || '',
      name: personName(x._embedded?.official),
      accepted: !!x.accepted,
      declined: !!x.declined,
    })),
    // Officials asking to work this game. Requests are per game, not per position. The docs show
    // one embedded `game_request`; a list is accepted too in case real data has several.
    requests: [g._embedded?.game_request, ...(g._embedded?.game_requests || []), ...(g.game_requests || [])]
      .filter(Boolean).map((r) => ({ name: personName(r._embedded?.official), status: r.status || '' })),
  };
}

/** ISO timestamp -> 'YYYY-MM-DDTHH:MM' wall-clock time in the league's zone. */
export function localDateTime(iso, timeZone) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

function personName(u) {
  return [u?.first_name, u?.last_name].filter(Boolean).join(' ') || u?.name || '';
}

// --- HTTP + crypto helpers ---

function httpError(status, message, reauth = false) {
  return Object.assign(new Error(message), { status, reauth });
}

function parseCookies(request) {
  const out = {};
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function respond(status, body, headers, cookies = []) {
  const h = new Headers(headers);
  for (const c of cookies) h.append('Set-Cookie', c);
  return new Response(body, { status, headers: h });
}

// Umpire data is per-person: never let a cache keep or share it.
const json = (data, cookies) => respond(200, JSON.stringify(data),
  { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' }, cookies);
const text = (status, body) => respond(status, body, { 'Content-Type': 'text/plain; charset=utf-8' });
const redirect = (location, cookies) => respond(302, null, { Location: location, 'Cache-Control': 'no-store' }, cookies);

function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Only a hash of the session id is stored, so a database leak can't be replayed as cookies.
async function sha256Hex(s) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
