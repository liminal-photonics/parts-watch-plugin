---
name: scheduled-parts-watch
description: Set up and run a recurring watch on a BOM or part list across Digi-Key, Mouser and Newark, and report only what changed (stock below threshold, price moves, lifecycle and lead-time changes). Use when someone wants to monitor parts, get alerted on stock or EOL changes, or schedule a BOM check.
---

# Scheduled parts watch

## Set up (once)
1. Confirm keys with `watch_status`. At least one distributor must be configured; the others are skipped with a note. Keys are the same as the parts-sourcing plugin (`DIGIKEY_CLIENT_ID` + `DIGIKEY_CLIENT_SECRET`, `MOUSER_API_KEY`, `NEWARK_API_KEY`). Never print or ask the user to paste key values into chat.
2. Turn the BOM into watch entries. For each line, ask for (or infer from the BOM) the **build quantity** to price at and a **minimum stock** that would put the build at risk (a sensible default is 2-3x the build quantity). Keep the default 5% price-change threshold unless the user says otherwise.
3. Call `watch_add` with all parts in one call. Set list-wide `defaults` when most parts share a quantity.
4. Run a first `watch_check` to save the baseline. Explain that the first check only reports parts already below their stock threshold, part numbers no distributor lists, and parts already end-of-life; changes show up from the second check onward.

## Schedule
- Offer a cadence: daily for active builds or allocation-prone parts, weekly otherwise. Avoid more than a few checks a day; distributor APIs have daily quotas.
- Use whatever scheduler the user's environment provides (a scheduled agent routine, or cron running an agent with this plugin). The routine prompt should be: "Run the parts watch check and report only changes; if nothing changed, say so in one line."
- Before creating a schedule or any notification that sends messages, show the user the exact schedule and message destination and get approval.

## Each run
1. Call `watch_check`.
2. Report, most urgent first:
   - lifecycle changes to obsolete / NRND / discontinued, and `no-longer-listed`
   - `stock-below-threshold`
   - price changes (give old -> new and %), lead-time changes
   - `check-failed` (say which distributor and that the part will be compared again next run)
3. Group by part, one line per change, with the distributor. Skip unchanged parts. Mention `stock-recovered` and `newly-listed` briefly at the end.
4. For an obsolete or out-of-stock part, suggest finding an alternate (the parts-sourcing plugin's alternates skill can help) but don't change the watch list unless asked.

## Notes
- Data is a point-in-time view from public distributor APIs; it is not a quote or allocation.
- Mouser leaves lifecycle empty for most active parts; "not stated" is not a change in status unless it actually moves.
- The watch list and snapshots are stored locally in one JSON file (`PARTS_WATCH_FILE`, default `~/.parts-watch/watchlist.json`). The last 30 checks are kept.
