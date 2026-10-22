// Cloudflare Worker entry: the same app as server.js, with the schedule cached
// in KV and refreshed by a cron trigger. Static files in public/ are served by
// Workers Static Assets before this code runs.

import { loadConfig } from './lib/config.js';
import { fetchSchedule } from './lib/sportsconnect.js';
import { scheduleJson, calendarIcs } from './lib/handlers.js';

const KV_KEY = 'schedule';
const MIN_REFRESH_MS = 60_000; // don't let ?refresh hammer the league site

let memo = null; // isolate-local copy, to skip KV reads and JSON parsing
let lastError = null;

const ageMs = (data) => Date.now() - Date.parse(data.fetchedAt);

async function refresh(env, cfg) {
  try {
    const data = await fetchSchedule(cfg);
    data.leagueName = cfg.leagueName;
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

async function getSchedule(env, ctx, cfg, { force = false } = {}) {
  const maxAge = cfg.cacheMinutes * 60_000;
  if (!memo || ageMs(memo) > maxAge) {
    const stored = await env.CACHE.get(KV_KEY, { type: 'json' });
    if (stored && (!memo || stored.fetchedAt > memo.fetchedAt)) memo = stored;
  }
  if (!memo) return refresh(env, cfg);
  if (force && ageMs(memo) > MIN_REFRESH_MS) {
    return refresh(env, cfg).catch(() => memo);
  }
  // The cron keeps KV fresh; this only kicks in if a run was missed.
  if (ageMs(memo) > maxAge + 5 * 60_000) ctx.waitUntil(refresh(env, cfg).catch(() => {}));
  return memo;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cfg = loadConfig(env);
    try {
      if (url.pathname === '/api/schedule') {
        const data = await getSchedule(env, ctx, cfg, { force: url.searchParams.has('refresh') });
        const { body, headers } = scheduleJson(data, { cacheMinutes: cfg.cacheMinutes, error: lastError?.message });
        return new Response(body, { headers });
      }
      if (url.pathname === '/calendar.ics') {
        const { body, headers } = calendarIcs(await getSchedule(env, ctx, cfg), url.searchParams);
        return new Response(body, { headers });
      }
    } catch (err) {
      return Response.json({ error: `Couldn't load the schedule: ${err.message}` }, { status: 502 });
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(refresh(env, loadConfig(env)));
  },
};
