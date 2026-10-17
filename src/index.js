#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { addParts, removeParts, listParts, runCheck, lastDiff, watchFile, DISTRIBUTORS } from "./watch.js";
import { status } from "./sourcing.js";
import { pluginVersion, stamp } from "./version.js";

const part = {
  type: "object",
  properties: {
    partNumber: { type: "string", minLength: 1, description: "Manufacturer or distributor part number." },
    qty: { type: "integer", minimum: 1, description: "Quantity to price at (default 100)." },
    minStock: { type: "integer", minimum: 0, description: "Alert when stock drops below this (default 0 = off)." },
    priceChangePct: { type: "number", minimum: 0, description: "Alert when the unit price at qty moves by at least this percent (default 5)." },
    distributors: { type: "array", items: { type: "string", enum: DISTRIBUTORS } },
    note: { type: "string", description: "Optional label, e.g. a BOM reference." },
  },
  required: ["partNumber"],
};

const TOOLS = [
  { name: "watch_add", description: "Add parts to the local watch list, or update their thresholds (qty to price at, minimum stock, price-change percent). Can also set list-wide defaults.",
    inputSchema: { type: "object", properties: { parts: { type: "array", items: part, maxItems: 200 }, defaults: { type: "object", properties: { qty: { type: "integer", minimum: 1 }, minStock: { type: "integer", minimum: 0 }, priceChangePct: { type: "number", minimum: 0 } } } } } },
  { name: "watch_remove", description: "Remove parts from the watch list by part number.",
    inputSchema: { type: "object", properties: { partNumbers: { type: "array", items: { type: "string" }, minItems: 1 } }, required: ["partNumbers"] } },
  { name: "watch_list", description: "Show the watch list, its defaults, the file location and when it was last checked.", inputSchema: { type: "object", properties: {} } },
  { name: "watch_check", description: "Check every watched part (or the ones named) on Digi-Key, Mouser and Newark, compare with the last saved check and report stock below threshold, price changes at the chosen qty, lifecycle/stocking-status changes and lead-time changes. Saves a new snapshot unless save is false.",
    inputSchema: { type: "object", properties: { partNumbers: { type: "array", items: { type: "string" } }, save: { type: "boolean", default: true } } } },
  { name: "watch_diff", description: "Show the changes between the last two saved checks without calling any distributor.",
    inputSchema: { type: "object", properties: { partNumber: { type: "string" } } } },
  { name: "watch_status", description: "Show which distributor API keys are configured, where the watch file is, and the plugin version and git commit that is running.", inputSchema: { type: "object", properties: {} } },
];

const HANDLERS = {
  watch_add: (a) => addParts(a),
  watch_remove: (a) => removeParts(a),
  watch_list: (a) => listParts(a),
  watch_check: (a) => runCheck(a),
  watch_diff: (a) => lastDiff(a),
  watch_status: async () => { const s = status(); const { pluginName, version, gitSha, gitShaSource, ...distributors } = s; return { distributors, watchFile: watchFile(), pluginName, version, gitSha, gitShaSource }; },
};

const server = new Server({ name: "parts-watch", version: pluginVersion().version || "0.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: a = {} } = req.params;
  try {
    const h = HANDLERS[name];
    if (!h) throw new Error(`Unknown tool ${name}`);
    return { content: [{ type: "text", text: JSON.stringify(stamp(await h(a || {})), null, 2) }] };
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: e.message }] };
  }
});
await server.connect(new StdioServerTransport());
