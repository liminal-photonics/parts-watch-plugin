// element14 / Newark / Farnell Product Search API client (API key from partner.element14.com).
import { request } from "./http.js";
const BASE = process.env.NEWARK_API_BASE || "https://api.element14.com/catalog/products";

export function newarkConfigured() {
  return Boolean(process.env.NEWARK_API_KEY);
}

export function newarkStore() {
  return process.env.NEWARK_STORE || "www.newark.com";
}

async function e14(term, limit) {
  const q = new URLSearchParams({
    term,
    "storeInfo.id": newarkStore(),
    "resultsSettings.offset": "0",
    "resultsSettings.numberOfResults": String(Math.min(limit, 50)),
    "resultsSettings.responseGroup": "large",
    "callInfo.responseDataFormat": "json",
    "callInfo.apiKey": process.env.NEWARK_API_KEY,
  });
  const res = await request("Newark", `${BASE}?${q}`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Newark HTTP ${res.status}`);
  const j = await res.json();
  if (j.Fault) throw new Error(`Newark: ${j.Fault.faultstring || "API fault"}`);
  // The return wrapper name depends on the search type (keywordSearchReturn, manufacturerPartNumberSearchReturn, premierFarnellPartNumberReturn).
  const wrapper = Object.values(j).find((v) => v && typeof v === "object" && "numberOfResults" in v) || {};
  return wrapper.products || [];
}

// productStatus is Newark's stocking status (STOCKED, DIRECT_SHIP, NO_LONGER_STOCKED, ...), not the
// manufacturer lifecycle. Only these values mean the part itself is end of life.
const EOL_STATUS = /NO_LONGER_MANUFACTURED|OBSOLETE|DISCONTINUED|END_OF_LIFE/i;

export function normalizeNewark(p) {
  if (!p) return null;
  const status = p.productStatus || p.stock?.status || null;
  const stock = p.stock?.level ?? p.inv ?? null;
  const lead = p.stock?.leastLeadTime;
  const coo = p.countryOfOrigin || p.coo || null;
  const ds = (p.datasheets || []).find((d) => d.url) || null;
  const attr = (label) => (p.attributes || []).find((a) => a.attributeLabel === label)?.attributeValue ?? null;
  const moq = p.translatedMinimumOrderQuality ?? p.translatedMinimumOrderQuantity ?? null;
  const breaks = (p.prices || []).map((b) => ({ qty: b.from, unitPrice: typeof b.cost === "number" ? b.cost : parseFloat(b.cost) }));
  if (moq && breaks.length && breaks[0].qty < moq) breaks[0] = { ...breaks[0], qty: moq };
  return {
    distributor: "Newark",
    distributorPartNumber: p.sku || null,
    manufacturer: p.brandName || p.vendorName || null,
    manufacturerPartNumber: p.translatedManufacturerPartNumber || null,
    description: p.displayName || null,
    stock: typeof stock === "number" ? stock : stock != null ? parseInt(stock, 10) || 0 : null,
    leadTime: lead ? `${lead} days (for quantities beyond stock)` : null,
    stockByWarehouse: (p.stock?.regionalBreakdown || []).map((w) => ({ warehouse: w.warehouse, stock: w.level })),
    lifecycle: status ? `${status} (Newark stocking status)` : null,
    discontinued: EOL_STATUS.test(String(status || "")),
    endOfLife: EOL_STATUS.test(String(status || "")),
    countryOfOrigin: coo,
    countryOfOriginNote: coo ? "From element14 product data" : "Not provided in element14 search response",
    packaging: p.packSize ? `pack of ${p.packSize}` : null,
    minimumOrderQty: moq,
    priceBreaks: breaks,
    currency: newarkStore() === "www.newark.com" ? "USD" : `${newarkStore()} store currency`,
    datasheetUrl: ds ? ds.url : null,
    productUrl: p.sku ? `https://${newarkStore()}/search?st=${encodeURIComponent(p.sku)}` : null,
    rohs: p.rohsStatusCode || null,
    eccn: attr("usEccn"),
  };
}

export async function newarkSearch(keyword, limit = 10) {
  return (await e14(`any:${keyword}`, limit)).slice(0, limit).map(normalizeNewark);
}

const alnum = (x) => String(x || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

export async function newarkDetails(partNumber) {
  let parts = await e14(`manuPartNum:${partNumber}`, 10);
  if (!parts.length) parts = await e14(`id:${partNumber}`, 1); // Newark/Farnell order code
  const pn = partNumber.toUpperCase();
  // MPN search is fuzzy and one MPN can have several Newark SKUs (cut tape, reel, legacy). Keep exact
  // matches only. Prefer SKUs in stock, then the lowest minimum order (cut tape before full reel), then most stock.
  let exact = parts.filter((p) => (p.translatedManufacturerPartNumber || "").toUpperCase() === pn || String(p.sku || "").toUpperCase() === pn);
  // Newark often stores MPNs without punctuation (ERJ-3EKF1002V is listed as ERJ3EKF1002V). Use a punctuation-blind
  // match only when there is no exact one.
  if (!exact.length) exact = parts.filter((p) => alnum(p.translatedManufacturerPartNumber) === alnum(pn) && alnum(pn).length >= 4);
  if (!exact.length) return null;
  const stk = (p) => p.stock?.level ?? p.inv ?? 0;
  const moq = (p) => p.translatedMinimumOrderQuality ?? p.translatedMinimumOrderQuantity ?? 1;
  exact.sort((a, b) => (stk(b) > 0) - (stk(a) > 0) || moq(a) - moq(b) || stk(b) - stk(a));
  const best = normalizeNewark(exact[0]);
  if (alnum(best.manufacturerPartNumber) === alnum(pn) && String(best.manufacturerPartNumber).toUpperCase() !== pn && String(exact[0].sku || "").toUpperCase() !== pn) best.matchNote = `Newark lists this part as ${best.manufacturerPartNumber}.`;
  if (exact.length > 1) best.otherSkus = exact.slice(1).map((p) => ({ sku: p.sku, status: p.productStatus, stock: stk(p), minimumOrderQty: moq(p) }));
  return best;
}
