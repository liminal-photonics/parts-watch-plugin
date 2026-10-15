// Mouser Search API v1 client (API key).
import { request } from "./http.js";
const BASE = process.env.MOUSER_API_BASE || "https://api.mouser.com/api/v1";

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
  if (!res.ok) throw new Error(`Mouser HTTP ${res.status}`);
  const j = await res.json();
  if (j.Errors && j.Errors.length) throw new Error(`Mouser: ${j.Errors.map((e) => e.Message).join("; ")}`);
  return j;
}

function parsePrice(s) {
  if (typeof s === "number") return s;
  const n = parseFloat(String(s || "").replace(/[^0-9.,]/g, "").replace(/,(?=\d{3}\b)/g, "").replace(",", "."));
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
    stock: Number.isFinite(stock) ? stock : 0,
    leadTime: p.LeadTime || null,
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

export async function mouserSearch(keyword, limit = 10) {
  const j = await ms(`/search/keyword`, {
    SearchByKeywordRequest: { keyword, records: Math.min(limit, 50), startingRecord: 0, searchOptions: "", searchWithYourSignUpLanguage: "" },
  });
  return (j.SearchResults?.Parts || []).slice(0, limit).map(normalizeMouser);
}

export async function mouserDetails(partNumber) {
  const j = await ms(`/search/partnumber`, {
    SearchByPartRequest: { mouserPartNumber: partNumber, partSearchOptions: "Exact" },
  });
  const parts = j.SearchResults?.Parts || [];
  const pn = partNumber.toUpperCase();
  const exact = parts.find((p) => (p.ManufacturerPartNumber || "").toUpperCase() === pn || (p.MouserPartNumber || "").toUpperCase() === pn);
  // Mouser can return near matches; only an exact MPN or Mouser PN counts as found.
  return exact ? normalizeMouser(exact) : null;
}
