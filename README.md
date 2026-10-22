# Sports Disconnect

A calendar for a SportsConnect league site that you can actually use. It pulls the
league's public schedule and shows it as a fast, filterable list, week or month view.

Defaults to [Fairfax Little League](https://www.fairfaxll.org/Default.aspx?tabid=953435#/gameScheduleCalendar).
No login and no dependencies; you only need Node 20 or newer.

```bash
npm start
```

Then open http://localhost:3000.

## What it does

- **List, Week and Month views.** List is grouped by day, with Today/Tomorrow labels and a "Now" badge on anything in progress.
- **Filters:** games, practices or other events; divisions and teams (union: "my kid's team + my other kid's whole division"); locations; date ranges; free-text search (`/` focuses it).
- **My teams.** Star a team (☆) and it's pinned. One click then shows only your teams. Stars are saved in your browser.
- **Every view is a URL.** Filters live in the address bar, so you can bookmark a view or text it to another parent.
- **Event details:** map link, field, notes ("Moved from Rutherford 2…"), reschedule flags, plus one-click *Add to calendar* or *Google Calendar*.
- **Export:** download an `.ics` file of what's on screen, or subscribe to a live feed for your filters. You can also print a clean list.
- Works on phones (the filters move into a drawer, and the view tabs sit at the bottom), and supports dark mode.

## Change tracking

SportsConnect doesn't say when a game changes, so the app keeps its own record.
Every refresh is compared, game by game, with the last version it saw (match IDs
stay the same when a game is rescheduled):

- **New**, **Updated** and **Removed** badges appear on recently changed games (the default window is 3 days).
- Updated games show inline before→after values, for example ~~3:30 PM–5:30 PM~~ → **9:00 AM–10:30 AM**.
- Removed games stay in their old slot, struck through, so they don't just silently disappear.
- The **Changes** view lists everything that changed, newest first, and respects your current filters. The tab shows a count of changes since your last visit.
- Each game's detail pop-up has a **History** section.
- In calendar exports, a game keeps the same ID when it's rescheduled. Subscribed calendars therefore update it in place instead of deleting it and adding a new one.

`lib/changes.js` contains the comparison logic. History begins when tracking starts; the first run only
records a starting snapshot. If a fetch is missing more than 20% of games, the app treats it as a bad
response and ignores those removals instead of reporting mass cancellations. The history is stored in D1
on Cloudflare (`migrations/`) and in `data/changes.json` locally.

## How it works

The SportsConnect calendar page is a Kendo UI app backed by public JSON endpoints under
`/DesktopModules/sScheduleEventServices/API/`. Calling `Calendar/GetMatches` with
`isToCheckForDateRange=false` returns every posted event in one request. Those
endpoints send no CORS headers, so `server.js` proxies them. It normalizes the
data (`lib/sportsconnect.js`), caches it for 15 minutes in memory and in `data/cache.json`,
and serves the static UI from `public/`.

| Route | What |
| --- | --- |
| `/api/schedule` | Normalized events, divisions, teams and locations (`?refresh` forces a re-fetch) |
| `/calendar.ics` | iCalendar feed. It takes the same query params as the UI (`team`, `div`, `type`, `loc`, `q`). Add `range`/`from`/`to` to limit dates, `download` for a file, or `name` to title it. |

The browser and the `.ics` export both use the same filter code (`public/js/filter.js`),
so an export always matches what's on screen.

## Configuration

Set these as environment variables:

| Variable | Default | Notes |
| --- | --- | --- |
| `SC_SITE` | `https://www.fairfaxll.org` | Any SportsConnect site |
| `SC_PORTAL_ID` | auto-discovered | Read from the site's home page if not set |
| `SC_TIMEZONE` | `America/New_York` | IANA zone the league's times are in |
| `SC_API_TIMEZONE` | `Eastern Standard Time` | Windows zone name the API expects |
| `SC_MAP_HINT` | `Fairfax, VA` | Added to map searches, because the site has no field addresses |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | Use `HOST=0.0.0.0` to reach it from your phone on the same Wi-Fi |
| `CACHE_MINUTES` | `15` | |

## Cloudflare deployment

Live at **https://sports-disconnect.gwaldron.workers.dev**. It runs as a Worker (`worker.js`):
- `public/` is served as static assets.
- The schedule is cached in a KV namespace (`CACHE`), and the change history lives in a D1 database (`DB`).
- A cron trigger refreshes the cache every 15 minutes, so visitors never wait on the league site.

The settings live in [`wrangler.jsonc`](wrangler.jsonc). To ship changes:

```bash
npm run deploy     # wrangler deploy
npm run cf:dev     # run the Worker locally on :8787
```

Because the site is public, **Export → Subscribe** URLs work in Google, Apple and Outlook calendars.
They re-check the feed on their own schedule. Google's can lag by several hours.

## Development

```bash
npm run dev   # restarts on changes
npm test      # offline unit tests for normalization, filters and ICS output
```
