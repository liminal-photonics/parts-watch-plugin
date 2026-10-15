// Live smoke test over stdio with real keys from env. Uses a throwaway watch file.
// SPEC=github:liminal-photonics/parts-watch-plugin#<sha> runs the server from a fresh npx install.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const file = join(await mkdtemp(join(tmpdir(), "pw-live-")), "watch.json");
const spec = process.env.SPEC;
const start = async (env) => {
  const t = new StdioClientTransport({ command: spec ? "npx" : "node", args: spec ? ["-y", spec] : ["src/index.js"], env: { ...process.env, PARTS_WATCH_FILE: file, ...env } });
  const c = new Client({ name: "smoke", version: "0" });
  await c.connect(t);
  return c;
};
const c = await start({});
const call = async (name, args = {}) => { const r = await c.callTool({ name, arguments: args }); const t = r.content[0].text; return r.isError ? { ERROR: t } : JSON.parse(t); };
console.log("TOOLS", (await c.listTools()).tools.map((x) => x.name).join(", "));
console.log("STATUS", JSON.stringify(await call("watch_status")).replace(file, "<tmp>"));
const pns = (process.env.SMOKE_PNS || "RC0603FR-0710KL,GRM188R71C104KA01D,LM358DR,ATMEGA328P-AU").split(",");
console.log("ADD", JSON.stringify(await call("watch_add", { parts: pns.map((p, i) => ({ partNumber: p, qty: [1000, 100, 100, 10][i] ?? 100, minStock: i === 3 ? 100000000 : 100 })) })).replace(file, "<tmp>"));
let r = await call("watch_check");
console.log("CHECK1", r.summary, "|", r.comparedWith, "| saved", r.saved, "| notes", r.notes);
for (const [pn, e] of Object.entries(r.current || {})) for (const [d, s] of Object.entries(e.distributors)) console.log(`   ${pn} ${d}: ${s.found ? `stock ${s.stock} | $${s.unitPrice}@${e.qty} | ${s.lifecycle ?? "-"} | ${s.leadTime ?? "-"}` : s.error || "not found"}`);
for (const ch of r.changes || []) console.log("   CHANGE", ch.partNumber, ch.distributor, ch.type, ch.detail);
// Simulate an older snapshot with different values so the next live check has something to diff.
const d = JSON.parse(await readFile(file, "utf8"));
const s0 = d.snapshots[0];
for (const e of Object.values(s0.parts)) for (const s of Object.values(e.distributors)) if (s.found) { s.unitPrice = s.unitPrice ? +(s.unitPrice * 1.5).toFixed(5) : s.unitPrice; s.leadTime = "99 weeks (test)"; }
await writeFile(file, JSON.stringify(d));
r = await call("watch_check");
console.log("CHECK2", r.summary, "| types", [...new Set(r.changes.map((x) => x.type))].join(","));
console.log("DIFF", (await call("watch_diff")).changes.length, "changes");
console.log("REMOVE", JSON.stringify(await call("watch_remove", { partNumbers: [pns[0], "NOPE-123"] })));
console.log("EMPTY_ADD", JSON.stringify(await call("watch_add", { parts: [{ partNumber: " " }] })));
console.log("LIST", (await call("watch_list")).parts.length, "parts");
await c.close();
const n = await start({ DIGIKEY_CLIENT_ID: "", DIGIKEY_CLIENT_SECRET: "", MOUSER_API_KEY: "", NEWARK_API_KEY: "" });
const nr = await n.callTool({ name: "watch_check", arguments: {} });
console.log("NOKEY", JSON.parse(nr.content[0].text).notes, "saved", JSON.parse(nr.content[0].text).saved);
await n.close();
