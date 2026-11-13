# Lions Results site

A static website for Central Districts Lions results, fixtures and live scores. There's no server and no scraper: each visitor's browser reads the latest games straight from BasketballConnect's public live-scores API, about 640 KB per load. Pages refresh every minute while a Lions game is live.

## Pages

- **Game day** (`#/`): the visitor's starred team, live scores, games that just finished, and every Lions game in the next week grouped by day and tip-off time.
- **Results** (`#/results/<round>`): pick a round to see wins, losses, the biggest win, and each age group's results. Filter by age and boys/girls.
- **Teams** (`#/teams`): all 41 teams with their form and record.
- **Box score** (`#/game/<matchId>`): points, free throws, 2s, 3s and fouls for each player on both teams. It refreshes every 30 seconds during live games. Tap any finished or live game to open it.
- **Team page** (`#/team/<id>`): season player stats (games, points, average, fouls), record, points for and against, next game with directions, results and fixtures. "Set as my team" pins the team to Game day. It's saved in that visitor's browser.

## Player names

Full names are shown, except players BasketballConnect marks as hidden. Those show only their shirt number (club decision, Nov 2026).

## Hosting

Upload this whole folder to any static host, such as GitHub Pages, Netlify or Cloudflare Pages. Opening `index.html` straight from disk won't load data in some browsers, so test it through a host or a local server (`python3 -m http.server`).

## New season or competition

Edit `config.js`:
- `competitionId`: the number in the `round/matches?competitionId=` request on the BasketballConnect fixture page (developer tools, Network tab).
- `teamIds`: the Lions team ids. The ids are in each match's `team1.id` / `team2.id`.
- `seasonLabel` and `sourceUrl`.

## Testing with saved data

`index.html?mock=mock.json` loads a local JSON file in the same shape as the API instead of calling it.
