// Configuration comes from environment variables, with defaults for Fairfax LL.
// Any SportsConnect site should work: set SC_SITE and (optionally) SC_PORTAL_ID.

export function loadConfig(env) {
  const site = (env.SC_SITE || 'https://www.fairfaxll.org').replace(/\/+$/, '');
  return {
    site,
    // Leave unset to discover it from the site's home page.
    portalId: env.SC_PORTAL_ID || '',
    calendarUrl: env.SC_CALENDAR_URL || (env.SC_SITE ? '' : `${site}/Default.aspx?tabid=953435#/gameScheduleCalendar`),
    // Windows-style zone name the SportsConnect API expects, and the IANA zone
    // the schedule's (offset-less) local times are in.
    apiTimeZone: env.SC_API_TIMEZONE || 'Eastern Standard Time',
    timeZone: env.SC_TIMEZONE || 'America/New_York',
    // Appended to location names for map searches, since the site has no addresses.
    mapHint: env.SC_MAP_HINT ?? (env.SC_SITE ? '' : 'Fairfax, VA'),
    leagueName: env.SC_LEAGUE_NAME || '',
    port: Number(env.PORT) || 3000,
    host: env.HOST || '127.0.0.1',
    cacheMinutes: Number(env.CACHE_MINUTES) || 15,
  };
}
