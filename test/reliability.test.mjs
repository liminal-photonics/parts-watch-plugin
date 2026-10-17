// Tool-response reliability audit (2026-10-17): same client fixes as parts-sourcing, plus watch alerts for rows that
// need a human check, stale-stock notes on stock alerts, and version/timestamps on every tool result.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { classifyLifecycle } from "../src/lifecycle.js";
import { normalizeMouser } from "../src/mouser.js";
import { stockNumber } from "../src/newark.js";
import { addParts, runCheck, summarize } from "../src/watch.js";

const SERVER = fileURLToPath(new URL("../src/index.js", import.meta.url));

test("lifecycle: blank Mouser field is unknown, Digi-Key Active is active, Newark stocking status is unknown", () => {
  assert.equal(classifyLifecycle(null, { distributor: "Mouser" }), "unknown");
  assert.equal(classifyLifecycle("Active", { distributor: "Digi-Key" }), "active");
  assert.equal(classifyLifecycle("STOCKED", { distributor: "Newark" }), "unknown");
  const m = normalizeMouser({ MouserPartNumber: "863-BAS116LT1G", ManufacturerPartNumber: "BAS116LT1G", Manufacturer: "onsemi", AvailabilityInStock: "21733", PriceBreaks: [] });
  assert.equal(summarize(m, 1).lifecycleStatus, "unknown");
  assert.equal(stockNumber("Call"), null);
});

test("watch_check raises needs-check for an unconfirmed maker and marks stale stock in stock alerts", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "pw-rel-")), "watch.json");
  await addParts({ parts: [{ partNumber: "SN74LVC1G14DBVR", minStock: 100000, distributors: ["digikey"] }] }, file);
  const details = async () => ({
    results: { digikey: { distributor: "Digi-Key", manufacturer: "UMW", stock: 26200, priceBreaks: [{ qty: 1, unitPrice: 0.16 }], currency: "USD", lifecycle: "Active", lifecycleStatus: "active", manufacturerConfirmed: false, stockFresh: false, stockNote: "refresh failed (Digi-Key HTTP 500)", exactMatch: true } },
    notes: ["Manufacturer NOT confirmed: ..."],
  });
  const r = await runCheck({ save: false }, file, details);
  const types = r.changes.map((c) => c.type);
  assert.ok(types.includes("needs-check"));
  const low = r.changes.find((c) => c.type === "stock-below-threshold");
  assert.match(low.detail, /stock may be stale: refresh failed/);
  assert.equal(low.stockFresh, false);
});

test("MCP: watch_status reports version and gitSha; results carry retrievedAt", async () => {
  const c = new Client({ name: "t", version: "1" });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...process.env, PARTS_WATCH_FILE: join(mkdtempSync(join(tmpdir(), "pw-st-")), "w.json") } }));
  try {
    const r = JSON.parse((await c.callTool({ name: "watch_status", arguments: {} })).content[0].text);
    assert.equal(r.version, "0.2.0");
    assert.match(r.gitSha, /^[0-9a-f]{40}$|^unknown$/);
    assert.ok(r.distributors && !("version" in r.distributors));
    assert.match(r.retrievedAt, /Z$/);
    assert.equal(r.plugin.version, "0.2.0");
  } finally { await c.close(); }
});
