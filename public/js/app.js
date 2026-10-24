import * as F from './filter.js';

const $ = (sel, el = document) => el.querySelector(sel);
const LS = {
  starred: 'sd.starred', lastHash: 'sd.lastHash', showPast: 'sd.showPast',
  changesSeen: 'sd.changesSeen', highlightDays: 'sd.highlightDays', sidebarCollapsed: 'sd.sidebarCollapsed',
};
const RANGE_LABELS = {
  upcoming: 'Upcoming', today: 'Today', next7: 'Next 7 days', week: 'This week',
  month: 'This month', past: 'Past', all: 'All dates', custom: 'Custom…',
};
const TYPE_LABELS = { game: 'Games', practice: 'Practices', other: 'Other' };
const TYPE_BADGE = { game: 'Game', practice: 'Practice', other: 'Event' };
const CHANGE_BADGE = { new: 'New', moved: 'Moved', updated: 'Updated', removed: 'Removed' };
const TYPE_NOUN = { game: 'game', practice: 'practice', other: 'event' };
const VIEWS = ['list', 'week', 'month', 'changes'];

const state = {
  data: null,
  events: [],
  divisions: new Map(), // id -> division (+ hue)
  teams: new Map(), // id -> { id, name, divisionId }
  filters: F.defaultFilters(),
  view: 'list',
  anchor: today(), // date the week/month views are positioned on
  starred: new Set(load(LS.starred, [])),
  expanded: new Set(),
  showPast: load(LS.showPast, false),
  teamQ: '',
  locQ: '',
  changes: [], // recent change log, newest first
  changesByMatch: new Map(), // matchId -> changes, oldest first
  eventsByMatch: new Map(),
  removed: [], // last-known versions of games that dropped off the schedule
  highlightDays: load(LS.highlightDays, 3),
  seenMark: '', // changes newer than this were unseen when the Changes view opened
  inChanges: false,
};

// ---------- utilities ----------

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}
function today() { return F.isoDate(new Date()); }

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

function parseDate(d) { const [y, m, day] = d.split('-').map(Number); return new Date(y, m - 1, day); }
const fmt = (opts) => new Intl.DateTimeFormat(undefined, opts);
const fmtDayLong = fmt({ weekday: 'long', month: 'long', day: 'numeric' });
const fmtDayLongYear = fmt({ weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
/** Long day label, with the year only when it isn't this year. */
const dayLabel = (date) => (date.slice(0, 4) === today().slice(0, 4) ? fmtDayLong : fmtDayLongYear).format(parseDate(date));
const fmtDayShort = fmt({ weekday: 'short', month: 'short', day: 'numeric' });
const fmtMonth = fmt({ month: 'long', year: 'numeric' });
const fmtWeekday = fmt({ weekday: 'short' });

function fmtTime(hhmm, short = false) {
  let [h, m] = hhmm.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  if (short) return `${h}${m ? ':' + String(m).padStart(2, '0') : ''}${ap === 'PM' ? 'p' : 'a'}`;
  return `${h}:${String(m).padStart(2, '0')} ${ap}`;
}
const startTime = (ev) => ev.start.slice(11, 16);
const endTime = (ev) => ev.end.slice(11, 16);

function relativeDay(date) {
  const t = today();
  if (date === t) return 'Today';
  if (date === F.addDays(t, 1)) return 'Tomorrow';
  if (date === F.addDays(t, -1)) return 'Yesterday';
  return '';
}

function timeAgo(iso) {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 24 ? `${hrs} hr ago` : `${Math.round(hrs / 24)} days ago`;
}

// ---------- URL state ----------

function readHash() {
  const raw = location.hash.slice(1) || load(LS.lastHash, '');
  const p = new URLSearchParams(raw);
  state.filters = F.parseFilters(p);
  state.view = VIEWS.includes(p.get('view')) ? p.get('view') : 'list';
  state.anchor = /^\d{4}-\d{2}-\d{2}$/.test(p.get('d') || '') ? p.get('d') : today();
}

function writeHash() {
  const p = F.serializeFilters(state.filters);
  if (state.view !== 'list') p.set('view', state.view);
  if (state.view !== 'list' && state.anchor !== today()) p.set('d', state.anchor);
  const hash = p.toString().replace(/%2C/g, ',');
  history.replaceState(null, '', hash ? `#${hash}` : location.pathname);
  save(LS.lastHash, hash);
}

// ---------- data ----------

async function fetchData(refresh = false) {
  const res = await fetch('/api/schedule' + (refresh ? '?refresh=1' : ''));
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function loadData(refresh = false) {
  applyData(await fetchData(refresh));
}

/**
 * Once per page load: show the cached copy right away (done by the caller),
 * then ask the server to re-check the league site and re-render if it changed.
 */
async function checkForUpdates() {
  const before = state.data.fetchedAt;
  $('#updated').textContent = 'Checking for updates…';
  try {
    const data = await fetchData(true);
    if (data.fetchedAt !== before) {
      applyData(data);
      render();
      return;
    }
  } catch { /* keep showing the cached copy */ }
  renderUpdated();
}

function applyData(data) {
  state.data = data;
  state.events = data.events;
  for (const ev of state.events) ev._hay = F.haystack(ev);
  state.eventsByMatch = new Map(state.events.map((ev) => [ev.matchId, ev]));

  state.changes = data.changes || [];
  state.changesByMatch = new Map();
  const gone = new Map();
  for (const c of [...state.changes].reverse()) {
    if (!state.changesByMatch.has(c.matchId)) state.changesByMatch.set(c.matchId, []);
    state.changesByMatch.get(c.matchId).push(c);
    if (c.event?.id) {
      c.event._hay = F.haystack(c.event);
      gone.set(c.matchId, c.event);
    }
  }
  state.removed = [...gone.values()];

  state.divisions = new Map();
  state.teams = new Map();
  data.divisions.forEach((d, i) => {
    state.divisions.set(d.id, { ...d, hue: Math.round((i * 137.508 + 210) % 360) });
    for (const t of d.teams) state.teams.set(t.id, { ...t, divisionId: d.id });
  });
}

/** The [from, to] window the current view displays. */
function viewWindow() {
  if (state.view === 'week') {
    const s = F.weekStart(state.anchor);
    return [s, F.addDays(s, 6)];
  }
  if (state.view === 'month') {
    const [first, last] = F.monthBounds(state.anchor);
    return [F.weekStart(first), F.addDays(F.weekStart(last), 6)];
  }
  if (state.view === 'changes') return [today(), ''];
  return F.rangeBounds(state.filters, today());
}

function visibleEvents() {
  const [from, to] = viewWindow();
  const inView = (ev) => (!from || ev.date >= from) && (!to || ev.date <= to) && F.matchesNonDate(ev, state.filters);
  let out = state.events.filter(inView);
  if (state.view === 'list') {
    // Recently removed games stay in their old slot, struck through, so you notice.
    const gone = state.removed.filter((ev) => inView(ev) && recentChange(ev)?.kind === 'removed');
    if (gone.length) out = out.concat(gone).sort((a, b) => a.start.localeCompare(b.start));
    if (state.filters.range === 'past') out.reverse();
  }
  return out;
}

function findEvent(id) {
  return state.events.find((x) => x.id === id) || state.changes.find((c) => c.event?.id === id)?.event;
}

// ---------- change tracking ----------

function highlightCutoff() {
  return new Date(Date.now() - state.highlightDays * 86400_000).toISOString();
}

/** What happened to a game within the highlight window: { kind, diffs, at } or null. */
function recentChange(ev) {
  const since = highlightCutoff();
  const list = (state.changesByMatch.get(ev.matchId) || []).filter((c) => c.at >= since);
  return list.length ? { kind: changeKind(list), diffs: collapseDiffs(list), at: list.at(-1).at } : null;
}

/** new | moved (time, date or field) | updated (anything else) | removed */
function changeKind(list) {
  if (list.at(-1).kind === 'removed') return 'removed';
  if (list.some((c) => c.kind === 'added')) return 'new';
  return collapseDiffs(list).some((d) => d.field === 'when' || d.field === 'where') ? 'moved' : 'updated';
}

/** Several changes to one field collapse into a single first-before → latest-after. */
function collapseDiffs(list) {
  const byField = new Map();
  for (const c of list) {
    if (c.kind !== 'changed') continue;
    if (byField.has(c.field)) byField.get(c.field).to = c.to;
    else byField.set(c.field, { field: c.field, from: c.from, to: c.to });
  }
  return [...byField.values()].filter((d) => d.from !== d.to);
}

function whenParts(v) {
  const [s, e] = v.split('/');
  return {
    date: fmtDayShort.format(parseDate(s.slice(0, 10))),
    time: e ? `${fmtTime(s.slice(11, 16))}–${fmtTime(e.slice(11, 16))}` : 'All day',
  };
}

function diffValues(d) {
  if (d.field === 'when' && d.from && d.to) {
    const a = whenParts(d.from);
    const b = whenParts(d.to);
    return a.date === b.date ? [a.time, b.time] : [`${a.date} · ${a.time}`, `${b.date} · ${b.time}`];
  }
  const show = (v) => (d.field === 'type' ? TYPE_BADGE[v] || v : v) || '(none)';
  return [show(d.from), show(d.to)];
}

/** One plain-English line per change, with before → after values. */
function explainDiff(d) {
  const [from, to] = diffValues(d);
  const beforeAfter = `<s>${esc(from)}</s> <span class="arrow" aria-label="changed to">→</span> <b>${esc(to)}</b>`;
  switch (d.field) {
    case 'when':
      return `${d.from?.slice(0, 10) === d.to?.slice(0, 10) ? 'Time changed' : 'Rescheduled'}: ${beforeAfter}`;
    case 'where':
      return `${d.from.split(' · ')[0] === d.to.split(' · ')[0] ? 'Field changed' : 'Moved to a different location'}: ${beforeAfter}`;
    case 'home': return `Home team changed: ${beforeAfter}`;
    case 'away': return `Away team changed: ${beforeAfter}`;
    case 'type': return `Changed from ${esc(from.toLowerCase())} to ${esc(to.toLowerCase())}.`;
    case 'status': return d.to ? `Marked “${esc(d.to)}”.` : `No longer marked “${esc(d.from)}”.`;
    case 'notes':
      if (!d.from) return `Note added: “${esc(d.to)}”`;
      if (!d.to) return `Note removed: <s>${esc(d.from)}</s>`;
      return `Note changed: ${beforeAfter}`;
    default: return `${esc(d.field)} changed: ${beforeAfter}`;
  }
}

/** What happened, in words. `kind` adds a leading sentence for new/removed games. */
function explainChanges(kind, diffs, ev) {
  const lines = [];
  if (kind === 'new') lines.push(`New ${TYPE_NOUN[ev.type]} added to the schedule.`);
  if (kind === 'removed') lines.push('Removed from the schedule. It may have been cancelled.');
  lines.push(...diffs.map(explainDiff));
  return lines.length ? `<div class="ev-changes">${lines.map((l) => `<div class="chg">${l}</div>`).join('')}</div>` : '';
}

const fmtClock = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtMonthDay = fmt({ month: 'short', day: 'numeric' });

/** "today 2:15 PM", "yesterday 9:40 AM", "Thu 11:12 AM", "Oct 3, 11:12 AM" */
function fmtMoment(iso) {
  const d = new Date(iso);
  const day = F.isoDate(d);
  const t = today();
  if (day === t) return `today ${fmtClock(iso)}`;
  if (day === F.addDays(t, -1)) return `yesterday ${fmtClock(iso)}`;
  if (day > F.addDays(t, -7)) return `${fmtWeekday.format(d)} ${fmtClock(iso)}`;
  return `${fmtMonthDay.format(d)}, ${fmtClock(iso)}`;
}

/**
 * Our best estimate of when the league made the edit. SportsConnect publishes
 * no edit times, so it's the window between the last check that still saw the
 * old version and the check that noticed the new one.
 */
function changedWhen(list) {
  const last = list.reduce((a, b) => (b.at > a.at ? b : a));
  if (!last.prevChecked) return `Noticed ${fmtMoment(last.at)}`;
  const from = Date.parse(last.prevChecked);
  const to = Date.parse(last.at);
  if (to - from <= 90 * 60_000) return `Changed around ${fmtMoment(new Date((from + to) / 2).toISOString())}`;
  return `Changed between ${fmtMoment(last.prevChecked)} and ${fmtMoment(last.at)}`;
}

/** Recently changed games, one item each (oldest change first), scoped to the current filters. */
function changeItems() {
  const since = highlightCutoff();
  const t = today();
  const items = new Map();
  for (const c of state.changes) {
    if (c.at < since) break; // newest first
    const ev = state.eventsByMatch.get(c.matchId) || c.event;
    if (!ev?.id) continue;
    if (!items.has(c.matchId)) items.set(c.matchId, { at: c.at, ev, list: [] }); // at = latest change
    items.get(c.matchId).list.unshift(c);
  }
  return [...items.values()].filter(({ ev, list }) => {
    if (!F.matchesNonDate(ev, state.filters)) return false;
    // Changes to games already played are noise, unless the game was moved.
    const movedFrom = list.find((c) => c.field === 'when')?.from?.slice(0, 10);
    return ev.date >= t || (movedFrom && movedFrom >= t);
  }).sort((a, b) => a.ev.start.localeCompare(b.ev.start));
}

/** Facet counts: how many events each option would show, given the other filters. */
function facetCounts() {
  const [from, to] = viewWindow();
  const f = state.filters;
  const inWindow = state.events.filter((ev) => (!from || ev.date >= from) && (!to || ev.date <= to));
  const counts = { type: {}, div: {}, team: {}, loc: {} };
  const bump = (bucket, key) => { if (key) bucket[key] = (bucket[key] || 0) + 1; };
  for (const ev of inWindow) {
    if (F.matchesNonDate(ev, { ...f, types: [] })) bump(counts.type, ev.type);
    if (F.matchesNonDate(ev, { ...f, divs: [], teams: [] })) {
      bump(counts.div, ev.divisionId);
      for (const t of ev.teams) bump(counts.team, t.id);
    }
    if (F.matchesNonDate(ev, { ...f, locs: [] })) bump(counts.loc, ev.locationId);
  }
  return counts;
}

// ---------- rendering: sidebar ----------

function renderSidebar(counts) {
  const f = state.filters;

  // My teams
  const starred = [...state.starred].map((id) => state.teams.get(id)).filter(Boolean);
  const showingMine = starred.length && !f.divs.length
    && f.teams.length === starred.length && starred.every((t) => f.teams.includes(t.id));
  $('#my-teams').innerHTML = starred.length
    ? `<div class="my-teams">${starred.map((t) => {
        const d = state.divisions.get(t.divisionId);
        return `<span class="team-chip" style="--h:${d?.hue ?? 0}">
          <button data-action="only-team" data-id="${t.id}" title="Show only ${esc(t.name)}">${esc(t.name)}<small>${esc(d?.label || '')}</small></button>
          <button class="unstar" data-action="star" data-id="${t.id}" aria-label="Unstar ${esc(t.name)}">×</button>
        </span>`;
      }).join('')}</div>
      <button class="btn ${showingMine ? 'primary' : ''} block" data-action="my-teams">
        ${showingMine ? '★ Showing my teams' : '★ Show only my teams'}</button>`
    : `<p class="hint">Tap the ☆ next to a team below to pin it here. Then one click shows just your teams.</p>`;

  // Types
  $('#type-pills').innerHTML = F.TYPES.map((t) => {
    const on = !f.types.length || f.types.includes(t);
    return `<button class="pill type-${t} ${on ? 'on' : ''}" data-action="type" data-type="${t}" aria-pressed="${on}">
      ${TYPE_LABELS[t]} <span class="n">${counts.type[t] || 0}</span></button>`;
  }).join('');

  // Date range (list view only; week/month have their own navigation)
  $('#range-panel').hidden = state.view !== 'list';
  $('#range-pills').innerHTML = F.RANGES.map((r) =>
    `<button class="pill ${f.range === r ? 'on' : ''}" data-action="range" data-range="${r}" aria-pressed="${f.range === r}">${RANGE_LABELS[r]}</button>`).join('');
  $('#custom-range').hidden = f.range !== 'custom';
  $('#from').value = f.from;
  $('#to').value = f.to;

  renderTree(counts);
  renderLocations(counts);
}

function renderTree(counts) {
  const f = state.filters;
  const q = state.teamQ.trim().toLowerCase();
  const recent = F.addDays(today(), -21);

  const groups = new Map(); // program -> divisions
  for (const d of state.divisions.values()) {
    if (!groups.has(d.program)) groups.set(d.program, []);
    groups.get(d.program).push(d);
  }

  const current = [];
  const past = [];
  for (const [program, divs] of groups) {
    const rows = divs.map((d) => {
      const divMatch = !q || d.label.toLowerCase().includes(q) || program.toLowerCase().includes(q);
      const teams = d.teams.filter((t) => divMatch || t.name.toLowerCase().includes(q));
      if (!divMatch && !teams.length) return '';
      const divOn = f.divs.includes(d.id);
      const open = q || state.expanded.has(d.id) || d.teams.some((t) => f.teams.includes(t.id));
      const teamRows = teams.map((t) => {
        const on = f.teams.includes(t.id);
        const star = state.starred.has(t.id);
        return `<li class="team-row ${divOn ? 'implied' : ''}">
          <label><input type="checkbox" data-kind="team" value="${t.id}" ${on || divOn ? 'checked' : ''} ${divOn ? 'disabled' : ''}>
            <span class="name">${highlight(t.name, q)}</span><span class="n">${counts.team[t.id] || ''}</span></label>
          <button class="star ${star ? 'on' : ''}" data-action="star" data-id="${t.id}" aria-pressed="${star}"
            title="${star ? 'Remove from' : 'Add to'} my teams">${star ? '★' : '☆'}</button>
        </li>`;
      }).join('');
      return `<li class="div-row ${open ? 'open' : ''}" style="--h:${d.hue}">
        <div class="div-line">
          <button class="caret" data-action="expand" data-id="${d.id}" aria-expanded="${!!open}" aria-label="Show teams">${d.teams.length ? '▸' : ''}</button>
          <label><input type="checkbox" data-kind="div" value="${d.id}" ${divOn ? 'checked' : ''}>
            <span class="dot"></span><span class="name">${highlight(d.label, q)}</span>
            <span class="n">${counts.div[d.id] || ''}</span></label>
        </div>
        ${teams.length ? `<ul class="teams">${teamRows}</ul>` : ''}
      </li>`;
    }).join('');
    if (!rows) continue;
    const html = `<div class="program"><h4>${esc(program)}</h4><ul>${rows}</ul></div>`;
    const last = divs.reduce((m, d) => (d.lastDate > m ? d.lastDate : m), '');
    (last >= recent ? current : past).push(html);
  }

  $('#div-tree').innerHTML = (current.join('') || (past.length ? '' : '<p class="hint">No matches.</p>'))
    + (past.length ? `<details class="past" ${state.showPast || q ? 'open' : ''}>
        <summary>Past seasons (${past.length})</summary>${past.join('')}</details>` : '');
}

function highlight(text, q) {
  if (!q) return esc(text);
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return esc(text);
  return esc(text.slice(0, i)) + `<mark>${esc(text.slice(i, i + q.length))}</mark>` + esc(text.slice(i + q.length));
}

function renderLocations(counts) {
  const f = state.filters;
  const q = state.locQ.trim().toLowerCase();
  const locs = state.data.locations
    .filter((l) => !q || l.name.toLowerCase().includes(q))
    // Selected first, then ones that have events in view, then the rest.
    .sort((a, b) => (f.locs.includes(b.id) - f.locs.includes(a.id))
      || (!!counts.loc[b.id] - !!counts.loc[a.id]) || a.name.localeCompare(b.name));
  $('#loc-list').innerHTML = locs.map((l) => `
    <label class="${counts.loc[l.id] ? '' : 'empty'}"><input type="checkbox" data-kind="loc" value="${l.id}" ${f.locs.includes(l.id) ? 'checked' : ''}>
      <span class="name">${highlight(l.name, q)}</span><span class="n">${counts.loc[l.id] || ''}</span></label>`).join('')
    || '<p class="hint">No matches.</p>';
  $('#loc-selected').textContent = f.locs.length ? `(${f.locs.length})` : '';
  if (f.locs.length) $('#loc-details').open = true;
}

// ---------- rendering: main ----------

/** Active filters are shown in the sidebar; this just keeps the counts and Clear link current. */
function renderFilterCount() {
  const f = state.filters;
  const active = (f.q ? 1 : 0) + (f.types.length ? 1 : 0) + f.divs.length + f.teams.length + f.locs.length;
  $('#filter-count').textContent = active || '';
  $('#sidebar-filter-count').textContent = active || '';
  $('#sidebar-clear').hidden = !active;
}

/** Desktop sidebar: collapsed only by the toggle button, and remembered. */
function setSidebarCollapsed(collapsed) {
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  const toggle = $('.sidebar-toggle');
  toggle.setAttribute('aria-expanded', String(!collapsed));
  toggle.title = collapsed ? 'Show filters' : 'Hide filters';
  save(LS.sidebarCollapsed, collapsed);
}

function renderMain() {
  const events = visibleEvents();
  const isCal = state.view === 'week' || state.view === 'month';
  $('#cal-nav').hidden = !isCal;
  if (state.view === 'week') {
    const s = F.weekStart(state.anchor);
    const e = F.addDays(s, 6);
    $('#cal-title').textContent = `${fmtDayShort.format(parseDate(s))} – ${fmtDayShort.format(parseDate(e))}`;
  } else if (state.view === 'month') {
    $('#cal-title').textContent = fmtMonth.format(parseDate(state.anchor));
  }

  const content = $('#content');
  content.className = `content view-${state.view}`;
  if (state.view === 'changes') {
    const items = changeItems();
    $('#result-count').textContent = `${items.length} change${items.length === 1 ? '' : 's'}`;
    content.innerHTML = renderChanges(items);
    return;
  }

  const live = events.filter((e) => !e.removed);
  const games = live.filter((e) => e.type === 'game').length;
  $('#result-count').textContent = `${live.length} event${live.length === 1 ? '' : 's'}`
    + (live.length ? ` · ${games} game${games === 1 ? '' : 's'}` : '');

  if (state.view === 'list') content.innerHTML = events.length ? renderAgenda(events) : emptyState();
  else if (state.view === 'week') content.innerHTML = renderWeek(events);
  else content.innerHTML = renderMonth(events);
}

function emptyState() {
  const f = state.filters;
  const hasFilters = f.q || f.types.length || f.divs.length || f.teams.length || f.locs.length;
  return `<div class="empty-state">
    <div class="big">⚾</div>
    <p>Nothing on the schedule${state.view === 'list' && f.range !== 'all' ? ` for “${RANGE_LABELS[f.range].replace('…', '')}”` : ''}${hasFilters ? ' with these filters' : ''}.</p>
    <div class="row">
      ${hasFilters ? '<button class="btn primary" data-action="clear">Clear filters</button>' : ''}
      ${state.view === 'list' && f.range !== 'all' ? '<button class="btn" data-action="range" data-range="all">Show all dates</button>' : ''}
    </div>
  </div>`;
}

function groupByDate(events) {
  const groups = new Map();
  for (const ev of events) {
    if (!groups.has(ev.date)) groups.set(ev.date, []);
    groups.get(ev.date).push(ev);
  }
  return groups;
}

function renderAgenda(events) {
  const t = today();
  return [...groupByDate(events)].map(([date, evs]) => {
    const rel = relativeDay(date);
    return `<section class="day ${date === t ? 'is-today' : ''} ${date < t ? 'is-past' : ''}" data-date="${date}">
      <h3 class="day-head"><span>${dayLabel(date)}</span>
        ${rel ? `<span class="rel">${rel}</span>` : ''}<span class="n">${evs.filter((e) => !e.removed).length}</span></h3>
      <div class="day-events">${evs.map(renderRow).join('')}</div>
    </section>`;
  }).join('');
}

function teamName(team) {
  if (!team) return '';
  const star = team.id && state.starred.has(team.id);
  const cls = `team ${star ? 'mine' : ''} ${team.external ? 'ext' : ''}`;
  return `<span class="${cls}">${star ? '★ ' : ''}${esc(team.name)}</span>`;
}

function rowTitle(ev) {
  if (ev.type === 'game' && ev.home && ev.away) {
    return `${teamName(ev.home)} <span class="vs">vs</span> ${teamName(ev.away)}`;
  }
  if (ev.type === 'practice' && ev.home) return `${teamName(ev.home)} <span class="vs">practice</span>`;
  return esc(ev.title);
}

function isNow(ev) {
  const now = new Date();
  const stamp = `${F.isoDate(now)}T${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return ev.start <= stamp && stamp < ev.end;
}

function renderRow(ev) {
  const d = state.divisions.get(ev.divisionId);
  const rc = recentChange(ev);
  const time = ev.allDay ? '<b>All day</b>' : `<b>${fmtTime(startTime(ev))}</b><span>${fmtTime(endTime(ev))}</span>`;
  return `<article class="ev type-${ev.type} ${isNow(ev) ? 'now' : ''} ${rc ? `chg-${rc.kind}` : ''}" style="--h:${d?.hue ?? 0}" data-action="open" data-id="${ev.id}" tabindex="0">
    <div class="ev-time">${time}</div>
    <div class="ev-body">
      <div class="ev-title">
        <span class="badge">${ev.postseason ? 'Playoff' : TYPE_BADGE[ev.type]}</span>
        ${rc ? changeBadge(rc.kind) : ''}
        ${ev.status ? `<span class="badge warn">${esc(ev.status)}</span>` : ''}
        ${isNow(ev) ? '<span class="badge live">Now</span>' : ''}
        <span class="matchup">${rowTitle(ev)}</span>
        ${ev.score ? `<span class="score">${ev.score.home}–${ev.score.away}</span>` : ''}
      </div>
      <div class="ev-meta">
        ${d ? `<span class="div"><span class="dot"></span>${esc(d.label)}</span>` : ''}
        <span class="where">${esc(ev.location)}${ev.field ? ` <span class="field">· ${esc(ev.field)}</span>` : ''}</span>
      </div>
      ${ev.notes ? `<div class="ev-notes">${esc(ev.notes)}</div>` : ''}
      ${rc ? explainChanges(null, rc.diffs, ev) : ''}
    </div>
    ${ev.mapUrl ? `<a class="map" href="${esc(ev.mapUrl)}" target="_blank" rel="noopener" title="Map: ${esc(ev.location)}" aria-label="Map">
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2a5.5 5.5 0 0 0-5.5 5.5c0 4.1 5.5 10.5 5.5 10.5s5.5-6.4 5.5-10.5A5.5 5.5 0 0 0 10 2Zm0 7.75a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5Z"/></svg></a>` : ''}
  </article>`;
}

function changeBadge(kind) {
  return `<span class="badge chg ${kind}">${CHANGE_BADGE[kind]}</span>`;
}

function renderChanges(items) {
  const days = state.highlightDays;
  const windowLabel = days === 1 ? '24 hours' : `${days} days`;
  const since = state.data.trackingSince;
  const f = state.filters;
  const scoped = f.q || f.types.length || f.divs.length || f.teams.length || f.locs.length;
  const head = `<div class="changes-head">
      <div><h2>What's changed</h2>
        <p class="muted">Games that were added, moved or removed${scoped ? ', matching your filters' : ''}, by game date.</p></div>
      <label class="window">Last
        <select id="highlight-days">${[1, 3, 7, 14, 30].map((d) =>
          `<option value="${d}" ${d === days ? 'selected' : ''}>${d === 1 ? '24 hours' : `${d} days`}</option>`).join('')}</select>
      </label>
    </div>`;
  const foot = `<p class="hint changes-foot">The league site is checked each time this page is opened.
    ${since ? `Tracking changes since ${fmtDayShort.format(new Date(since))}.` : ''}</p>`;

  if (!items.length) {
    const young = since && Date.now() - Date.parse(since) < days * 86400_000;
    return `${head}<div class="empty-state"><div class="big">✅</div>
      <p>${young ? `Change tracking started ${timeAgo(since)}. Changes will appear here when the league updates the schedule.`
        : `No schedule changes in the last ${windowLabel}${scoped ? ' for these filters' : ''}.`}</p></div>${foot}`;
  }

  const t = today();
  return head + [...groupByDate(items.map((it) => ({ ...it, date: it.ev.date })))].map(([day, list]) => {
    const rel = relativeDay(day);
    return `<section class="day ${day === t ? 'is-today' : ''}">
      <h3 class="day-head"><span>${dayLabel(day)}</span>${rel ? `<span class="rel">${rel}</span>` : ''}<span class="n">${list.length}</span></h3>
      <div class="day-events">${list.map(renderChangeItem).join('')}</div>
    </section>`;
  }).join('') + foot;
}

function renderChangeItem({ ev, list, at }) {
  const d = state.divisions.get(ev.divisionId);
  const kind = changeKind(list);
  const unseen = at > state.seenMark;
  const time = ev.allDay ? '<b>All day</b>' : `<b>${fmtTime(startTime(ev))}</b><span>${fmtTime(endTime(ev))}</span>`;
  return `<article class="ev chg-item chg-${kind} type-${ev.type} ${unseen ? 'unseen' : ''}" style="--h:${d?.hue ?? 0}" data-action="open" data-id="${ev.id}" tabindex="0">
    <div class="ev-time">${time}</div>
    <div class="ev-body">
      <div class="ev-title">${changeBadge(kind)}<span class="matchup">${rowTitle(ev)}</span></div>
      <div class="ev-meta">
        ${d ? `<span class="div"><span class="dot"></span>${esc(d.label)}</span>` : ''}
        <span class="where">${esc(ev.location)}${ev.field ? ` <span class="field">· ${esc(ev.field)}</span>` : ''}</span>
      </div>
      ${explainChanges(kind, collapseDiffs(list), ev)}
      <div class="chg-when">${unseen ? '<span class="new-dot" title="New since your last visit"></span>' : ''}${changedWhen(list)}</div>
    </div>
  </article>`;
}

/** "AA – Minors" -> "AA". Softball shares level names with baseball, so it gets a tag. */
function ageGroup(d) {
  if (!d) return '';
  const short = d.label.split(' – ')[0];
  return d.sport === 'Softball' ? `${short} SB` : short;
}

function compactTitle(ev) {
  if (ev.type === 'game' && ev.home && ev.away) return `${ev.home.name} v ${ev.away.name}`;
  if (ev.type === 'practice' && ev.home) return `${ev.home.name} (prac)`;
  return ev.title;
}

function renderWeek(events) {
  const s = F.weekStart(state.anchor);
  const byDate = groupByDate(events);
  const t = today();
  let html = '<div class="week">';
  for (let i = 0; i < 7; i++) {
    const date = F.addDays(s, i);
    const evs = byDate.get(date) || [];
    html += `<section class="wday ${date === t ? 'is-today' : ''} ${date < t ? 'is-past' : ''}">
      <h3><span class="dow">${fmtWeekday.format(parseDate(date))}</span> <span class="num">${parseDate(date).getDate()}</span>
        ${evs.length ? `<span class="n">${evs.length}</span>` : ''}</h3>
      <div class="wday-events">${evs.map((ev) => {
        const d = state.divisions.get(ev.divisionId);
        return `<button class="wev type-${ev.type} ${recentChange(ev) ? 'changed' : ''}" style="--h:${d?.hue ?? 0}" data-action="open" data-id="${ev.id}">
          <span class="wtop">
            <span class="t">${ev.allDay ? 'All day' : `${fmtTime(startTime(ev), true)}–${fmtTime(endTime(ev), true)}`}${ev.status ? ' <b class="warn">!</b>' : ''}</span>
            ${d ? `<span class="age" title="${esc(d.label)} (${esc(d.sport)})">${esc(ageGroup(d))}</span>` : ''}
          </span>
          <span class="title">${esc(compactTitle(ev))}</span>
          <span class="loc">${esc(ev.location)}${ev.field ? ` · ${esc(ev.field)}` : ''}</span>
        </button>`;
      }).join('') || '<p class="none">—</p>'}</div>
    </section>`;
  }
  return html + '</div>';
}

function renderMonth(events) {
  const [first, last] = F.monthBounds(state.anchor);
  const start = F.weekStart(first);
  const byDate = groupByDate(events);
  const t = today();
  const MAX = 3;
  let html = '<div class="month"><div class="mhead">';
  for (let i = 0; i < 7; i++) html += `<div>${fmtWeekday.format(parseDate(F.addDays(start, i)))}</div>`;
  html += '</div><div class="mgrid">';
  for (let date = start; date <= last || F.weekStart(date) === F.weekStart(last); date = F.addDays(date, 1)) {
    if (date > last && parseDate(date).getDay() === 0) break;
    const evs = byDate.get(date) || [];
    const out = date < first || date > last;
    const games = evs.filter((e) => e.type === 'game').length;
    html += `<div class="mday ${out ? 'out' : ''} ${date === t ? 'is-today' : ''} ${date < t ? 'is-past' : ''} ${evs.length ? 'has' : ''}"
        ${evs.length ? `data-action="day" data-date="${date}" role="button" tabindex="0"` : ''}
        aria-label="${fmtDayLong.format(parseDate(date))}: ${evs.length} events">
      <div class="mnum"><span>${parseDate(date).getDate()}</span>${evs.length ? `<span class="n" title="${games} games, ${evs.length - games} other">${evs.length}</span>` : ''}</div>
      ${evs.slice(0, MAX).map((ev) => {
        const d = state.divisions.get(ev.divisionId);
        return `<div class="mev type-${ev.type} ${recentChange(ev) ? 'changed' : ''}" style="--h:${d?.hue ?? 0}">
          <span class="t">${ev.allDay ? '' : fmtTime(startTime(ev), true)}</span> ${esc(compactTitle(ev))}</div>`;
      }).join('')}
      ${evs.length > MAX ? `<div class="more">+${evs.length - MAX} more</div>` : ''}
    </div>`;
  }
  return html + '</div></div>';
}

function render() {
  if (!state.data) return;
  const counts = facetCounts();
  document.querySelectorAll('.views button').forEach((b) => {
    b.setAttribute('aria-selected', b.dataset.view === state.view);
  });
  $('#q').value !== state.filters.q && ($('#q').value = state.filters.q);
  markChangesSeen();
  renderSidebar(counts);
  renderFilterCount();
  renderMain();
  renderUpdated();
  syncBarHeights(); // the toolbar's height depends on the view
  writeHash();
}

/**
 * Opening the Changes view marks everything as seen, but keeps the old mark
 * for this visit so the items that were new stay highlighted while you read.
 */
function markChangesSeen() {
  if (state.view === 'changes') {
    if (!state.inChanges) state.seenMark = load(LS.changesSeen, '');
    state.inChanges = true;
    save(LS.changesSeen, state.changes[0]?.at || new Date().toISOString());
  } else {
    state.inChanges = false;
  }
  const seen = load(LS.changesSeen, '');
  const unseen = state.view === 'changes' ? 0 : changeItems().filter((it) => it.at > seen).length;
  $('#changes-count').textContent = unseen || '';
}

function renderUpdated() {
  const d = state.data;
  $('#updated').textContent = `Updated ${timeAgo(d.fetchedAt)}`;
  $('#updated').title = new Date(d.fetchedAt).toLocaleString();
  const banner = $('#banner');
  if (d.stale && d.error) {
    banner.hidden = false;
    banner.textContent = `Couldn't reach the league site (${d.error}). Showing data from ${timeAgo(d.fetchedAt)}.`;
  } else {
    banner.hidden = true;
  }
}

// ---------- dialogs ----------

const dialog = $('#dialog');

function openDialog(html) {
  $('#dialog-body').innerHTML = html;
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
}

function gcalLink(ev) {
  const fmtD = (s) => s.replace(/[-:]/g, '') + (s.length > 10 ? '00' : '');
  const dates = ev.allDay
    ? `${ev.date.replace(/-/g, '')}/${F.addDays(ev.date, 1).replace(/-/g, '')}`
    : `${fmtD(ev.start)}/${fmtD(ev.end)}`;
  const p = new URLSearchParams({
    action: 'TEMPLATE', text: ev.title, dates, ctz: state.data.timeZone,
    location: [ev.location, ev.field].filter(Boolean).join(' – '),
    details: [ev.division, ev.eventName, ev.notes].filter(Boolean).join('\n'),
  });
  return `https://calendar.google.com/calendar/render?${p}`;
}

function eventDetail(ev) {
  const d = state.divisions.get(ev.divisionId);
  const when = ev.allDay ? 'All day' : `${fmtTime(startTime(ev))} – ${fmtTime(endTime(ev))}`;
  const teamBlock = (team, role) => {
    if (!team) return '';
    const star = team.id && state.starred.has(team.id);
    return `<div class="dteam">
      <div><span class="role">${role}</span><strong>${esc(team.name)}</strong>${team.external ? ' <span class="muted">(other league)</span>' : ''}</div>
      ${team.id ? `<div class="row">
        <button class="btn small" data-action="only-team" data-id="${team.id}">Show this team's schedule</button>
        <button class="btn small star ${star ? 'on' : ''}" data-action="star" data-id="${team.id}" data-from="${ev.id}">${star ? '★ My team' : '☆ Add to my teams'}</button>
      </div>` : ''}
    </div>`;
  };
  const ics = `/calendar.ics?id=${encodeURIComponent(ev.id)}&download=1&name=${encodeURIComponent(ev.title)}`;
  const rc = recentChange(ev);
  return `<div class="detail" style="--h:${d?.hue ?? 0}">
    <div class="dialog-top">
      <span></span>
      <button class="btn icon ghost" data-action="close-dialog" aria-label="Close">×</button>
    </div>
    <div class="badges">
      <span class="badge type-${ev.type}">${ev.postseason ? 'Playoff' : TYPE_BADGE[ev.type]}</span>
      ${rc ? changeBadge(rc.kind) : ''}
      ${ev.status ? `<span class="badge warn">${esc(ev.status)}</span>` : ''}
    </div>
    <h2>${esc(ev.title)}</h2>
    <dl>
      <dt>When</dt><dd>${fmtDayLong.format(parseDate(ev.date))}<br>${when}</dd>
      <dt>Where</dt><dd>${esc(ev.location)}${ev.field ? `<br><span class="muted">${esc(ev.field)}</span>` : ''}
        ${ev.address ? `<br><span class="muted">${esc(ev.address)}</span>` : ''}
        ${ev.mapUrl ? `<br><a href="${esc(ev.mapUrl)}" target="_blank" rel="noopener">Open in Maps ↗</a>` : ''}</dd>
      ${d ? `<dt>Division</dt><dd><span class="dot"></span>${esc(d.label)}<br><span class="muted">${esc(d.program)}</span></dd>` : ''}
      ${ev.eventName ? `<dt>Schedule</dt><dd>${esc(ev.eventName)}</dd>` : ''}
      ${ev.notes ? `<dt>Notes</dt><dd class="notes">${esc(ev.notes)}</dd>` : ''}
      ${ev.score ? `<dt>Score</dt><dd>${ev.score.home} – ${ev.score.away}</dd>` : ''}
    </dl>
    ${ev.type === 'game' ? teamBlock(ev.home, 'Home') + teamBlock(ev.away, 'Away') : ev.teams.map((t) => teamBlock(t, 'Team')).join('')}
    ${historyHtml(ev)}
    ${ev.removed ? '' : `<div class="row actions">
      <a class="btn" href="${ics}">Add to calendar (.ics)</a>
      <a class="btn" href="${gcalLink(ev)}" target="_blank" rel="noopener">Google Calendar ↗</a>
    </div>`}
  </div>`;
}

/** Month view → List view, scrolled so `date` is at the top. */
function goToDay(date) {
  state.view = 'list';
  const [from, to] = F.rangeBounds(state.filters, today());
  if ((from && date < from) || (to && date > to)) state.filters.range = 'all';
  render();
  document.querySelector(`.day[data-date="${date}"]`)?.scrollIntoView({ block: 'start' });
  settleUntil = performance.now() + 300; // our own jump: don't tuck the search row for it
}

function historyHtml(ev) {
  const byTime = new Map();
  for (const c of state.changesByMatch.get(ev.matchId) || []) {
    if (!byTime.has(c.at)) byTime.set(c.at, []);
    byTime.get(c.at).push(c);
  }
  const entries = [...byTime].reverse().map(([, list]) => {
    const event = list.find((c) => c.kind !== 'changed')?.kind;
    const kind = event === 'added' ? 'new' : event === 'removed' ? 'removed' : null;
    return `<li><time>${changedWhen(list)}</time>
      ${event === 'restored' ? '<div>Back on the schedule.</div>' : ''}${explainChanges(kind, collapseDiffs(list), ev)}</li>`;
  });
  const since = state.data.trackingSince;
  const origin = ev.firstSeen
    ? `First seen ${fmtDayShort.format(new Date(ev.firstSeen))}.`
    : since ? `On the schedule since before tracking began (${fmtDayShort.format(new Date(since))}).` : '';
  if (!entries.length && !origin) return '';
  return `<section class="history"><h3>History</h3>
    ${ev.removed ? '<p class="notes">No longer on the league schedule. It may have been cancelled.</p>' : ''}
    ${entries.length ? `<ul>${entries.join('')}</ul>` : '<p class="muted">No changes in the last 30 days.</p>'}
    <p class="muted small">${origin}</p></section>`;
}

function exportDialog() {
  const p = F.serializeFilters(state.filters);
  const name = describeFilters();
  const feed = new URLSearchParams(p);
  feed.delete('range'); feed.delete('from'); feed.delete('to');
  if (name) feed.set('name', name);
  const dl = new URLSearchParams(state.view === 'list' ? p : feed);
  if (state.view !== 'list') {
    const [from, to] = viewWindow();
    dl.set('range', 'custom'); dl.set('from', from); dl.set('to', to);
  } else if (!dl.has('range')) dl.set('range', 'upcoming');
  dl.set('download', '1');
  if (name) dl.set('name', name);
  const feedUrl = `${location.origin}/calendar.ics?${feed}`;
  const count = visibleEvents().length;
  const isLocal = /^(localhost|127\.|\[::1\])/.test(location.hostname);

  return `<div class="dialog-top"><h2>Export</h2>
      <button class="btn icon ghost" data-action="close-dialog" aria-label="Close">×</button></div>
    <div class="export">
      <section>
        <h3>Download</h3>
        <p>Get the <b>${count} event${count === 1 ? '' : 's'}</b> you're looking at as a calendar file you can import into Google, Apple or Outlook calendars.</p>
        <a class="btn primary" href="/calendar.ics?${dl}">Download .ics</a>
      </section>
      <section>
        <h3>Subscribe</h3>
        <p>A live feed for these filters (all upcoming dates). Your calendar app re-checks it, so schedule changes show up automatically.</p>
        <div class="copy"><input readonly value="${esc(feedUrl)}" id="feed-url"><button class="btn" data-action="copy-feed">Copy</button></div>
        ${isLocal ? `<p class="hint">Heads up: this app is running on <code>${esc(location.host)}</code>, which Google/Apple calendar servers can't reach. Subscribing works once you host it somewhere public (see README). Downloading works fine.</p>` : ''}
      </section>
      <section>
        <h3>Print</h3>
        <p>A clean list for the fridge.</p>
        <button class="btn" data-action="print">Print this list</button>
      </section>
      <section>
        <h3>Share</h3>
        <p>This page's address includes your filters, so you can bookmark it or send it to another parent.</p>
        <button class="btn" data-action="copy-link">Copy link to this view</button>
      </section>
    </div>`;
}

function describeFilters() {
  const f = state.filters;
  const parts = [
    ...f.teams.map((id) => state.teams.get(id)?.name),
    ...f.divs.map((id) => state.divisions.get(id)?.label),
  ].filter(Boolean);
  const types = f.types.length ? f.types.map((t) => TYPE_LABELS[t]).join(' & ') : '';
  const league = state.data.leagueName || 'League';
  return [league, parts.slice(0, 3).join(', ') + (parts.length > 3 ? ` +${parts.length - 3}` : ''), types].filter(Boolean).join(' – ');
}

// ---------- events ----------

function update(fn) {
  fn(state.filters);
  render();
}

function toggle(list, value) {
  const i = list.indexOf(value);
  if (i >= 0) list.splice(i, 1); else list.push(value);
}

function shiftAnchor(dir) {
  if (state.view === 'week') state.anchor = F.addDays(state.anchor, 7 * dir);
  else {
    const d = parseDate(state.anchor);
    state.anchor = F.isoDate(new Date(d.getFullYear(), d.getMonth() + dir, 1));
  }
  render();
}

async function copy(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const old = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = old; }, 1500);
  } catch {
    prompt('Copy this:', text);
  }
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  if (el.tagName === 'A' && el.dataset.action !== 'open') return;
  if (e.target.closest('a.map')) return; // let map links through
  const { action, id } = el.dataset;

  switch (action) {
    case 'open': {
      const ev = findEvent(id);
      if (ev) openDialog(eventDetail(ev));
      break;
    }
    case 'day': goToDay(el.dataset.date); break;
    case 'close-dialog': dialog.close(); break;
    case 'type': update((f) => {
      const t = el.dataset.type;
      // First click isolates a type; later clicks toggle; all-on resets to "no filter".
      if (!f.types.length) f.types = [t];
      else toggle(f.types, t);
      if (f.types.length === F.TYPES.length) f.types = [];
    }); break;
    case 'range': update((f) => {
      f.range = el.dataset.range;
      if (f.range === 'custom' && !f.from) { f.from = today(); f.to = F.addDays(today(), 13); }
    }); break;
    case 'expand':
      if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
      render();
      break;
    case 'star':
      if (state.starred.has(id)) state.starred.delete(id); else state.starred.add(id);
      save(LS.starred, [...state.starred]);
      render();
      if (el.dataset.from && dialog.open) {
        const ev = findEvent(el.dataset.from);
        if (ev) openDialog(eventDetail(ev));
      }
      break;
    case 'my-teams': update((f) => {
      const mine = [...state.starred].filter((t) => state.teams.has(t));
      const showing = !f.divs.length && f.teams.length === mine.length && mine.every((t) => f.teams.includes(t));
      f.teams = showing ? [] : mine;
      f.divs = [];
    }); break;
    case 'only-team':
      if (dialog.open) dialog.close();
      update((f) => { f.teams = [id]; f.divs = []; f.q = ''; });
      break;
    case 'clear': {
      const range = state.filters.range;
      state.filters = F.defaultFilters();
      state.filters.range = range === 'custom' ? 'upcoming' : range;
      render();
      break;
    }
    case 'prev': shiftAnchor(-1); break;
    case 'next': shiftAnchor(1); break;
    case 'today': state.anchor = today(); render(); break;
    case 'toggle-sidebar':
      setSidebarCollapsed(!document.body.classList.contains('sidebar-collapsed'));
      syncBarHeights(); // the toolbar is wider now, so it may wrap differently
      break;
    case 'open-filters': document.body.classList.add('filters-open'); break;
    case 'close-filters': document.body.classList.remove('filters-open'); break;
    case 'export': openDialog(exportDialog()); break;
    case 'copy-feed': copy($('#feed-url').value, el); break;
    case 'copy-link': copy(location.href, el); break;
    case 'print': dialog.close(); setTimeout(() => window.print(), 50); break;
    case 'refresh':
      el.disabled = true;
      el.textContent = 'Refreshing…';
      loadData(true).then(render).catch((err) => alert(`Refresh failed: ${err.message}`))
        .finally(() => { el.disabled = false; el.textContent = 'Refresh now'; });
      break;
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('[data-action="open"], [data-action="day"]')) e.target.click();
  if (e.key === '/' && !e.target.matches('input, textarea')) { e.preventDefault(); $('#q').focus(); }
  if (state.view !== 'list' && !e.target.matches('input, textarea') && !dialog.open) {
    if (e.key === 'ArrowLeft') shiftAnchor(-1);
    if (e.key === 'ArrowRight') shiftAnchor(1);
  }
});

document.addEventListener('change', (e) => {
  const { kind } = e.target.dataset;
  if (kind) update((f) => toggle(f[{ div: 'divs', team: 'teams', loc: 'locs' }[kind]], e.target.value));
  if (e.target.id === 'from' || e.target.id === 'to') update((f) => { f[e.target.id] = e.target.value; });
  if (e.target.id === 'highlight-days') {
    state.highlightDays = Number(e.target.value);
    save(LS.highlightDays, state.highlightDays);
    render();
  }
});

let qTimer;
$('#q').addEventListener('input', (e) => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => update((f) => { f.q = e.target.value.trim(); }), 150);
});
$('#team-q').addEventListener('input', (e) => { state.teamQ = e.target.value; renderTree(facetCounts()); });
$('#loc-q').addEventListener('input', (e) => { state.locQ = e.target.value; renderLocations(facetCounts()); });
$('#div-tree').addEventListener('toggle', (e) => {
  if (e.target.matches('details.past')) { state.showPast = e.target.open; save(LS.showPast, state.showPast); }
}, true);

document.querySelectorAll('.views button').forEach((b) => b.addEventListener('click', () => {
  state.view = b.dataset.view;
  render();
  $('#content').scrollTop = 0;
}));

// Sticky day headers sit under the top bar and toolbar, whose heights vary
// (the top bar wraps onto two rows on phones), so measure them.
function syncBarHeights() {
  const root = document.documentElement.style;
  root.setProperty('--toolbar-h', `${$('.toolbar').offsetHeight}px`);
  root.setProperty('--topbar-h', `${$('.topbar').offsetHeight}px`);
}
const barObserver = new ResizeObserver(syncBarHeights);
barObserver.observe($('.topbar'));
barObserver.observe($('.toolbar'));

// On phones the search row tucks away while scrolling down and comes back on
// scroll up (CSS only applies it at phone widths). It stays put near the top,
// while focused, or while a search is active, since it's the only place that
// shows the query.
let lastScrollY = scrollY;
let settleUntil = 0;
addEventListener('scroll', () => {
  const y = scrollY;
  // Collapsing the row shifts the page and the browser adjusts scrollY to
  // compensate; don't mistake that for the user scrolling back up.
  if (performance.now() < settleUntil) { lastScrollY = y; return; }
  const dy = y - lastScrollY;
  if (Math.abs(dy) < 8) return;
  lastScrollY = y;
  const q = $('#q');
  const tuck = dy > 0 && y > 80 && document.activeElement !== q && !q.value;
  if (tuck !== document.body.classList.contains('search-tucked')) {
    document.body.classList.toggle('search-tucked', tuck);
    settleUntil = performance.now() + 300;
  }
}, { passive: true });

dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); }); // backdrop
window.addEventListener('hashchange', () => { readHash(); render(); });

setInterval(() => state.data && renderUpdated(), 60_000);

// ---------- boot ----------

setSidebarCollapsed(load(LS.sidebarCollapsed, false));
readHash();
loadData()
  .then(() => {
    const d = state.data;
    $('#league-name').textContent = d.leagueName || new URL(d.site).hostname;
    document.title = `${d.leagueName || 'League'} schedule · Sports Disconnect`;
    $('#source-link').href = d.calendarUrl || d.site;
    // Drop starred/filtered team ids that no longer exist.
    for (const id of state.starred) if (!state.teams.has(id)) state.starred.delete(id);
    render();
    checkForUpdates();
  })
  .catch((err) => {
    $('#content').innerHTML = `<div class="empty-state"><div class="big">🌧️</div>
      <p>Couldn't load the schedule.</p><p class="muted">${esc(err.message)}</p>
      <button class="btn primary" onclick="location.reload()">Try again</button></div>`;
  });
