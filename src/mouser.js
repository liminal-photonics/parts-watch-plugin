// Mouser Search API v1 client (API key).
import { request } from "./http.js";
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
  if (res.status === 401 || res.status === 403) throw new Error(`Mouser rejected the API key (HTTP ${res.status}). Check MOUSER_API_KEY.`);
  if (!res.ok) throw new Error(`Mouser HTTP ${res.status}`);
  const j = await res.json();
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

export function normalizeMouser(p) {
  if (!p) return null;
  const compliance = p.ProductCompliance || [];
  const coo = compliance.find((c) => /origin|coo/i.test(c.ComplianceName || ""));
  const stock = p.AvailabilityInStock != null ? parseInt(p.AvailabilityInStock, 10) : parseInt(String(p.Availability || "").replace(/\D/g, ""), 10);
  return {
    distributor: "Mouser",
    distributorPartNumber: p.MouserPartNumber || null,
    manufacturer: p.Manufacturer || null,
    manufacturerPartNumber: p.ManufacturerPartNumber || null,
    description: p.Description || null,
    stock: Number.isFinite(stock) ? stock : p.AvailabilityInStock == null && !p.Availability ? null : 0, // no stock fields at all = not stated
    leadTime: p.LeadTime || null,
    leadTimeDays: leadDays(p.LeadTime), // same unit at every distributor
    lifecycle: p.LifecycleStatus || null, // Mouser leaves this empty for most active parts; null means "not stated", not "active".
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
  const exact = parts.find((p) => (p.ManufacturerPartNumber || "").toUpperCase() === pn || (p.MouserPartNumber || "").toUpperCase() === pn)
    || (alnum(pn).length >= 4 ? parts.find((p) => alnum(p.ManufacturerPartNumber) === alnum(pn)) : undefined);
  // Mouser can return near matches; only an exact MPN or Mouser PN counts as found.
  return exact ? normalizeMouser(exact) : null;
}
