// Response builders shared by the Node server and the Cloudflare Worker.

import { toIcs } from './ics.js';
import { applyFilters, parseFilters, haystack, addDays } from '../public/js/filter.js';

/** Today's date ('YYYY-MM-DD') in the league's time zone, not the server's. */
export function todayIn(timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
}

export function scheduleJson(data, { cacheMinutes, error = null }) {
  const stale = Date.now() - Date.parse(data.fetchedAt) > cacheMinutes * 60_000;
  return {
    body: JSON.stringify({ ...data, stale, error }),
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  };
}

export function calendarIcs(data, params) {
  const today = todayIn(data.timeZone);
  const ids = params.get('id')?.split(',');
  // A calendar feed is about the future; include the last 30 days for context.
  const ignoreDate = !params.has('range');
  const cutoff = addDays(today, -30);
  const events = ids
    ? data.events.filter((e) => ids.includes(e.id))
    : applyFilters(data.events.map((e) => ({ ...e, _hay: haystack(e) })), parseFilters(params), today, { ignoreDate })
      .filter((e) => !ignoreDate || e.date >= cutoff);

  const calName = params.get('name') || data.leagueName || 'Schedule';
  const headers = { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-store' };
  if (params.has('download')) {
    headers['Content-Disposition'] = `attachment; filename="${calName.replace(/[^\w.-]+/g, '-')}.ics"`;
  }
  const body = toIcs(events, { timeZone: data.timeZone, calName, site: data.calendarUrl || data.site });
  return { body, headers };
}
