// Minimal iCalendar (RFC 5545) writer for normalized events.

// Standard-time UTC offsets for US zones that follow the usual DST rules, so we
// can emit a VTIMEZONE block (Outlook wants one; Google/Apple don't care).
const US_ZONES = { 'America/New_York': -5, 'America/Chicago': -6, 'America/Denver': -7, 'America/Los_Angeles': -8 };

export function toIcs(events, { timeZone, calName = 'Schedule', site = '' } = {}) {
  const now = stamp(new Date());
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//sports-disconnect//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(calName)}`,
    `X-WR-TIMEZONE:${timeZone}`,
    ...vtimezone(timeZone),
  ];

  for (const ev of events) {
    const desc = [
      ev.division && `Division: ${ev.division}`,
      ev.eventName && `Schedule: ${ev.eventName}`,
      ev.status && `Status: ${ev.status}`,
      ev.notes && `Notes: ${ev.notes}`,
      ev.mapUrl && `Map: ${ev.mapUrl}`,
    ].filter(Boolean).join('\n');

    lines.push('BEGIN:VEVENT', `UID:sc-${ev.matchId}-${ev.date}@sports-disconnect`, `DTSTAMP:${now}`);
    if (ev.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${ev.date.replace(/-/g, '')}`);
    } else {
      lines.push(`DTSTART;TZID=${timeZone}:${local(ev.start)}`, `DTEND;TZID=${timeZone}:${local(ev.end)}`);
    }
    lines.push(
      `SUMMARY:${esc((ev.status ? `[${ev.status}] ` : '') + ev.title)}`,
      `LOCATION:${esc([ev.location, ev.field].filter(Boolean).join(' – '))}`,
      `DESCRIPTION:${esc(desc)}`,
      `CATEGORIES:${esc(ev.type)}`,
    );
    if (site) lines.push(`URL:${site}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

function vtimezone(tz) {
  const std = US_ZONES[tz];
  if (std === undefined) return [];
  const off = (h) => `${h < 0 ? '-' : '+'}${String(Math.abs(h)).padStart(2, '0')}00`;
  return [
    'BEGIN:VTIMEZONE', `TZID:${tz}`,
    'BEGIN:DAYLIGHT', `TZOFFSETFROM:${off(std)}`, `TZOFFSETTO:${off(std + 1)}`,
    'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
    'BEGIN:STANDARD', `TZOFFSETFROM:${off(std + 1)}`, `TZOFFSETTO:${off(std)}`,
    'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD',
    'END:VTIMEZONE',
  ];
}

const local = (s) => s.replace(/[-:]/g, '') + '00'; // 2026-10-01T17:00 -> 20261001T170000
const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

// Fold lines longer than 75 octets, per RFC 5545 §3.1.
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function fold(line) {
  const bytes = encoder.encode(line);
  if (bytes.length <= 75) return line;
  const parts = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + (parts.length ? 74 : 75), bytes.length);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--; // don't split a UTF-8 char
    parts.push(decoder.decode(bytes.subarray(start, end)));
    start = end;
  }
  return parts.join('\r\n ');
}
