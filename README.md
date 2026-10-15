# Parts Watch (Digi-Key, Mouser, Newark)

An MCP server and skill that watch a BOM or part list across **Digi-Key**, **Mouser** and **Newark (element14)** and report only what changed since the last check:

- stock dropping below your threshold (and recovering)
- unit-price changes at the quantity you build at, above a percent you choose
- lifecycle / stocking-status changes (e.g. Active → Obsolete, NRND, no longer stocked)
- lead-time changes
- a part disappearing from, or newly appearing at, a distributor

The watch list and the last 30 checks live in one local JSON file. Nothing is sent anywhere except the distributor APIs.

The distributor clients are the same as in [parts-sourcing-plugin](https://github.com/liminal-photonics/parts-sourcing-plugin), with the same environment variables, so one set of keys works for both.

## Tools

| Tool | What it does |
|---|---|
| `watch_add` | Add parts or update their settings: `qty` to price at (default 100), `minStock` alert threshold (default 0 = off), `priceChangePct` (default 5), optional `distributors` and `note`. Can set list-wide `defaults`. Part numbers are matched case-insensitively. |
| `watch_remove` | Remove parts by part number. Reports any that weren't on the list. |
| `watch_list` | The watch list, defaults, file location and last check time. |
| `watch_check` | Check every watched part (or `partNumbers`), compare with the previous check of each part, and save a new snapshot (`save: false` for a dry run). |
| `watch_diff` | Changes between the last two saved checks, with no API calls. |
| `watch_status` | Which distributor keys are configured, and the watch file path. |

The first check is a baseline: it only reports parts already below their stock threshold. If a distributor fails during a check (timeout, rate limit), that part is reported as `check-failed` and is not counted as delisted; it's compared again next time.

## Setup

Bring your own keys (all free). Any subset works; missing distributors are skipped with a note.

| Variable | Distributor |
|---|---|
| `DIGIKEY_CLIENT_ID`, `DIGIKEY_CLIENT_SECRET` | Digi-Key API (Product Information v4, client credentials) |
| `MOUSER_API_KEY` | Mouser Search API |
| `NEWARK_API_KEY` | element14 Product Search API (`NEWARK_STORE` optional, default `www.newark.com`) |
| `PARTS_WATCH_FILE` | Optional. Watch file path. Default `~/.parts-watch/watchlist.json` |

Optional: `PARTS_WATCH_KEEP` (snapshots kept, default 30), `PARTS_WATCH_TIMEOUT_MS` (default 20000).

Never commit keys. The plugin reads them from the environment only and never writes them to the watch file or to error messages.

## Skill

`scheduled-parts-watch` walks through turning a BOM into watch entries, taking a baseline, choosing a cadence and writing a routine prompt that reports only changes. It asks for approval before setting up any schedule or notification.

## Example

> Watch RC0603FR-0710KL at 5000 pcs with a 50k stock floor, and ATMEGA328P-AU at 100 pcs with a 1000 floor. Then check now.

## Notes and limits

- Point-in-time data from public distributor APIs; not a quote or allocation.
- Prices are compared only when the currency and quantity are unchanged between checks.
- Mouser leaves lifecycle empty for most active parts. Newark reports stocking status (e.g. `DIRECT_SHIP`, `NO_LONGER_STOCKED`) rather than manufacturer lifecycle.
- Checks run two parts at a time to stay under distributor rate limits. A 200-part list takes a few minutes and uses part of each distributor's daily quota.
- Timeouts (20 s) and HTTP 429 rate limits are reported per distributor without stopping the check.

## Development

```
npm install
npm test          # offline unit tests
npm run live      # live smoke test with real keys (uses a temp watch file)
```

## License

MIT © Liminal Photonics
