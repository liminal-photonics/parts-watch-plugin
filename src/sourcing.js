import { digikeyConfigured, digikeySearch, digikeyDetails } from "./digikey.js";
import { mouserConfigured, mouserSearch, mouserDetails } from "./mouser.js";
import { newarkConfigured, newarkSearch, newarkDetails } from "./newark.js";

const SOURCES = {
  digikey: { name: "Digi-Key", configured: digikeyConfigured, search: digikeySearch, details: digikeyDetails, env: "DIGIKEY_CLIENT_ID and DIGIKEY_CLIENT_SECRET" },
  mouser: { name: "Mouser", configured: mouserConfigured, search: mouserSearch, details: mouserDetails, env: "MOUSER_API_KEY" },
  newark: { name: "Newark", configured: newarkConfigured, search: newarkSearch, details: newarkDetails, env: "NEWARK_API_KEY" },
};

function pick(distributors, notes) {
  if (typeof distributors === "string" && distributors.trim()) distributors = distributors.split(/[,;\s]+/).filter(Boolean); // "mouser" or "digikey, mouser"
  if (!Array.isArray(distributors) || !distributors.length) return Object.keys(SOURCES);
  const keys = [...new Set(distributors.map((d) => String(d).toLowerCase().replace(/[^a-z]/g, "")))];
  for (const k of keys) if (!SOURCES[k]) notes.push(`Unknown distributor "${k}" ignored (use digikey, mouser or newark).`);
  return keys.filter((k) => SOURCES[k]);
}

function requireText(v, field) {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) throw new Error(`${field} is required and must be a non-empty string.`);
  return s;
}

export function cleanQuantities(quantities) {
  if (quantities == null) return [1, 10, 100, 1000];
  const list = Array.isArray(quantities) ? quantities : [quantities];
  const out = [...new Set(list.map(Number))];
  if (!out.length || out.some((q) => !Number.isInteger(q) || q < 1)) throw new Error("quantities must be whole numbers of 1 or more.");
  if (out.length > 20) throw new Error("Give at most 20 quantities.");
  return out.sort((a, b) => a - b);
}

async function fanOut(distributors, fn) {
  const results = {};
  const notes = [];
  const picked = pick(distributors, notes);
  await Promise.all(
    picked.map(async (k) => {
      const s = SOURCES[k];
      if (!s.configured()) {
        notes.push(`${s.name} skipped: set ${s.env} to enable it.`);
        return;
      }
      try {
        results[k] = await fn(s);
      } catch (e) {
        notes.push(`${s.name} error: ${e.message}`);
      }
    })
  );
  if (!picked.some((k) => SOURCES[k].configured())) notes.push("No distributor was queried. Set at least one distributor API key (see the status tool).");
  return { results, notes };
}

export async function searchParts({ keyword, limit = 5, distributors } = {}) {
  keyword = requireText(keyword, "keyword");
  limit = Math.min(50, Math.max(1, Math.floor(Number(limit)) || 5));
  const { results, notes } = await fanOut(distributors, (s) => s.search(keyword, limit));
  for (const k of Object.keys(results)) if (!results[k].length) notes.push(`${SOURCES[k].name}: no results for "${keyword}".`);
  return { keyword, results, notes };
}

export async function getPartDetails({ partNumber, distributors } = {}) {
  partNumber = requireText(partNumber, "partNumber");
  const { results, notes } = await fanOut(distributors, (s) => s.details(partNumber));
  for (const k of Object.keys(results)) if (!results[k]) notes.push(`${SOURCES[k].name}: no match for ${partNumber}.`);
  return { partNumber, results, notes };
}

export function priceAt(breaks, qty) {
  if (!breaks || !breaks.length) return null;
  const sorted = breaks.filter((b) => Number.isFinite(b?.qty)).sort((a, b) => a.qty - b.qty);
  if (!sorted.some((b) => Number.isFinite(b.unitPrice))) return null; // breaks listed but none has a usable price
  let best = null;
  for (const b of sorted) if (qty >= b.qty && Number.isFinite(b.unitPrice)) best = b;
  return best ? { breakQty: best.qty, unitPrice: best.unitPrice, extended: +(best.unitPrice * qty).toFixed(4) } : { belowMinimum: true, minimumBreak: sorted[0].qty };
}

export async function compareDistributors({ partNumber, quantities, distributors } = {}) {
  quantities = cleanQuantities(quantities);
  const d = await getPartDetails({ partNumber, distributors });
  const rows = Object.values(d.results).filter(Boolean).map((r) => ({
    distributor: r.distributor,
    distributorPartNumber: r.distributorPartNumber,
    manufacturer: r.manufacturer,
    manufacturerPartNumber: r.manufacturerPartNumber,
    stock: r.stock,
    leadTime: r.leadTime,
    lifecycle: r.lifecycle,
    discontinued: r.discontinued,
    countryOfOrigin: r.countryOfOrigin,
    countryOfOriginNote: r.countryOfOriginNote,
    datasheetUrl: r.datasheetUrl,
    productUrl: r.productUrl,
    currency: r.currency || null,
    pricing: Object.fromEntries(quantities.map((q) => [q, priceAt(r.priceBreaks, q)])),
  }));
  const cheapest = {};
  // only compare prices in one currency (a non-US Newark store prices in its own currency)
  const baseCur = rows.some((r) => r.currency === "USD") ? "USD" : rows[0]?.currency;
  const mixed = rows.filter((r) => r.currency !== baseCur);
  for (const q of quantities) {
    let best = null;
    for (const r of rows) {
      const p = r.pricing[q];
      if (r.currency === baseCur && p && p.unitPrice != null && (r.stock ?? 0) >= q && (!best || p.unitPrice < best.unitPrice)) best = { distributor: r.distributor, unitPrice: p.unitPrice };
    }
    cheapest[q] = best || "No distributor has this quantity in stock at a listed price";
  }
  const flags = [];
  const queried = Object.keys(d.results).length; // configured, not filtered out, and answered
  if (queried >= 2 && rows.length === 1) flags.push(`Only found at ${rows[0].distributor} (single source among checked distributors).`);
  if (mixed.length) flags.push(`Not compared for cheapest (prices not in ${baseCur}): ${mixed.map((r) => `${r.distributor} (${r.currency})`).join(", ")}.`);
  for (const r of rows) {
    if (r.discontinued || /obsolete|not recommended|eol|end of life|last time/i.test(r.lifecycle || "")) flags.push(`${r.distributor}: lifecycle "${r.lifecycle}".`);
    if (r.stock === 0) flags.push(`${r.distributor}: zero stock.`);
    else if (r.stock == null) flags.push(`${r.distributor}: stock not stated.`);
  }
  return { partNumber, quantities, rows, cheapestInStock: cheapest, flags, notes: d.notes };
}

export function status() {
  return Object.fromEntries(Object.entries(SOURCES).map(([k, s]) => [k, s.configured() ? "configured" : `missing ${s.env}`]));
}
