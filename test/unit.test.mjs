import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addParts, removeParts, listParts, runCheck, lastDiff, diffSnapshots, cleanPart, load } from "../src/watch.js";

const tmp = async () => join(await mkdtemp(join(tmpdir(), "pw-")), "w.json");
const rec = (o = {}) => ({ distributorPartNumber: "X-ND", stock: 1000, priceBreaks: [{ qty: 1, unitPrice: 1 }, { qty: 100, unitPrice: 0.5 }], currency: "USD", lifecycle: "Active", discontinued: false, leadTime: "8 weeks", ...o });
const fake = (map) => async ({ partNumber, distributors }) => {
  const results = {}, notes = [];
  for (const d of distributors) {
    const v = map[partNumber]?.[d];
    if (v instanceof Error) notes.push(`${{ digikey: "Digi-Key", mouser: "Mouser", newark: "Newark" }[d]} error: ${v.message}`);
    else if (v !== undefined) results[d] = v;
  }
  return { partNumber, results, notes };
};

test("add, update, list and remove parts", async () => {
  const f = await tmp();
  let r = await addParts({ parts: [{ partNumber: "ABC", qty: 10, minStock: 500 }, { partNumber: "def" }] }, f);
  assert.deepEqual(r.added, ["ABC", "def"]);
  r = await addParts({ parts: [{ partNumber: "abc", priceChangePct: 2 }], defaults: { qty: 250 } }, f);
  assert.deepEqual(r.updated, ["ABC"]); // the stored spelling is kept
  const l = await listParts({}, f);
  assert.equal(l.parts.length, 2);
  assert.equal(l.parts[0].qty, 10);
  assert.equal(l.parts[0].priceChangePct, 2);
  assert.equal(l.defaults.qty, 250);
  r = await removeParts({ partNumbers: ["DEF", "nope"] }, f);
  assert.deepEqual(r.removed, ["def"]);
  assert.deepEqual(r.notFound, ["nope"]);
});

test("bad input is rejected clearly", async () => {
  assert.throws(() => cleanPart({ partNumber: "  " }), /partNumber is required/);
  assert.throws(() => cleanPart({ partNumber: "A", qty: 0 }), /qty/);
  assert.throws(() => cleanPart({ partNumber: "A", distributors: ["arrow"] }), /Unknown distributor/);
  await assert.rejects(addParts({}, await tmp()), /at least one part/);
  await assert.rejects(removeParts({ partNumbers: [] }, await tmp()), /at least one/);
  await assert.rejects(runCheck({}, await tmp(), fake({})), /empty/);
  const f = await tmp();
  await writeFile(f, "{not json");
  await assert.rejects(load(f), /not valid JSON/);
});

test("first check raises only threshold alerts, second check diffs", async () => {
  const f = await tmp();
  await addParts({ parts: [{ partNumber: "P1", qty: 100, minStock: 500 }, { partNumber: "P2", minStock: 2000 }] }, f);
  let r = await runCheck({}, f, fake({ P1: { digikey: rec(), mouser: rec({ stock: 100 }), newark: null }, P2: { digikey: rec() } }));
  assert.deepEqual(r.changes.map((c) => `${c.partNumber}/${c.distributor}/${c.type}`).sort(), ["P1/mouser/stock-below-threshold", "P2/digikey/stock-below-threshold"]);
  r = await runCheck({}, f, fake({
    P1: { digikey: rec({ stock: 400, priceBreaks: [{ qty: 1, unitPrice: 1 }, { qty: 100, unitPrice: 0.56 }] }), mouser: rec({ stock: 900 }), newark: rec() },
    P2: { digikey: rec({ lifecycle: "Obsolete", discontinued: true, leadTime: "52 weeks", stock: 10 }), mouser: new Error("rate limit reached") },
  }));
  const t = r.changes.map((c) => `${c.partNumber}/${c.distributor}/${c.type}`).sort();
  assert.deepEqual(t, ["P1/digikey/price-change", "P1/digikey/stock-below-threshold", "P1/mouser/stock-recovered", "P1/newark/newly-listed", "P2/digikey/lead-time-change", "P2/digikey/lifecycle-change", "P2/mouser/check-failed"]);
  assert.equal(r.changes.find((c) => c.type === "price-change").changePct, 12);
  const d = await lastDiff({}, f);
  assert.equal(d.changes.length, 7);
  assert.equal((await lastDiff({ partNumber: "p2" }, f)).changes.length, 3);
});

test("small price moves, unchanged stock and save:false do not alert or write", async () => {
  const f = await tmp();
  await addParts({ parts: [{ partNumber: "Q", minStock: 10 }] }, f);
  await runCheck({}, f, fake({ Q: { mouser: rec() } }));
  const before = await readFile(f, "utf8");
  const r = await runCheck({ save: false }, f, fake({ Q: { mouser: rec({ priceBreaks: [{ qty: 100, unitPrice: 0.51 }] }) } }));
  assert.equal(r.changes.length, 0);
  assert.equal(await readFile(f, "utf8"), before);
});

test("an earlier failed check is not treated as a delisting or relisting", () => {
  const d = { parts: [{ partNumber: "Z" }] };
  const prev = { parts: { Z: { qty: 100, distributors: { mouser: { error: "Mouser error: timed out" } } } } };
  const cur = { parts: { Z: { qty: 100, distributors: { mouser: { found: true, stock: 5, unitPrice: 1, currency: "USD" } } } } };
  assert.deepEqual(diffSnapshots(prev, cur, d), []);
  assert.equal(prev.parts.Z.distributors.mouser.unknown, undefined);
});

test("missing keys: check reports the skip notes and saves nothing", async () => {
  const saved = { ...process.env };
  for (const k of ["MOUSER_API_KEY", "NEWARK_API_KEY", "DIGIKEY_CLIENT_ID", "DIGIKEY_CLIENT_SECRET"]) delete process.env[k];
  const f = await tmp();
  await addParts({ parts: [{ partNumber: "A" }] }, f);
  const r = await runCheck({}, f);
  assert.match(r.notes.join(" "), /No distributor was queried/);
  assert.equal((await load(f)).snapshots.length, 0);
  assert.equal(r.saved, false);
  Object.assign(process.env, saved);
});

test("edge cases: concurrent writes, junk entries, case-preserving update, add during a check", async () => {
  const f = await tmp();
  await Promise.all(Array.from({ length: 10 }, (_, i) => addParts({ parts: [{ partNumber: `P${i}` }] }, f)));
  assert.equal((await listParts({}, f)).parts.length, 10, "no lost updates");
  const raw = JSON.parse(await readFile(f, "utf8"));
  raw.parts.push(null, { qty: 5 }, 7); raw.snapshots = [null, "x"];
  await writeFile(f, JSON.stringify(raw));
  assert.equal((await load(f)).parts.length, 10);
  const g = await tmp();
  await addParts({ parts: [{ partNumber: "LM358DR" }] }, g);
  await runCheck({}, g, fake({ LM358DR: { digikey: rec({ priceBreaks: [{ qty: 1, unitPrice: 1 }, { qty: 100, unitPrice: 1 }] }) } }));
  await addParts({ parts: [{ partNumber: "lm358dr", minStock: 5 }] }, g);
  assert.equal((await listParts({}, g)).parts[0].partNumber, "LM358DR");
  const r = await runCheck({}, g, fake({ LM358DR: { digikey: rec({ priceBreaks: [{ qty: 1, unitPrice: 1 }, { qty: 100, unitPrice: 2 }] }) } }));
  assert.ok(r.changes.some((c) => c.type === "price-change"), "earlier snapshot still matched after a case change");
  // a part added while a slow check runs survives the check's save
  let release; const gate = new Promise((res) => (release = res));
  const slow = async (a) => { await gate; return fake({ LM358DR: { digikey: rec() } })(a); };
  const check = runCheck({ partNumbers: "LM358DR" }, g, slow);
  await addParts({ parts: [{ partNumber: "BSS138" }] }, g);
  release(); await check;
  assert.deepEqual((await listParts({}, g)).parts.map((p) => p.partNumber), ["LM358DR", "BSS138"]);
});

test("watch file path: ~ expands to the home folder", async () => {
  const { watchFile } = await import("../src/watch.js");
  const { homedir } = await import("node:os");
  const saved = process.env.PARTS_WATCH_FILE;
  try {
    process.env.PARTS_WATCH_FILE = "~/pw/w.json"; assert.equal(watchFile(), join(homedir(), "pw", "w.json"));
    process.env.PARTS_WATCH_FILE = "/abs/w.json"; assert.equal(watchFile(), "/abs/w.json");
  } finally { if (saved == null) delete process.env.PARTS_WATCH_FILE; else process.env.PARTS_WATCH_FILE = saved; }
});

test("round 3: first check flags parts no distributor lists and parts already end-of-life, once", async () => {
  const { diffSnapshots } = await import("../src/watch.js");
  const cur = { parts: { TYPO: { qty: 100, distributors: { digikey: { found: false }, mouser: { found: false } } }, OLD: { qty: 100, distributors: { digikey: { found: true, lifecycle: "Obsolete", discontinued: false }, mouser: { found: true, lifecycle: null, discontinued: true } } }, OK: { qty: 100, distributors: { digikey: { found: true, lifecycle: "Active", discontinued: false } } } } };
  const d = { parts: [{ partNumber: "TYPO" }, { partNumber: "OLD" }, { partNumber: "OK" }] };
  const first = diffSnapshots(null, cur, d);
  assert.deepEqual(first.map((c) => `${c.partNumber}:${c.type}`).sort(), ["OLD:end-of-life", "OLD:end-of-life", "TYPO:not-found"]);
  assert.deepEqual(diffSnapshots(cur, cur, d), []);
});
