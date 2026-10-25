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
    // Assignr sign-in (umpire assignments). Off unless both credentials are set.
    // The bases are overridable so the flow can be tested against a mock.
    assignr: {
      clientId: env.ASSIGNR_CLIENT_ID || '',
      clientSecret: env.ASSIGNR_CLIENT_SECRET || '',
      authBase: (env.ASSIGNR_AUTH_BASE || 'https://app.assignr.com').replace(/\/+$/, ''),
      apiBase: (env.ASSIGNR_API_BASE || 'https://api.assignr.com/api/v2').replace(/\/+$/, ''),
      gameUrl: env.ASSIGNR_GAME_URL || 'https://app.assignr.com/games/{id}',
      // Assignr's games list for one day; {date} = 2026-10-24, {mdy} = 10/24/2026.
      dayUrl: env.ASSIGNR_DAY_URL || 'https://app.assignr.com/games?search[start_date]={date}&search[end_date]={date}',
    },
  };
}
