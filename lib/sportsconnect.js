// Fetches schedule data from a SportsConnect (Stack Sports / Blue Sombrero) site's
// public calendar API and normalizes it into something sane.
//
// The calendar page is a Kendo UI app that calls these JSON endpoints under
// /DesktopModules/sScheduleEventServices/API/. No login is needed. Passing
// isToCheckForDateRange=false to GetMatches returns every posted event at once
// instead of one month at a time.
//
// This module runs in both Node and Cloudflare Workers, so it only uses fetch();
// callers can pass their own getJson (the Node server does, to prefer IPv4).

const API_PATH = '/DesktopModules/sScheduleEventServices/API';
export const USER_AGENT = 'Mozilla/5.0 (compatible; sports-disconnect/1.0)';

// SportsConnect team "types" seen in the wild.
const TEAM_TYPE = { TEAM: 0, EXTERNAL: 1, PRACTICE: 3, PLACEHOLDER: 5, PORTAL: 6 };

// Rough youngest-to-oldest ordering for divisions; unmatched names sort last.
const LEVELS = [/tee ?ball/i, /coach toss/i, /rookie/i, /single[ -]?a\b/i, /\baa\b/i, /\baaa\b/i,
  /majors/i, /intermediate/i, /junior/i, /senior/i];

export async function fetchSchedule(cfg, { getJson = fetchJson } = {}) {
  const base = cfg.site.replace(/\/+$/, '') + API_PATH;
  const today = new Date();
  const mdY = `${today.getMonth() + 1}/${today.getDate()}/${today.getFullYear()}`;

  const matchesUrl = `${base}/Calendar/GetMatches?` + new URLSearchParams({
    portalId: cfg.portalId,
    selectedEvents: '',
    selectedFields: '',
    currentDate: mdY,
    timeZone: cfg.apiTimeZone,
    currentCalendarView: '1',
    isToCheckForDateRange: 'false',
    isPosted: 'true',
    selectedTeams: '',
    isCustomEventMatchInclude: 'true',
    isCheckForAction: 'false',
    isBulkEventCancel: 'false',
  });
  const programsUrl = `${base}/ProgramDivision/GetAllProgramsWithDivisionsTeams?portalId=${cfg.portalId}`;
  const locationsUrl = `${base}/Locations/GetAllLocationsByPortalGroups?masterPortalId=${cfg.portalId}&needToIncludeTBDLocation=true`;

  const [matches, programs, locations] = await Promise.all([
    getJson(matchesUrl),
    getJson(programsUrl),
    getJson(locationsUrl).catch(() => []), // only used for addresses; not essential
  ]);
  return normalize({ matches, programs, locations }, cfg);
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${url}`);
  return res.json();
}

export function normalize({ matches, programs, locations }, cfg) {
  // Program -> division -> team tree. Team names repeat across divisions
  // ("Team McCarthy" coaches two), so teams are keyed by their numeric id.
  const divisions = new Map(); // id -> { id, label, sport, program, teams: Map }
  const teamDivision = new Map(); // team id -> division id

  const ensureDivision = (program, label) => {
    const id = slug(label ? `${program} ${label}` : program);
    if (!divisions.has(id)) {
      divisions.set(id, { id, label: tidy(label || program), sport: sportOf(program), program, teams: new Map(), dates: [] });
    }
    return divisions.get(id);
  };

  for (const prog of programs || []) {
    for (const div of prog.ChildItems || []) {
      const d = ensureDivision(prog.Name, div.Name);
      for (const team of div.ChildItems || []) {
        d.teams.set(String(team.Id), team.Name);
        teamDivision.set(String(team.Id), d.id);
      }
    }
  }
  const programNames = (programs || []).map((p) => p.Name).sort((a, b) => b.length - a.length);

  const addresses = new Map();
  for (const loc of locations || []) {
    const addr = [loc.Street, loc.City, loc.State || loc.RegionCode, loc.PostalCode].filter(Boolean).join(', ');
    if (addr || loc.LocationMapURL) addresses.set(loc.Name, { address: addr, mapUrl: loc.LocationMapURL || '' });
  }

  const events = [];
  const seen = new Set();
  const divisionByEventName = new Map(); // fallback for events missing a program

  for (const m of matches || []) {
    if (m.IsDeleted) continue;
    const key = `${m.MatchID}|${m.Start}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const type = m.EventType === 'Practice' ? 'practice'
      : m.EventType === 'Games' || m.EventTypeID === 1 || m.EventTypeID === 3 ? 'game'
      : 'other';

    const sides = [
      side(m.Team1, m.Team1Type, m.HomeTeamID),
      side(m.Team2, m.Team2Type, m.AwayTeamID),
    ];
    const teams = sides.filter(Boolean);

    // Division: program name on the event, else the team's division, else
    // whatever other events with the same schedule name belong to.
    let division = null;
    const programName = firstProgram(m.ProgramName);
    if (programName) {
      const root = programNames.find((p) => programName.startsWith(p + ' - '));
      if (root) {
        division = ensureDivision(root, programName.slice(root.length + 3).trim());
      } else {
        // A program that's no longer in the tree (e.g. last season): guess the
        // split at the first " - ".
        const i = programName.indexOf(' - ');
        division = i > 0
          ? ensureDivision(programName.slice(0, i), programName.slice(i + 3).trim())
          : ensureDivision(programName, '');
      }
    }
    if (!division) {
      const tid = teams.find((t) => t.id && teamDivision.has(t.id))?.id;
      if (tid) division = divisions.get(teamDivision.get(tid));
    }
    for (const t of teams) {
      if (t.id && division && !teamDivision.has(t.id)) {
        division.teams.set(t.id, t.name);
        teamDivision.set(t.id, division.id);
      }
    }

    const location = (m.LocationName || '').trim();
    const field = (m.FieldName || '').trim();
    const addr = addresses.get(location);

    const ev = {
      id: `${m.MatchID}-${m.Start.slice(0, 10)}`,
      matchId: m.MatchID,
      type,
      postseason: m.EventTypeID === 3,
      title: '',
      eventName: (m.EventName || '').trim().replace(/\s+/g, ' '),
      divisionId: division?.id || '',
      division: division?.label || '',
      sport: division?.sport || '',
      date: m.Start.slice(0, 10),
      // SportsConnect stuffs a sort-order counter into the seconds; drop it.
      start: m.Start.slice(0, 16),
      end: (m.End || m.Start).slice(0, 16),
      allDay: !!m.IsAllDay,
      home: sides[0],
      away: type === 'game' ? sides[1] : null,
      teams,
      locationId: slug(location || 'tbd'),
      location: location || 'TBD',
      field: field && field !== location ? field : '',
      address: addr?.address || '',
      mapUrl: addr?.mapUrl || (location && !/^tbd$/i.test(location)
        ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent([location, cfg.mapHint].filter(Boolean).join(', '))
        : ''),
      notes: (m.Notes || m.EventDetail?.Description || '').trim(),
      status: m.StatusName && m.StatusName !== 'None' ? m.StatusName : '',
      score: (m.HomeTeamScore || m.AwayTeamScore || m.WinningTeamId)
        ? { home: m.HomeTeamScore, away: m.AwayTeamScore } : null,
    };
    ev.title = titleFor(ev);
    events.push(ev);
    if (ev.divisionId && ev.eventName) divisionByEventName.set(ev.eventName, division);
  }

  for (const ev of events) {
    if (!ev.divisionId && divisionByEventName.has(ev.eventName)) {
      const d = divisionByEventName.get(ev.eventName);
      Object.assign(ev, { divisionId: d.id, division: d.label, sport: d.sport });
    }
  }

  events.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
  for (const ev of events) if (ev.divisionId) divisions.get(ev.divisionId).dates.push(ev.date);

  // Programs (seasons) newest-first; divisions youngest-first within each.
  const programLast = new Map();
  for (const d of divisions.values()) {
    const last = d.dates.at(-1) || '';
    if (last > (programLast.get(d.program) || '')) programLast.set(d.program, last);
  }
  const divisionList = [...divisions.values()]
    .filter((d) => d.dates.length || d.teams.size)
    .map((d) => ({
      id: d.id, label: d.label, sport: d.sport, program: d.program,
      firstDate: d.dates[0] || '', lastDate: d.dates.at(-1) || '', count: d.dates.length,
      teams: [...d.teams].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => (programLast.get(b.program) || '').localeCompare(programLast.get(a.program) || '')
      || a.program.localeCompare(b.program)
      || levelOf(a.label) - levelOf(b.label) || a.label.localeCompare(b.label));

  const locationList = [...new Map(events.map((e) => [e.locationId, e.location]))]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    fetchedAt: new Date().toISOString(),
    site: cfg.site,
    calendarUrl: cfg.calendarUrl,
    timeZone: cfg.timeZone,
    events,
    divisions: divisionList,
    locations: locationList,
  };
}

function side(name, teamType, id) {
  name = (name || '').trim();
  if (!name || teamType === TEAM_TYPE.PRACTICE || teamType === TEAM_TYPE.PORTAL || name === 'PortalTeam') return null;
  if (teamType === TEAM_TYPE.TEAM && id) return { id: String(id), name };
  return { id: '', name, external: teamType === TEAM_TYPE.EXTERNAL };
}

function titleFor(ev) {
  if (ev.type === 'game' && ev.home && ev.away) return `${ev.home.name} vs ${ev.away.name}`;
  if (ev.type === 'practice' && ev.home) return `${ev.home.name} practice`;
  return ev.eventName || ev.teams.map((t) => t.name).join(' / ') || 'Event';
}

// "Single A- Machine Pitch - 2nd Grade" -> "Single A – Machine Pitch – 2nd Grade"
function tidy(label) {
  return label.replace(/\s*-\s*LL Softball\s*-\s*Girls\s*$/i, '')
    .replace(/\s*-\s+|\s+-\s*/g, ' – ').replace(/\s+/g, ' ').trim();
}

function firstProgram(raw) {
  return (raw || '').split(/<br\s*\/?>/i).map((s) => s.trim()).find(Boolean) || '';
}

function sportOf(program) {
  return /softball/i.test(program) ? 'Softball' : /baseball/i.test(program) ? 'Baseball' : 'Other';
}

function levelOf(label) {
  const i = LEVELS.findIndex((re) => re.test(label));
  return i === -1 ? LEVELS.length : i;
}

export function slug(s) {
  return s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
