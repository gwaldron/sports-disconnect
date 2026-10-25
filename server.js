// Local web server: proxies + caches the SportsConnect schedule (the site sends
// no CORS headers, so the browser can't call it directly) and serves the UI.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/config.js';
import { fetchSchedule } from './lib/sportsconnect.js';
import { getJson, discoverPortal } from './lib/node-http.js';
import { scheduleJson, calendarIcs } from './lib/handlers.js';
import { trackChanges } from './lib/changes.js';
import { FileChangeStore } from './lib/change-store-file.js';
import { handleAssignr } from './lib/assignr.js';
import { FileAssignrSessions } from './lib/assignr-store-file.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const CACHE_FILE = path.join(ROOT, 'data', 'cache.json');
const changeStore = new FileChangeStore(path.join(ROOT, 'data', 'changes.json'));
const assignrSessions = new FileAssignrSessions(
  path.join(ROOT, 'data', 'assignr-sessions.json'), path.join(ROOT, 'data', 'assignr-done.json'));
const cfg = loadConfig(process.env);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

// --- schedule cache: memory, backed by a file so restarts are instant ---

let cache = null; // { data, fetchedAtMs }
let inflight = null;
let lastError = null;

async function loadDiskCache() {
  try {
    const data = JSON.parse(await fs.readFile(CACHE_FILE, 'utf8'));
    if (data.site === cfg.site) cache = { data, fetchedAtMs: Date.parse(data.fetchedAt) };
  } catch { /* no cache yet */ }
}

async function refresh() {
  if (!inflight) {
    inflight = (async () => {
      if (!cfg.portalId) {
        const found = await discoverPortal(cfg.site);
        cfg.portalId = found.portalId;
        cfg.leagueName ||= found.title;
        console.log(`Discovered portal ${cfg.portalId} (${cfg.leagueName || 'unnamed'})`);
      }
      const t0 = Date.now();
      const data = await fetchSchedule(cfg, { getJson });
      data.leagueName = cfg.leagueName;
      try {
        const r = await trackChanges(changeStore, data);
        if (r.changes.length || r.seeding) console.log(`Recorded ${r.changes.length} changes${r.seeding ? ' (seeded baseline)' : ''}`);
        if (r.skippedRemovals) console.warn(`Ignored ${r.skippedRemovals} missing games (looks like a partial fetch)`);
      } catch (err) {
        console.error('Change tracking failed:', err.message);
      }
      cache = { data, fetchedAtMs: Date.now() };
      lastError = null;
      console.log(`Fetched ${data.events.length} events in ${Date.now() - t0} ms`);
      await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
      await fs.writeFile(CACHE_FILE, JSON.stringify(data));
    })().catch((err) => {
      lastError = err;
      console.error('Schedule fetch failed:', err.message);
      throw err;
    }).finally(() => { inflight = null; });
  }
  return inflight;
}

const MIN_REFRESH_MS = 60_000; // page loads within a minute of each other share one fetch

/** The cached schedule, re-fetched from the league site if older than maxAgeMs. */
async function getSchedule({ maxAgeMs = Infinity } = {}) {
  if (cache && Date.now() - cache.fetchedAtMs <= maxAgeMs) return cache.data;
  try {
    await refresh();
  } catch (err) {
    if (!cache) throw err; // league site down: serve what we have, flagged via lastError
  }
  return cache.data;
}

// --- HTTP ---

function send(req, res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const gzip = buf.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')
    && /json|text|javascript|calendar|svg/.test(headers['Content-Type'] || '');
  res.writeHead(status, {
    ...headers,
    ...(gzip ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}),
  });
  res.end(gzip ? zlib.gzipSync(buf) : buf);
}

/** Bridge node:http to the fetch-style handler shared with the Worker. */
async function handleWeb(req, res, handler) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = Buffer.concat(chunks);
  }
  const request = new Request(`http://${req.headers.host || 'localhost'}${req.url}`, { method: req.method, headers, body });
  const response = await handler(request);
  if (!response) return false;
  const out = Object.fromEntries(response.headers);
  const cookies = response.headers.getSetCookie();
  if (cookies.length) out['set-cookie'] = cookies;
  res.writeHead(response.status, out);
  res.end(Buffer.from(await response.arrayBuffer()));
  return true;
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');

  if (await handleWeb(req, res, (request) => handleAssignr(request, { cfg, sessions: assignrSessions }))) return;

  if (url.pathname === '/api/schedule') {
    // ?refresh is sent once per page load; plain requests get the cache.
    const data = await getSchedule({ maxAgeMs: url.searchParams.has('refresh') ? MIN_REFRESH_MS : Infinity });
    const { body, headers } = scheduleJson(data, { cacheMinutes: cfg.cacheMinutes, error: lastError?.message });
    return send(req, res, 200, body, headers);
  }

  if (url.pathname === '/calendar.ics') {
    // Calendar apps poll this with nobody opening the page, so refresh if old.
    const data = await getSchedule({ maxAgeMs: cfg.cacheMinutes * 60_000 });
    const { body, headers } = calendarIcs(data, url.searchParams);
    return send(req, res, 200, body, headers);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, 'Method not allowed');

  // Static files.
  const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const file = path.resolve(PUBLIC, '.' + rel);
  if (!file.startsWith(PUBLIC + path.sep)) return send(req, res, 403, 'Forbidden');
  try {
    const body = await fs.readFile(file);
    return send(req, res, 200, body, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
  } catch {
    return send(req, res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  }
}

await loadDiskCache();
http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    send(req, res, 502, JSON.stringify({ error: `Couldn't load the schedule: ${err.message}` }),
      { 'Content-Type': 'application/json' });
  });
}).listen(cfg.port, cfg.host, () => {
  console.log(`Sports Disconnect running at http://${cfg.host === '0.0.0.0' ? 'localhost' : cfg.host}:${cfg.port}`);
  console.log(`Source: ${cfg.site}${cfg.portalId ? ` (portal ${cfg.portalId})` : ''}`);
});
