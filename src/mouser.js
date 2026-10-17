// Mouser Search API v1 client (API key).
import { request } from "./http.js";
import { lifecycleFields } from "./lifecycle.js";
const BASE = process.env.MOUSER_API_BASE || "https://api.mouser.com/api/v1";

// "168 Days", "12 Weeks" -> days
const leadDays = (t) => { const m = String(t || "").match(/(\d+(?:\.\d+)?)\s*(day|week)/i); const d = m ? Math.round(Number(m[1]) * (/week/i.test(m[2]) ? 7 : 1)) : 0; return d > 0 ? d : null; }; // "0 Days" = not stated

export function mouserConfigured() {
  return Boolean(process.env.MOUSER_API_KEY);
}

async function ms(path, body) {
  const url = `${BASE}${path}?apiKey=${encodeURIComponent(process.env.MOUSER_API_KEY)}`;
  const res = await request("Mouser", url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  let j = null;
  try { j = await res.json(); } catch { j = null; }
  // Mouser reports its per-minute and per-day call limits as HTTP 403 with Errors[].Code "TooManyRequests".
  const errs = (j && Array.isArray(j.Errors) ? j.Errors : []);
  if (errs.some((e) => /TooManyRequests|MaxCall/i.test(`${e.Code} ${e.ResourceKey} ${e.Message}`))) {
    const perDay = errs.some((e) => /day/i.test(`${e.ResourceKey} ${e.Message}`));
    throw new Error(`Mouser rate limit reached (${perDay ? "daily call limit" : "30 calls per minute"}). This is not a key problem. ${perDay ? "Try again tomorrow" : "Wait a minute and try again"}, or query fewer parts at once.`);
  }
  if (res.status === 401 || res.status === 403) throw new Error(`Mouser rejected the API key (HTTP ${res.status}). Check MOUSER_API_KEY.`);
  if (!res.ok) throw new Error(`Mouser HTTP ${res.status}`);
  if (!j) throw new Error("Mouser returned a response that is not JSON. Try again later.");
  if (j.Errors && j.Errors.length) { const msg = j.Errors.map((e) => e.Message).join("; "); throw new Error(/unique identifier|api ?key|unauthori[sz]ed/i.test(msg) ? `Mouser rejected the API key (${msg}). Check MOUSER_API_KEY.` : `Mouser: ${msg}`); }
  return j;
}

function parsePrice(s) {
  if (typeof s === "number") return s;
  let t = String(s || "").replace(/[^0-9.,]/g, "");
  // the last separator is the decimal point when both appear ("1,234.56" or "1.234,56")
  if (t.includes(",") && t.includes(".")) t = t.lastIndexOf(",") > t.lastIndexOf(".") ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
  else t = t.replace(/,(?=\d{3}\b)/g, "").replace(",", ".");
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

// Stock from Mouser's fields. AvailabilityInStock is a plain count. The Availability text is only trusted in the
// form "39,388 In Stock"; anything else ("In stock 500, 1000 on order", "On Order") gives null, never digits glued together.
export function mouserStock(p) {
  const n = p?.AvailabilityInStock;
  if (n != null && n !== "") { const t = String(n).trim().replace(/,/g, ""); return /^\d+$/.test(t) ? Number(t) : null; }
  if (/^(none|out of stock)$/i.test(String(p?.Availability ?? "").trim())) return 0;
  const m = String(p?.Availability ?? "").trim().match(/^(\d{1,3}(?:,\d{3})+|\d+)\s+In Stock$/i);
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

export function normalizeMouser(p) {
  if (!p) return null;
  const compliance = p.ProductCompliance || [];
  const coo = compliance.find((c) => /origin|coo/i.test(c.ComplianceName || ""));
  const stock = mouserStock(p);
  return {
    distributor: "Mouser",
    distributorPartNumber: p.MouserPartNumber && p.MouserPartNumber !== "N/A" ? p.MouserPartNumber : null, // "N/A" = listed but not sold by Mouser
    manufacturer: p.Manufacturer || null,
    manufacturerPartNumber: p.ManufacturerPartNumber || null,
    description: p.Description || null,
    stock, // null = not stated or not in a format we recognize (see availabilityText)
    ...(stock == null && p.Availability ? { availabilityText: String(p.Availability).slice(0, 200) } : {}),
    leadTime: leadDays(p.LeadTime) ? p.LeadTime : null, // Mouser sends "0 Days" when it has no lead time
    leadTimeDays: leadDays(p.LeadTime), // same unit at every distributor
    lifecycle: p.LifecycleStatus || null, // Mouser leaves this empty for most active parts; null means "not stated", not "active".
    ...lifecycleFields(p.IsDiscontinued === "true" ? "Discontinued" : p.LifecycleStatus, "Mouser"),
    discontinued: /obsolete|discontinued|end of life|eol/i.test(p.LifecycleStatus || "") || p.IsDiscontinued === "true",
    endOfLife: /end of life|eol|obsolete/i.test(p.LifecycleStatus || ""),
    countryOfOrigin: coo ? coo.ComplianceValue : null,
    countryOfOriginNote: coo ? `From Mouser compliance field "${coo.ComplianceName}"` : "Not provided in Mouser search response",
    packaging: null,
    minimumOrderQty: p.Min ? parseInt(p.Min, 10) : null,
    priceBreaks: (p.PriceBreaks || []).map((b) => ({ qty: b.Quantity, unitPrice: parsePrice(b.Price) })),
    currency: p.PriceBreaks?.[0]?.Currency || "USD",
    datasheetUrl: p.DataSheetUrl || null,
    productUrl: p.ProductDetailUrl || null,
    rohs: p.ROHSStatus || null,
    ...(p.MouserPartNumber === "N/A" ? { availabilityNote: "Mouser lists this part for reference but does not sell it (no Mouser part number)." } : {}),
  };
}

// Mouser's API rejects some non-ASCII characters with HTTP 400 (e.g. "µ" in "10µF"). Map common symbols to ASCII.
export function asciiKeyword(k) {
  return String(k).replace(/[µμ]/g, "u").replace(/[Ωω]/g, "ohm").replace(/±/g, "+/-").replace(/°/g, "deg").normalize("NFKD").replace(/[^\x20-\x7E]/g, "");
}

export async function mouserSearch(keyword, limit = 10) {
  keyword = asciiKeyword(keyword);
  const j = await ms(`/search/keyword`, {
    SearchByKeywordRequest: { keyword, records: Math.min(limit, 50), startingRecord: 0, searchOptions: "", searchWithYourSignUpLanguage: "" },
  });
  return (j.SearchResults?.Parts || []).slice(0, limit).map(normalizeMouser);
}

export async function mouserDetails(partNumber) {
  const j = await ms(`/search/partnumber`, {
    SearchByPartRequest: { mouserPartNumber: asciiKeyword(partNumber), partSearchOptions: "Exact" },
  });
  const parts = j.SearchResults?.Parts || [];
  const pn = partNumber.toUpperCase();
  const alnum = (x) => String(x || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const strict = parts.find((p) => (p.ManufacturerPartNumber || "").toUpperCase() === pn || (p.MouserPartNumber || "").toUpperCase() === pn);
  // Mouser can return near matches; only an exact MPN or Mouser PN counts as found. A punctuation-blind match
  // (ERJ3EKF1002V for ERJ-3EKF1002V) is returned, but marked exactMatch:false with a note so it can't pass silently.
  const loose = strict ? null : (alnum(pn).length >= 4 ? parts.find((p) => alnum(p.ManufacturerPartNumber) === alnum(pn)) : undefined);
  const hit = strict || loose;
  if (!hit) return null;
  const row = normalizeMouser(hit);
  row.exactMatch = Boolean(strict);
  if (!strict) row.matchNote = `Mouser lists this part as ${hit.ManufacturerPartNumber}, which matches ${partNumber} only when punctuation is ignored. Check that it is the same ordering code.`;
  return row;
}
