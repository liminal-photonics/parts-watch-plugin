// Watch list, snapshots and diffing. Data lives in one local JSON file; nothing is sent anywhere except the distributor APIs.
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { getPartDetails, priceAt } from "./sourcing.js";

export const DISTRIBUTORS = ["digikey", "mouser", "newark"];
const MAX_SNAPSHOTS = Math.max(2, Number(process.env.PARTS_WATCH_KEEP) || 30);
const MAX_PARTS = 200;

export function watchFile() {
  const f = (process.env.PARTS_WATCH_FILE || "").trim();
  if (!f || f.startsWith("${")) return join(homedir(), ".parts-watch", "watchlist.json");
  return /^~(?=$|[\\/])/.test(f) ? join(homedir(), f.slice(1)) : f; // "~/x.json" (shells don't expand ~ inside env config)
}

export async function load(file = watchFile()) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { version: 1, parts: [], snapshots: [] };
    throw new Error(`Could not read the watch file: ${e.message}`);
  }
  let d;
  try {
    d = JSON.parse(raw);
  } catch {
    throw new Error(`The watch file at ${file} is not valid JSON. Fix or move it, then try again.`);
  }
  if (!d || !Array.isArray(d.parts)) throw new Error(`The watch file at ${file} has no "parts" list.`);
  // drop hand-edited junk entries instead of crashing on them
  d.parts = d.parts.filter((p) => p && typeof p === "object" && typeof p.partNumber === "string" && p.partNumber.trim());
  d.snapshots = Array.isArray(d.snapshots) ? d.snapshots.filter((s) => s && typeof s === "object" && s.parts && typeof s.parts === "object") : [];
  return d;
}

export async function save(d, file = watchFile()) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; // unique per write
  await writeFile(tmp, JSON.stringify(d, null, 2) + "\n");
  await rename(tmp, file); // atomic replace, so a crash never leaves a half-written file
}

const key = (pn) => String(pn).trim().toUpperCase();

// Serialize read-modify-write sections in this process so two tool calls can't overwrite each other's changes.
let lock = Promise.resolve();
function locked(fn) { const run = lock.then(fn, fn); lock = run.catch(() => {}); return run; }

function num(v, field, { min = 0, int = false } = {}) {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || (int && !Number.isInteger(n))) throw new Error(`${field} must be ${int ? "a whole number" : "a number"} of ${min} or more.`);
  return n;
}

export function cleanPart(p) {
  if (!p || typeof p !== "object") throw new Error("Each part must be an object with at least partNumber.");
  const partNumber = typeof p.partNumber === "string" ? p.partNumber.trim() : "";
  if (!partNumber) throw new Error("partNumber is required and must be a non-empty string.");
  if (partNumber.length > 80) throw new Error("partNumber is too long (80 characters max).");
  const out = { partNumber };
  const qty = num(p.qty, "qty", { min: 1, int: true });
  const minStock = num(p.minStock, "minStock", { int: true });
  const priceChangePct = num(p.priceChangePct, "priceChangePct");
  if (qty !== undefined) out.qty = qty;
  if (minStock !== undefined) out.minStock = minStock;
  if (priceChangePct !== undefined) out.priceChangePct = priceChangePct;
  if (p.note != null && String(p.note).trim()) out.note = String(p.note).trim().slice(0, 200);
  if (p.distributors != null) {
    const ds = [...new Set((Array.isArray(p.distributors) ? p.distributors : [p.distributors]).map((d) => String(d).toLowerCase().replace(/[^a-z]/g, "")))];
    const bad = ds.filter((d) => !DISTRIBUTORS.includes(d));
    if (bad.length) throw new Error(`Unknown distributor ${bad.join(", ")} (use digikey, mouser or newark).`);
    if (ds.length) out.distributors = ds;
  }
  return out;
}

export function defaults(d) {
  return { qty: 100, minStock: 0, priceChangePct: 5, ...(d.defaults || {}) };
}

export function addParts(a = {}, file) { return locked(() => addPartsUnlocked(a, file)); }
async function addPartsUnlocked({ parts, defaults: dflt } = {}, file) {
  const list = Array.isArray(parts) ? parts : parts ? [parts] : [];
  if (!list.length && !dflt) throw new Error("Give at least one part, e.g. { partNumber: \"RC0603FR-0710KL\", qty: 1000, minStock: 5000 }.");
  const cleaned = list.map(cleanPart);
  const d = await load(file);
  if (dflt) {
    const c = {};
    const q = num(dflt.qty, "defaults.qty", { min: 1, int: true }), m = num(dflt.minStock, "defaults.minStock", { int: true }), pc = num(dflt.priceChangePct, "defaults.priceChangePct");
    if (q !== undefined) c.qty = q;
    if (m !== undefined) c.minStock = m;
    if (pc !== undefined) c.priceChangePct = pc;
    d.defaults = { ...(d.defaults || {}), ...c };
  }
  const added = [], updated = [];
  for (const p of cleaned) {
    const i = d.parts.findIndex((x) => key(x.partNumber) === key(p.partNumber));
    // keep the stored spelling so earlier snapshots (keyed by it) still match
    if (i >= 0) { d.parts[i] = { ...d.parts[i], ...p, partNumber: d.parts[i].partNumber }; updated.push(d.parts[i].partNumber); }
    else { d.parts.push(p); added.push(p.partNumber); }
  }
  if (d.parts.length > MAX_PARTS) throw new Error(`A watch list can hold at most ${MAX_PARTS} parts.`);
  await save(d, file);
  return { file: file || watchFile(), added, updated, total: d.parts.length, defaults: defaults(d) };
}

export function removeParts(a = {}, file) { return locked(() => removePartsUnlocked(a, file)); }
async function removePartsUnlocked({ partNumbers } = {}, file) {
  const list = (Array.isArray(partNumbers) ? partNumbers : partNumbers ? [partNumbers] : []).filter((x) => typeof x === "string" || typeof x === "number").map((x) => String(x).trim()).filter(Boolean);
  if (!list.length) throw new Error("Give at least one part number to remove.");
  const d = await load(file);
  const want = new Set(list.map(key));
  const removed = d.parts.filter((p) => want.has(key(p.partNumber))).map((p) => p.partNumber);
  d.parts = d.parts.filter((p) => !want.has(key(p.partNumber)));
  const notFound = list.filter((pn) => !removed.some((r) => key(r) === key(pn)));
  if (removed.length) await save(d, file);
  return { removed, notFound, total: d.parts.length };
}

export async function listParts(_a, file) {
  const d = await load(file);
  const last = d.snapshots.at(-1);
  return { file: file || watchFile(), defaults: defaults(d), parts: d.parts, snapshots: d.snapshots.length, lastCheck: last?.takenAt || null };
}

// Reduce a normalized distributor record to the fields we track.
export function summarize(r, qty) {
  if (!r) return { found: false };
  const p = priceAt(r.priceBreaks, qty);
  return {
    found: true,
    manufacturer: r.manufacturer ?? null,
    distributorPartNumber: r.distributorPartNumber ?? null,
    stock: r.stock ?? null,
    unitPrice: p?.unitPrice ?? null,
    priceNote: p?.belowMinimum ? `qty below minimum break ${p.minimumBreak}` : null,
    currency: r.currency || null,
    lifecycle: r.lifecycle ?? null,
    lifecycleStatus: r.lifecycleStatus ?? "unknown",
    discontinued: Boolean(r.discontinued),
    leadTime: r.leadTime ?? null,
    manufacturerConfirmed: r.manufacturerConfirmed ?? true,
    exactMatch: r.exactMatch ?? true,
    stockFresh: r.stockFresh ?? true,
    ...(r.stockNote ? { stockNote: r.stockNote } : {}),
    ...(r.matchNote ? { matchNote: r.matchNote } : {}),
    ...(r.availabilityNote ? { availabilityNote: r.availabilityNote } : {}),
  };
}

const pct = (a, b) => (a ? +(((b - a) / a) * 100).toFixed(2) : null);

// Compare two snapshots. prev may be null (first check): then only current threshold alerts are raised.
export function diffSnapshots(prev, cur, d) {
  const dflt = defaults(d);
  const changes = [];
  const byPn = new Map((d.parts || []).map((p) => [key(p.partNumber), p]));
  for (const [pn, cp] of Object.entries(cur.parts)) {
    const cfg = { ...dflt, ...(byPn.get(key(pn)) || {}) };
    const pp = prev?.parts?.[pn];
    if (pp && pp.qty !== cp.qty) changes.push({ partNumber: pn, type: "settings", detail: `price qty changed ${pp.qty} -> ${cp.qty}; price comparison skipped this time` });
    for (const [dist, c] of Object.entries(cp.distributors)) {
      const o = pp?.distributors?.[dist];
      const add = (type, detail, extra = {}) => changes.push({ partNumber: pn, distributor: dist, type, detail, ...extra });
      if (c.error) { add("check-failed", c.error); continue; }
      if (!c.found) { if (o && o.found) add("no-longer-listed", "Part no longer found at this distributor"); continue; }
      if (o && !o.found && !o.error) add("newly-listed", "Part now found at this distributor");
      const usable = o && o.found && !o.error;
      // Rows a person must check before trusting them: an unconfirmed maker (e.g. TI vs a clone with the same MPN),
      // a punctuation-only match, or Digi-Key stock that could not be refreshed. Raised on every check, not just once.
      if (c.manufacturerConfirmed === false) add("needs-check", `manufacturer not confirmed (${c.manufacturer}); several makers list this part number and no other distributor confirmed which one`);
      if (c.exactMatch === false) add("needs-check", `not an exact part-number match (${c.matchNote || "punctuation-blind match"})`);
      const stale = c.stockFresh === false ? ` (stock may be stale: ${c.stockNote || "not refreshed"})` : "";
      // Stock: alert when it is below the threshold now and was not before (or this is the first check).
      if (c.stock != null && c.stock < cfg.minStock && (!usable || o.stock == null || o.stock >= cfg.minStock))
        add("stock-below-threshold", `stock ${c.stock} is below ${cfg.minStock}${usable && o.stock != null ? ` (was ${o.stock})` : ""}${stale}`, { stock: c.stock, minStock: cfg.minStock, stockFresh: c.stockFresh !== false });
      if (usable && o.stock != null && c.stock != null && o.stock < cfg.minStock && c.stock >= cfg.minStock)
        add("stock-recovered", `stock ${c.stock} is back at or above ${cfg.minStock} (was ${o.stock})${stale}`);
      if (!usable) continue;
      if (pp.qty === cp.qty && o.unitPrice != null && c.unitPrice != null && o.currency === c.currency) {
        const ch = pct(o.unitPrice, c.unitPrice);
        if (ch != null && Math.abs(ch) >= cfg.priceChangePct && o.unitPrice !== c.unitPrice)
          add("price-change", `unit price at qty ${cp.qty} ${o.unitPrice} -> ${c.unitPrice}${c.currency ? ` ${c.currency}` : ""} (${ch > 0 ? "+" : ""}${ch}%)`, { from: o.unitPrice, to: c.unitPrice, changePct: ch, qty: cp.qty });
      } else if (o.unitPrice != null && c.unitPrice == null) add("price-missing", `no price at qty ${cp.qty} now (was ${o.unitPrice})`);
      if ((o.lifecycle || null) !== (c.lifecycle || null) || o.discontinued !== c.discontinued)
        add("lifecycle-change", `lifecycle "${o.lifecycle ?? "not stated"}" -> "${c.lifecycle ?? "not stated"}"${c.discontinued && !o.discontinued ? " (now flagged discontinued)" : ""}`);
      if ((o.leadTime || null) !== (c.leadTime || null)) add("lead-time-change", `lead time "${o.leadTime ?? "not stated"}" -> "${c.leadTime ?? "not stated"}"`);
    }
    // State alerts a first check would otherwise miss: a part no distributor lists (likely a typo) and parts already end-of-life.
    const missing = (x) => x && Object.values(x.distributors || {}).length > 0 && Object.values(x.distributors).every((e) => e && !e.found && !e.error);
    if (missing(cp) && !missing(pp)) changes.push({ partNumber: pn, type: "not-found", detail: "Not found at any distributor checked; check the part number" });
    if (!pp) for (const [dist, c] of Object.entries(cp.distributors)) {
      if (c.found && (c.discontinued || ["eol", "nrnd"].includes(c.lifecycleStatus) || EOL.test(c.lifecycle || ""))) changes.push({ partNumber: pn, distributor: dist, type: "end-of-life", detail: `already "${c.lifecycle ?? "discontinued"}" at the first check` });
    }
  }
  if (prev) for (const pn of Object.keys(prev.parts)) if (!cur.parts[pn]) changes.push({ partNumber: pn, type: "unwatched", detail: "No longer on the watch list" });
  return changes;
}

const EOL = /obsolete|end of life|\beol\b|no_longer|not recommended|last time buy|discontinued/i;

async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const j = i++; out[j] = await fn(items[j]); } }));
  return out;
}

export async function runCheck({ partNumbers, save: doSave = true } = {}, file, details = getPartDetails) {
  const d = await load(file);
  if (!d.parts.length) throw new Error("The watch list is empty. Add parts first.");
  let parts = d.parts;
  if (typeof partNumbers === "string") partNumbers = partNumbers.split(/[,;\s]+/).filter(Boolean);
  if (Array.isArray(partNumbers) && partNumbers.length) {
    const want = new Set(partNumbers.filter((x) => typeof x === "string" || typeof x === "number").map(key));
    parts = d.parts.filter((p) => want.has(key(p.partNumber)));
    if (!parts.length) throw new Error("None of those part numbers are on the watch list.");
  }
  const dflt = defaults(d);
  const notes = new Set();
  const snap = { takenAt: new Date().toISOString(), parts: {} };
  // Two parts at a time keeps each distributor well under its rate limit.
  await mapLimit(parts, 2, async (p) => {
    const qty = p.qty ?? dflt.qty;
    const ds = p.distributors || DISTRIBUTORS;
    const r = await details({ partNumber: p.partNumber, distributors: ds });
    const entry = { qty, distributors: {} };
    for (const k of ds) {
      const err = (r.notes || []).find((n) => n.toLowerCase().startsWith(`${({ digikey: "digi-key", mouser: "mouser", newark: "newark" })[k]} error`));
      if (k in (r.results || {})) entry.distributors[k] = summarize(r.results[k], qty);
      else if (err) entry.distributors[k] = { error: err };
    }
    for (const n of r.notes || []) if (/skipped|No distributor was queried/.test(n)) notes.add(n);
    snap.parts[p.partNumber] = entry;
  });
  // Partial checks are diffed against the latest snapshot that has each part.
  const prevFor = (pn) => [...d.snapshots].reverse().find((s) => s.parts?.[pn]);
  const prev = { takenAt: null, parts: {} };
  for (const pn of Object.keys(snap.parts)) { const s = prevFor(pn); if (s) prev.parts[pn] = s.parts[pn]; }
  const hasPrev = Object.keys(prev.parts).length > 0;
  const changes = diffSnapshots(hasPrev ? prev : null, snap, d).filter((c) => c.type !== "unwatched");
  let saved = false;
  if (doSave && Object.values(snap.parts).some((e) => Object.keys(e.distributors).length)) {
    // re-read under the lock: parts added or removed while the (slow) check ran must not be lost
    await locked(async () => {
      const fresh = await load(file);
      // Drop parts removed from the watch list while the check ran, so they do not come back in the snapshot.
      const watched = new Set(fresh.parts.map((p) => key(p.partNumber)));
      for (const pn of Object.keys(snap.parts)) if (!watched.has(key(pn))) delete snap.parts[pn];
      if (Object.keys(snap.parts).length) fresh.snapshots.push(snap);
      fresh.snapshots = fresh.snapshots.slice(-MAX_SNAPSHOTS);
      await save(fresh, file);
    });
    saved = true;
  }
  return {
    checkedAt: snap.takenAt,
    comparedWith: hasPrev ? "latest earlier snapshot of each part" : "nothing (first check; only threshold, not-found and end-of-life alerts)",
    saved,
    changes,
    summary: `${Object.keys(snap.parts).length} part${Object.keys(snap.parts).length === 1 ? "" : "s"} checked, ${changes.length} change${changes.length === 1 ? "" : "s"}`,
    current: snap.parts,
    notes: [...notes],
  };
}

export async function lastDiff({ partNumber } = {}, file) {
  const d = await load(file);
  if (d.snapshots.length < 2) return { changes: [], note: `Need at least two saved checks to compare; have ${d.snapshots.length}.` };
  const [a, b] = d.snapshots.slice(-2);
  let changes = diffSnapshots(a, b, d);
  if (partNumber) changes = changes.filter((c) => key(c.partNumber) === key(partNumber));
  return { from: a.takenAt, to: b.takenAt, changes };
}
