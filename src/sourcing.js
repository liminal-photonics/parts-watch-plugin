import { digikeyConfigured, digikeySearch, digikeyDetails } from "./digikey.js";
import { mouserConfigured, mouserSearch, mouserDetails } from "./mouser.js";
import { newarkConfigured, newarkSearch, newarkDetails } from "./newark.js";
import { pluginVersion } from "./version.js";

const SOURCES = {
  digikey: { name: "Digi-Key", configured: digikeyConfigured, search: digikeySearch, details: digikeyDetails, env: "DIGIKEY_CLIENT_ID and DIGIKEY_CLIENT_SECRET" },
  mouser: { name: "Mouser", configured: mouserConfigured, search: mouserSearch, details: mouserDetails, env: "MOUSER_API_KEY" },
  newark: { name: "Newark", configured: newarkConfigured, search: newarkSearch, details: newarkDetails, env: "NEWARK_API_KEY" },
};

function pick(distributors, notes) {
  if (typeof distributors === "string" && distributors.trim()) distributors = distributors.split(/[,;\s]+/).filter(Boolean); // "mouser" or "digikey, mouser"
  if (!Array.isArray(distributors) || !distributors.length) return Object.keys(SOURCES);
  const keys = [...new Set(distributors.map((d) => String(d).toLowerCase().replace(/[^a-z]/g, "")))];
  const unknown = keys.filter((k) => !SOURCES[k]);
  if (unknown.length) notes.push(`Unknown distributor${unknown.length > 1 ? "s" : ""} ${unknown.slice(0, 5).map((k) => `"${k.slice(0, 30)}"`).join(", ")}${unknown.length > 5 ? ` and ${unknown.length - 5} more` : ""} ignored (use digikey, mouser or newark).`);
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

// "Texas Instruments" / "TEXAS INSTRUMENTS" / "Analog Devices / Maxim Integrated" -> "texas" / "analog"
// Known renames that would otherwise look like different makers ("ON Semiconductor" vs "onsemi").
const MFR_ALIASES = { on: "onsemi", onsemi: "onsemi", fairchild: "onsemi", ti: "texas", nxp: "nxp", freescale: "nxp", maxim: "analog", linear: "analog" };
export const mfrKey = (m) => { const k = (String(m || "").toLowerCase().match(/[a-z0-9]+/) || [""])[0]; return MFR_ALIASES[k] || k; };

// Digi-Key sometimes lists one MPN from several manufacturers (e.g. a clone maker using the original part number) and
// picks by stock. When Mouser or Newark name the manufacturer, prefer Digi-Key's listing from that manufacturer.
export function preferManufacturer(results, notes) {
  const dk = results.digikey;
  const alts = dk && dk._alternatives;
  if (!dk) return;
  const others = Object.entries(results).filter(([k, r]) => k !== "digikey" && r && r.manufacturer).map(([, r]) => r);
  const keys = new Set(others.map((r) => mfrKey(r.manufacturer)));
  if (keys.has(mfrKey(dk.manufacturer))) { dk.manufacturerConfirmed = true; return; }
  if (!keys.size) {
    // No other distributor named a maker (not configured, rate-limited, not stocked, or digikey-only call). The
    // Digi-Key pick stands, but if several makers list the MPN it is unconfirmed and must not go into a BOM as is.
    if (dk.manufacturerConfirmed === false) notes.push(`Manufacturer NOT confirmed: ${(alts || []).length || "several"} manufacturers list ${dk.manufacturerPartNumber} on Digi-Key and no other distributor answered to confirm which one is meant. Showing ${dk.manufacturer} by stock; check it against the schematic's intended maker before recording it (some listings are second-source or clone makers).`);
    return;
  }
  const match = (alts || []).find((r) => keys.has(mfrKey(r.manufacturer)));
  if (match) {
    const rest = alts.filter((r) => r !== match);
    const swapped = { ...match, manufacturerConfirmed: true, otherManufacturers: rest.map((r) => ({ manufacturer: r.manufacturer, distributorPartNumber: r.distributorPartNumber, stock: r.stock, minimumOrderQty: r.minimumOrderQty })) };
    swapped.matchNote = `${alts.length} manufacturers list this part number on Digi-Key; showing ${match.manufacturer}, the manufacturer ${others.map((r) => r.distributor).join(" and ")} list. Others (e.g. ${dk.manufacturer}) are under otherManufacturers.`;
    results.digikey = swapped;
  } else {
    dk.manufacturerConfirmed = false;
    notes.push(`Manufacturer NOT confirmed: Digi-Key's match is made by ${dk.manufacturer}, but ${others.map((r) => `${r.distributor} lists ${r.manufacturer}`).join(" and ")}. Check that it is the part you want.`);
  }
}

// Conditions that make a row unfit to record in a BOM, lifecycle check or cost model without a human check.
export function rowWarnings(r) {
  const w = [];
  if (!r) return w;
  if (r.manufacturerConfirmed === false) w.push(`${r.distributor}: manufacturer not confirmed (${r.manufacturer}); several makers list this part number.`);
  if (r.exactMatch === false) w.push(`${r.distributor}: not an exact part-number match (${r.manufacturerPartNumber}).`);
  if (r.stockFresh === false) w.push(`${r.distributor}: stock may be stale (${r.stockNote || "not refreshed"}).`);
  if (r.lifecycleStated === false) w.push(`${r.distributor}: lifecycle not stated; this is "unknown" and does not count as a clean lifecycle check.`);
  return w;
}

export async function getPartDetails({ partNumber, distributors } = {}) {
  partNumber = requireText(partNumber, "partNumber");
  const { results, notes } = await fanOut(distributors, (s) => s.details(partNumber));
  preferManufacturer(results, notes);
  for (const k of Object.keys(results)) if (!results[k]) notes.push(`${SOURCES[k].name}: no match for ${partNumber}.`);
  const warnings = Object.values(results).flatMap(rowWarnings);
  return { partNumber, results, warnings, notes };
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
    leadTimeDays: r.leadTimeDays ?? null,
    lifecycle: r.lifecycle,
    lifecycleStatus: r.lifecycleStatus ?? "unknown",
    cleanLifecycleCheck: Boolean(r.cleanLifecycleCheck),
    discontinued: r.discontinued,
    manufacturerConfirmed: r.manufacturerConfirmed ?? true,
    exactMatch: r.exactMatch ?? true,
    stockFresh: r.stockFresh ?? true,
    ...(r.stockNote ? { stockNote: r.stockNote } : {}),
    countryOfOrigin: r.countryOfOrigin,
    countryOfOriginNote: r.countryOfOriginNote,
    datasheetUrl: r.datasheetUrl,
    productUrl: r.productUrl,
    currency: r.currency || null,
    pricing: Object.fromEntries(quantities.map((q) => [q, priceAt(r.priceBreaks, q)])),
    ...(r.matchNote ? { matchNote: r.matchNote } : {}),
    ...(r.availabilityNote ? { availabilityNote: r.availabilityNote } : {}),
  }));
  const cheapest = {};
  // only compare prices in one currency (a non-US Newark store prices in its own currency)
  const baseCur = rows.some((r) => r.currency === "USD") ? "USD" : rows[0]?.currency;
  const mixed = rows.filter((r) => r.currency !== baseCur);
  for (const q of quantities) {
    let best = null;
    for (const r of rows) {
      const p = r.pricing[q];
      // Stale stock, an unconfirmed maker or a non-exact match can't win "cheapest in stock".
      if (r.currency === baseCur && r.stockFresh && r.manufacturerConfirmed && r.exactMatch && p && p.unitPrice != null && (r.stock ?? 0) >= q && (!best || p.unitPrice < best.unitPrice)) best = { distributor: r.distributor, unitPrice: p.unitPrice };
    }
    cheapest[q] = best || "No distributor has this quantity in stock at a listed price";
  }
  const flags = [];
  const queried = Object.keys(d.results).length; // configured, not filtered out, and answered
  if (queried >= 2 && rows.length === 1) flags.push(`Only found at ${rows[0].distributor} (single source among checked distributors).`);
  if (mixed.length) flags.push(`Not compared for cheapest (prices not in ${baseCur}): ${mixed.map((r) => `${r.distributor} (${r.currency})`).join(", ")}.`);
  for (const r of rows) {
    if (r.discontinued || ["eol", "nrnd"].includes(r.lifecycleStatus) || /obsolete|not recommended|eol|end of life|last time/i.test(r.lifecycle || "")) flags.push(`${r.distributor}: lifecycle "${r.lifecycle}".`);
    if (r.availabilityNote) flags.push(`${r.distributor}: ${r.availabilityNote}`);
    else if (r.stock === 0) flags.push(`${r.distributor}: zero stock.`);
    else if (r.stock == null) flags.push(`${r.distributor}: stock not stated.`);
  }
  flags.push(...d.warnings);
  const clean = rows.filter((r) => r.cleanLifecycleCheck && r.manufacturerConfirmed && r.exactMatch).map((r) => r.distributor);
  const lifecycleSummary = { cleanChecks: clean, count: clean.length, note: "Only an explicit active status from the source counts. Two clean checks from separate sources are needed to clear a part (AGENTS.md); unknown never counts." };
  return { partNumber, quantities, rows, cheapestInStock: cheapest, lifecycleSummary, flags, notes: d.notes };
}

export function status() {
  const v = pluginVersion();
  return {
    ...Object.fromEntries(Object.entries(SOURCES).map(([k, s]) => [k, s.configured() ? "configured" : `missing ${s.env}`])),
    plugin: v.name, version: v.version, gitSha: v.gitSha, gitShaSource: v.gitShaSource,
  };
}
