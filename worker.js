// Cloudflare Worker entry: the same app as server.js, with the schedule cached
// in KV and changes logged to D1. Nothing runs on a timer: the browser asks for
// a fresh copy when the page loads. Static files in public/ are served by
// Workers Static Assets before this code runs.

import { loadConfig } from './lib/config.js';
import { fetchSchedule } from './lib/sportsconnect.js';
import { scheduleJson, calendarIcs } from './lib/handlers.js';
import { trackChanges } from './lib/changes.js';
import { D1ChangeStore } from './lib/change-store-d1.js';
import { handleAssignr } from './lib/assignr.js';
import { D1AssignrSessions } from './lib/assignr-store-d1.js';

const KV_KEY = 'schedule';
const MIN_REFRESH_MS = 60_000; // page loads within a minute of each other share one fetch

let memo = null; // isolate-local copy, to skip KV reads and JSON parsing
let lastError = null;

const ageMs = (data) => Date.now() - Date.parse(data.fetchedAt);

async function refresh(env, cfg) {
  try {
    const data = await fetchSchedule(cfg);
    data.leagueName = cfg.leagueName;
    try {
      const r = await trackChanges(new D1ChangeStore(env.DB), data);
      if (r.changes.length || r.seeding) console.log(`Recorded ${r.changes.length} changes${r.seeding ? ' (seeded baseline)' : ''}`);
      if (r.skippedRemovals) console.warn(`Ignored ${r.skippedRemovals} missing games (looks like a partial fetch)`);
    } catch (err) {
      // Change tracking is a bonus; never let it take the schedule down.
      console.error('Change tracking failed:', err.message);
    }
    await env.CACHE.put(KV_KEY, JSON.stringify(data));
    memo = data;
    lastError = null;
    return data;
  } catch (err) {
    lastError = err;
    console.error('Schedule fetch failed:', err.message);
    throw err;
  }
}

/** The cached schedule, re-fetched from the league site if older than maxAgeMs. */
async function getSchedule(env, cfg, { maxAgeMs = Infinity } = {}) {
  if (!memo || ageMs(memo) > maxAgeMs) {
    // Another isolate may have refreshed recently.
    const stored = await env.CACHE.get(KV_KEY, { type: 'json' });
    if (stored && (!memo || stored.fetchedAt > memo.fetchedAt)) memo = stored;
  }
  if (memo && ageMs(memo) <= maxAgeMs) return memo;
  try {
    return await refresh(env, cfg);
  } catch (err) {
    if (memo) return memo; // league site down: serve what we have, flagged via lastError
    throw err;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cfg = loadConfig(env);
    // Per-user umpire data; handles its own errors.
    const assignr = await handleAssignr(request, { cfg, sessions: new D1AssignrSessions(env.DB) });
    if (assignr) return assignr;
    try {
      if (url.pathname === '/api/schedule') {
        // ?refresh is sent once per page load; plain requests get the cache.
        const maxAgeMs = url.searchParams.has('refresh') ? MIN_REFRESH_MS : Infinity;
        const data = await getSchedule(env, cfg, { maxAgeMs });
        const { body, headers } = scheduleJson(data, { cacheMinutes: cfg.cacheMinutes, error: lastError?.message });
        return new Response(body, { headers });
      }
      if (url.pathname === '/calendar.ics') {
        // Calendar apps poll this on their own, with nobody opening the page,
        // so subscribed feeds refresh themselves when the cache is old.
        const data = await getSchedule(env, cfg, { maxAgeMs: cfg.cacheMinutes * 60_000 });
        const { body, headers } = calendarIcs(data, url.searchParams);
        return new Response(body, { headers });
      }
    } catch (err) {
      return Response.json({ error: `Couldn't load the schedule: ${err.message}` }, { status: 502 });
    }
    return env.ASSETS.fetch(request);
  },
};
